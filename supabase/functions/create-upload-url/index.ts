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

type UploadRequest = {
  filename: string;
  sourceMime: string;
  filenamePrefix?: string;
};

const allowedSourceMimes = new Set(["image/jpeg", "image/jpg"]);

const PREFIX_RANDOM_HEAD_LENGTH = 3;
const PREFIX_BODY_LENGTH = 6;
const MAX_PREFIX_LENGTH = PREFIX_RANDOM_HEAD_LENGTH + 1 + PREFIX_BODY_LENGTH;
const RANDOM_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789";
const DEFAULT_TOTAL_IMAGES_PER_IP_LIMIT = 50;
const TGA_VARIANTS_PER_UPLOAD = 5;
const STORAGE_LIST_PAGE_SIZE = 100;

type UploadLimitRow = {
  images_per_ip_limit: number;
};

async function getUploadLimits(
  adminClient: ReturnType<typeof createClient>,
): Promise<{ imagesPerIpLimit: number }> {
  const { data, error } = await adminClient
    .from("api_upload_limits")
    .select("images_per_ip_limit")
    .eq("id", "global")
    .maybeSingle();

  if (error || !data) {
    return {
      imagesPerIpLimit: DEFAULT_TOTAL_IMAGES_PER_IP_LIMIT,
    };
  }

  const row = data as UploadLimitRow;
  return {
    imagesPerIpLimit: Number.isFinite(row.images_per_ip_limit)
      ? Math.max(1, Math.floor(row.images_per_ip_limit))
      : DEFAULT_TOTAL_IMAGES_PER_IP_LIMIT,
  };
}

async function countCurrentUserStorageImages(
  adminClient: ReturnType<typeof createClient>,
  userId: string,
): Promise<{ count: number; error: string | null }> {
  let offset = 0;
  let total = 0;

  while (true) {
    const { data, error } = await adminClient.storage
      .from("portraits-converted")
      .list(userId, {
        limit: STORAGE_LIST_PAGE_SIZE,
        offset,
        sortBy: { column: "name", order: "asc" },
      });

    if (error) {
      return { count: 0, error: error.message };
    }

    const page = data ?? [];
    for (const entry of page) {
      if (typeof entry.name === "string" && /_[HLMST]\.tga$/i.test(entry.name)) {
        total += 1;
      }
    }

    if (page.length < STORAGE_LIST_PAGE_SIZE) {
      break;
    }

    offset += STORAGE_LIST_PAGE_SIZE;
    if (offset > 20000) {
      break;
    }
  }

  return { count: total, error: null };
}

function normalizePrefix(value: string): string {
  const lower = value.toLowerCase();
  const stripped = lower.replace(/[^a-z0-9_]/g, "_");
  const collapsed = stripped.replace(/_+/g, "_").replace(/^_+|_+$/g, "");
  return collapsed;
}

function randomSegment(length: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let out = "";
  for (let i = 0; i < length; i += 1) {
    out += RANDOM_CHARS[bytes[i] % RANDOM_CHARS.length];
  }
  return out;
}

function buildCandidatePrefix(userTail: string | null): string {
  const head = randomSegment(PREFIX_RANDOM_HEAD_LENGTH);
  const normalizedTail = (userTail ?? "").slice(0, PREFIX_BODY_LENGTH);
  const missing = PREFIX_BODY_LENGTH - normalizedTail.length;
  const suffix = missing > 0 ? randomSegment(missing) : "";
  const body = `${normalizedTail}${suffix}`;
  return `${head}_${body}`;
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

  const limits = await getUploadLimits(adminClient);
  const storageCountResult = await countCurrentUserStorageImages(
    adminClient,
    userData.user.id,
  );

  if (storageCountResult.error) {
    return errorResponse(
      `Failed to evaluate storage-backed upload limit: ${storageCountResult.error}`,
      500,
    );
  }

  const projectedImages = storageCountResult.count + TGA_VARIANTS_PER_UPLOAD;
  if (projectedImages > limits.imagesPerIpLimit) {
    return errorResponse(
      `Upload limit reached for this account. Max total images: ${limits.imagesPerIpLimit}.`,
      429,
    );
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
      "Filename prefix must include letters, numbers, or underscores (max 10 chars)",
      400,
    );
  }

  let imageRow: { id: string; original_path: string; status: string; filename_prefix: string } | null = null;
  let insertError: { message?: string; code?: string } | null = null;
  const maxInsertAttempts = 5;

  for (let attempt = 0; attempt < maxInsertAttempts; attempt += 1) {
    const candidatePrefix = buildCandidatePrefix(normalizedRequestedPrefix);

    const { data: insertedRow, error: imageError } = await supabase
      .from("images")
      .insert({
        user_id: userData.user.id,
        original_path: objectPath,
        source_mime: sourceMime,
        uploader_ip: identity.requesterIp,
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

  }

  if (!imageRow) {
    return errorResponse(
      `Failed to insert image row: ${insertError?.message ?? "unknown"}`,
      500,
    );
  }

  const chosenPrefixForCatalog = normalizedRequestedPrefix
    ? normalizedRequestedPrefix.slice(0, PREFIX_BODY_LENGTH)
    : null;
  const convertedPathBase = `${userData.user.id}/${imageRow.id}`;
  const { error: catalogError } = await supabase
    .from("upload_files")
    .upsert(
      {
        image_id: imageRow.id,
        user_id: userData.user.id,
        chosen_prefix: chosenPrefixForCatalog,
        final_prefix: imageRow.filename_prefix,
        final_file_name: `${imageRow.filename_prefix}H.tga`,
        converted_path_base: convertedPathBase,
        uploader_ip: identity.requesterIp,
      },
      { onConflict: "image_id" },
    );

  if (catalogError) {
    return errorResponse(
      `Failed to persist upload metadata: ${catalogError.message}`,
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
