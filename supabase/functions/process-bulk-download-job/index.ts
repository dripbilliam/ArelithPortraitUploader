import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import JSZip from "https://esm.sh/jszip@3.10.1";
import { checkApiBan, resolveIdentity } from "../_shared/moderation.ts";

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

type ProcessRequest = {
  jobId: string;
  accessToken: string;
};

const tgaSuffixes = ["H", "L", "M", "S", "T"];

const MAX_FILES_PER_EXPORT = 1000;
const MAX_TOTAL_INPUT_BYTES = 200 * 1024 * 1024;
const RATE_LIMIT_WINDOW_MINUTES = 15;
const RATE_LIMIT_MAX_REQUESTS = 3;
const EXPORT_RETENTION_BUFFER_SECONDS = 60 * 5;
const EXPORT_SIGNED_URL_TTL_SECONDS = 60 * 10;
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

  const supabase = createClient(supabaseUrl, supabaseAnonKey, {
    global: {
      headers: {
        Authorization: authHeader,
      },
    },
  });
  const adminClient = createClient(supabaseUrl, serviceRoleKey);

  const identity = await resolveIdentity(supabase, req);
  const banResult = await checkApiBan(adminClient, identity, "download");
  if (banResult.error) {
    return errorResponse(`Failed to evaluate download ban policy: ${banResult.error}`, 500);
  }
  if (banResult.blocked) {
    return errorResponse(`Access denied: ${banResult.reason ?? "download blocked"}`, 403);
  }

  let body: ProcessRequest;
  try {
    body = await req.json();
  } catch {
    return errorResponse("Invalid JSON", 400);
  }

  if (!body.jobId || !body.accessToken) {
    return errorResponse("Missing required fields", 400);
  }

  const windowStartIso = new Date(Date.now() - RATE_LIMIT_WINDOW_MINUTES * 60 * 1000).toISOString();

  const { count: requesterWindowCount, error: rateError } = await adminClient
    .from("bulk_download_audit")
    .select("id", { count: "exact", head: true })
    .eq("requester_key", identity.requesterKey)
    .gte("created_at", windowStartIso);

  if (rateError) {
    return errorResponse(`Rate limit check failed: ${rateError.message}`, 500);
  }

  if ((requesterWindowCount ?? 0) >= RATE_LIMIT_MAX_REQUESTS) {
    await adminClient.from("bulk_export_jobs").update({
      status: "failed",
      error_message: `Too many requests. Try again in about ${RATE_LIMIT_WINDOW_MINUTES} minutes.`,
      finished_at: new Date().toISOString(),
    }).eq("id", body.jobId).eq("requester_key", identity.requesterKey).eq("access_token", body.accessToken);

    await adminClient.from("bulk_download_audit").insert({
      user_id: identity.userId,
      requester_key: identity.requesterKey,
      requester_ip: identity.requesterIp,
      status: "rate_limited",
      error_message: "Too many export requests in time window",
    });

    return jsonResponse({
      jobId: body.jobId,
      status: "failed",
      message: "rate_limited",
    }, 429);
  }

  const now = Date.now();
  const maxZipAgeMs = (EXPORT_SIGNED_URL_TTL_SECONDS + EXPORT_RETENTION_BUFFER_SECONDS) * 1000;
  const { data: existingExports } = await adminClient.storage
    .from("bulk-exports")
    .list("exports", { limit: 1000, offset: 0, sortBy: { column: "name", order: "asc" } });

  const pathsToDelete = (existingExports ?? [])
    .map((entry) => {
      const ts = parseExportTimestampMs(entry.name ?? "");
      if (ts === null) {
        return null;
      }
      if (now - ts <= maxZipAgeMs) {
        return null;
      }
      return `exports/${entry.name}`;
    })
    .filter((path): path is string => typeof path === "string");

  if (pathsToDelete.length > 0) {
    await adminClient.storage.from("bulk-exports").remove(pathsToDelete);
  }

  const { data: claimedRows, error: claimError } = await adminClient
    .from("bulk_export_jobs")
    .update({
      status: "processing",
      error_message: null,
      started_at: new Date().toISOString(),
      finished_at: null,
      file_count: 0,
      skipped_count: 0,
      zip_path: null,
    })
    .eq("id", body.jobId)
    .eq("requester_key", identity.requesterKey)
    .eq("access_token", body.accessToken)
    .eq("status", "queued")
    .select("id")
    .limit(1);

  if (claimError) {
    return errorResponse(`Failed to claim job: ${claimError.message}`, 500);
  }

  if (!claimedRows || claimedRows.length === 0) {
    const { data: existingJob, error: jobReadError } = await adminClient
      .from("bulk_export_jobs")
      .select("id, status, file_count, skipped_count, zip_path, error_message")
      .eq("id", body.jobId)
      .eq("requester_key", identity.requesterKey)
      .eq("access_token", body.accessToken)
      .single();

    if (jobReadError || !existingJob) {
      return errorResponse("Job not found", 404);
    }

    return jsonResponse({
      jobId: existingJob.id,
      status: existingJob.status,
      fileCount: existingJob.file_count,
      skippedCount: existingJob.skipped_count,
      zipPath: existingJob.zip_path,
      error: existingJob.error_message,
      reused: true,
    });
  }

  const { data: rows, error: rowsError } = await adminClient
    .from("images")
    .select("id, user_id, converted_path, filename_prefix, target_format, created_at")
    .order("created_at", { ascending: false })
    .limit(MAX_FILES_PER_EXPORT);

  if (rowsError) {
    await adminClient.from("bulk_export_jobs").update({
      status: "failed",
      error_message: `Failed to fetch image rows: ${rowsError.message}`,
      finished_at: new Date().toISOString(),
    }).eq("id", body.jobId);

    return errorResponse(`Failed to fetch image rows: ${rowsError.message}`, 500);
  }

  const imageRows = (rows ?? []) as ImageRow[];
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
        candidates.push({
          fileName: `${basePrefix}${suffix}.tga`,
          storagePath: `${convertedBase}_${suffix}.tga`,
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
        return { candidate, blob, error };
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
    await adminClient.from("bulk_export_jobs").update({
      status: "failed",
      file_count: 0,
      skipped_count: skippedCount,
      error_message: "No downloadable files found.",
      finished_at: new Date().toISOString(),
    }).eq("id", body.jobId);

    await adminClient.from("bulk_download_audit").insert({
      user_id: identity.userId,
      requester_key: identity.requesterKey,
      requester_ip: identity.requesterIp,
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
    compressionOptions: { level: 6 },
  });

  const exportPath = `exports/all-users-${Date.now()}.zip`;
  const { error: uploadError } = await adminClient.storage
    .from("bulk-exports")
    .upload(exportPath, archiveBytes, {
      upsert: true,
      contentType: "application/zip",
    });

  if (uploadError) {
    await adminClient.from("bulk_export_jobs").update({
      status: "failed",
      file_count: includedCount,
      skipped_count: skippedCount,
      error_message: `Failed to upload ZIP: ${uploadError.message}`,
      finished_at: new Date().toISOString(),
    }).eq("id", body.jobId);

    await adminClient.from("bulk_download_audit").insert({
      user_id: identity.userId,
      requester_key: identity.requesterKey,
      requester_ip: identity.requesterIp,
      status: "failed",
      file_count: includedCount,
      skipped_count: skippedCount,
      zip_path: exportPath,
      error_message: uploadError.message,
    });

    return errorResponse(`Failed to upload ZIP: ${uploadError.message}`, 500);
  }

  await adminClient.from("bulk_export_jobs").update({
    status: "ready",
    file_count: includedCount,
    skipped_count: skippedCount,
    zip_path: exportPath,
    error_message: null,
    finished_at: new Date().toISOString(),
  }).eq("id", body.jobId);

  await adminClient.from("bulk_download_audit").insert({
    user_id: identity.userId,
    requester_key: identity.requesterKey,
    requester_ip: identity.requesterIp,
    status: "ok",
    file_count: includedCount,
    skipped_count: skippedCount,
    zip_path: exportPath,
  });

  return jsonResponse({
    jobId: body.jobId,
    status: "ready",
    zipPath: exportPath,
    fileCount: includedCount,
    skippedCount,
  });
});
