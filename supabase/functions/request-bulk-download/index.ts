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
  const apikeyHeader = req.headers.get("apikey") ?? supabaseAnonKey;
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

  const existingJobQuery = await adminClient
    .from("bulk_export_jobs")
    .select("id, status, created_at")
    .eq("user_id", userId)
    .in("status", ["queued", "processing"])
    .order("created_at", { ascending: false })
    .limit(1);

  if (existingJobQuery.error) {
    return errorResponse(`Failed to query existing jobs: ${existingJobQuery.error.message}`, 500);
  }

  const existingJob = (existingJobQuery.data ?? [])[0] ?? null;
  if (existingJob) {
    return jsonResponse({
      jobId: existingJob.id,
      status: existingJob.status,
      reused: true,
    });
  }

  const { data: createdJob, error: createJobError } = await supabase
    .from("bulk_export_jobs")
    .insert({
      user_id: userId,
      status: "queued",
    })
    .select("id, status")
    .single();

  if (createJobError || !createdJob) {
    return errorResponse(`Failed to create export job: ${createJobError?.message ?? "unknown"}`, 500);
  }

  const triggerProcess = async () => {
    try {
      await fetch(`${supabaseUrl}/functions/v1/process-bulk-download-job`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: apikeyHeader,
          Authorization: authHeader,
          "x-forwarded-for": requesterIp,
        },
        body: JSON.stringify({
          jobId: createdJob.id,
        }),
      });
    } catch {
      // The job stays queued; client polling can trigger retry paths later.
    }
  };

  const maybeEdgeRuntime = (globalThis as { EdgeRuntime?: { waitUntil: (promise: Promise<unknown>) => void } }).EdgeRuntime;
  if (maybeEdgeRuntime?.waitUntil) {
    maybeEdgeRuntime.waitUntil(triggerProcess());
  } else {
    void triggerProcess();
  }

  return jsonResponse({
    jobId: createdJob.id,
    status: createdJob.status,
    reused: false,
  });
});
