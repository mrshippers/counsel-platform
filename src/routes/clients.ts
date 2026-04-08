import { Hono } from "hono";
import type { AppEnv } from "../index";
import { authMiddleware } from "../middleware/auth";
import { createSupabaseAdmin } from "../lib/supabase";
import { logAuditEvent } from "../middleware/audit";

export const clientsRoutes = new Hono<AppEnv>();

clientsRoutes.use("*", authMiddleware);

// Generate next client reference number (CLT-0001 format)
async function generateClientReference(
  supabase: ReturnType<typeof createSupabaseAdmin>,
  firmId: string
): Promise<string> {
  const { count } = await supabase
    .from("clients")
    .select("*", { count: "exact", head: true })
    .eq("firm_id", firmId);

  const nextNum = (count || 0) + 1;
  return `CLT-${String(nextNum).padStart(4, "0")}`;
}

// GET /api/clients — list clients (firm-scoped)
clientsRoutes.get("/", async (c) => {
  const user = c.get("user");
  const supabase = createSupabaseAdmin(c.env);
  const search = c.req.query("search");

  let query = supabase
    .from("clients")
    .select("*")
    .eq("firm_id", user.firm_id);

  if (search) {
    query = query.or(
      `first_name.ilike.%${search}%,last_name.ilike.%${search}%,email.ilike.%${search}%,reference_number.ilike.%${search}%,company_number.ilike.%${search}%`
    );
  }

  const { data, error } = await query.order("last_name", { ascending: true });

  if (error) {
    return c.json({ error: "Failed to fetch clients" }, 500);
  }

  return c.json({ data }, 200);
});

// POST /api/clients — create client
clientsRoutes.post("/", async (c) => {
  const user = c.get("user");
  const body = await c.req.json().catch(() => ({}));

  if (!body.first_name || !body.last_name) {
    return c.json({ error: "First name and last name are required" }, 400);
  }

  const clientType = body.client_type || "personal";
  if (!["personal", "business"].includes(clientType)) {
    return c.json({ error: "Client type must be personal or business" }, 400);
  }

  const supabase = createSupabaseAdmin(c.env);

  // Auto-generate reference number
  const referenceNumber = await generateClientReference(supabase, user.firm_id);

  const { data, error } = await supabase
    .from("clients")
    .insert({
      firm_id: user.firm_id,
      reference_number: referenceNumber,
      first_name: body.first_name.trim(),
      last_name: body.last_name.trim(),
      date_of_birth: body.date_of_birth || null,
      email: body.email || null,
      mobile_phone: body.mobile_phone || null,
      landline_phone: body.landline_phone || null,
      address_line_1: body.address_line_1 || null,
      address_line_2: body.address_line_2 || null,
      city: body.city || null,
      county: body.county || null,
      postcode: body.postcode || null,
      national_insurance_number: body.national_insurance_number || null,
      company_number: body.company_number || null,
      client_type: clientType,
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

// GET /api/clients/:id/active-cases — check for active cases (conflict of interest)
clientsRoutes.get("/:id/active-cases", async (c) => {
  const user = c.get("user");
  const clientId = c.req.param("id");
  const supabase = createSupabaseAdmin(c.env);

  const { data, error } = await supabase
    .from("cases")
    .select("id, title, status, lawyer_id, users(name)")
    .eq("client_id", clientId)
    .eq("firm_id", user.firm_id)
    .in("status", ["pending", "in_progress"]);

  if (error) {
    return c.json({ error: "Failed to check active cases" }, 500);
  }

  return c.json({ data: data || [], has_active_cases: (data || []).length > 0 }, 200);
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

  // Validate client_type if provided
  if (body.client_type && !["personal", "business"].includes(body.client_type)) {
    return c.json({ error: "Client type must be personal or business" }, 400);
  }

  // Strip protected fields
  const { firm_id, id, created_at, updated_at, reference_number, ...allowed } = body;

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
