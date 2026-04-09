import { Hono } from "hono";
import type { AppEnv } from "../index";
import { authMiddleware, signJWT } from "../middleware/auth";
import { createSupabaseAdmin } from "../lib/supabase";

export const portalRoutes = new Hono<AppEnv>();

// POST /api/portal/invite — generate portal access token (auth required)
portalRoutes.post("/invite", authMiddleware, async (c) => {
  const user = c.get("user");
  const body = await c.req.json().catch(() => ({}));

  if (!body.client_id) {
    return c.json({ error: "client_id is required" }, 400);
  }

  const supabase = createSupabaseAdmin(c.env);

  // Verify client belongs to firm
  const { data: client } = await supabase
    .from("clients")
    .select("id, name, email")
    .eq("id", body.client_id)
    .eq("firm_id", user.firm_id)
    .single();

  if (!client) {
    return c.json({ error: "Client not found" }, 404);
  }

  // Generate 256-bit token
  const rawToken = crypto.getRandomValues(new Uint8Array(32));
  const token = Array.from(rawToken).map(b => b.toString(16).padStart(2, "0")).join("");
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(); // 30 days

  const { data: tokenRecord, error } = await supabase
    .from("client_portal_tokens")
    .insert({
      firm_id: user.firm_id,
      client_id: body.client_id,
      token,
      expires_at: expiresAt,
    })
    .select()
    .single();

  if (error || !tokenRecord) {
    return c.json({ error: "Failed to create portal invite" }, 500);
  }

  const portalUrl = `https://counsel-app.co.uk/portal?token=${token}`;

  return c.json({
    portal_url: portalUrl,
    token,
    expires_at: expiresAt,
    client_name: client.name,
  }, 201);
});

// POST /api/portal/login — client logs in with token (public, no auth)
portalRoutes.post("/login", async (c) => {
  const body = await c.req.json().catch(() => ({}));

  if (!body.token) {
    return c.json({ error: "Token is required" }, 400);
  }

  const supabase = createSupabaseAdmin(c.env);

  // Look up token
  const { data: tokenRecord } = await supabase
    .from("client_portal_tokens")
    .select("*")
    .eq("token", body.token)
    .single();

  if (!tokenRecord) {
    return c.json({ error: "Invalid or expired token" }, 401);
  }

  // Check expiry
  if (new Date(tokenRecord.expires_at) < new Date()) {
    return c.json({ error: "Token has expired" }, 401);
  }

  // Get client data
  const { data: client } = await supabase
    .from("clients")
    .select("id, name, email, phone, type")
    .eq("id", tokenRecord.client_id)
    .single();

  if (!client) {
    return c.json({ error: "Client not found" }, 404);
  }

  // Sign a client JWT (limited scope)
  const jwt = await signJWT(
    {
      sub: client.id,
      firm_id: tokenRecord.firm_id,
      role: "client" as "partner", // special role for portal
      email: client.email || "",
    },
    c.env.JWT_SECRET,
    24 // 24-hour expiry for client tokens
  );

  return c.json({
    access_token: jwt,
    client: {
      id: client.id,
      name: client.name,
      email: client.email,
    },
  }, 200);
});

// GET /api/portal/cases — client views their cases (client auth)
portalRoutes.get("/cases", authMiddleware, async (c) => {
  const user = c.get("user");
  const supabase = createSupabaseAdmin(c.env);

  const { data, error } = await supabase
    .from("cases")
    .select("id, title, status, progress, type, opened_date, deadline, users(name)")
    .eq("client_id", user.sub)
    .eq("firm_id", user.firm_id)
    .order("created_at", { ascending: false });

  if (error) {
    return c.json({ error: "Failed to fetch cases" }, 500);
  }

  return c.json({ data }, 200);
});

// GET /api/portal/cases/:id/documents — client views documents for their case
portalRoutes.get("/cases/:id/documents", authMiddleware, async (c) => {
  const user = c.get("user");
  const caseId = c.req.param("id");
  const supabase = createSupabaseAdmin(c.env);

  // Verify case belongs to this client
  const { data: caseData } = await supabase
    .from("cases")
    .select("id, client_id, firm_id")
    .eq("id", caseId)
    .eq("client_id", user.sub)
    .eq("firm_id", user.firm_id)
    .single();

  if (!caseData) {
    return c.json({ error: "Case not found" }, 404);
  }

  const { data: docs, error } = await supabase
    .from("documents")
    .select("id, file_name, file_type, created_at")
    .eq("case_id", caseId)
    .order("created_at", { ascending: false });

  if (error) {
    return c.json({ error: "Failed to fetch documents" }, 500);
  }

  return c.json({ data: docs }, 200);
});
