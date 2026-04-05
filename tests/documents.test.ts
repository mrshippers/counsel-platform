import { describe, it, expect, vi, beforeEach } from "vitest";
import { app } from "../src/index";
import {
  TEST_ENV,
  TEST_FIRM_A,
  TEST_PARTNER,
  TEST_ASSOCIATE,
  TEST_FIRM_B_USER,
  createTestToken,
  partnerTokenPayload,
  associateTokenPayload,
  firmBTokenPayload,
} from "./helpers";

vi.mock("../src/lib/password", () => ({
  verifyPassword: vi.fn(),
  hashPassword: vi.fn().mockResolvedValue("100000:fakesalt:fakehash"),
  validatePassword: vi.fn((pw: string) => {
    if (!pw || pw.length < 8) return "Password must be at least 8 characters long";
    if (!/\d/.test(pw)) return "Password must contain at least one number";
    return null;
  }),
}));

let mockResponses: Array<{ data: unknown; error: unknown }> = [];
let mockInsertLog: unknown[] = [];
let mockUpdateLog: Array<{ data: unknown; table?: string }> = [];
let mockDeleteLog: Array<{ table: string }> = [];
let mockQueryLog: Array<{ table: string; method: string; args: unknown[] }> = [];

function createChainableMock(
  getNext: () => { data: unknown; error: unknown },
  table: string
) {
  let depth = 0;
  const proxy = (): unknown => {
    depth++;
    return new Proxy({} as Record<string, unknown>, {
      get(_target, prop: string) {
        if (prop === "then") {
          if (depth >= 2) return (resolve: (v: unknown) => void) => resolve({ data: null, error: null });
          return undefined;
        }
        return (...args: unknown[]) => {
          mockQueryLog.push({ table, method: prop, args });
          if (["single", "limit", "order"].includes(prop)) return Promise.resolve(getNext());
          return proxy();
        };
      },
    });
  };
  return proxy();
}

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: (table: string) => {
      const getNext = () => mockResponses.shift() || { data: null, error: null };
      return {
        select: (...args: unknown[]) => {
          mockQueryLog.push({ table, method: "select", args });
          return createChainableMock(getNext, table);
        },
        insert: (data: unknown) => {
          mockInsertLog.push(data);
          mockQueryLog.push({ table, method: "insert", args: [data] });
          return createChainableMock(getNext, table);
        },
        update: (data: unknown) => {
          mockUpdateLog.push({ data, table });
          mockQueryLog.push({ table, method: "update", args: [data] });
          return createChainableMock(getNext, table);
        },
        delete: () => {
          mockDeleteLog.push({ table });
          mockQueryLog.push({ table, method: "delete", args: [] });
          return createChainableMock(getNext, table);
        },
      };
    },
  }),
}));

async function authedReq(
  method: string, path: string,
  tokenPayload: Parameters<typeof createTestToken>[0],
  body?: unknown
) {
  const token = await createTestToken(tokenPayload);
  const init: RequestInit = {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
  };
  if (body) init.body = JSON.stringify(body);
  return app.request(path, init, TEST_ENV);
}

// ============================================================
// DOCUMENTS — Upload (create metadata)
// ============================================================

describe("Documents — Upload", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResponses = []; mockInsertLog = []; mockUpdateLog = [];
    mockDeleteLog = []; mockQueryLog = [];
  });

  it("POST /api/documents/cases/:caseId creates document record", async () => {
    // 1. Verify case belongs to firm
    mockResponses.push({
      data: { id: "c1", firm_id: TEST_FIRM_A.id },
      error: null,
    });
    // 2. Insert document
    mockResponses.push({
      data: {
        id: "doc-1",
        case_id: "c1",
        uploaded_by: TEST_PARTNER.id,
        file_name: "contract.pdf",
        file_type: "application/pdf",
        file_size_bytes: 1024,
        storage_path: "firms/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/cases/c1/contract.pdf",
        storage_bucket: "documents",
        created_at: "2026-04-01T00:00:00Z",
        updated_at: "2026-04-01T00:00:00Z",
      },
      error: null,
    });
    // 3. Audit log
    mockResponses.push({ data: null, error: null });

    const res = await authedReq("POST", "/api/documents/cases/c1", partnerTokenPayload(), {
      file_name: "contract.pdf",
      file_type: "application/pdf",
      file_size_bytes: 1024,
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.file_name).toBe("contract.pdf");
    expect(body.data.case_id).toBe("c1");
  });

  it("upload rejects file over 50MB", async () => {
    // Case check not needed — validation happens before DB call
    const res = await authedReq("POST", "/api/documents/cases/c1", partnerTokenPayload(), {
      file_name: "huge-video.mp4",
      file_type: "video/mp4",
      file_size_bytes: 52428801, // 50MB + 1 byte
    });

    expect(res.status).toBe(413);
  });

  it("document linked to correct case_id and uploaded_by", async () => {
    // 1. Verify case belongs to firm
    mockResponses.push({
      data: { id: "c5", firm_id: TEST_FIRM_A.id },
      error: null,
    });
    // 2. Insert document
    mockResponses.push({
      data: {
        id: "doc-2",
        case_id: "c5",
        uploaded_by: TEST_ASSOCIATE.id,
        file_name: "witness-statement.docx",
        file_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        file_size_bytes: 2048,
        storage_path: "firms/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/cases/c5/witness-statement.docx",
        storage_bucket: "documents",
      },
      error: null,
    });
    // 3. Audit
    mockResponses.push({ data: null, error: null });

    const res = await authedReq("POST", "/api/documents/cases/c5", associateTokenPayload(), {
      file_name: "witness-statement.docx",
      file_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      file_size_bytes: 2048,
    });

    expect(res.status).toBe(201);

    // Verify the insert payload had the correct case_id and uploaded_by
    const docInsert = mockInsertLog.find(
      (entry) => (entry as Record<string, unknown>).case_id === "c5"
    ) as Record<string, unknown> | undefined;
    expect(docInsert).toBeDefined();
    expect(docInsert!.case_id).toBe("c5");
    expect(docInsert!.uploaded_by).toBe(TEST_ASSOCIATE.id);
  });
});

// ============================================================
// DOCUMENTS — Delete
// ============================================================

describe("Documents — Delete", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResponses = []; mockInsertLog = []; mockUpdateLog = [];
    mockDeleteLog = []; mockQueryLog = [];
  });

  it("associate can only delete own uploads", async () => {
    // 1. Fetch document (belongs to partner, not associate)
    mockResponses.push({
      data: {
        id: "doc-1",
        case_id: "c1",
        uploaded_by: TEST_PARTNER.id, // uploaded by partner
        file_name: "contract.pdf",
      },
      error: null,
    });
    // 2. Fetch case to check firm_id
    mockResponses.push({
      data: { id: "c1", firm_id: TEST_FIRM_A.id },
      error: null,
    });

    const res = await authedReq("DELETE", "/api/documents/doc-1", associateTokenPayload());

    expect(res.status).toBe(403);
  });

  it("partner can delete any document", async () => {
    // 1. Fetch document (belongs to associate)
    mockResponses.push({
      data: {
        id: "doc-1",
        case_id: "c1",
        uploaded_by: TEST_ASSOCIATE.id, // uploaded by associate
        file_name: "notes.pdf",
      },
      error: null,
    });
    // 2. Fetch case to check firm_id
    mockResponses.push({
      data: { id: "c1", firm_id: TEST_FIRM_A.id },
      error: null,
    });
    // 3. Delete succeeds (delete().eq() — no terminal, does NOT consume response)
    // 4. Audit log
    mockResponses.push({ data: null, error: null });

    const res = await authedReq("DELETE", "/api/documents/doc-1", partnerTokenPayload());

    expect(res.status).toBe(200);
  });
});

// ============================================================
// DOCUMENTS — List
// ============================================================

describe("Documents — List", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResponses = []; mockInsertLog = []; mockUpdateLog = [];
    mockDeleteLog = []; mockQueryLog = [];
  });

  it("GET /api/documents/cases/:caseId lists documents for a case", async () => {
    // 1. Verify case belongs to firm
    mockResponses.push({
      data: { id: "c1", firm_id: TEST_FIRM_A.id },
      error: null,
    });
    // 2. Fetch documents for the case
    mockResponses.push({
      data: [
        { id: "doc-1", case_id: "c1", file_name: "contract.pdf", uploaded_by: TEST_PARTNER.id },
        { id: "doc-2", case_id: "c1", file_name: "evidence.jpg", uploaded_by: TEST_ASSOCIATE.id },
      ],
      error: null,
    });

    const res = await authedReq("GET", "/api/documents/cases/c1", partnerTokenPayload());

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(2);
    expect(body.data[0].file_name).toBe("contract.pdf");
  });

  it("document access is firm-scoped", async () => {
    // Firm B user tries to access Firm A's case documents
    // Case lookup returns null — case not in firm B
    mockResponses.push({ data: null, error: { message: "not found" } });

    const res = await authedReq("GET", "/api/documents/cases/c1", firmBTokenPayload());

    expect(res.status).toBe(404);
  });

  it("GET /api/documents/clients/:clientId returns docs across all client's cases", async () => {
    // 1. Verify client belongs to firm
    mockResponses.push({
      data: { id: "cl1", firm_id: TEST_FIRM_A.id },
      error: null,
    });
    // 2. Fetch cases for this client (to get case IDs)
    mockResponses.push({
      data: [
        { id: "c1" },
        { id: "c2" },
      ],
      error: null,
    });
    // 3. Fetch documents for those cases
    mockResponses.push({
      data: [
        { id: "doc-1", case_id: "c1", file_name: "contract.pdf" },
        { id: "doc-2", case_id: "c1", file_name: "evidence.jpg" },
        { id: "doc-3", case_id: "c2", file_name: "letter.docx" },
      ],
      error: null,
    });

    const res = await authedReq("GET", "/api/documents/clients/cl1", partnerTokenPayload());

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(3);
  });
});
