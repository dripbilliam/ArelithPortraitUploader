"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { getSupabaseClient } from "@/lib/supabase";
import { convertImageToTgaVariants } from "@/lib/tga";

type UploadResponse = {
  imageId: string;
  filenamePrefix: string;
  objectPath: string;
};

type FinalizeResponse = {
  imageId: string;
  status: "ready";
  convertedPathBase: string;
};

type MyImageRow = {
  id: string;
  filename_prefix: string;
  status: "uploaded" | "processing" | "ready" | "failed";
  created_at: string;
};

type DeleteImageResponse = {
  imageId: string;
  deleted: boolean;
};

type BulkDownloadResponse = {
  jobId: string;
  status: "queued" | "processing" | "ready" | "failed";
  accessToken: string;
  reused?: boolean;
};

type BulkDownloadJobStatus = {
  jobId: string;
  status: "queued" | "processing" | "ready" | "failed";
  fileCount: number;
  skippedCount: number;
  zipPath: string | null;
  signedUrl: string | null;
  error: string | null;
};

const POLL_INTERVAL_MS = 1500;
const POLL_MAX_ATTEMPTS = 120;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function convertPngFileToJpeg(file: File): Promise<File> {
  const bitmap = await createImageBitmap(file);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;

    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error("Could not create canvas context for PNG conversion");
    }

    // Fill alpha with black so transparent PNGs remain game-friendly.
    ctx.fillStyle = "black";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0);

    const jpegBlob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (!blob) {
          reject(new Error("Failed to encode PNG as JPG"));
          return;
        }
        resolve(blob);
      }, "image/jpeg", 0.92);
    });

    const baseName = file.name.replace(/\.[^/.]+$/, "");
    return new File([jpegBlob], `${baseName}.jpg`, { type: "image/jpeg" });
  } finally {
    bitmap.close();
  }
}

export default function Home() {
  const supabase = useMemo(() => getSupabaseClient(), []);
  const isConfigured = Boolean(supabase);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [isSignUp, setIsSignUp] = useState(false);
  const [session, setSession] = useState<Session | null>(null);

  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [filenamePrefixInput, setFilenamePrefixInput] = useState("");
  const [lastFilenamePrefix, setLastFilenamePrefix] = useState("");
  const [myImages, setMyImages] = useState<MyImageRow[]>([]);
  const [isLoadingMyImages, setIsLoadingMyImages] = useState(false);
  const [statusMessage, setStatusMessage] = useState("");
  const [isError, setIsError] = useState(false);
  const [isWorking, setIsWorking] = useState(false);

  const loggedInEmail = useMemo(() => session?.user?.email ?? "", [session]);

  const loadMyImages = useCallback(async () => {
    if (!supabase) {
      return;
    }

    setIsLoadingMyImages(true);
    const { data, error } = await supabase
      .from("images")
      .select("id, filename_prefix, status, created_at")
      .order("created_at", { ascending: false })
      .limit(100);

    if (!error && data) {
      setMyImages(data as MyImageRow[]);
    }
    setIsLoadingMyImages(false);
  }, [supabase]);

  const loadSessionState = useCallback(async (currentUserId: string | null) => {
    if (!currentUserId) {
      setSelectedFile(null);
      setFilenamePrefixInput("");
      setLastFilenamePrefix("");
      setMyImages([]);
      return;
    }

    await loadMyImages();
  }, [loadMyImages]);

  useEffect(() => {
    if (!supabase) {
      return;
    }

    const loadSession = async () => {
      const { data } = await supabase.auth.getSession();
      const currentSession = data.session ?? null;
      setSession(currentSession);
      await loadSessionState(currentSession?.user?.id ?? null);
    };

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, currentSession) => {
      setSession(currentSession);
      void loadSessionState(currentSession?.user?.id ?? null);
    });

    void loadSession();

    return () => subscription.unsubscribe();
  }, [supabase, loadSessionState]);

  const handleAuth = async (event: FormEvent) => {
    event.preventDefault();
    if (!supabase) {
      setIsError(true);
      setStatusMessage("Missing Supabase environment configuration.");
      return;
    }

    setIsWorking(true);
    setIsError(false);
    setStatusMessage("");

    try {
      if (isSignUp) {
        const { error } = await supabase.auth.signUp({ email, password });
        if (error) {
          throw error;
        }
        setStatusMessage(
          "Sign-up submitted. Check your email if confirmation is enabled.",
        );
      } else {
        const { error } = await supabase.auth.signInWithPassword({
          email,
          password,
        });
        if (error) {
          throw error;
        }
        setStatusMessage("Signed in successfully.");
      }
    } catch (error) {
      setIsError(true);
      setStatusMessage(error instanceof Error ? error.message : "Auth failed");
    } finally {
      setIsWorking(false);
    }
  };

  const handleSignOut = async () => {
    if (!supabase) {
      return;
    }

    setIsWorking(true);
    await supabase.auth.signOut();
    setSelectedFile(null);
    setStatusMessage("Signed out.");
    setIsError(false);
    setIsWorking(false);
  };

  const handleUpload = async (event: FormEvent) => {
    event.preventDefault();

    if (!supabase) {
      setIsError(true);
      setStatusMessage("Missing Supabase environment configuration.");
      return;
    }

    if (!session?.access_token) {
      setIsError(true);
      setStatusMessage("You must be signed in before uploading.");
      return;
    }

    if (!selectedFile) {
      setIsError(true);
      setStatusMessage("Select an image first.");
      return;
    }

    const fileType = selectedFile.type.toLowerCase();
    const lowerName = selectedFile.name.toLowerCase();
    const isPng = fileType === "image/png" || lowerName.endsWith(".png");
    const isJpeg =
      fileType === "image/jpeg" ||
      fileType === "image/jpg" ||
      lowerName.endsWith(".jpg") ||
      lowerName.endsWith(".jpeg");

    if (!isJpeg && !isPng) {
      setIsError(true);
      setStatusMessage("Only JPG/JPEG or PNG files are allowed.");
      return;
    }

    if (selectedFile.size > 25 * 1024 * 1024) {
      setIsError(true);
      setStatusMessage("Max size is 25 MiB.");
      return;
    }

    setIsWorking(true);
    setIsError(false);
    setStatusMessage("Preparing upload...");

    try {
      let uploadSourceFile = selectedFile;
      if (isPng) {
        setStatusMessage("Converting PNG to JPG...");
        uploadSourceFile = await convertPngFileToJpeg(selectedFile);
      }

      if (uploadSourceFile.size > 25 * 1024 * 1024) {
        throw new Error("Converted JPG exceeds max size of 25 MiB.");
      }

      setStatusMessage("Creating upload URL...");

      const { data, error } = await supabase.functions.invoke<UploadResponse>(
        "create-upload-url",
        {
          body: {
            filename: uploadSourceFile.name,
            sourceMime: uploadSourceFile.type || "application/octet-stream",
            filenamePrefix: filenamePrefixInput,
          },
        },
      );

      if (error || !data) {
        throw new Error(error?.message ?? "Failed to create upload URL");
      }

      setStatusMessage(`Building TGA variants in browser...`);

      const variants = await convertImageToTgaVariants(uploadSourceFile);
      const convertedPathBase = `${session.user.id}/${data.imageId}`;

      for (const variant of variants) {
        const tgaPath = `${convertedPathBase}_${variant.suffix}.tga`;
        const { error: tgaUploadError } = await supabase.storage
          .from("portraits-converted")
          .upload(tgaPath, variant.blob, {
            upsert: true,
            contentType: "image/x-tga",
          });

        if (tgaUploadError) {
          throw new Error(`Failed to upload ${variant.suffix} TGA: ${tgaUploadError.message}`);
        }
      }

      setStatusMessage(`Uploaded TGAs. Finalizing image ${data.imageId}...`);

      const { error: finalizeError } = await supabase.functions.invoke<FinalizeResponse>(
        "finalize-client-conversion",
        {
          body: {
            imageId: data.imageId,
            convertedPathBase,
          },
        },
      );

      if (finalizeError) {
        throw new Error(`Upload succeeded, finalize failed: ${finalizeError.message}`);
      }

      setLastFilenamePrefix(data.filenamePrefix);
      setStatusMessage(`${isPng ? "PNG" : "JPG"} converted to 5 TGAs and saved for ${data.imageId}.`);
      setSelectedFile(null);
      await loadMyImages();
    } catch (error) {
      setIsError(true);
      setStatusMessage(
        error instanceof Error ? error.message : "Upload request failed",
      );
    } finally {
      setIsWorking(false);
    }
  };

  const copyLastPrefix = async () => {
    if (!lastFilenamePrefix) {
      return;
    }

    try {
      await navigator.clipboard.writeText(lastFilenamePrefix);
      setIsError(false);
      setStatusMessage(`Copied filename prefix: ${lastFilenamePrefix}`);
    } catch {
      setIsError(true);
      setStatusMessage("Could not copy prefix automatically. Copy it manually.");
    }
  };

  const handleDownloadAll = async () => {
    if (!supabase) {
      setIsError(true);
      setStatusMessage("Missing Supabase environment configuration.");
      return;
    }

    setIsWorking(true);
    setIsError(false);
    setStatusMessage("Queueing bulk export...");

    try {
      const { data, error } = await supabase.functions.invoke<BulkDownloadResponse>(
        "request-bulk-download",
      );

      if (error || !data) {
        throw new Error(error?.message ?? "Failed to get download links");
      }

      let finalJob: BulkDownloadJobStatus | null = null;
      for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt += 1) {
        const { data: statusData, error: statusError } = await supabase.functions.invoke<BulkDownloadJobStatus>(
          "get-bulk-download-job",
          {
            body: {
              jobId: data.jobId,
              accessToken: data.accessToken,
            },
          },
        );

        if (statusError || !statusData) {
          throw new Error(statusError?.message ?? "Failed to query bulk export job");
        }

        finalJob = statusData;
        if (statusData.status === "ready" || statusData.status === "failed") {
          break;
        }

        setStatusMessage(`Building ZIP in background... (${attempt + 1}/${POLL_MAX_ATTEMPTS})`);
        await sleep(POLL_INTERVAL_MS);
      }

      if (!finalJob) {
        throw new Error("No job status received");
      }

      if (finalJob.status === "failed") {
        throw new Error(finalJob.error || "Bulk export failed");
      }

      if (!finalJob.signedUrl) {
        throw new Error("ZIP is ready but no signed URL was returned");
      }

      const link = document.createElement("a");
      link.href = finalJob.signedUrl;
      link.download = "all-images.zip";
      link.rel = "noopener noreferrer";
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);

      setStatusMessage(
        `ZIP ready (${finalJob.fileCount} files, ${finalJob.skippedCount} skipped). Download started.`,
      );
    } catch (error) {
      setIsError(true);
      setStatusMessage(
        error instanceof Error ? error.message : "Download request failed",
      );
    } finally {
      setIsWorking(false);
    }
  };

  const handleDeleteImage = async (image: MyImageRow) => {
    if (!supabase) {
      setIsError(true);
      setStatusMessage("Missing Supabase environment configuration.");
      return;
    }

    const confirmed = window.confirm(
      `Delete image prefix ${image.filename_prefix}? This cannot be undone.`,
    );
    if (!confirmed) {
      return;
    }

    setIsWorking(true);
    setIsError(false);
    setStatusMessage(`Deleting ${image.filename_prefix}...`);

    try {
      const { data, error } = await supabase.functions.invoke<DeleteImageResponse>(
        "delete-image",
        {
          body: {
            imageId: image.id,
          },
        },
      );

      if (error || !data?.deleted) {
        throw new Error(error?.message ?? "Failed to delete image");
      }

      await loadMyImages();
      setStatusMessage(`Deleted ${image.filename_prefix}.`);
    } catch (error) {
      setIsError(true);
      setStatusMessage(error instanceof Error ? error.message : "Delete failed");
    } finally {
      setIsWorking(false);
    }
  };

  return (
    <main className="page">
      <div className="container">
        <section className="panel">
          <h1 className="title">Arelith Portrait Uploader</h1>
          <p className="lead">
            Sign in, upload an image, and your current pipeline will store it as
            an upload job.
          </p>

          {!session ? (
            <form className="stack" onSubmit={handleAuth}>
              <label className="label" htmlFor="email">
                Email
              </label>
              <input
                id="email"
                className="input"
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                required
              />

              <label className="label" htmlFor="password">
                Password
              </label>
              <input
                id="password"
                className="input"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
                minLength={6}
              />

              <button className="button" type="submit" disabled={isWorking}>
                {isWorking ? "Working..." : isSignUp ? "Create account" : "Sign in"}
              </button>

              <button
                className="button secondary"
                type="button"
                disabled={isWorking}
                onClick={() => setIsSignUp((value) => !value)}
              >
                {isSignUp
                  ? "Switch to sign in"
                  : "Need an account? Switch to sign up"}
              </button>
            </form>
          ) : (
            <div className="stack">
              <p className="hint">
                Signed in as <strong>{loggedInEmail}</strong>
              </p>
              <button
                className="button secondary"
                type="button"
                onClick={handleSignOut}
                disabled={isWorking}
              >
                Sign out
              </button>
            </div>
          )}

          {statusMessage ? (
            <p className={`status ${isError ? "error" : ""}`}>{statusMessage}</p>
          ) : null}

          {!isConfigured ? (
            <p className="status error">
              Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY in
              <code className="mono"> web/.env.local</code>.
            </p>
          ) : null}
        </section>

        <section className="panel">
          <h2 className="title">Upload</h2>
          <p className="lead">Limit: 25 MiB. Accepted: JPG/JPEG (PNG auto-converts to JPG).</p>

          <form className="stack" onSubmit={handleUpload}>
            <div className="row">
              <div className="stack">
                <label className="label" htmlFor="filenamePrefix">
                  Filename prefix (optional)
                </label>
                <input
                  id="filenamePrefix"
                  className="input"
                  type="text"
                  value={filenamePrefixInput}
                  onChange={(event) => setFilenamePrefixInput(event.target.value)}
                  maxLength={10}
                  placeholder="Example: myportrait"
                />
                <p className="hint">We auto-format to 3 random chars + underscore + 6 chars from your prefix (or random if blank).</p>

                <label className="label" htmlFor="file">
                  JPG or PNG file
                </label>
                <input
                  id="file"
                  className="input"
                  type="file"
                  accept=".jpg,.jpeg,.png,image/jpeg,image/png"
                  onChange={(event) =>
                    setSelectedFile(event.target.files?.[0] ?? null)
                  }
                />
              </div>
            </div>

            <p className="hint">
              Selected: {selectedFile ? `${selectedFile.name} (${selectedFile.type})` : "none"}
            </p>

            <button
              className="button"
              type="submit"
              disabled={isWorking || !session || !isConfigured}
            >
              {isWorking ? "Uploading..." : "Upload image"}
            </button>

            {lastFilenamePrefix ? (
              <div className="stack">
                <p className="hint">
                  Filename prefix for DM/server: <code className="mono">{lastFilenamePrefix}</code>
                </p>
                <button
                  className="button secondary"
                  type="button"
                  onClick={copyLastPrefix}
                  disabled={isWorking}
                >
                  Copy filename prefix
                </button>
              </div>
            ) : null}
          </form>
        </section>

        <section className="panel">
          <h2 className="title">Download All</h2>
          <p className="lead">
            Generates one ZIP containing all stored images across all users.
          </p>

          <button
            className="button"
            type="button"
            disabled={isWorking || !isConfigured}
            onClick={handleDownloadAll}
          >
            Download all images (ZIP)
          </button>
        </section>

        {session ? (
          <section className="panel">
            <h2 className="title">Your Uploads</h2>
            <p className="lead">Review and remove images uploaded by your account.</p>

            {isLoadingMyImages ? (
              <p className="hint">Loading your images...</p>
            ) : myImages.length === 0 ? (
              <p className="hint">No images uploaded yet.</p>
            ) : (
              <div className="stack">
                {myImages.map((image) => (
                  <div key={image.id} className="row" style={{ justifyContent: "space-between", alignItems: "center", gap: "0.75rem" }}>
                    <div className="stack" style={{ gap: "0.15rem" }}>
                      <p className="hint"><code className="mono">{image.filename_prefix}</code> - {image.status}</p>
                      <p className="hint">Uploaded {new Date(image.created_at).toLocaleString()}</p>
                    </div>
                    <button
                      className="button secondary"
                      type="button"
                      disabled={isWorking}
                      onClick={() => handleDeleteImage(image)}
                    >
                      Delete
                    </button>
                  </div>
                ))}
              </div>
            )}
          </section>
        ) : null}
      </div>
    </main>
  );
}
