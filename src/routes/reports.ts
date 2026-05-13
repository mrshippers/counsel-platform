import { Hono } from "hono";
import type { AppEnv } from "../index";
import { authMiddleware } from "../middleware/auth";
import { createSupabaseAdmin } from "../lib/supabase";

export const reportsRoutes = new Hono<AppEnv>();

reportsRoutes.use("*", authMiddleware);

// GET /api/reports/utilisation?start=YYYY-MM-DD&end=YYYY-MM-DD
// Returns billable hours and amount per fee-earner in the date range
reportsRoutes.get("/utilisation", async (c) => {
  const user = c.get("user");
  const supabase = createSupabaseAdmin(c.env);

  const start = c.req.query("start");
  const end = c.req.query("end");

  // Default: current calendar month
  const now = new Date();
  const defaultStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
  const defaultEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0)
    .toISOString().split("T")[0];

  const rangeStart = start || defaultStart;
  const rangeEnd = end || defaultEnd;

  // Get all time entries in range for this firm
  const { data: entries, error } = await supabase
    .from("time_entries")
    .select("lawyer_id, duration_minutes, rate_pence, billable, date")
    .eq("firm_id", user.firm_id)
    .gte("date", rangeStart)
    .lte("date", rangeEnd);

  if (error) {
    return c.json({ error: "Failed to fetch time entries" }, 500);
  }

  // Get all lawyers for the firm
  const { data: lawyers } = await supabase
    .from("users")
    .select("id, name, role")
    .eq("firm_id", user.firm_id)
    .eq("active", true);

  type EntryRow = { lawyer_id: string; duration_minutes: number; rate_pence: number; billable: boolean };
  const allEntries: EntryRow[] = entries || [];

  // Aggregate per lawyer
  const statsMap: Record<string, {
    total_minutes: number;
    billable_minutes: number;
    non_billable_minutes: number;
    total_amount_pence: number;
    entry_count: number;
  }> = {};

  for (const e of allEntries) {
    if (!statsMap[e.lawyer_id]) {
      statsMap[e.lawyer_id] = {
        total_minutes: 0,
        billable_minutes: 0,
        non_billable_minutes: 0,
        total_amount_pence: 0,
        entry_count: 0,
      };
    }
    const s = statsMap[e.lawyer_id];
    s.total_minutes += e.duration_minutes;
    s.entry_count++;
    if (e.billable) {
      s.billable_minutes += e.duration_minutes;
      s.total_amount_pence += Math.round((e.duration_minutes / 60) * e.rate_pence);
    } else {
      s.non_billable_minutes += e.duration_minutes;
    }
  }

  type LawyerRow = { id: string; name: string; role: string };
  const report = (lawyers || []).map((l: LawyerRow) => {
    const s = statsMap[l.id] || {
      total_minutes: 0, billable_minutes: 0, non_billable_minutes: 0,
      total_amount_pence: 0, entry_count: 0,
    };
    const billable_hours = +(s.billable_minutes / 60).toFixed(2);
    const total_hours = +(s.total_minutes / 60).toFixed(2);
    return {
      user_id: l.id,
      name: l.name,
      role: l.role,
      billable_hours,
      total_hours,
      non_billable_hours: +(s.non_billable_minutes / 60).toFixed(2),
      utilisation_pct: total_hours > 0 ? +((billable_hours / total_hours) * 100).toFixed(1) : 0,
      total_amount_pence: s.total_amount_pence,
      entry_count: s.entry_count,
    };
  });

  return c.json({
    period: { start: rangeStart, end: rangeEnd },
    data: report,
  }, 200);
});

// GET /api/reports/invoices — invoice summary (outstanding vs paid)
reportsRoutes.get("/invoices", async (c) => {
  const user = c.get("user");
  const supabase = createSupabaseAdmin(c.env);

  const { data: invoices, error } = await supabase
    .from("invoices")
    .select("id, invoice_number, invoice_date, total_pence, paid_at, case_id, cases(title)")
    .eq("firm_id", user.firm_id)
    .order("invoice_date", { ascending: false });

  if (error) {
    return c.json({ error: "Failed to fetch invoices" }, 500);
  }

  type InvRow = { id: string; total_pence: number; paid_at: string | null };
  const all = invoices || [];
  const paid = all.filter((i: InvRow) => i.paid_at !== null);
  const outstanding = all.filter((i: InvRow) => i.paid_at === null);

  const sumPence = (arr: InvRow[]) =>
    arr.reduce((s: number, i: InvRow) => s + i.total_pence, 0);

  return c.json({
    summary: {
      total_invoices: all.length,
      paid_count: paid.length,
      outstanding_count: outstanding.length,
      paid_total_pence: sumPence(paid as InvRow[]),
      outstanding_total_pence: sumPence(outstanding as InvRow[]),
      currency: "GBP",
    },
    outstanding,
    paid,
  }, 200);
});

// GET /api/reports/matter-time?case_id=UUID — time breakdown for a single matter
reportsRoutes.get("/matter-time", async (c) => {
  const user = c.get("user");
  const caseId = c.req.query("case_id");

  if (!caseId) {
    return c.json({ error: "case_id query parameter is required" }, 400);
  }

  const supabase = createSupabaseAdmin(c.env);

  // Verify case belongs to firm
  const { data: caseData } = await supabase
    .from("cases")
    .select("id, title, type, status")
    .eq("id", caseId)
    .eq("firm_id", user.firm_id)
    .single();

  if (!caseData) {
    return c.json({ error: "Case not found" }, 404);
  }

  const { data: entries, error } = await supabase
    .from("time_entries")
    .select("*, users(name)")
    .eq("case_id", caseId)
    .eq("firm_id", user.firm_id)
    .order("date", { ascending: false });

  if (error) {
    return c.json({ error: "Failed to fetch time entries" }, 500);
  }

  type EntryRow = { duration_minutes: number; rate_pence: number; billable: boolean };
  const all: EntryRow[] = entries || [];
  const billable = all.filter(e => e.billable);

  const totalBillableMinutes = billable.reduce((s, e) => s + e.duration_minutes, 0);
  const totalAmountPence = billable.reduce(
    (s, e) => s + Math.round((e.duration_minutes / 60) * e.rate_pence), 0
  );

  return c.json({
    case: caseData,
    summary: {
      total_entries: all.length,
      billable_entries: billable.length,
      total_billable_hours: +(totalBillableMinutes / 60).toFixed(2),
      total_amount_pence: totalAmountPence,
      currency: "GBP",
    },
    entries,
  }, 200);
});
