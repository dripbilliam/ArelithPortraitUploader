"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { getSupabaseClient } from "@/lib/supabase";
import { convertImageToTgaVariants } from "@/lib/tga";

type UploadResponse = {
  imageId: string;
  filenamePrefix: string;
  objectPath: string;
  token: string;
  uploadUrl: string;
};

type FinalizeResponse = {
  imageId: string;
  status: "ready";
  convertedPathBase: string;
};

type BulkDownloadResponse = {
  zipPath: string;
  signedUrl: string;
  fileCount: number;
  skippedCount: number;
};

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
  const [statusMessage, setStatusMessage] = useState("");
  const [isError, setIsError] = useState(false);
  const [isWorking, setIsWorking] = useState(false);

  const loggedInEmail = useMemo(() => session?.user?.email ?? "", [session]);

  const loadSessionState = useCallback(async (currentUserId: string | null) => {
    if (!currentUserId) {
      setSelectedFile(null);
      setFilenamePrefixInput("");
      setLastFilenamePrefix("");
    }
  }, []);

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
    if (fileType !== "image/jpeg" && fileType !== "image/jpg") {
      setIsError(true);
      setStatusMessage("Only JPG/JPEG files are allowed.");
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
            filenamePrefix: filenamePrefixInput,
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

      setStatusMessage(`Upload complete. Building TGA variants in browser...`);

      const variants = await convertImageToTgaVariants(selectedFile);
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
      setStatusMessage(`JPG converted to 5 TGAs and saved for ${data.imageId}.`);
      setSelectedFile(null);
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

      if (!data.signedUrl) {
        setStatusMessage("No downloadable ZIP was generated.");
        return;
      }

      const link = document.createElement("a");
      link.href = data.signedUrl;
      link.download = "all-images.zip";
      link.rel = "noopener noreferrer";
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);

      setStatusMessage(
        `ZIP ready (${data.fileCount} files, ${data.skippedCount} skipped). Download started.`,
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
          <p className="lead">Limit: 25 MiB. Accepted: JPG/JPEG only. Conversion to 5 TGAs happens in your browser.</p>

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
                  maxLength={15}
                  placeholder="Example: myportrait"
                />
                <p className="hint">Allowed: letters, numbers, underscores. Max 15 chars for NWN compatibility.</p>

                <label className="label" htmlFor="file">
                  JPG file
                </label>
                <input
                  id="file"
                  className="input"
                  type="file"
                  accept=".jpg,.jpeg,image/jpeg"
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
            disabled={isWorking || !session || !isConfigured}
            onClick={handleDownloadAll}
          >
            Download all images (ZIP)
          </button>
        </section>
      </div>
    </main>
  );
}
