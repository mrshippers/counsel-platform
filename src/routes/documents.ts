import { Hono } from "hono";
import type { AppEnv } from "../index";
import { authMiddleware } from "../middleware/auth";
import { createSupabaseAdmin } from "../lib/supabase";
import { logAuditEvent } from "../middleware/audit";

const MAX_FILE_SIZE_BYTES = 52428800; // 50 MB

export const documentsRoutes = new Hono<AppEnv>();

// All document routes require auth
documentsRoutes.use("*", authMiddleware);

// POST /api/documents/cases/:caseId — create document metadata record
documentsRoutes.post("/cases/:caseId", async (c) => {
  const user = c.get("user");
  const caseId = c.req.param("caseId");
  const body = await c.req.json().catch(() => ({}));

  // Validate required fields
  if (!body.file_name) {
    return c.json({ error: "file_name is required" }, 400);
  }

  // Validate file size before any DB call
  if (body.file_size_bytes && body.file_size_bytes > MAX_FILE_SIZE_BYTES) {
    return c.json({ error: "File exceeds maximum size of 50MB" }, 413);
  }

  const supabase = createSupabaseAdmin(c.env);

  // Verify case belongs to user's firm
  const { data: caseData, error: caseError } = await supabase
    .from("cases")
    .select("id")
    .eq("id", caseId)
    .eq("firm_id", user.firm_id)
    .single();

  if (!caseData || caseError) {
    return c.json({ error: "Case not found" }, 404);
  }

  // Build storage path
  const storagePath = `firms/${user.firm_id}/cases/${caseId}/${body.file_name}`;

  // Insert document record
  const { data: doc, error: insertError } = await supabase
    .from("documents")
    .insert({
      case_id: caseId,
      uploaded_by: user.sub,
      file_name: body.file_name,
      file_type: body.file_type || null,
      file_size_bytes: body.file_size_bytes || null,
      storage_path: storagePath,
      storage_bucket: "documents",
    })
    .select()
    .single();

  if (insertError || !doc) {
    return c.json({ error: "Failed to create document record" }, 500);
  }

  await logAuditEvent(c, "document_uploaded", "document", doc.id);

  return c.json({ data: doc }, 201);
});

// GET /api/documents/cases/:caseId — list documents for a case (firm-scoped)
documentsRoutes.get("/cases/:caseId", async (c) => {
  const user = c.get("user");
  const caseId = c.req.param("caseId");
  const supabase = createSupabaseAdmin(c.env);

  // Verify case belongs to user's firm
  const { data: caseData, error: caseError } = await supabase
    .from("cases")
    .select("id")
    .eq("id", caseId)
    .eq("firm_id", user.firm_id)
    .single();

  if (!caseData || caseError) {
    return c.json({ error: "Case not found" }, 404);
  }

  // Fetch documents for this case
  const { data: docs, error: docsError } = await supabase
    .from("documents")
    .select("*")
    .eq("case_id", caseId)
    .order("created_at", { ascending: false });

  if (docsError) {
    return c.json({ error: "Failed to fetch documents" }, 500);
  }

  return c.json({ data: docs }, 200);
});

// GET /api/documents/clients/:clientId — list documents across all client's cases
documentsRoutes.get("/clients/:clientId", async (c) => {
  const user = c.get("user");
  const clientId = c.req.param("clientId");
  const supabase = createSupabaseAdmin(c.env);

  // Verify client belongs to user's firm
  const { data: clientData, error: clientError } = await supabase
    .from("clients")
    .select("id")
    .eq("id", clientId)
    .eq("firm_id", user.firm_id)
    .single();

  if (!clientData || clientError) {
    return c.json({ error: "Client not found" }, 404);
  }

  // Get all case IDs for this client
  const { data: cases, error: casesError } = await supabase
    .from("cases")
    .select("id")
    .eq("client_id", clientId)
    .eq("firm_id", user.firm_id)
    .order("created_at", { ascending: false });

  if (casesError || !cases) {
    return c.json({ error: "Failed to fetch cases" }, 500);
  }

  const caseIds = cases.map((cs: { id: string }) => cs.id);

  if (caseIds.length === 0) {
    return c.json({ data: [] }, 200);
  }

  // Fetch all documents for those cases
  const { data: docs, error: docsError } = await supabase
    .from("documents")
    .select("*")
    .in("case_id", caseIds)
    .order("created_at", { ascending: false });

  if (docsError) {
    return c.json({ error: "Failed to fetch documents" }, 500);
  }

  return c.json({ data: docs }, 200);
});

// DELETE /api/documents/:id — delete document (associate: own only, partner: any in firm)
documentsRoutes.delete("/:id", async (c) => {
  const user = c.get("user");
  const docId = c.req.param("id");
  const supabase = createSupabaseAdmin(c.env);

  // Fetch the document
  const { data: doc, error: docError } = await supabase
    .from("documents")
    .select("*")
    .eq("id", docId)
    .single();

  if (!doc || docError) {
    return c.json({ error: "Document not found" }, 404);
  }

  // Verify the document's case belongs to user's firm
  const { data: caseData, error: caseError } = await supabase
    .from("cases")
    .select("id")
    .eq("id", doc.case_id)
    .eq("firm_id", user.firm_id)
    .single();

  if (!caseData || caseError) {
    return c.json({ error: "Document not found" }, 404);
  }

  // Associate can only delete their own uploads
  if (user.role === "associate" && doc.uploaded_by !== user.sub) {
    return c.json({ error: "Forbidden" }, 403);
  }

  // Delete the document record
  await supabase.from("documents").delete().eq("id", docId);

  await logAuditEvent(c, "document_deleted", "document", docId);

  return c.json({ message: "Document deleted" }, 200);
});
