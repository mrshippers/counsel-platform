import { Hono } from "hono";
import type { AppEnv } from "../index";
import { authMiddleware } from "../middleware/auth";
import { createSupabaseAdmin } from "../lib/supabase";
import { logAuditEvent } from "../middleware/audit";

const MAX_FILE_SIZE_BYTES = 52428800; // 50 MB

export const documentsRoutes = new Hono<AppEnv>();

documentsRoutes.use("*", authMiddleware);

// POST /api/documents/cases/:caseId/upload — upload file to R2 and record metadata
documentsRoutes.post("/cases/:caseId/upload", async (c) => {
  const user = c.get("user");
  const caseId = c.req.param("caseId");

  const supabase = createSupabaseAdmin(c.env);

  const { data: caseData, error: caseError } = await supabase
    .from("cases")
    .select("id")
    .eq("id", caseId)
    .eq("firm_id", user.firm_id)
    .single();

  if (!caseData || caseError) {
    return c.json({ error: "Case not found" }, 404);
  }

  let formData: FormData;
  try {
    formData = await c.req.formData();
  } catch {
    return c.json({ error: "Expected multipart/form-data with a 'file' field" }, 400);
  }

  const fileEntry = formData.get("file");
  if (!fileEntry || typeof fileEntry === "string") {
    return c.json({ error: "'file' field is required" }, 400);
  }
  const file = fileEntry as File;

  if (file.size > MAX_FILE_SIZE_BYTES) {
    return c.json({ error: "File exceeds maximum size of 50MB" }, 413);
  }

  // Sanitise filename to prevent path traversal
  const safeFileName = (file.name || "upload").replace(/[^a-zA-Z0-9._-]/g, "_");
  const r2Key = `firms/${user.firm_id}/cases/${caseId}/${Date.now()}-${safeFileName}`;

  await c.env.R2_DOCUMENTS.put(r2Key, file.stream(), {
    httpMetadata: { contentType: file.type || "application/octet-stream" },
    customMetadata: { uploaded_by: user.sub, case_id: caseId, firm_id: user.firm_id },
  });

  const { data: doc, error: insertError } = await supabase
    .from("documents")
    .insert({
      case_id: caseId,
      uploaded_by: user.sub,
      file_name: safeFileName,
      file_type: file.type || null,
      file_size_bytes: file.size,
      storage_path: r2Key,
      storage_bucket: "r2",
    })
    .select()
    .single();

  if (insertError || !doc) {
    return c.json({ error: "Failed to record document" }, 500);
  }

  await logAuditEvent(c, "document_uploaded", "document", doc.id);

  return c.json({ data: doc }, 201);
});

// POST /api/documents/cases/:caseId — create document metadata record only (legacy, no file upload)
documentsRoutes.post("/cases/:caseId", async (c) => {
  const user = c.get("user");
  const caseId = c.req.param("caseId");
  const body = await c.req.json().catch(() => ({}));

  if (!body.file_name) {
    return c.json({ error: "file_name is required" }, 400);
  }
  if (body.file_size_bytes && body.file_size_bytes > MAX_FILE_SIZE_BYTES) {
    return c.json({ error: "File exceeds maximum size of 50MB" }, 413);
  }

  const supabase = createSupabaseAdmin(c.env);

  const { data: caseData, error: caseError } = await supabase
    .from("cases")
    .select("id")
    .eq("id", caseId)
    .eq("firm_id", user.firm_id)
    .single();

  if (!caseData || caseError) {
    return c.json({ error: "Case not found" }, 404);
  }

  const storagePath = `firms/${user.firm_id}/cases/${caseId}/${body.file_name}`;

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

// GET /api/documents/cases/:caseId — list documents for a case
documentsRoutes.get("/cases/:caseId", async (c) => {
  const user = c.get("user");
  const caseId = c.req.param("caseId");
  const supabase = createSupabaseAdmin(c.env);

  const { data: caseData, error: caseError } = await supabase
    .from("cases")
    .select("id")
    .eq("id", caseId)
    .eq("firm_id", user.firm_id)
    .single();

  if (!caseData || caseError) {
    return c.json({ error: "Case not found" }, 404);
  }

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

  const { data: clientData, error: clientError } = await supabase
    .from("clients")
    .select("id")
    .eq("id", clientId)
    .eq("firm_id", user.firm_id)
    .single();

  if (!clientData || clientError) {
    return c.json({ error: "Client not found" }, 404);
  }

  const { data: cases, error: casesError } = await supabase
    .from("cases")
    .select("id")
    .eq("client_id", clientId)
    .eq("firm_id", user.firm_id)
    .order("id");

  if (casesError || !cases) {
    return c.json({ error: "Failed to fetch cases" }, 500);
  }

  const caseIds = cases.map((cs: { id: string }) => cs.id);
  if (caseIds.length === 0) {
    return c.json({ data: [] }, 200);
  }

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

// GET /api/documents/:id/content — stream file from R2 (or redirect to Supabase signed URL)
documentsRoutes.get("/:id/content", async (c) => {
  const user = c.get("user");
  const docId = c.req.param("id");
  const supabase = createSupabaseAdmin(c.env);

  const { data: doc, error: docError } = await supabase
    .from("documents")
    .select("*")
    .eq("id", docId)
    .single();

  if (!doc || docError) {
    return c.json({ error: "Document not found" }, 404);
  }

  const { data: caseData, error: caseError } = await supabase
    .from("cases")
    .select("id")
    .eq("id", doc.case_id)
    .eq("firm_id", user.firm_id)
    .single();

  if (!caseData || caseError) {
    return c.json({ error: "Document not found" }, 404);
  }

  if (doc.storage_bucket === "r2") {
    const object = await c.env.R2_DOCUMENTS.get(doc.storage_path);
    if (!object) {
      return c.json({ error: "File not found in storage" }, 404);
    }
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set("Content-Disposition", `attachment; filename="${doc.file_name}"`);
    headers.set("Cache-Control", "private, max-age=3600");
    return new Response(object.body, { headers });
  }

  // Fallback: Supabase storage signed URL
  const { data: signedData, error: signError } = await supabase.storage
    .from(doc.storage_bucket)
    .createSignedUrl(doc.storage_path, 3600);

  if (signError || !signedData) {
    return c.json({ error: "Failed to generate download URL" }, 500);
  }

  return c.redirect(signedData.signedUrl, 302);
});

// GET /api/documents/:id/download-url — signed URL (legacy, kept for backward compat)
documentsRoutes.get("/:id/download-url", async (c) => {
  const user = c.get("user");
  const docId = c.req.param("id");
  const supabase = createSupabaseAdmin(c.env);

  const { data: doc, error: docError } = await supabase
    .from("documents")
    .select("*")
    .eq("id", docId)
    .single();

  if (!doc || docError) {
    return c.json({ error: "Document not found" }, 404);
  }

  const { data: caseData, error: caseError } = await supabase
    .from("cases")
    .select("id")
    .eq("id", doc.case_id)
    .eq("firm_id", user.firm_id)
    .single();

  if (!caseData || caseError) {
    return c.json({ error: "Document not found" }, 404);
  }

  if (doc.storage_bucket === "r2") {
    // For R2 docs, return the /content URL instead of a presigned URL
    return c.json({ url: `/api/documents/${docId}/content`, expires_in: 3600 }, 200);
  }

  const { data: signedData, error: signError } = await supabase.storage
    .from(doc.storage_bucket)
    .createSignedUrl(doc.storage_path, 3600);

  if (signError || !signedData) {
    return c.json({ error: "Failed to generate download URL" }, 500);
  }

  return c.json({ url: signedData.signedUrl, expires_in: 3600 }, 200);
});

// DELETE /api/documents/:id
documentsRoutes.delete("/:id", async (c) => {
  const user = c.get("user");
  const docId = c.req.param("id");
  const supabase = createSupabaseAdmin(c.env);

  const { data: doc, error: docError } = await supabase
    .from("documents")
    .select("*")
    .eq("id", docId)
    .single();

  if (!doc || docError) {
    return c.json({ error: "Document not found" }, 404);
  }

  const { data: caseData, error: caseError } = await supabase
    .from("cases")
    .select("id")
    .eq("id", doc.case_id)
    .eq("firm_id", user.firm_id)
    .single();

  if (!caseData || caseError) {
    return c.json({ error: "Document not found" }, 404);
  }

  if (user.role === "associate" && doc.uploaded_by !== user.sub) {
    return c.json({ error: "Forbidden" }, 403);
  }

  // Delete from R2 if stored there
  if (doc.storage_bucket === "r2") {
    await c.env.R2_DOCUMENTS.delete(doc.storage_path);
  }

  await supabase.from("documents").delete().eq("id", docId);
  await logAuditEvent(c, "document_deleted", "document", docId);

  return c.json({ message: "Document deleted" }, 200);
});
