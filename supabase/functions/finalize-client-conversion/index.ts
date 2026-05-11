import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { checkApiBan, resolveIdentity } from "../_shared/moderation.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type FinalizeRequest = {
  imageId: string;
  convertedPathBase: string;
};

type ExistingImageRow = {
  id: string;
  converted_path: string | null;
};

const tgaSuffixes = ["H", "L", "M", "S", "T"] as const;

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((value) => value.toString(16).padStart(2, "0")).join("");
}

async function computeTgaSetSha256(
  supabase: ReturnType<typeof createClient>,
  convertedPathBase: string,
): Promise<{ hash: string; uploadedPaths: string[] } | { error: Response }> {
  const chunks: Uint8Array[] = [];
  const uploadedPaths: string[] = [];

  for (const suffix of tgaSuffixes) {
    const tgaPath = `${convertedPathBase}_${suffix}.tga`;
    const { data: blob, error } = await supabase.storage
      .from("portraits-converted")
      .download(tgaPath);

    if (error || !blob) {
      return {
        error: errorResponse(`Missing converted file: ${tgaPath}`, 400),
      };
    }

    const bytes = new Uint8Array(await blob.arrayBuffer());
    chunks.push(bytes);
    uploadedPaths.push(tgaPath);
  }

  const totalLength = chunks.reduce((sum, part) => sum + part.length, 0);
  const merged = new Uint8Array(totalLength);
  let offset = 0;

  for (const part of chunks) {
    merged.set(part, offset);
    offset += part.length;
  }

  const digest = await crypto.subtle.digest("SHA-256", merged);
  const hash = bytesToHex(new Uint8Array(digest));
  return { hash, uploadedPaths };
}

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
  const banResult = await checkApiBan(adminClient, identity, "upload");
  if (banResult.error) {
    return errorResponse(`Failed to evaluate upload ban policy: ${banResult.error}`, 500);
  }
  if (banResult.blocked) {
    return errorResponse(`Access denied: ${banResult.reason ?? "upload blocked"}`, 403);
  }

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
    .select("id, user_id, status, original_path")
    .eq("id", body.imageId)
    .single();

  if (rowError || !row) {
    return errorResponse(`Image row not found: ${rowError?.message ?? "unknown"}`, 404);
  }

  if (row.user_id !== userData.user.id) {
    return errorResponse("Forbidden", 403);
  }

  const hashResult = await computeTgaSetSha256(supabase, body.convertedPathBase);
  if ("error" in hashResult) {
    return hashResult.error;
  }

  const { hash, uploadedPaths } = hashResult;

  let finalConvertedPath = body.convertedPathBase;
  let deduped = false;

  const { data: duplicateRows, error: duplicateError } = await supabase
    .from("images")
    .select("id, converted_path")
    .eq("status", "ready")
    .eq("target_format", "tga")
    .eq("tga_set_sha256", hash)
    .neq("id", body.imageId)
    .order("created_at", { ascending: true })
    .limit(1);

  if (duplicateError) {
    return errorResponse(`Failed dedupe lookup: ${duplicateError.message}`, 500);
  }

  const duplicate = ((duplicateRows ?? [])[0] ?? null) as ExistingImageRow | null;
  if (duplicate?.converted_path) {
    finalConvertedPath = duplicate.converted_path;
    deduped = true;

    const { error: removeDuplicateFilesError } = await supabase.storage
      .from("portraits-converted")
      .remove(uploadedPaths);

    if (
      removeDuplicateFilesError &&
      !removeDuplicateFilesError.message.toLowerCase().includes("not found")
    ) {
      return errorResponse(`Failed cleanup of duplicate files: ${removeDuplicateFilesError.message}`, 500);
    }
  }

  const { error: removeOriginalError } = await supabase.storage
    .from("portraits-original")
    .remove([row.original_path]);

  if (removeOriginalError && !removeOriginalError.message.toLowerCase().includes("not found")) {
    return errorResponse(`Failed to delete original JPG: ${removeOriginalError.message}`, 500);
  }

  const { error: updateError } = await supabase
    .from("images")
    .update({
      status: "ready",
      converted_path: finalConvertedPath,
      target_format: "tga",
      tga_set_sha256: hash,
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
      convertedPathBase: finalConvertedPath,
      deduped,
    }),
    {
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
      },
    },
  );
});
