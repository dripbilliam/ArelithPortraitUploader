"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { getSupabaseClient } from "@/lib/supabase";

type TargetFormat = "png" | "jpg" | "webp";

type ImageRow = {
  id: string;
  status: string;
  target_format: TargetFormat;
  original_path: string;
  converted_path: string | null;
  error_message: string | null;
  created_at: string;
};

type UploadResponse = {
  imageId: string;
  objectPath: string;
  token: string;
  uploadUrl: string;
};

type ProcessResponse = {
  imageId: string;
  status: "ready";
  convertedPath: string;
  targetFormat: TargetFormat;
};

type BulkFile = {
  id: string;
  convertedPath: string;
  targetFormat: string;
  createdAt: string;
  signedUrl: string | null;
};

type BulkDownloadResponse = {
  files: BulkFile[];
};

export default function Home() {
  const supabase = useMemo(() => getSupabaseClient(), []);
  const isConfigured = Boolean(supabase);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [isSignUp, setIsSignUp] = useState(false);
  const [session, setSession] = useState<Session | null>(null);

  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [targetFormat, setTargetFormat] = useState<TargetFormat>("png");
  const [statusMessage, setStatusMessage] = useState("");
  const [isError, setIsError] = useState(false);
  const [isWorking, setIsWorking] = useState(false);
  const [images, setImages] = useState<ImageRow[]>([]);

  const loggedInEmail = useMemo(() => session?.user?.email ?? "", [session]);

  const loadImagesForUser = useCallback(async (userId: string | null) => {
    if (!supabase) {
      return;
    }

    if (!userId) {
      setImages([]);
      return;
    }

    const { data, error } = await supabase
      .from("images")
      .select("id, status, target_format, original_path, converted_path, error_message, created_at")
      .order("created_at", { ascending: false })
      .limit(12);

    if (error) {
      setIsError(true);
      setStatusMessage(
        `Could not load image history: ${error.message}. Check Data API table exposure if needed.`,
      );
      return;
    }

    setImages((data ?? []) as ImageRow[]);
  }, [supabase]);

  useEffect(() => {
    if (!supabase) {
      return;
    }

    const loadSession = async () => {
      const { data } = await supabase.auth.getSession();
      const currentSession = data.session ?? null;
      setSession(currentSession);
      await loadImagesForUser(currentSession?.user?.id ?? null);
    };

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, currentSession) => {
      setSession(currentSession);
      void loadImagesForUser(currentSession?.user?.id ?? null);
    });

    void loadSession();

    return () => subscription.unsubscribe();
  }, [supabase, loadImagesForUser]);

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

    if (!selectedFile.type.startsWith("image/")) {
      setIsError(true);
      setStatusMessage("Only image files are allowed.");
      return;
    }

    if (selectedFile.size > 25 * 1024 * 1024) {
      setIsError(true);
      setStatusMessage("Max size is 25 MiB.");
      return;
    }

    setIsWorking(true);
    setIsError(false);
    setStatusMessage("Creating upload URL...");

    try {
      const { data, error } = await supabase.functions.invoke<UploadResponse>(
        "create-upload-url",
        {
          body: {
            filename: selectedFile.name,
            sourceMime: selectedFile.type || "application/octet-stream",
            targetFormat,
          },
        },
      );

      if (error || !data) {
        throw new Error(error?.message ?? "Failed to create upload URL");
      }

      setStatusMessage(`Uploading to storage for image ${data.imageId}...`);

      const uploadResponse = await fetch(data.uploadUrl, {
        method: "PUT",
        headers: {
          "Content-Type": selectedFile.type || "application/octet-stream",
        },
        body: selectedFile,
      });

      if (!uploadResponse.ok) {
        const uploadText = await uploadResponse.text();
        throw new Error(
          `Upload failed (${uploadResponse.status}): ${uploadText || "unknown error"}`,
        );
      }

      setStatusMessage(`Upload complete. Processing image ${data.imageId}...`);

      const { error: processError } = await supabase.functions.invoke<ProcessResponse>(
        "process-image",
        {
          body: {
            imageId: data.imageId,
          },
        },
      );

      if (processError) {
        throw new Error(`Upload succeeded, processing failed: ${processError.message}`);
      }

      setStatusMessage(`Upload and conversion complete for ${data.imageId}.`);
      setSelectedFile(null);
      await loadImagesForUser(session.user.id);
    } catch (error) {
      setIsError(true);
      setStatusMessage(
        error instanceof Error ? error.message : "Upload request failed",
      );
    } finally {
      setIsWorking(false);
    }
  };

  const handleProcessPending = async (imageId: string) => {
    if (!supabase || !session) {
      return;
    }

    setIsWorking(true);
    setIsError(false);
    setStatusMessage(`Processing image ${imageId}...`);

    try {
      const { error } = await supabase.functions.invoke<ProcessResponse>(
        "process-image",
        {
          body: {
            imageId,
          },
        },
      );

      if (error) {
        throw new Error(error.message);
      }

      setStatusMessage(`Image ${imageId} processed and ready.`);
      await loadImagesForUser(session.user.id);
    } catch (error) {
      setIsError(true);
      setStatusMessage(
        error instanceof Error ? error.message : "Failed to process image",
      );
    } finally {
      setIsWorking(false);
    }
  };

  const handleDownloadAll = async () => {
    if (!supabase || !session) {
      setIsError(true);
      setStatusMessage("Sign in before downloading.");
      return;
    }

    setIsWorking(true);
    setIsError(false);
    setStatusMessage("Gathering download links...");

    try {
      const { data, error } = await supabase.functions.invoke<BulkDownloadResponse>(
        "request-bulk-download",
      );

      if (error || !data) {
        throw new Error(error?.message ?? "Failed to get download links");
      }

      const validFiles = data.files.filter((file) => file.signedUrl);

      if (validFiles.length === 0) {
        setStatusMessage("No ready files available to download.");
        return;
      }

      validFiles.forEach((file, index) => {
        const link = document.createElement("a");
        link.href = file.signedUrl as string;
        link.download = file.convertedPath.split("/").pop() ?? `converted-${index}`;
        link.rel = "noopener noreferrer";
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
      });

      setStatusMessage(`Started ${validFiles.length} download(s).`);
    } catch (error) {
      setIsError(true);
      setStatusMessage(
        error instanceof Error ? error.message : "Download request failed",
      );
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
          <p className="lead">Limit: 25 MiB. Accepted: image files. Upload auto-processes now.</p>

          <form className="stack" onSubmit={handleUpload}>
            <div className="row">
              <div className="stack">
                <label className="label" htmlFor="file">
                  Image file
                </label>
                <input
                  id="file"
                  className="input"
                  type="file"
                  accept="image/*"
                  onChange={(event) =>
                    setSelectedFile(event.target.files?.[0] ?? null)
                  }
                />
              </div>

              <div className="stack">
                <label className="label" htmlFor="target-format">
                  Target format
                </label>
                <select
                  id="target-format"
                  className="select"
                  value={targetFormat}
                  onChange={(event) =>
                    setTargetFormat(event.target.value as TargetFormat)
                  }
                >
                  <option value="png">png</option>
                  <option value="jpg">jpg</option>
                  <option value="webp">webp</option>
                </select>
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
          </form>
        </section>

        <section className="panel">
          <h2 className="title">Recent Uploads</h2>
          <p className="lead">
            Ready files can be fetched and downloaded in one click.
          </p>

          <button
            className="button"
            type="button"
            disabled={isWorking || !session || !isConfigured}
            onClick={handleDownloadAll}
          >
            Download all ready files
          </button>

          <div className="list">
            {images.length === 0 ? (
              <p className="hint">No uploads yet.</p>
            ) : (
              images.map((image) => (
                <article key={image.id} className="listItem">
                  <p className="mono">id: {image.id}</p>
                  <p>
                    status: <strong>{image.status}</strong> | target: {image.target_format}
                  </p>
                  <p className="mono">path: {image.original_path}</p>
                  {image.converted_path ? (
                    <p className="mono">converted: {image.converted_path}</p>
                  ) : null}
                  {image.error_message ? (
                    <p className="status error">error: {image.error_message}</p>
                  ) : null}
                  {image.status !== "ready" ? (
                    <button
                      className="button secondary"
                      type="button"
                      disabled={isWorking || !session || !isConfigured}
                      onClick={() => void handleProcessPending(image.id)}
                    >
                      Process now
                    </button>
                  ) : null}
                  <p className="hint">
                    created: {new Date(image.created_at).toLocaleString()}
                  </p>
                </article>
              ))
            )}
          </div>
        </section>
      </div>
    </main>
  );
}
