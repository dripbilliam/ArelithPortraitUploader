import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

export type BanAction = "upload" | "download";

export type RequestIdentity = {
  requesterIp: string;
  requesterKey: string;
  userId: string | null;
  email: string | null;
};

export function getRequesterIp(req: Request): string {
  return (req.headers.get("x-forwarded-for") ?? "")
    .split(",")[0]
    .trim() || "unknown";
}

export async function resolveIdentity(
  supabase: SupabaseClient,
  req: Request,
): Promise<RequestIdentity> {
  const requesterIp = getRequesterIp(req);

  try {
    const { data } = await supabase.auth.getUser();
    const user = data?.user ?? null;
    if (user) {
      return {
        requesterIp,
        requesterKey: `user:${user.id}`,
        userId: user.id,
        email: (user.email ?? null)?.toLowerCase() ?? null,
      };
    }
  } catch {
    // Unauthenticated request; continue with IP identity.
  }

  return {
    requesterIp,
    requesterKey: `ip:${requesterIp}`,
    userId: null,
    email: null,
  };
}

export async function checkApiBan(
  adminClient: SupabaseClient,
  identity: RequestIdentity,
  action: BanAction,
): Promise<{ blocked: boolean; reason: string | null; error: string | null }> {
  const orParts = [`ip.eq.${identity.requesterIp}`];
  if (identity.userId) {
    orParts.push(`user_id.eq.${identity.userId}`);
  }
  if (identity.email) {
    orParts.push(`email.eq.${identity.email}`);
  }

  const { data, error } = await adminClient
    .from("api_access_bans")
    .select("scope, reason, expires_at")
    .eq("active", true)
    .or(orParts.join(","));

  if (error) {
    return {
      blocked: false,
      reason: null,
      error: error.message,
    };
  }

  const now = Date.now();
  const match = (data ?? []).find((row) => {
    if (row.expires_at) {
      const expiresMs = new Date(row.expires_at).getTime();
      if (Number.isFinite(expiresMs) && expiresMs <= now) {
        return false;
      }
    }

    return row.scope === "any" || row.scope === action;
  });

  if (!match) {
    return {
      blocked: false,
      reason: null,
      error: null,
    };
  }

  return {
    blocked: true,
    reason: match.reason ?? "Blocked by moderation policy",
    error: null,
  };
}
