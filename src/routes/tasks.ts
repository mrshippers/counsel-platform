import { Hono } from "hono";
import type { AppEnv } from "../index";
import { authMiddleware } from "../middleware/auth";
import { createSupabaseAdmin } from "../lib/supabase";
import { logAuditEvent } from "../middleware/audit";

export const tasksRoutes = new Hono<AppEnv>();

tasksRoutes.use("*", authMiddleware);

// PATCH /api/tasks/:id — toggle task done/undone + recalculate case progress
tasksRoutes.patch("/:id", async (c) => {
  const user = c.get("user");
  const taskId = c.req.param("id");
  const body = await c.req.json<{ done: boolean }>().catch(() => ({ done: false }));
  const supabase = createSupabaseAdmin(c.env);

  // Get the task
  const { data: task, error: taskError } = await supabase
    .from("tasks")
    .select("*")
    .eq("id", taskId)
    .single();

  if (!task || taskError) {
    return c.json({ error: "Task not found" }, 404);
  }

  // Verify parent case belongs to user's firm
  const { data: parentCase } = await supabase
    .from("cases")
    .select("firm_id, lawyer_id")
    .eq("id", task.case_id)
    .single();

  if (!parentCase || parentCase.firm_id !== user.firm_id) {
    return c.json({ error: "Task not found" }, 404);
  }
  if (user.role === "associate" && parentCase.lawyer_id !== user.sub) {
    return c.json({ error: "Forbidden" }, 403);
  }

  // Update the task
  const { error: updateError } = await supabase
    .from("tasks")
    .update({ done: body.done })
    .eq("id", taskId)
    .single();

  if (updateError) {
    return c.json({ error: "Failed to update task" }, 500);
  }

  // Get all tasks for this case to recalculate progress
  const { data: allTasks } = await supabase
    .from("tasks")
    .select("id, done")
    .eq("case_id", task.case_id)
    .order("order_index", { ascending: true });

  const tasks = allTasks || [];
  const doneCount = tasks.filter((t) => t.id === taskId ? body.done : t.done).length;
  const totalCount = tasks.length;
  const progress = totalCount > 0 ? Math.round((doneCount / totalCount) * 100) : 0;

  // Determine case status based on progress
  let caseStatus: string;
  if (progress === 0) {
    caseStatus = "pending";
  } else if (progress === 100) {
    caseStatus = "completed";
  } else {
    caseStatus = "in_progress";
  }

  // Update case progress and status
  await supabase
    .from("cases")
    .update({ progress, status: caseStatus })
    .eq("id", task.case_id)
    .single();

  // Audit log
  await logAuditEvent(c, body.done ? "task_completed" : "task_unchecked", "task", taskId);

  return c.json({
    task: { ...task, done: body.done },
    case_progress: progress,
    case_status: caseStatus,
  }, 200);
});

// Helper: recalculate case progress from tasks
async function recalculateCaseProgress(
  supabase: ReturnType<typeof createSupabaseAdmin>,
  caseId: string
) {
  const { data: allTasks } = await supabase
    .from("tasks")
    .select("id, done")
    .eq("case_id", caseId)
    .order("order_index", { ascending: true });

  const tasks = allTasks || [];
  const doneCount = tasks.filter((t) => t.done).length;
  const totalCount = tasks.length;
  const progress = totalCount > 0 ? Math.round((doneCount / totalCount) * 100) : 0;

  let caseStatus: string;
  if (progress === 0) caseStatus = "pending";
  else if (progress === 100) caseStatus = "completed";
  else caseStatus = "in_progress";

  await supabase
    .from("cases")
    .update({ progress, status: caseStatus })
    .eq("id", caseId)
    .single();

  return { progress, caseStatus };
}

// POST /api/tasks — add custom task to a case
tasksRoutes.post("/", async (c) => {
  const user = c.get("user");
  const body = await c.req.json().catch(() => ({}));
  const supabase = createSupabaseAdmin(c.env);

  if (!body.case_id || !body.label) {
    return c.json({ error: "case_id and label are required" }, 400);
  }

  // Verify case belongs to user's firm
  const { data: caseData, error: caseError } = await supabase
    .from("cases")
    .select("id, firm_id")
    .eq("id", body.case_id)
    .eq("firm_id", user.firm_id)
    .single();

  if (!caseData || caseError) {
    return c.json({ error: "Case not found" }, 404);
  }

  // Get max order_index for this case
  const { data: newTask, error: insertError } = await supabase
    .from("tasks")
    .insert({
      case_id: body.case_id,
      label: body.label,
      done: false,
      order_index: body.order_index ?? 99,
    })
    .select()
    .single();

  if (insertError || !newTask) {
    return c.json({ error: "Failed to create task" }, 500);
  }

  // Recalculate progress (adding a new undone task lowers completion %)
  const { progress, caseStatus } = await recalculateCaseProgress(supabase, body.case_id);

  await logAuditEvent(c, "task_created", "task", newTask.id);

  return c.json({
    data: newTask,
    case_progress: progress,
    case_status: caseStatus,
  }, 201);
});

// DELETE /api/tasks/:id — remove task and recalculate
tasksRoutes.delete("/:id", async (c) => {
  const user = c.get("user");
  const taskId = c.req.param("id");
  const supabase = createSupabaseAdmin(c.env);

  // Get the task
  const { data: task, error: taskError } = await supabase
    .from("tasks")
    .select("*")
    .eq("id", taskId)
    .single();

  if (!task || taskError) {
    return c.json({ error: "Task not found" }, 404);
  }

  // Verify the parent case belongs to this firm
  const { data: caseData, error: caseError } = await supabase
    .from("cases")
    .select("id, firm_id")
    .eq("id", task.case_id)
    .eq("firm_id", user.firm_id)
    .single();

  if (!caseData || caseError) {
    return c.json({ error: "Case not found" }, 404);
  }

  // Delete the task
  await supabase.from("tasks").delete().eq("id", taskId);

  // Recalculate progress
  const { progress, caseStatus } = await recalculateCaseProgress(supabase, task.case_id);

  await logAuditEvent(c, "task_deleted", "task", taskId);

  return c.json({
    message: "Task deleted",
    case_progress: progress,
    case_status: caseStatus,
  }, 200);
});
