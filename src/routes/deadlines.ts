import { Hono } from "hono";
import type { AppEnv } from "../index";
import { authMiddleware } from "../middleware/auth";
import { createSupabaseAdmin } from "../lib/supabase";
import { logAuditEvent } from "../middleware/audit";
import { createEmailClient, sendDeadlineReminder } from "../lib/email";

export const deadlinesRoutes = new Hono<AppEnv>();

// All deadline routes require auth
deadlinesRoutes.use("*", authMiddleware);

// POST /api/deadlines — create deadline
deadlinesRoutes.post("/", async (c) => {
  const user = c.get("user");
  const body = await c.req.json().catch(() => ({}));

  // Validate required fields
  if (!body.title || !body.date) {
    return c.json({ error: "Missing required fields: title, date" }, 400);
  }

  const supabase = createSupabaseAdmin(c.env);

  const { data, error } = await supabase
    .from("deadlines")
    .insert({
      firm_id: user.firm_id,
      created_by: user.sub,
      title: body.title,
      date: body.date,
      case_id: body.case_id || null,
      lawyer_id: body.lawyer_id || null,
      note: body.note || null,
    })
    .select()
    .single();

  if (error || !data) {
    return c.json({ error: "Failed to create deadline" }, 500);
  }

  await logAuditEvent(c, "deadline_created", "deadline", data.id);

  return c.json({ data }, 201);
});

// GET /api/deadlines/upcoming — next 5 deadlines for dashboard
deadlinesRoutes.get("/upcoming", async (c) => {
  const user = c.get("user");
  const supabase = createSupabaseAdmin(c.env);

  let query = supabase
    .from("deadlines")
    .select("*")
    .eq("firm_id", user.firm_id)
    .gte("date", new Date().toISOString().split("T")[0]);

  // Associate: only their deadlines
  if (user.role === "associate") {
    query = query.eq("lawyer_id", user.sub);
  }

  const { data, error } = await query.order("date", { ascending: true }).limit(5);

  if (error) {
    return c.json({ error: "Failed to fetch upcoming deadlines" }, 500);
  }

  return c.json({ data }, 200);
});

// POST /api/deadlines/send-reminders — trigger 48hr deadline reminders (cron)
deadlinesRoutes.post("/send-reminders", async (c) => {
  const user = c.get("user");
  const supabase = createSupabaseAdmin(c.env);

  // Calculate 48-hour window
  const now = new Date();
  const in48h = new Date(now.getTime() + 48 * 60 * 60 * 1000);
  const todayStr = now.toISOString().split("T")[0];
  const in48hStr = in48h.toISOString().split("T")[0];

  // Fetch deadlines within 48 hours, with related case, client, and lawyer data
  const { data: deadlines, error } = await supabase
    .from("deadlines")
    .select("*, cases(title, id)")
    .eq("firm_id", user.firm_id)
    .gte("date", todayStr)
    .lte("date", in48hStr)
    .order("date", { ascending: true });

  if (error) {
    return c.json({ error: "Failed to fetch deadlines for reminders" }, 500);
  }

  // Fetch lawyer data separately to avoid ambiguous FK join
  const lawyerIds = [...new Set((deadlines || []).map((d) => d.lawyer_id).filter(Boolean))];
  const { data: lawyersData } = lawyerIds.length > 0
    ? await supabase.from("users").select("id, name, email, reminder_emails_enabled").in("id", lawyerIds)
    : { data: [] };
  const lawyerMap = new Map((lawyersData || []).map((l: { id: string }) => [l.id, l]));

  const reminders: Array<{
    deadline_id: string;
    lawyer_email: string;
    lawyer_name: string;
    case_title: string;
    deadline_date: string;
    deadline_title: string;
  }> = [];
  let skipped = 0;

  for (const deadline of deadlines || []) {
    const lawyer = lawyerMap.get(deadline.lawyer_id) as {
      id: string; name: string; email: string; reminder_emails_enabled: boolean;
    } | undefined;

    if (!lawyer || !lawyer.reminder_emails_enabled) {
      skipped++;
      continue;
    }

    const caseData = deadline.cases as { title: string; id: string } | null;

    reminders.push({
      deadline_id: deadline.id,
      lawyer_email: lawyer.email,
      lawyer_name: lawyer.name,
      case_title: caseData?.title || deadline.title,
      deadline_date: deadline.date,
      deadline_title: deadline.title,
    });
  }

  // Send reminder emails via Resend
  let emailsSent = 0;
  const emailClient = createEmailClient(c.env);
  for (const reminder of reminders) {
    try {
      await sendDeadlineReminder(
        emailClient,
        reminder.lawyer_email,
        reminder.lawyer_name,
        reminder.case_title,
        "", // client name not available in this context
        reminder.deadline_date,
        reminder.deadline_id
      );
      emailsSent++;
    } catch {
      // Log but don't fail the whole batch
    }
  }

  return c.json({ reminders, skipped, emails_sent: emailsSent, total: (deadlines || []).length }, 200);
});

// PATCH /api/deadlines/:id — update deadline (firm-scoped)
deadlinesRoutes.patch("/:id", async (c) => {
  const user = c.get("user");
  const deadlineId = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));
  const supabase = createSupabaseAdmin(c.env);

  // Verify deadline exists and belongs to firm
  const { data: existing, error: fetchError } = await supabase
    .from("deadlines")
    .select("*")
    .eq("id", deadlineId)
    .eq("firm_id", user.firm_id)
    .single();

  if (!existing || fetchError) {
    return c.json({ error: "Deadline not found" }, 404);
  }

  // Strip protected fields
  const { firm_id, id, created_at, updated_at, created_by, ...allowed } = body;

  const { data: updated, error: updateError } = await supabase
    .from("deadlines")
    .update(allowed)
    .eq("id", deadlineId)
    .select()
    .single();

  if (updateError) {
    return c.json({ error: "Failed to update deadline" }, 500);
  }

  await logAuditEvent(c, "deadline_updated", "deadline", deadlineId);

  return c.json({ data: updated }, 200);
});

// DELETE /api/deadlines/:id — delete deadline (firm-scoped)
deadlinesRoutes.delete("/:id", async (c) => {
  const user = c.get("user");
  const deadlineId = c.req.param("id");
  const supabase = createSupabaseAdmin(c.env);

  // Verify deadline exists and belongs to firm
  const { data: existing, error: fetchError } = await supabase
    .from("deadlines")
    .select("id")
    .eq("id", deadlineId)
    .eq("firm_id", user.firm_id)
    .single();

  if (!existing || fetchError) {
    return c.json({ error: "Deadline not found" }, 404);
  }

  await supabase.from("deadlines").delete().eq("id", deadlineId);
  await logAuditEvent(c, "deadline_deleted", "deadline", deadlineId);

  return c.json({ message: "Deadline deleted" }, 200);
});
