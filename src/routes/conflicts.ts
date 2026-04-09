import { Hono } from "hono";
import type { AppEnv } from "../index";
import { authMiddleware } from "../middleware/auth";
import { createSupabaseAdmin } from "../lib/supabase";
import { logAuditEvent } from "../middleware/audit";
import type { ConflictPartyType } from "../types";

const VALID_PARTY_TYPES: ConflictPartyType[] = ["client", "opposing", "witness", "related"];

export const conflictsRoutes = new Hono<AppEnv>();

conflictsRoutes.use("*", authMiddleware);

// POST /api/conflicts/check — check a name against all existing parties and clients
conflictsRoutes.post("/check", async (c) => {
  const user = c.get("user");
  const body = await c.req.json().catch(() => ({}));

  if (!body.party_name || typeof body.party_name !== "string" || !body.party_name.trim()) {
    return c.json({ error: "party_name is required" }, 400);
  }

  const supabase = createSupabaseAdmin(c.env);
  const searchName = body.party_name.trim();

  // Check against conflict_parties table
  const { data: partyMatches, error: partyError } = await supabase
    .from("conflict_parties")
    .select("*, cases(title), clients(name)")
    .eq("firm_id", user.firm_id)
    .ilike("party_name", `%${searchName}%`)
    .order("created_at", { ascending: false });

  if (partyError) {
    return c.json({ error: "Failed to check conflicts" }, 500);
  }

  // Also check against clients table (existing clients of the firm)
  const { data: clientMatches, error: clientError } = await supabase
    .from("clients")
    .select("id, name, type")
    .eq("firm_id", user.firm_id)
    .ilike("name", `%${searchName}%`)
    .order("name", { ascending: true });

  if (clientError) {
    return c.json({ error: "Failed to check client conflicts" }, 500);
  }

  const matches = partyMatches || [];
  const clientResults = clientMatches || [];
  const hasConflict = matches.length > 0 || clientResults.length > 0;

  return c.json({
    has_conflict: hasConflict,
    matches,
    client_matches: clientResults,
    searched_name: searchName,
  }, 200);
});

// POST /api/conflicts/parties — add a party to a case
conflictsRoutes.post("/parties", async (c) => {
  const user = c.get("user");
  const body = await c.req.json().catch(() => ({}));

  if (!body.case_id || !body.party_name || !body.party_type) {
    return c.json({ error: "Missing required fields: case_id, party_name, party_type" }, 400);
  }

  if (!VALID_PARTY_TYPES.includes(body.party_type)) {
    return c.json({ error: `Invalid party_type. Must be one of: ${VALID_PARTY_TYPES.join(", ")}` }, 400);
  }

  const supabase = createSupabaseAdmin(c.env);

  // Verify case belongs to this firm
  const { data: caseData } = await supabase
    .from("cases")
    .select("id, firm_id")
    .eq("id", body.case_id)
    .eq("firm_id", user.firm_id)
    .single();

  if (!caseData) {
    return c.json({ error: "Case not found" }, 404);
  }

  const { data: party, error } = await supabase
    .from("conflict_parties")
    .insert({
      firm_id: user.firm_id,
      case_id: body.case_id,
      client_id: body.client_id || null,
      party_name: body.party_name,
      party_type: body.party_type,
      notes: body.notes || null,
    })
    .select()
    .single();

  if (error || !party) {
    return c.json({ error: "Failed to add party" }, 500);
  }

  await logAuditEvent(c, "conflict_party_added", "conflict_party", party.id);

  return c.json({ data: party }, 201);
});

// GET /api/conflicts/parties — list parties for a case
conflictsRoutes.get("/parties", async (c) => {
  const user = c.get("user");
  const caseId = c.req.query("case_id");

  if (!caseId) {
    return c.json({ error: "case_id query parameter is required" }, 400);
  }

  const supabase = createSupabaseAdmin(c.env);

  const { data, error } = await supabase
    .from("conflict_parties")
    .select("*")
    .eq("firm_id", user.firm_id)
    .eq("case_id", caseId)
    .order("created_at", { ascending: false });

  if (error) {
    return c.json({ error: "Failed to fetch parties" }, 500);
  }

  return c.json({ data }, 200);
});

// DELETE /api/conflicts/parties/:id — partner only
conflictsRoutes.delete("/parties/:id", async (c) => {
  const user = c.get("user");
  const partyId = c.req.param("id");

  if (user.role !== "partner") {
    return c.json({ error: "Forbidden" }, 403);
  }

  const supabase = createSupabaseAdmin(c.env);

  const { data: existing } = await supabase
    .from("conflict_parties")
    .select("id")
    .eq("id", partyId)
    .eq("firm_id", user.firm_id)
    .single();

  if (!existing) {
    return c.json({ error: "Party not found" }, 404);
  }

  await supabase.from("conflict_parties").delete().eq("id", partyId);
  await logAuditEvent(c, "conflict_party_deleted", "conflict_party", partyId);

  return c.json({ message: "Party deleted" }, 200);
});
