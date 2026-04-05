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

  const { data, error } = await supabase
    .from("users")
    .select("id, name, email, role, avatar_initials, active, last_login")
    .eq("firm_id", user.firm_id)
    .order("name", { ascending: true });

  if (error) {
    return c.json({ error: "Failed to fetch lawyers" }, 500);
  }

  return c.json({ data }, 200);
});
