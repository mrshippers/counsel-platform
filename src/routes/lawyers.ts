import { Hono } from "hono";
import type { AppEnv } from "../index";
import { authMiddleware } from "../middleware/auth";
import { partnerOnly } from "../middleware/rbac";
import { createSupabaseAdmin } from "../lib/supabase";

export const lawyersRoutes = new Hono<AppEnv>();

lawyersRoutes.use("*", authMiddleware);
lawyersRoutes.use("*", partnerOnly()); // Partner-only section

// GET /api/lawyers — list firm lawyers with workload stats
lawyersRoutes.get("/", async (c) => {
  const user = c.get("user");
  const supabase = createSupabaseAdmin(c.env);

  // Fetch users and all firm cases in parallel
  const [usersResult, casesResult] = await Promise.all([
    supabase
      .from("users")
      .select("id, name, email, role, avatar_initials, active, last_login")
      .eq("firm_id", user.firm_id)
      .order("name", { ascending: true }),

    supabase
      .from("cases")
      .select("id, lawyer_id, status, priority, deadline")
      .eq("firm_id", user.firm_id)
      .order("created_at", { ascending: false }),
  ]);

  if (usersResult.error) {
    return c.json({ error: "Failed to fetch lawyers" }, 500);
  }

  const users = usersResult.data || [];
  const cases = casesResult.data || [];

  const now = new Date();
  const sevenDaysFromNow = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

  // Build workload map keyed by lawyer_id
  const workloadMap: Record<string, { active_cases: number; urgent_cases: number; deadline_pressure: number }> = {};

  for (const cs of cases) {
    const lid = cs.lawyer_id;
    if (!workloadMap[lid]) {
      workloadMap[lid] = { active_cases: 0, urgent_cases: 0, deadline_pressure: 0 };
    }

    const isActive = cs.status !== "completed";
    if (isActive) {
      workloadMap[lid].active_cases++;
      if (cs.priority === "urgent") {
        workloadMap[lid].urgent_cases++;
      }
      if (cs.deadline) {
        const dl = new Date(cs.deadline);
        if (dl >= now && dl <= sevenDaysFromNow) {
          workloadMap[lid].deadline_pressure++;
        }
      }
    }
  }

  // Enrich each user with workload stats
  const enriched = users.map((u: { id: string }) => {
    const wl = workloadMap[u.id] || { active_cases: 0, urgent_cases: 0, deadline_pressure: 0 };
    return {
      ...u,
      workload: {
        ...wl,
        overloaded: wl.active_cases >= 8,
      },
    };
  });

  return c.json({ data: enriched }, 200);
});
