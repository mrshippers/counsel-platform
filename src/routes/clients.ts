import { Hono } from "hono";
import type { AppEnv } from "../index";
import { authMiddleware } from "../middleware/auth";
import { createSupabaseAdmin } from "../lib/supabase";
import { logAuditEvent } from "../middleware/audit";

export const clientsRoutes = new Hono<AppEnv>();

clientsRoutes.use("*", authMiddleware);

// GET /api/clients — list clients (firm-scoped)
clientsRoutes.get("/", async (c) => {
  const user = c.get("user");
  const supabase = createSupabaseAdmin(c.env);

  const { data, error } = await supabase
    .from("clients")
    .select("*")
    .eq("firm_id", user.firm_id)
    .order("name", { ascending: true });

  if (error) {
    return c.json({ error: "Failed to fetch clients" }, 500);
  }

  return c.json({ data }, 200);
});

// POST /api/clients — create client
clientsRoutes.post("/", async (c) => {
  const user = c.get("user");
  const body = await c.req.json().catch(() => ({}));

  if (!body.name) {
    return c.json({ error: "Client name is required" }, 400);
  }

  const supabase = createSupabaseAdmin(c.env);

  const { data, error } = await supabase
    .from("clients")
    .insert({
      firm_id: user.firm_id,
      name: body.name,
      email: body.email || null,
      phone: body.phone || null,
      type: body.type || "individual",
      companies_house_number: body.companies_house_number || null,
      notes: body.notes || null,
    })
    .select()
    .single();

  if (error || !data) {
    return c.json({ error: "Failed to create client" }, 500);
  }

  await logAuditEvent(c, "client_created", "client", data.id);

  return c.json({ data }, 201);
});

// GET /api/clients/:id — single client with cases and documents
clientsRoutes.get("/:id", async (c) => {
  const user = c.get("user");
  const clientId = c.req.param("id");
  const supabase = createSupabaseAdmin(c.env);

  const { data, error } = await supabase
    .from("clients")
    .select("*, cases(*, tasks(*), documents(*))")
    .eq("id", clientId)
    .eq("firm_id", user.firm_id)
    .single();

  if (!data || error) {
    return c.json({ error: "Client not found" }, 404);
  }

  return c.json({ data }, 200);
});

// PATCH /api/clients/:id — update client
clientsRoutes.patch("/:id", async (c) => {
  const user = c.get("user");
  const clientId = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));
  const supabase = createSupabaseAdmin(c.env);

  // Verify client belongs to firm
  const { data: existing, error: fetchError } = await supabase
    .from("clients")
    .select("id")
    .eq("id", clientId)
    .eq("firm_id", user.firm_id)
    .single();

  if (!existing || fetchError) {
    return c.json({ error: "Client not found" }, 404);
  }

  // Strip protected fields
  const { firm_id, id, created_at, updated_at, ...allowed } = body;

  const { data: updated, error: updateError } = await supabase
    .from("clients")
    .update(allowed)
    .eq("id", clientId)
    .select()
    .single();

  if (updateError) {
    return c.json({ error: "Failed to update client" }, 500);
  }

  await logAuditEvent(c, "client_updated", "client", clientId);

  return c.json({ data: updated }, 200);
});

// DELETE /api/clients/:id — partner only (cascades to cases, tasks, docs)
clientsRoutes.delete("/:id", async (c) => {
  const user = c.get("user");
  const clientId = c.req.param("id");
  const supabase = createSupabaseAdmin(c.env);

  if (user.role !== "partner") {
    return c.json({ error: "Forbidden" }, 403);
  }

  const { data: existing, error: fetchError } = await supabase
    .from("clients")
    .select("id")
    .eq("id", clientId)
    .eq("firm_id", user.firm_id)
    .single();

  if (!existing || fetchError) {
    return c.json({ error: "Client not found" }, 404);
  }

  await supabase.from("clients").delete().eq("id", clientId);
  await logAuditEvent(c, "client_deleted", "client", clientId);

  return c.json({ message: "Client deleted" }, 200);
});
