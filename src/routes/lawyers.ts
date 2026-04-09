import { Hono } from "hono";
import type { AppEnv } from "../index";
import { authMiddleware } from "../middleware/auth";
import { partnerOnly } from "../middleware/rbac";
import { createSupabaseAdmin } from "../lib/supabase";
import { hashPassword, validatePassword } from "../lib/password";
import { logAuditEvent } from "../middleware/audit";

export const lawyersRoutes = new Hono<AppEnv>();

lawyersRoutes.use("*", authMiddleware);
lawyersRoutes.use("*", partnerOnly()); // Partner-only section

// POST /api/lawyers — add new lawyer to firm
lawyersRoutes.post("/", async (c) => {
  const user = c.get("user");
  const body = await c.req.json().catch(() => ({}));

  // Validate required fields
  if (!body.name || !body.email || !body.password || !body.role) {
    return c.json({ error: "name, email, password, and role are required" }, 400);
  }

  // Validate role
  if (!["partner", "associate"].includes(body.role)) {
    return c.json({ error: "role must be 'partner' or 'associate'" }, 400);
  }

  // Validate password strength
  const pwError = validatePassword(body.password);
  if (pwError) {
    return c.json({ error: pwError }, 400);
  }

  // Hash password
  const password_hash = await hashPassword(body.password);

  const supabase = createSupabaseAdmin(c.env);

  // Plan limit enforcement
  const PLAN_LIMITS: Record<string, number> = {
    solo: 1,
    starter: 5,
    professional: 10,
    enterprise: 20,
  };
  const PLAN_UPGRADES: Record<string, string> = {
    solo: "starter",
    starter: "professional",
    professional: "enterprise",
  };

  const { data: firm } = await supabase
    .from("firms")
    .select("id, plan")
    .eq("id", user.firm_id)
    .single();

  const firmPlan = (firm?.plan as string) || "solo";
  const maxUsers = PLAN_LIMITS[firmPlan] || 1;

  const { data: existingUsers } = await supabase
    .from("users")
    .select("id")
    .eq("firm_id", user.firm_id)
    .order("created_at", { ascending: true });

  const currentCount = (existingUsers || []).length;

  if (currentCount >= maxUsers) {
    return c.json({
      error: `Plan limit reached. Your ${firmPlan} plan allows ${maxUsers} user(s).`,
      max_users: maxUsers,
      current_users: currentCount,
      upgrade_to: PLAN_UPGRADES[firmPlan] || null,
    }, 403);
  }

  // Build initials from name
  const nameParts = body.name.trim().split(/\s+/);
  const avatar_initials = nameParts.length >= 2
    ? (nameParts[0][0] + nameParts[nameParts.length - 1][0]).toUpperCase()
    : body.name.slice(0, 2).toUpperCase();

  // Insert user — firm_id always from JWT, never from request body
  const { data: newUser, error: insertError } = await supabase
    .from("users")
    .insert({
      firm_id: user.firm_id,
      name: body.name,
      email: body.email,
      password_hash,
      role: body.role,
      avatar_initials,
      active: true,
    })
    .select()
    .single();

  if (insertError || !newUser) {
    return c.json({ error: "Failed to create lawyer" }, 500);
  }

  await logAuditEvent(c, "lawyer_added", "user", newUser.id);

  // Strip password_hash from response
  const { password_hash: _ph, ...safeUser } = newUser as Record<string, unknown>;

  return c.json({ data: safeUser }, 201);
});

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
