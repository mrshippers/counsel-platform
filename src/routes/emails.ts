import { Hono } from "hono";
import type { AppEnv } from "../index";
import { authMiddleware } from "../middleware/auth";
import { createSupabaseAdmin } from "../lib/supabase";
import { logAuditEvent } from "../middleware/audit";

export const emailsRoutes = new Hono<AppEnv>();

emailsRoutes.use("*", authMiddleware);

// POST /api/emails/file — file an email against a case
emailsRoutes.post("/file", async (c) => {
  const user = c.get("user");
  const body = await c.req.json().catch(() => ({}));

  if (!body.case_id || !body.subject || !body.from_address) {
    return c.json({ error: "Missing required fields: case_id, subject, from_address" }, 400);
  }

  const supabase = createSupabaseAdmin(c.env);

  // Verify case belongs to firm
  const { data: caseData } = await supabase
    .from("cases")
    .select("id, firm_id, lawyer_id")
    .eq("id", body.case_id)
    .eq("firm_id", user.firm_id)
    .single();

  if (!caseData) {
    return c.json({ error: "Case not found" }, 404);
  }

  // Associate can only file to their own cases
  if (user.role === "associate" && caseData.lawyer_id !== user.sub) {
    return c.json({ error: "Forbidden" }, 403);
  }

  const { data: email, error } = await supabase
    .from("case_emails")
    .insert({
      firm_id: user.firm_id,
      case_id: body.case_id,
      filed_by: user.sub,
      subject: body.subject,
      from_address: body.from_address,
      body: body.body || null,
      received_date: body.received_date || new Date().toISOString(),
    })
    .select()
    .single();

  if (error || !email) {
    return c.json({ error: "Failed to file email" }, 500);
  }

  await logAuditEvent(c, "email_filed", "case_email", email.id);

  return c.json({ data: email }, 201);
});

// GET /api/emails — list filed emails for a case
emailsRoutes.get("/", async (c) => {
  const user = c.get("user");
  const caseId = c.req.query("case_id");

  if (!caseId) {
    return c.json({ error: "case_id query parameter is required" }, 400);
  }

  const supabase = createSupabaseAdmin(c.env);

  const { data, error } = await supabase
    .from("case_emails")
    .select("*")
    .eq("firm_id", user.firm_id)
    .eq("case_id", caseId)
    .order("received_date", { ascending: false });

  if (error) {
    return c.json({ error: "Failed to fetch emails" }, 500);
  }

  return c.json({ data }, 200);
});

// DELETE /api/emails/:id — partner only
emailsRoutes.delete("/:id", async (c) => {
  const user = c.get("user");
  const emailId = c.req.param("id");

  if (user.role !== "partner") {
    return c.json({ error: "Forbidden" }, 403);
  }

  const supabase = createSupabaseAdmin(c.env);

  const { data: existing } = await supabase
    .from("case_emails")
    .select("id")
    .eq("id", emailId)
    .eq("firm_id", user.firm_id)
    .single();

  if (!existing) {
    return c.json({ error: "Email not found" }, 404);
  }

  await supabase.from("case_emails").delete().eq("id", emailId);
  await logAuditEvent(c, "email_deleted", "case_email", emailId);

  return c.json({ message: "Email deleted" }, 200);
});
