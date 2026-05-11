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
  original_path: string;
  converted_path: string | null;
  created_at: string;
};

const MAX_FILES_PER_EXPORT = 1000;
const MAX_TOTAL_INPUT_BYTES = 200 * 1024 * 1024;
const RATE_LIMIT_WINDOW_MINUTES = 15;
const RATE_LIMIT_MAX_REQUESTS = 3;

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

  const { data: rows, error: rowsError } = await adminClient
    .from("images")
    .select("id, user_id, original_path, converted_path, created_at")
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

  const zip = new JSZip();
  let includedCount = 0;
  let skippedCount = 0;
  let totalInputBytes = 0;

  for (const row of imageRows) {
    const useConverted = typeof row.converted_path === "string" && row.converted_path.length > 0;
    const path = useConverted ? (row.converted_path as string) : row.original_path;
    const bucket = useConverted ? "portraits-converted" : "portraits-original";

    const { data: blob, error: downloadError } = await adminClient.storage
      .from(bucket)
      .download(path);

    if (downloadError || !blob) {
      skippedCount += 1;
      continue;
    }

    if (totalInputBytes + blob.size > MAX_TOTAL_INPUT_BYTES) {
      skippedCount += 1;
      continue;
    }

    const bytes = await blob.arrayBuffer();
    const fallbackName = `${row.id}${useConverted ? "" : "_original"}`;
    const fileName = path.split("/").pop() ?? fallbackName;
    zip.file(`${row.user_id}/${fileName}`, bytes);
    totalInputBytes += blob.size;
    includedCount += 1;
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
    .createSignedUrl(exportPath, 60 * 10);

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
