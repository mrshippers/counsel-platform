import { Hono } from "hono";
import type { AppEnv } from "../index";
import { authMiddleware } from "../middleware/auth";
import { createSupabaseAdmin } from "../lib/supabase";

export const calendarRoutes = new Hono<AppEnv>();

calendarRoutes.use("*", authMiddleware);

// GET /api/calendar — deadlines for firm (partner: all, associate: own)
calendarRoutes.get("/", async (c) => {
  const user = c.get("user");
  const supabase = createSupabaseAdmin(c.env);
  const month = c.req.query("month"); // YYYY-MM format

  let query = supabase
    .from("deadlines")
    .select("*, cases(title, status), users(name, avatar_initials)")
    .eq("firm_id", user.firm_id);

  // Associate: only their deadlines
  if (user.role === "associate") {
    query = query.eq("lawyer_id", user.sub);
  }

  // Filter by month if provided
  if (month && !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    return c.json({ error: "Invalid month format. Use YYYY-MM." }, 400);
  }

  if (month) {
    const start = `${month}-01`;
    const [year, m] = month.split("-").map(Number);
    const lastDay = new Date(year, m, 0).getDate();
    const end = `${month}-${lastDay}`;
    query = query.gte("date", start).lte("date", end);
  }

  const { data, error } = await query.order("date", { ascending: true });

  if (error) {
    return c.json({ error: "Failed to fetch calendar" }, 500);
  }

  return c.json({ data }, 200);
});
