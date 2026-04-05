import { Hono } from "hono";
import type { AppEnv } from "../index";
import { authMiddleware } from "../middleware/auth";
import { createSupabaseAdmin } from "../lib/supabase";

export const dashboardRoutes = new Hono<AppEnv>();

dashboardRoutes.use("*", authMiddleware);

// GET /api/dashboard — triage intelligence board
dashboardRoutes.get("/", async (c) => {
  const user = c.get("user");
  const supabase = createSupabaseAdmin(c.env);
  const firmId = user.firm_id;

  // Parallel queries for dashboard data
  const [casesResult, lawyersResult, deadlinesResult, clientsResult] =
    await Promise.all([
      // All active cases for firm
      supabase
        .from("cases")
        .select("*, clients(name), users(name, avatar_initials)")
        .eq("firm_id", firmId)
        .neq("status", "completed")
        .order("deadline", { ascending: true }),

      // Lawyer workload
      supabase
        .from("users")
        .select("id, name, avatar_initials, role")
        .eq("firm_id", firmId)
        .eq("active", true),

      // Upcoming deadlines (next 30 days)
      supabase
        .from("deadlines")
        .select("*, cases(title, status)")
        .eq("firm_id", firmId)
        .gte("date", new Date().toISOString().split("T")[0])
        .order("date", { ascending: true })
        .limit(5),

      // Client count
      supabase
        .from("clients")
        .select("id", { count: "exact" })
        .eq("firm_id", firmId),
    ]);

  const cases = casesResult.data || [];
  const lawyers = lawyersResult.data || [];
  const deadlines = deadlinesResult.data || [];
  const clientCount = clientsResult.count || 0;

  const now = new Date();
  const twoDaysFromNow = new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000);

  // Triage intelligence
  const bleeding = cases.filter(
    (c) => c.deadline && new Date(c.deadline) <= twoDaysFromNow && c.progress < 100
  );

  const stalled = cases.filter((c) => {
    const updated = new Date(c.updated_at);
    const daysSince = (now.getTime() - updated.getTime()) / (1000 * 60 * 60 * 24);
    return daysSince >= 7;
  });

  // If associate, filter ALL triage data to their cases only
  const isAssociate = user.role === "associate";
  const visibleCases = isAssociate ? cases.filter((c) => c.lawyer_id === user.sub) : cases;
  const visibleBleeding = isAssociate ? bleeding.filter((c) => c.lawyer_id === user.sub) : bleeding;
  const visibleStalled = isAssociate ? stalled.filter((c) => c.lawyer_id === user.sub) : stalled;

  return c.json({
    triage: {
      bleeding: visibleBleeding.length,
      stalled: visibleStalled.length,
      total_active: visibleCases.length,
    },
    bleeding_cases: visibleBleeding,
    stalled_cases: visibleStalled,
    upcoming_deadlines: deadlines,
    lawyers: user.role === "partner" ? lawyers : [],
    client_count: clientCount,
  });
});
