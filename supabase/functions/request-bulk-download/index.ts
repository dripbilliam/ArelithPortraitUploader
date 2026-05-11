import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import JSZip from "https://esm.sh/jszip@3.10.1";

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

type ImageRow = {
  id: string;
  user_id: string;
  original_path: string;
  converted_path: string | null;
  created_at: string;
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
  const adminEmailsRaw = Deno.env.get("ADMIN_DOWNLOAD_EMAILS") ?? "";

  if (!supabaseUrl || !supabaseAnonKey || !serviceRoleKey) {
    return errorResponse("Missing Supabase env", 500);
  }

  const adminEmails = adminEmailsRaw
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);

  const authHeader = req.headers.get("Authorization") ?? "";

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

  const email = (userData.user.email ?? "").toLowerCase();
  if (adminEmails.length > 0 && !adminEmails.includes(email)) {
    return errorResponse("Forbidden", 403);
  }

  const { data: rows, error: rowsError } = await adminClient
    .from("images")
    .select("id, user_id, original_path, converted_path, created_at")
    .order("created_at", { ascending: false })
    .limit(500);

  if (rowsError) {
    return errorResponse(`Failed to fetch image rows: ${rowsError.message}`, 500);
  }

  const imageRows = (rows ?? []) as ImageRow[];
  if (imageRows.length === 0) {
    return new Response(JSON.stringify({ files: [] }), {
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
      },
    });
  }

  const zip = new JSZip();
  let includedCount = 0;
  let skippedCount = 0;

  for (const row of imageRows) {
    const useConverted = typeof row.converted_path === "string" && row.converted_path.length > 0;
    const path = useConverted ? (row.converted_path as string) : row.original_path;
    const bucket = useConverted ? "portraits-converted" : "portraits-original";

    const { data: blob, error: downloadError } = await adminClient.storage
      .from(bucket)
      .download(path);

    if (downloadError || !blob) {
      skippedCount += 1;
      continue;
    }

    const bytes = await blob.arrayBuffer();
    const fallbackName = `${row.id}${useConverted ? "" : "_original"}`;
    const fileName = path.split("/").pop() ?? fallbackName;
    zip.file(`${row.user_id}/${fileName}`, bytes);
    includedCount += 1;
  }

  if (includedCount === 0) {
    return errorResponse("No downloadable files found.", 404);
  }

  const archiveBytes = await zip.generateAsync({
    type: "uint8array",
    compression: "DEFLATE",
    compressionOptions: {
      level: 6,
    },
  });

  const exportPath = `exports/all-users-${Date.now()}.zip`;
  const { error: uploadError } = await adminClient.storage
    .from("bulk-exports")
    .upload(exportPath, archiveBytes, {
      upsert: true,
      contentType: "application/zip",
    });

  if (uploadError) {
    return errorResponse(`Failed to upload ZIP: ${uploadError.message}`, 500);
  }

  const { data: signedData, error: signedError } = await adminClient.storage
    .from("bulk-exports")
    .createSignedUrl(exportPath, 60 * 10);

  if (signedError || !signedData?.signedUrl) {
    return errorResponse(
      `Failed to create signed ZIP URL: ${signedError?.message ?? "unknown"}`,
      500,
    );
  }

  return new Response(
    JSON.stringify({
      zipPath: exportPath,
      signedUrl: signedData.signedUrl,
      fileCount: includedCount,
      skippedCount,
    }),
    {
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  },
  );
});
