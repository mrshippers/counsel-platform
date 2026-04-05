import { Hono } from "hono";
import type { AppEnv } from "../index";
import { authMiddleware } from "../middleware/auth";
import { partnerOnly } from "../middleware/rbac";
import { createSupabaseAdmin } from "../lib/supabase";
import { logAuditEvent } from "../middleware/audit";

export const gdprRoutes = new Hono<AppEnv>();

gdprRoutes.use("*", authMiddleware);
gdprRoutes.use("*", partnerOnly());

// GET /api/gdpr/export/:clientId — Subject Access Request
gdprRoutes.get("/export/:clientId", async (c) => {
  const user = c.get("user");
  const clientId = c.req.param("clientId");
  const supabase = createSupabaseAdmin(c.env);

  // Verify client belongs to firm
  const { data: client, error: clientError } = await supabase
    .from("clients")
    .select("*")
    .eq("id", clientId)
    .eq("firm_id", user.firm_id)
    .single();

  if (!client || clientError) {
    return c.json({ error: "Client not found" }, 404);
  }

  // Fetch all cases for this client
  const { data: cases } = await supabase
    .from("cases")
    .select("*")
    .eq("client_id", clientId)
    .eq("firm_id", user.firm_id)
    .order("created_at", { ascending: false });

  const caseIds = (cases || []).map((cs: { id: string }) => cs.id);

  // Fetch all tasks for those cases
  const { data: tasks } = await supabase
    .from("tasks")
    .select("*")
    .in("case_id", caseIds.length > 0 ? caseIds : ["__none__"])
    .order("order_index", { ascending: true });

  // Fetch all document metadata for those cases
  const { data: documents } = await supabase
    .from("documents")
    .select("id, case_id, uploaded_by, file_name, file_type, file_size_bytes, created_at, updated_at")
    .in("case_id", caseIds.length > 0 ? caseIds : ["__none__"])
    .order("created_at", { ascending: false });

  // Fetch all deadlines for those cases
  const { data: deadlines } = await supabase
    .from("deadlines")
    .select("*")
    .in("case_id", caseIds.length > 0 ? caseIds : ["__none__"])
    .order("date", { ascending: true });

  await logAuditEvent(c, "sar_export", "client", clientId);

  return c.json({
    client,
    cases: cases || [],
    tasks: tasks || [],
    documents: documents || [],
    deadlines: deadlines || [],
  }, 200);
});

// DELETE /api/gdpr/erase/:clientId — Right to Erasure
gdprRoutes.delete("/erase/:clientId", async (c) => {
  const user = c.get("user");
  const clientId = c.req.param("clientId");
  const supabase = createSupabaseAdmin(c.env);

  // Verify client belongs to firm
  const { data: client, error: clientError } = await supabase
    .from("clients")
    .select("id")
    .eq("id", clientId)
    .eq("firm_id", user.firm_id)
    .single();

  if (!client || clientError) {
    return c.json({ error: "Client not found" }, 404);
  }

  // Delete client — Postgres cascades to cases -> tasks, documents, deadlines
  await supabase.from("clients").delete().eq("id", clientId);

  await logAuditEvent(c, "client_erased", "client", clientId);

  return c.json({ message: "Client data erased", client_id: clientId }, 200);
});
