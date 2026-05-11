import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type DeleteRequest = {
  imageId: string;
};

type ImageRow = {
  id: string;
  user_id: string;
  converted_path: string | null;
  original_path: string;
};

const tgaSuffixes = ["H", "L", "M", "S", "T"] as const;

function errorResponse(message: string, status: number): Response {
  return new Response(message, {
    status,
    headers: corsHeaders,
  });
}

function isNotFoundStorageError(message: string | undefined): boolean {
  return (message ?? "").toLowerCase().includes("not found");
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

  let body: DeleteRequest;
  try {
    body = await req.json();
  } catch {
    return errorResponse("Invalid JSON", 400);
  }

  if (!body.imageId) {
    return errorResponse("Missing imageId", 400);
  }

  const { data: row, error: rowError } = await userClient
    .from("images")
    .select("id, user_id, converted_path, original_path")
    .eq("id", body.imageId)
    .single();

  if (rowError || !row) {
    return errorResponse(`Image not found: ${rowError?.message ?? "unknown"}`, 404);
  }

  const imageRow = row as ImageRow;
  if (imageRow.user_id !== userData.user.id) {
    return errorResponse("Forbidden", 403);
  }

  if (imageRow.converted_path) {
    const { count, error: refError } = await adminClient
      .from("images")
      .select("id", { count: "exact", head: true })
      .eq("converted_path", imageRow.converted_path)
      .neq("id", imageRow.id);

    if (refError) {
      return errorResponse(`Failed reference check: ${refError.message}`, 500);
    }

    if ((count ?? 0) === 0) {
      const filesToDelete = tgaSuffixes.map((suffix) => `${imageRow.converted_path}_${suffix}.tga`);
      const { error: removeConvertedError } = await adminClient.storage
        .from("portraits-converted")
        .remove(filesToDelete);

      if (removeConvertedError && !isNotFoundStorageError(removeConvertedError.message)) {
        return errorResponse(`Failed converted cleanup: ${removeConvertedError.message}`, 500);
      }
    }
  }

  if (imageRow.original_path) {
    const { error: removeOriginalError } = await adminClient.storage
      .from("portraits-original")
      .remove([imageRow.original_path]);

    if (removeOriginalError && !isNotFoundStorageError(removeOriginalError.message)) {
      return errorResponse(`Failed original cleanup: ${removeOriginalError.message}`, 500);
    }
  }

  const { error: deleteRowError } = await userClient
    .from("images")
    .delete()
    .eq("id", imageRow.id);

  if (deleteRowError) {
    return errorResponse(`Failed to delete image row: ${deleteRowError.message}`, 500);
  }

  return new Response(
    JSON.stringify({
      imageId: imageRow.id,
      deleted: true,
    }),
    {
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
      },
    },
  );
});
