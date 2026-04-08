import { Hono } from "hono";
import type { AppEnv } from "../index";
import { authMiddleware } from "../middleware/auth";
import { createSupabaseAdmin } from "../lib/supabase";
import { logAuditEvent } from "../middleware/audit";
import { DEFAULT_CASE_TASKS } from "../types";
import type { CaseType, CasePriority } from "../types";

const VALID_TYPES: CaseType[] = [
  "corporate", "criminal", "family", "civil", "real_estate", "employment", "other",
];
const VALID_PRIORITIES: CasePriority[] = ["urgent", "high", "normal"];

export const casesRoutes = new Hono<AppEnv>();

// All case routes require auth
casesRoutes.use("*", authMiddleware);

// GET /api/cases — list cases (partner: all firm cases, associate: own only)
casesRoutes.get("/", async (c) => {
  const user = c.get("user");
  const supabase = createSupabaseAdmin(c.env);

  const search = c.req.query("search");
  const status = c.req.query("status");

  let query = supabase
    .from("cases")
    .select("*, clients(first_name, last_name, reference_number), users(name, avatar_initials)")
    .eq("firm_id", user.firm_id);

  // Associate: only their assigned cases
  if (user.role === "associate") {
    query = query.eq("lawyer_id", user.sub);
  }

  // Filter by status
  if (status) {
    query = query.eq("status", status);
  }

  // Search by title
  if (search) {
    query = query.ilike("title", `%${search}%`);
  }

  const { data, error } = await query.order("created_at", { ascending: false });

  if (error) {
    return c.json({ error: "Failed to fetch cases" }, 500);
  }

  return c.json({ data }, 200);
});

// POST /api/cases — create case with 4 default tasks
casesRoutes.post("/", async (c) => {
  const user = c.get("user");
  const body = await c.req.json().catch(() => ({}));

  // Validate required fields
  if (!body.client_id || !body.lawyer_id || !body.title || !body.type) {
    return c.json({ error: "Missing required fields: client_id, lawyer_id, title, type" }, 400);
  }

  // Validate case type
  if (!VALID_TYPES.includes(body.type)) {
    return c.json({ error: `Invalid type. Must be one of: ${VALID_TYPES.join(", ")}` }, 400);
  }

  // Validate priority if provided
  if (body.priority && !VALID_PRIORITIES.includes(body.priority)) {
    return c.json({ error: `Invalid priority. Must be one of: ${VALID_PRIORITIES.join(", ")}` }, 400);
  }

  const supabase = createSupabaseAdmin(c.env);

  // Verify client and lawyer belong to this firm
  const [clientCheck, lawyerCheck] = await Promise.all([
    supabase.from("clients").select("id, first_name, last_name").eq("id", body.client_id).eq("firm_id", user.firm_id).single(),
    supabase.from("users").select("id").eq("id", body.lawyer_id).eq("firm_id", user.firm_id).single(),
  ]);

  if (!clientCheck.data || !lawyerCheck.data) {
    return c.json({ error: "Invalid client or lawyer for this firm" }, 400);
  }

  // Conflict of interest check — warn if client has other active cases
  const { data: activeCases } = await supabase
    .from("cases")
    .select("id, title")
    .eq("client_id", body.client_id)
    .eq("firm_id", user.firm_id)
    .in("status", ["pending", "in_progress"]);

  const conflictWarning = (activeCases && activeCases.length > 0)
    ? `Warning: This client already has ${activeCases.length} active case(s).`
    : null;

  // Create case — firm_id ALWAYS from JWT, never from request body
  const { data: newCase, error: caseError } = await supabase
    .from("cases")
    .insert({
      firm_id: user.firm_id, // Belt and braces: always from JWT
      client_id: body.client_id,
      lawyer_id: body.lawyer_id,
      title: body.title,
      type: body.type,
      priority: body.priority || "normal",
      deadline: body.deadline || null,
      notes: body.notes || null,
      status: "pending",
      progress: 0,
    })
    .select()
    .single();

  if (caseError || !newCase) {
    return c.json({ error: "Failed to create case" }, 500);
  }

  // Create 4 default tasks
  const defaultTasks = DEFAULT_CASE_TASKS.map((label, i) => ({
    case_id: newCase.id,
    label,
    done: false,
    order_index: i,
  }));

  await supabase.from("tasks").insert(defaultTasks);

  // Audit log
  await logAuditEvent(c, "case_created", "case", newCase.id);

  return c.json({ data: newCase, conflict_warning: conflictWarning }, 201);
});

// GET /api/cases/:id — get single case
casesRoutes.get("/:id", async (c) => {
  const user = c.get("user");
  const caseId = c.req.param("id");
  const supabase = createSupabaseAdmin(c.env);

  const { data, error } = await supabase
    .from("cases")
    .select("*, clients(first_name, last_name, reference_number, email, mobile_phone, landline_phone, client_type), users(name, avatar_initials), tasks(*)")
    .eq("id", caseId)
    .eq("firm_id", user.firm_id) // Firm isolation
    .single();

  if (!data || error) {
    return c.json({ error: "Case not found" }, 404);
  }

  // Associate can only see their own cases
  if (user.role === "associate" && data.lawyer_id !== user.sub) {
    return c.json({ error: "Forbidden" }, 403);
  }

  return c.json({ data }, 200);
});

const VALID_STATUSES = ["pending", "in_progress", "completed"] as const;

// PATCH /api/cases/:id — update case
casesRoutes.patch("/:id", async (c) => {
  const user = c.get("user");
  const caseId = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));
  const supabase = createSupabaseAdmin(c.env);

  // Verify case exists and belongs to firm
  const { data: existing, error: fetchError } = await supabase
    .from("cases")
    .select("*")
    .eq("id", caseId)
    .eq("firm_id", user.firm_id)
    .single();

  if (!existing || fetchError) {
    return c.json({ error: "Case not found" }, 404);
  }

  // Associate can only update their own cases
  if (user.role === "associate" && existing.lawyer_id !== user.sub) {
    return c.json({ error: "Forbidden" }, 403);
  }

  // Validate fields if provided
  if (body.type && !VALID_TYPES.includes(body.type)) {
    return c.json({ error: `Invalid type. Must be one of: ${VALID_TYPES.join(", ")}` }, 400);
  }
  if (body.priority && !VALID_PRIORITIES.includes(body.priority)) {
    return c.json({ error: `Invalid priority. Must be one of: ${VALID_PRIORITIES.join(", ")}` }, 400);
  }
  if (body.status && !VALID_STATUSES.includes(body.status)) {
    return c.json({ error: `Invalid status. Must be one of: ${VALID_STATUSES.join(", ")}` }, 400);
  }

  // Strip fields that cannot be updated via API
  const { firm_id, id, created_at, updated_at, ...allowed } = body;

  const { data: updated, error: updateError } = await supabase
    .from("cases")
    .update(allowed)
    .eq("id", caseId)
    .select()
    .single();

  if (updateError) {
    return c.json({ error: "Failed to update case" }, 500);
  }

  await logAuditEvent(c, "case_updated", "case", caseId);

  return c.json({ data: updated }, 200);
});

// DELETE /api/cases/:id — partner only
casesRoutes.delete("/:id", async (c) => {
  const user = c.get("user");
  const caseId = c.req.param("id");
  const supabase = createSupabaseAdmin(c.env);

  // Partner only
  if (user.role !== "partner") {
    return c.json({ error: "Forbidden" }, 403);
  }

  // Verify case belongs to firm
  const { data: existing, error: fetchError } = await supabase
    .from("cases")
    .select("id")
    .eq("id", caseId)
    .eq("firm_id", user.firm_id)
    .single();

  if (!existing || fetchError) {
    return c.json({ error: "Case not found" }, 404);
  }

  await supabase.from("cases").delete().eq("id", caseId);
  await logAuditEvent(c, "case_deleted", "case", caseId);

  return c.json({ message: "Case deleted" }, 200);
});
