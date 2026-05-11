import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
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

  const existingJobQuery = await adminClient
    .from("bulk_export_jobs")
    .select("id, status, access_token, created_at")
    .eq("requester_key", identity.requesterKey)
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
      accessToken: existingJob.access_token,
      reused: true,
    });
  }

  const { data: createdJob, error: createJobError } = await adminClient
    .from("bulk_export_jobs")
    .insert({
      user_id: identity.userId,
      requester_key: identity.requesterKey,
      requester_ip: identity.requesterIp,
      status: "queued",
    })
    .select("id, status, access_token")
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
          "x-forwarded-for": identity.requesterIp,
        },
        body: JSON.stringify({
          jobId: createdJob.id,
          accessToken: createdJob.access_token,
        }),
      });
    } catch {
      // Job remains queued if trigger fails.
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
    accessToken: createdJob.access_token,
    reused: false,
  });
});
