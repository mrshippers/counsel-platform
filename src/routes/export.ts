import { Hono } from "hono";
import type { AppEnv } from "../index";
import { authMiddleware } from "../middleware/auth";
import { partnerOnly } from "../middleware/rbac";
import { createSupabaseAdmin } from "../lib/supabase";
import { logAuditEvent } from "../middleware/audit";

export const exportRoutes = new Hono<AppEnv>();

exportRoutes.use("*", authMiddleware);
exportRoutes.use("*", partnerOnly());

// GET /api/export/firm — Full firm data export (partner only)
exportRoutes.get("/firm", async (c) => {
  const user = c.get("user");
  const supabase = createSupabaseAdmin(c.env);

  // Fetch all clients
  const { data: clients } = await supabase
    .from("clients")
    .select("*")
    .eq("firm_id", user.firm_id)
    .order("name", { ascending: true });

  // Fetch all cases
  const { data: cases } = await supabase
    .from("cases")
    .select("*")
    .eq("firm_id", user.firm_id)
    .order("created_at", { ascending: false });

  // Fetch all tasks for firm cases
  const caseIds = (cases || []).map((cs: { id: string }) => cs.id);

  const { data: tasks } = await supabase
    .from("tasks")
    .select("*")
    .in("case_id", caseIds.length > 0 ? caseIds : ["__none__"])
    .order("order_index", { ascending: true });

  // Fetch document metadata (no file contents)
  const { data: documents } = await supabase
    .from("documents")
    .select("id, case_id, uploaded_by, file_name, file_type, file_size_bytes, created_at, updated_at")
    .in("case_id", caseIds.length > 0 ? caseIds : ["__none__"])
    .order("created_at", { ascending: false });

  // Fetch all deadlines
  const { data: deadlines } = await supabase
    .from("deadlines")
    .select("*")
    .eq("firm_id", user.firm_id)
    .order("date", { ascending: true });

  // Fetch users (strip password_hash)
  const { data: usersRaw } = await supabase
    .from("users")
    .select("*")
    .eq("firm_id", user.firm_id)
    .order("name", { ascending: true });

  const users = (usersRaw || []).map((u: Record<string, unknown>) => {
    const { password_hash, ...safeUser } = u;
    return safeUser;
  });

  await logAuditEvent(c, "firm_data_export", "firm");

  return c.json({
    exported_at: new Date().toISOString(),
    clients: clients || [],
    cases: cases || [],
    tasks: tasks || [],
    documents: documents || [],
    deadlines: deadlines || [],
    users,
  }, 200);
});
