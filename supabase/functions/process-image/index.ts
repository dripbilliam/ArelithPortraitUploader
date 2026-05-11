import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { Image } from "https://deno.land/x/imagescript@1.3.0/mod.ts";

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

type ProcessRequest = {
  imageId: string;
};

type ImageRow = {
  id: string;
  user_id: string;
  original_path: string;
  target_format: "png" | "jpg" | "webp";
  status: "uploaded" | "processing" | "ready" | "failed";
};

const mimeByTarget: Record<ImageRow["target_format"], string> = {
  png: "image/png",
  jpg: "image/jpeg",
  webp: "image/webp",
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
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!supabaseUrl || !supabaseAnonKey || !serviceRoleKey) {
    return errorResponse("Missing Supabase env", 500);
  }

  const authHeader = req.headers.get("Authorization") ?? "";
  const userClient = createClient(supabaseUrl, supabaseAnonKey, {
    global: {
      headers: {
        Authorization: authHeader,
      },
    },
  });

  const adminClient = createClient(supabaseUrl, serviceRoleKey);

  const { data: userData, error: userError } = await userClient.auth.getUser();
  if (userError || !userData.user) {
    return errorResponse("Unauthorized", 401);
  }

  let body: ProcessRequest;
  try {
    body = await req.json();
  } catch {
    return errorResponse("Invalid JSON", 400);
  }

  if (!body.imageId) {
    return errorResponse("Missing imageId", 400);
  }

  const { data: imageRow, error: imageError } = await userClient
    .from("images")
    .select("id, user_id, original_path, target_format, status")
    .eq("id", body.imageId)
    .single();

  if (imageError || !imageRow) {
    return errorResponse(`Image not found: ${imageError?.message ?? "unknown"}`, 404);
  }

  const row = imageRow as ImageRow;

  if (row.user_id !== userData.user.id) {
    return errorResponse("Forbidden", 403);
  }

  if (row.status === "ready") {
    return new Response(
      JSON.stringify({
        imageId: row.id,
        status: "ready",
        convertedPath: `${row.user_id}/${row.id}.${row.target_format}`,
        skipped: true,
      }),
      {
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
        },
      },
    );
  }

  const { error: markProcessingError } = await userClient
    .from("images")
    .update({ status: "processing", error_message: null })
    .eq("id", row.id);

  if (markProcessingError) {
    return errorResponse(`Failed to mark processing: ${markProcessingError.message}`, 500);
  }

  try {
    const { data: originalBlob, error: downloadError } = await adminClient.storage
      .from("portraits-original")
      .download(row.original_path);

    if (downloadError || !originalBlob) {
      throw new Error(`Failed to download source image: ${downloadError?.message ?? "unknown"}`);
    }

    const sourceBytes = new Uint8Array(await originalBlob.arrayBuffer());
    const decoded = await Image.decode(sourceBytes);

    let bytes: Uint8Array;
    if (row.target_format === "png") {
      bytes = await decoded.encode();
    } else if (row.target_format === "jpg") {
      bytes = await decoded.encodeJPEG(90);
    } else {
      bytes = await decoded.encodeWEBP(90);
    }

    const convertedPath = `${row.user_id}/${row.id}.${row.target_format}`;

    const { error: uploadError } = await adminClient.storage
      .from("portraits-converted")
      .upload(convertedPath, bytes, {
        upsert: true,
        contentType: mimeByTarget[row.target_format],
      });

    if (uploadError) {
      throw new Error(`Failed to upload converted file: ${uploadError.message}`);
    }

    const { error: markReadyError } = await userClient
      .from("images")
      .update({
        status: "ready",
        converted_path: convertedPath,
        error_message: null,
      })
      .eq("id", row.id);

    if (markReadyError) {
      throw new Error(`Failed to mark ready: ${markReadyError.message}`);
    }

    return new Response(
      JSON.stringify({
        imageId: row.id,
        status: "ready",
        convertedPath,
        targetFormat: row.target_format,
      }),
      {
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
        },
      },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Conversion failed";

    await userClient
      .from("images")
      .update({
        status: "failed",
        error_message: message.slice(0, 1000),
      })
      .eq("id", row.id);

    return errorResponse(message, 500);
  }
});
