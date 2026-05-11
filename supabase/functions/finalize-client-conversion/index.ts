import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type FinalizeRequest = {
  imageId: string;
  convertedPathBase: string;
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

  let body: FinalizeRequest;
  try {
    body = await req.json();
  } catch {
    return errorResponse("Invalid JSON", 400);
  }

  if (!body.imageId || !body.convertedPathBase) {
    return errorResponse("Missing required fields", 400);
  }

  const expectedPrefix = `${userData.user.id}/`;
  if (!body.convertedPathBase.startsWith(expectedPrefix)) {
    return errorResponse("Invalid converted path base", 400);
  }

  const { data: row, error: rowError } = await supabase
    .from("images")
    .select("id, user_id, status")
    .eq("id", body.imageId)
    .single();

  if (rowError || !row) {
    return errorResponse(`Image row not found: ${rowError?.message ?? "unknown"}`, 404);
  }

  if (row.user_id !== userData.user.id) {
    return errorResponse("Forbidden", 403);
  }

  const { error: updateError } = await supabase
    .from("images")
    .update({
      status: "ready",
      converted_path: body.convertedPathBase,
      target_format: "tga",
      error_message: null,
    })
    .eq("id", body.imageId);

  if (updateError) {
    return errorResponse(`Failed to finalize row: ${updateError.message}`, 500);
  }

  return new Response(
    JSON.stringify({
      imageId: body.imageId,
      status: "ready",
      convertedPathBase: body.convertedPathBase,
    }),
    {
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
      },
    },
  );
});
