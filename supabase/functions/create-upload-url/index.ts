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
  filenamePrefix?: string;
};

const allowedSourceMimes = new Set(["image/jpeg", "image/jpg"]);

const MAX_PREFIX_LENGTH = 15;

function normalizePrefix(value: string): string {
  const lower = value.toLowerCase();
  const stripped = lower.replace(/[^a-z0-9_]/g, "_");
  const collapsed = stripped.replace(/_+/g, "_").replace(/^_+|_+$/g, "");
  return collapsed.slice(0, MAX_PREFIX_LENGTH);
}

function makeGeneratedPrefix(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 12);
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

  let body: UploadRequest;
  try {
    body = await req.json();
  } catch {
    return errorResponse("Invalid JSON", 400);
  }

  const { filename, sourceMime } = body;
  if (!filename || !sourceMime) {
    return errorResponse("Missing required fields", 400);
  }

  if (!allowedSourceMimes.has(sourceMime.toLowerCase())) {
    return errorResponse("Only JPG/JPEG uploads are supported", 400);
  }

  const normalized = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
  const objectPath = `${userData.user.id}/${crypto.randomUUID()}_${normalized}`;

  const rawRequestedPrefix = typeof body.filenamePrefix === "string"
    ? body.filenamePrefix
    : "";
  const userRequestedPrefix = rawRequestedPrefix.trim();
  const normalizedRequestedPrefix = userRequestedPrefix.length > 0
    ? normalizePrefix(userRequestedPrefix)
    : null;

  if (userRequestedPrefix.length > 0 && !normalizedRequestedPrefix) {
    return errorResponse(
      "Filename prefix must include letters, numbers, or underscores (max 15 chars)",
      400,
    );
  }

  let imageRow: { id: string; original_path: string; status: string; filename_prefix: string } | null = null;
  let insertError: { message?: string; code?: string } | null = null;
  const maxInsertAttempts = 5;

  for (let attempt = 0; attempt < maxInsertAttempts; attempt += 1) {
    const candidatePrefix = normalizedRequestedPrefix ?? makeGeneratedPrefix();

    const { data: insertedRow, error: imageError } = await supabase
      .from("images")
      .insert({
        user_id: userData.user.id,
        original_path: objectPath,
        source_mime: sourceMime,
        target_format: "tga",
        filename_prefix: candidatePrefix,
        status: "uploaded",
      })
      .select("id, original_path, status, filename_prefix")
      .single();

    if (!imageError && insertedRow) {
      imageRow = insertedRow;
      break;
    }

    insertError = imageError;
    const isPrefixConflict = imageError?.code === "23505";
    if (!isPrefixConflict) {
      break;
    }

    if (normalizedRequestedPrefix) {
      return errorResponse("That filename prefix is already in use", 409);
    }
  }

  if (!imageRow) {
    return errorResponse(
      `Failed to insert image row: ${insertError?.message ?? "unknown"}`,
      500,
    );
  }

  return new Response(
    JSON.stringify({
      imageId: imageRow.id,
      filenamePrefix: imageRow.filename_prefix,
      objectPath,
    }),
    {
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
      },
    },
  );
});
