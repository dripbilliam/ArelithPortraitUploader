import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import JSZip from "https://esm.sh/jszip@3.10.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function errorResponse(message: string, status: number): Response {
  return new Response(message, {
    status,
    headers: corsHeaders,
  });
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  });
}

type ImageRow = {
  id: string;
  user_id: string;
  converted_path: string | null;
  filename_prefix: string | null;
  target_format: string;
  created_at: string;
};

type ZipCandidate = {
  fileName: string;
  storagePath: string;
};

const tgaSuffixes = ["H", "L", "M", "S", "T"];

const MAX_FILES_PER_EXPORT = 1000;
const MAX_TOTAL_INPUT_BYTES = 200 * 1024 * 1024;
const RATE_LIMIT_WINDOW_MINUTES = 15;
const RATE_LIMIT_MAX_REQUESTS = 3;
const EXPORT_SIGNED_URL_TTL_SECONDS = 60 * 10;
const EXPORT_RETENTION_BUFFER_SECONDS = 60 * 5;
const DOWNLOAD_BATCH_CONCURRENCY = 12;

function toSafePrefix(raw: string): string {
  const normalized = raw.toLowerCase().replace(/[^a-z0-9_]/g, "_");
  const compact = normalized.replace(/_+/g, "_").replace(/^_+|_+$/g, "");
  const trimmed = compact.slice(0, 15);
  return trimmed || "portrait";
}

function parseExportTimestampMs(pathName: string): number | null {
  const match = pathName.match(/all-users-(\d+)\.zip$/);
  if (!match) {
    return null;
  }

  const ts = Number(match[1]);
  return Number.isFinite(ts) ? ts : null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return errorResponse("Method not allowed", 405);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!supabaseUrl || !supabaseAnonKey || !serviceRoleKey) {
    return errorResponse("Missing Supabase env", 500);
  }

  const authHeader = req.headers.get("Authorization") ?? "";
  const requesterIp = (req.headers.get("x-forwarded-for") ?? "")
    .split(",")[0]
    .trim() || "unknown";

  const supabase = createClient(supabaseUrl, supabaseAnonKey, {
    global: {
      headers: {
        Authorization: authHeader,
      },
    },
  });
  const adminClient = createClient(supabaseUrl, serviceRoleKey);

  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData.user) {
    return errorResponse("Unauthorized", 401);
  }

  const userId = userData.user.id;
  const windowStartIso = new Date(
    Date.now() - RATE_LIMIT_WINDOW_MINUTES * 60 * 1000,
  ).toISOString();

  const { count: userWindowCount, error: rateError } = await adminClient
    .from("bulk_download_audit")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .gte("created_at", windowStartIso);

  if (rateError) {
    return errorResponse(`Rate limit check failed: ${rateError.message}`, 500);
  }

  if ((userWindowCount ?? 0) >= RATE_LIMIT_MAX_REQUESTS) {
    await adminClient.from("bulk_download_audit").insert({
      user_id: userId,
      requester_ip: requesterIp,
      status: "rate_limited",
      error_message: "Too many export requests in time window",
    });

    return jsonResponse(
      {
        error: "rate_limited",
        message: `Too many requests. Try again in about ${RATE_LIMIT_WINDOW_MINUTES} minutes.`,
      },
      429,
    );
  }

  const now = Date.now();
  const maxZipAgeMs = (EXPORT_SIGNED_URL_TTL_SECONDS + EXPORT_RETENTION_BUFFER_SECONDS) * 1000;
  const { data: existingExports, error: listExportsError } = await adminClient.storage
    .from("bulk-exports")
    .list("exports", { limit: 1000, offset: 0, sortBy: { column: "name", order: "asc" } });

  if (listExportsError) {
    return errorResponse(`Failed to list prior ZIP exports: ${listExportsError.message}`, 500);
  }

  const pathsToDelete = (existingExports ?? [])
    .map((entry) => {
      const ts = parseExportTimestampMs(entry.name ?? "");
      if (ts === null) {
        return null;
      }

      const age = now - ts;
      if (age <= maxZipAgeMs) {
        return null;
      }

      return `exports/${entry.name}`;
    })
    .filter((path): path is string => typeof path === "string");

  if (pathsToDelete.length > 0) {
    const { error: cleanupError } = await adminClient.storage
      .from("bulk-exports")
      .remove(pathsToDelete);

    if (cleanupError) {
      return errorResponse(`Failed to clean up prior ZIP exports: ${cleanupError.message}`, 500);
    }
  }

  const { data: rows, error: rowsError } = await adminClient
    .from("images")
    .select("id, user_id, converted_path, filename_prefix, target_format, created_at")
    .order("created_at", { ascending: false })
    .limit(MAX_FILES_PER_EXPORT);

  if (rowsError) {
    return errorResponse(`Failed to fetch image rows: ${rowsError.message}`, 500);
  }

  const imageRows = (rows ?? []) as ImageRow[];
  if (imageRows.length === 0) {
    return jsonResponse({
      signedUrl: null,
      fileCount: 0,
      skippedCount: 0,
    });
  }

  const candidates: ZipCandidate[] = [];
  let skippedCount = 0;

  for (const row of imageRows) {
    const basePrefix = (row.filename_prefix && row.filename_prefix.length > 0)
      ? toSafePrefix(row.filename_prefix)
      : toSafePrefix(row.id);

    const convertedBase =
      typeof row.converted_path === "string" && row.converted_path.length > 0
        ? row.converted_path
        : null;

    if (convertedBase && row.target_format === "tga") {
      for (const suffix of tgaSuffixes) {
        const tgaPath = `${convertedBase}_${suffix}.tga`;
        const fileName = `${basePrefix}${suffix}.tga`;
        candidates.push({
          fileName,
          storagePath: tgaPath,
        });
      }
      continue;
    }

    skippedCount += 1;
  }

  const zip = new JSZip();
  let includedCount = 0;
  let totalInputBytes = 0;

  for (let i = 0; i < candidates.length; i += DOWNLOAD_BATCH_CONCURRENCY) {
    if (totalInputBytes >= MAX_TOTAL_INPUT_BYTES) {
      skippedCount += candidates.length - i;
      break;
    }

    const chunk = candidates.slice(i, i + DOWNLOAD_BATCH_CONCURRENCY);
    const results = await Promise.all(
      chunk.map(async (candidate) => {
        const { data: blob, error } = await adminClient.storage
          .from("portraits-converted")
          .download(candidate.storagePath);
        return {
          candidate,
          blob,
          error,
        };
      }),
    );

    for (const result of results) {
      if (result.error || !result.blob) {
        skippedCount += 1;
        continue;
      }

      if (totalInputBytes + result.blob.size > MAX_TOTAL_INPUT_BYTES) {
        skippedCount += 1;
        continue;
      }

      const bytes = await result.blob.arrayBuffer();
      zip.file(result.candidate.fileName, bytes);
      totalInputBytes += result.blob.size;
      includedCount += 1;
    }
  }

  if (includedCount === 0) {
    await adminClient.from("bulk_download_audit").insert({
      user_id: userId,
      requester_ip: requesterIp,
      status: "failed",
      file_count: 0,
      skipped_count: skippedCount,
      error_message: "No downloadable files after filtering",
    });

    return errorResponse("No downloadable files found.", 404);
  }

  const archiveBytes = await zip.generateAsync({
    type: "uint8array",
    compression: "DEFLATE",
    compressionOptions: {
      level: 6,
    },
  });

  const exportPath = `exports/all-users-${Date.now()}.zip`;
  const { error: uploadError } = await adminClient.storage
    .from("bulk-exports")
    .upload(exportPath, archiveBytes, {
      upsert: true,
      contentType: "application/zip",
    });

  if (uploadError) {
    await adminClient.from("bulk_download_audit").insert({
      user_id: userId,
      requester_ip: requesterIp,
      status: "failed",
      file_count: includedCount,
      skipped_count: skippedCount,
      zip_path: exportPath,
      error_message: uploadError.message,
    });

    return errorResponse(`Failed to upload ZIP: ${uploadError.message}`, 500);
  }

  const { data: signedData, error: signedError } = await adminClient.storage
    .from("bulk-exports")
    .createSignedUrl(exportPath, EXPORT_SIGNED_URL_TTL_SECONDS);

  if (signedError || !signedData?.signedUrl) {
    await adminClient.from("bulk_download_audit").insert({
      user_id: userId,
      requester_ip: requesterIp,
      status: "failed",
      file_count: includedCount,
      skipped_count: skippedCount,
      zip_path: exportPath,
      error_message: signedError?.message ?? "Failed to sign ZIP URL",
    });

    return errorResponse(
      `Failed to create signed ZIP URL: ${signedError?.message ?? "unknown"}`,
      500,
    );
  }

  await adminClient.from("bulk_download_audit").insert({
    user_id: userId,
    requester_ip: requesterIp,
    status: "ok",
    file_count: includedCount,
    skipped_count: skippedCount,
    zip_path: exportPath,
  });

  return jsonResponse({
    zipPath: exportPath,
    signedUrl: signedData.signedUrl,
    fileCount: includedCount,
    skippedCount,
    limits: {
      maxFilesPerExport: MAX_FILES_PER_EXPORT,
      maxInputBytes: MAX_TOTAL_INPUT_BYTES,
      windowMinutes: RATE_LIMIT_WINDOW_MINUTES,
      maxRequestsPerWindow: RATE_LIMIT_MAX_REQUESTS,
    },
  });
});
