import { Context } from "hono";
import type { AppEnv } from "../index";
import { createSupabaseAdmin } from "../lib/supabase";

export async function logAuditEvent(
  c: Context<AppEnv>,
  action: string,
  entityType: string,
  entityId?: string
) {
  const user = c.get("user");
  const ip = c.get("ip");

  if (!user) return;

  const supabase = createSupabaseAdmin(c.env);
  const { error } = await supabase.from("audit_log").insert({
    firm_id: user.firm_id,
    user_id: user.sub,
    action,
    entity_type: entityType,
    entity_id: entityId || null,
    ip_address: ip || null,
  });

  if (error) {
    console.error("AUDIT_FAIL", action, entityType, entityId, error.message);
  }
}

export async function logAuthEvent(
  env: AppEnv["Bindings"],
  userId: string,
  firmId: string,
  action: string,
  ip: string
) {
  const supabase = createSupabaseAdmin(env);
  const { error } = await supabase.from("audit_log").insert({
    firm_id: firmId,
    user_id: userId,
    action,
    entity_type: "auth",
    ip_address: ip || null,
  });

  if (error) {
    console.error("AUDIT_FAIL", action, "auth", error.message);
  }
}
