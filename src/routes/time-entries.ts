import { Hono } from "hono";
import type { AppEnv } from "../index";
import { authMiddleware } from "../middleware/auth";
import { createSupabaseAdmin } from "../lib/supabase";
import { logAuditEvent } from "../middleware/audit";

export const timeEntriesRoutes = new Hono<AppEnv>();

timeEntriesRoutes.use("*", authMiddleware);

// POST /api/time-entries — log billable hours against a case
timeEntriesRoutes.post("/", async (c) => {
  const user = c.get("user");
  const body = await c.req.json().catch(() => ({}));

  // Validate required fields
  if (!body.case_id || !body.description || !body.duration_minutes || body.rate_pence === undefined) {
    return c.json({ error: "Missing required fields: case_id, description, duration_minutes, rate_pence" }, 400);
  }

  if (typeof body.duration_minutes !== "number" || body.duration_minutes <= 0) {
    return c.json({ error: "duration_minutes must be a positive number" }, 400);
  }

  if (typeof body.rate_pence !== "number" || body.rate_pence < 0) {
    return c.json({ error: "rate_pence must be zero or positive" }, 400);
  }

  const supabase = createSupabaseAdmin(c.env);

  // Verify case belongs to this firm
  const { data: caseData } = await supabase
    .from("cases")
    .select("id, firm_id, lawyer_id")
    .eq("id", body.case_id)
    .eq("firm_id", user.firm_id)
    .single();

  if (!caseData) {
    return c.json({ error: "Case not found" }, 404);
  }

  // Associate can only log time on their own cases
  if (user.role === "associate" && caseData.lawyer_id !== user.sub) {
    return c.json({ error: "Forbidden" }, 403);
  }

  const { data: entry, error } = await supabase
    .from("time_entries")
    .insert({
      firm_id: user.firm_id,
      case_id: body.case_id,
      lawyer_id: user.sub,
      description: body.description,
      duration_minutes: body.duration_minutes,
      date: body.date || new Date().toISOString().split("T")[0],
      billable: body.billable !== undefined ? body.billable : true,
      rate_pence: body.rate_pence,
    })
    .select()
    .single();

  if (error || !entry) {
    return c.json({ error: "Failed to create time entry" }, 500);
  }

  await logAuditEvent(c, "time_entry_created", "time_entry", entry.id);

  return c.json({ data: entry }, 201);
});

// GET /api/time-entries — list time entries (optionally filtered by case_id)
timeEntriesRoutes.get("/", async (c) => {
  const user = c.get("user");
  const caseId = c.req.query("case_id");
  const supabase = createSupabaseAdmin(c.env);

  let query = supabase
    .from("time_entries")
    .select("*, cases(title), users(name)")
    .eq("firm_id", user.firm_id);

  if (caseId) {
    query = query.eq("case_id", caseId);
  }

  // Associate: only their entries
  if (user.role === "associate") {
    query = query.eq("lawyer_id", user.sub);
  }

  const { data, error } = await query.order("date", { ascending: false });

  if (error) {
    return c.json({ error: "Failed to fetch time entries" }, 500);
  }

  return c.json({ data }, 200);
});

// GET /api/time-entries/summary — billing summary for a case
timeEntriesRoutes.get("/summary", async (c) => {
  const user = c.get("user");
  const caseId = c.req.query("case_id");
  const supabase = createSupabaseAdmin(c.env);

  let query = supabase
    .from("time_entries")
    .select("duration_minutes, rate_pence, billable")
    .eq("firm_id", user.firm_id);

  if (caseId) {
    query = query.eq("case_id", caseId);
  }

  const { data: entries, error } = await query.order("date", { ascending: false });

  if (error) {
    return c.json({ error: "Failed to fetch time entries" }, 500);
  }

  const allEntries = entries || [];
  const billableEntries = allEntries.filter((e: { billable: boolean }) => e.billable);

  const totalBillableMinutes = billableEntries.reduce(
    (sum: number, e: { duration_minutes: number }) => sum + e.duration_minutes,
    0
  );

  // Calculate total: (minutes / 60) * rate_pence per entry
  const totalAmountPence = billableEntries.reduce(
    (sum: number, e: { duration_minutes: number; rate_pence: number }) =>
      sum + Math.round((e.duration_minutes / 60) * e.rate_pence),
    0
  );

  return c.json({
    total_entries: allEntries.length,
    billable_entries: billableEntries.length,
    total_billable_minutes: totalBillableMinutes,
    total_amount_pence: totalAmountPence,
    currency: "GBP",
  }, 200);
});

// PATCH /api/time-entries/:id — update a time entry
timeEntriesRoutes.patch("/:id", async (c) => {
  const user = c.get("user");
  const entryId = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));
  const supabase = createSupabaseAdmin(c.env);

  // Fetch existing entry
  const { data: existing } = await supabase
    .from("time_entries")
    .select("*")
    .eq("id", entryId)
    .eq("firm_id", user.firm_id)
    .single();

  if (!existing) {
    return c.json({ error: "Time entry not found" }, 404);
  }

  // Associate can only update their own entries
  if (user.role === "associate" && existing.lawyer_id !== user.sub) {
    return c.json({ error: "Forbidden" }, 403);
  }

  const { firm_id, id, created_at, updated_at, ...allowed } = body;

  const { data: updated, error } = await supabase
    .from("time_entries")
    .update(allowed)
    .eq("id", entryId)
    .select()
    .single();

  if (error) {
    return c.json({ error: "Failed to update time entry" }, 500);
  }

  await logAuditEvent(c, "time_entry_updated", "time_entry", entryId);

  return c.json({ data: updated }, 200);
});

// DELETE /api/time-entries/:id — partner only
timeEntriesRoutes.delete("/:id", async (c) => {
  const user = c.get("user");
  const entryId = c.req.param("id");

  if (user.role !== "partner") {
    return c.json({ error: "Forbidden" }, 403);
  }

  const supabase = createSupabaseAdmin(c.env);

  const { data: existing } = await supabase
    .from("time_entries")
    .select("id")
    .eq("id", entryId)
    .eq("firm_id", user.firm_id)
    .single();

  if (!existing) {
    return c.json({ error: "Time entry not found" }, 404);
  }

  await supabase.from("time_entries").delete().eq("id", entryId);
  await logAuditEvent(c, "time_entry_deleted", "time_entry", entryId);

  return c.json({ message: "Time entry deleted" }, 200);
});
