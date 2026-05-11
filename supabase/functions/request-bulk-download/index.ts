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

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return errorResponse("Method not allowed", 405);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY");

  if (!supabaseUrl || !supabaseAnonKey) {
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

  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData.user) {
    return errorResponse("Unauthorized", 401);
  }

  const { data: rows, error: rowsError } = await supabase
    .from("images")
    .select("id, converted_path, target_format, created_at")
    .eq("user_id", userData.user.id)
    .eq("status", "ready")
    .not("converted_path", "is", null)
    .order("created_at", { ascending: false })
    .limit(500);

  if (rowsError) {
    return errorResponse(`Failed to fetch image rows: ${rowsError.message}`, 500);
  }

  const paths = (rows ?? [])
    .map((row) => row.converted_path)
    .filter((p): p is string => typeof p === "string" && p.length > 0);

  if (paths.length === 0) {
    return new Response(JSON.stringify({ files: [] }), {
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
      },
    });
  }

  const { data: signedUrls, error: signedError } = await supabase.storage
    .from("portraits-converted")
    .createSignedUrls(paths, 60 * 10);

  if (signedError) {
    return errorResponse(`Failed to create signed URLs: ${signedError.message}`, 500);
  }

  const files = (rows ?? []).map((row, idx) => ({
    id: row.id,
    convertedPath: row.converted_path,
    targetFormat: row.target_format,
    createdAt: row.created_at,
    signedUrl: signedUrls?.[idx]?.signedUrl ?? null,
  }));

  return new Response(JSON.stringify({ files }), {
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  });
});
