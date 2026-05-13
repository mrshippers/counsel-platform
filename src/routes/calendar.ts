import { Hono } from "hono";
import type { AppEnv } from "../index";
import { authMiddleware } from "../middleware/auth";
import { createSupabaseAdmin } from "../lib/supabase";
import * as jose from "jose";
import type { JWTPayload } from "../types";

export const calendarRoutes = new Hono<AppEnv>();

calendarRoutes.use("*", authMiddleware);

// GET /api/calendar — deadlines for firm (partner: all, associate: own)
calendarRoutes.get("/", async (c) => {
  const user = c.get("user");
  const supabase = createSupabaseAdmin(c.env);
  const month = c.req.query("month"); // YYYY-MM format

  let query = supabase
    .from("deadlines")
    .select("*")
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

// GET /api/calendar/ical — iCal feed (pass JWT as ?token= for calendar app subscriptions)
// This route bypasses the authMiddleware applied above by being declared outside the use("*") scope.
// We handle auth manually to support query-param tokens for calendar app subscriptions.
calendarRoutes.get("/ical", async (c) => {
  // Accept token from Authorization header OR ?token= query param (calendar apps use the latter)
  const tokenFromQuery = c.req.query("token");
  const authHeader = c.req.header("Authorization");
  const rawToken = tokenFromQuery || (authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null);

  if (!rawToken) {
    return c.text("Unauthorized", 401);
  }

  let user: JWTPayload;
  try {
    const secret = new TextEncoder().encode(c.env.JWT_SECRET);
    const { payload } = await jose.jwtVerify(rawToken, secret, { algorithms: ["HS256"] });
    user = payload as unknown as JWTPayload;
  } catch {
    return c.text("Unauthorized", 401);
  }

  const supabase = createSupabaseAdmin(c.env);

  let query = supabase
    .from("deadlines")
    .select("*, cases(title)")
    .eq("firm_id", user.firm_id)
    .order("date", { ascending: true });

  if (user.role === "associate") {
    query = query.eq("lawyer_id", user.sub);
  }

  const { data: deadlines } = await query;

  const fmt = (d: string) => d.replace(/-/g, "");

  const events = (deadlines || []).map((dl: {
    id: string; title: string; date: string; note?: string | null;
    cases?: { title: string } | null;
  }) => {
    const caseTitle = dl.cases?.title ? ` — ${dl.cases.title}` : "";
    const summary = `${dl.title}${caseTitle}`;
    const description = dl.note ? dl.note.replace(/\n/g, "\\n") : "";
    return [
      "BEGIN:VEVENT",
      `UID:deadline-${dl.id}@counsel-app.co.uk`,
      `DTSTART;VALUE=DATE:${fmt(dl.date)}`,
      `DTEND;VALUE=DATE:${fmt(dl.date)}`,
      `SUMMARY:${summary}`,
      description ? `DESCRIPTION:${description}` : "",
      "END:VEVENT",
    ].filter(Boolean).join("\r\n");
  }).join("\r\n");

  const ical = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Counsel//Case Management//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:Counsel Deadlines`,
    "X-WR-TIMEZONE:Europe/London",
    events,
    "END:VCALENDAR",
  ].filter(Boolean).join("\r\n");

  return new Response(ical, {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": "attachment; filename=\"counsel-deadlines.ics\"",
      "Cache-Control": "no-cache, no-store",
    },
  });
});
