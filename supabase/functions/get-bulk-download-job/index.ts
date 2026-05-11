import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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

type StatusRequest = {
  jobId: string;
};

const EXPORT_SIGNED_URL_TTL_SECONDS = 60 * 10;

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

  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData.user) {
    return errorResponse("Unauthorized", 401);
  }

  let body: StatusRequest;
  try {
    body = await req.json();
  } catch {
    return errorResponse("Invalid JSON", 400);
  }

  if (!body.jobId) {
    return errorResponse("Missing required fields", 400);
  }

  const { data: job, error: jobError } = await adminClient
    .from("bulk_export_jobs")
    .select("id, user_id, status, file_count, skipped_count, zip_path, error_message, created_at, updated_at, started_at, finished_at")
    .eq("id", body.jobId)
    .eq("user_id", userData.user.id)
    .single();

  if (jobError || !job) {
    return errorResponse("Job not found", 404);
  }

  let signedUrl: string | null = null;
  if (job.status === "ready" && typeof job.zip_path === "string" && job.zip_path.length > 0) {
    const { data: signedData, error: signedError } = await adminClient.storage
      .from("bulk-exports")
      .createSignedUrl(job.zip_path, EXPORT_SIGNED_URL_TTL_SECONDS);

    if (!signedError && signedData?.signedUrl) {
      signedUrl = signedData.signedUrl;
    }
  }

  return jsonResponse({
    jobId: job.id,
    status: job.status,
    fileCount: job.file_count,
    skippedCount: job.skipped_count,
    zipPath: job.zip_path,
    signedUrl,
    error: job.error_message,
    createdAt: job.created_at,
    updatedAt: job.updated_at,
    startedAt: job.started_at,
    finishedAt: job.finished_at,
  });
});
