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

type UploadRequest = {
  filename: string;
  sourceMime: string;
  targetFormat: "png" | "jpg" | "webp";
};

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

  let body: UploadRequest;
  try {
    body = await req.json();
  } catch {
    return errorResponse("Invalid JSON", 400);
  }

  const { filename, sourceMime, targetFormat } = body;
  if (!filename || !sourceMime || !targetFormat) {
    return errorResponse("Missing required fields", 400);
  }

  const normalized = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
  const objectPath = `${userData.user.id}/${crypto.randomUUID()}_${normalized}`;

  const { data: signedData, error: signedError } = await supabase.storage
    .from("portraits-original")
    .createSignedUploadUrl(objectPath);

  if (signedError || !signedData) {
    return errorResponse(
      `Failed to create upload URL: ${signedError?.message ?? "unknown"}`,
      500,
    );
  }

  const { data: imageRow, error: imageError } = await supabase
    .from("images")
    .insert({
      user_id: userData.user.id,
      original_path: objectPath,
      source_mime: sourceMime,
      target_format: targetFormat,
      status: "uploaded",
    })
    .select("id, original_path, status")
    .single();

  if (imageError || !imageRow) {
    return errorResponse(
      `Failed to insert image row: ${imageError?.message ?? "unknown"}`,
      500,
    );
  }

  return new Response(
    JSON.stringify({
      imageId: imageRow.id,
      objectPath,
      token: signedData.token,
      uploadUrl: `${supabaseUrl}/storage/v1/object/upload/sign/portraits-original/${objectPath}?token=${signedData.token}`,
    }),
    {
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
      },
    },
  );
});
