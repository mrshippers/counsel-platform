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
          if (["single", "limit"].includes(prop)) return Promise.resolve(getNext());
          // order() can be terminal OR chained (.order().limit())
          // Return a dual-purpose object: thenable AND chainable
          if (prop === "order") {
            const result = getNext();
            const orderProxy: Record<string, unknown> = {
              then: (resolve: (v: unknown) => void) => resolve(result),
              limit: (...limitArgs: unknown[]) => {
                mockQueryLog.push({ table, method: "limit", args: limitArgs });
                return Promise.resolve(result);
              },
            };
            return orderProxy;
          }
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
// GDPR — Subject Access Request (SAR Export)
// ============================================================

describe("GDPR — SAR Export", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResponses = []; mockInsertLog = []; mockUpdateLog = [];
    mockDeleteLog = []; mockQueryLog = [];
  });

  it("SAR export returns all client data as JSON", async () => {
    // 1. Verify client belongs to firm
    mockResponses.push({
      data: { id: "cl1", firm_id: TEST_FIRM_A.id, name: "John Smith", email: "john@example.com" },
      error: null,
    });
    // 2. Fetch cases for client
    mockResponses.push({
      data: [
        { id: "c1", client_id: "cl1", title: "Smith v Jones", type: "civil", status: "in_progress" },
        { id: "c2", client_id: "cl1", title: "Smith Incorporation", type: "corporate", status: "pending" },
      ],
      error: null,
    });
    // 3. Fetch tasks for those cases
    mockResponses.push({
      data: [
        { id: "t1", case_id: "c1", label: "Initial Review", done: true },
        { id: "t2", case_id: "c1", label: "Document Filing", done: false },
        { id: "t3", case_id: "c2", label: "Prepare Articles", done: false },
      ],
      error: null,
    });
    // 4. Fetch document metadata for those cases
    mockResponses.push({
      data: [
        { id: "d1", case_id: "c1", file_name: "contract.pdf", file_type: "application/pdf", file_size_bytes: 1024 },
      ],
      error: null,
    });
    // 5. Fetch deadlines for those cases
    mockResponses.push({
      data: [
        { id: "dl1", case_id: "c1", title: "Filing deadline", date: "2026-05-01" },
      ],
      error: null,
    });
    // 6. Audit log insert (no terminal — not consumed)

    const res = await authedReq("GET", "/api/gdpr/export/cl1", partnerTokenPayload());

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.client).toBeDefined();
    expect(body.client.name).toBe("John Smith");
    expect(body.cases).toHaveLength(2);
    expect(body.tasks).toHaveLength(3);
    expect(body.documents).toHaveLength(1);
    expect(body.deadlines).toHaveLength(1);
  });

  it("SAR export is firm-scoped", async () => {
    // Client lookup returns null — not in this firm
    mockResponses.push({ data: null, error: { message: "not found" } });

    const res = await authedReq("GET", "/api/gdpr/export/cl1", firmBTokenPayload());

    expect(res.status).toBe(404);
  });

  it("SAR export requires partner role", async () => {
    const res = await authedReq("GET", "/api/gdpr/export/cl1", associateTokenPayload());

    expect(res.status).toBe(403);
  });
});

// ============================================================
// GDPR — Right to Erasure
// ============================================================

describe("GDPR — Right to Erasure", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResponses = []; mockInsertLog = []; mockUpdateLog = [];
    mockDeleteLog = []; mockQueryLog = [];
  });

  it("Right to erasure deletes client", async () => {
    // 1. Verify client belongs to firm
    mockResponses.push({
      data: { id: "cl1", firm_id: TEST_FIRM_A.id, name: "John Smith" },
      error: null,
    });
    // 2. delete().eq() — no terminal, does NOT consume a response
    // 3. Audit log insert — no terminal, not consumed

    const res = await authedReq("DELETE", "/api/gdpr/erase/cl1", partnerTokenPayload());

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.message).toBe("Client data erased");
    expect(body.client_id).toBe("cl1");

    // Verify delete was called on clients table
    const clientDelete = mockDeleteLog.find((d) => d.table === "clients");
    expect(clientDelete).toBeDefined();
  });

  it("Right to erasure is firm-scoped", async () => {
    // Client lookup returns null — not in this firm
    mockResponses.push({ data: null, error: { message: "not found" } });

    const res = await authedReq("DELETE", "/api/gdpr/erase/cl1", firmBTokenPayload());

    expect(res.status).toBe(404);
  });

  it("Right to erasure requires partner role", async () => {
    const res = await authedReq("DELETE", "/api/gdpr/erase/cl1", associateTokenPayload());

    expect(res.status).toBe(403);
  });

  it("Right to erasure logs audit event", async () => {
    // 1. Verify client belongs to firm
    mockResponses.push({
      data: { id: "cl1", firm_id: TEST_FIRM_A.id, name: "John Smith" },
      error: null,
    });
    // 2. delete().eq() — no terminal, does NOT consume a response
    // 3. Audit log insert — no terminal, not consumed

    await authedReq("DELETE", "/api/gdpr/erase/cl1", partnerTokenPayload());

    // Verify audit log was inserted
    const auditInsert = mockInsertLog.find(
      (entry: unknown) => (entry as Record<string, unknown>).action === "client_erased"
    );
    expect(auditInsert).toBeDefined();
    expect((auditInsert as Record<string, unknown>).entity_type).toBe("client");
    expect((auditInsert as Record<string, unknown>).entity_id).toBe("cl1");
  });
});

// ============================================================
// EXPORT — Firm Data Export
// ============================================================

describe("Export — Firm Data", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResponses = []; mockInsertLog = []; mockUpdateLog = [];
    mockDeleteLog = []; mockQueryLog = [];
  });

  it("Firm data export returns all data", async () => {
    // 1. Fetch clients
    mockResponses.push({
      data: [
        { id: "cl1", firm_id: TEST_FIRM_A.id, name: "John Smith" },
        { id: "cl2", firm_id: TEST_FIRM_A.id, name: "Jane Doe" },
      ],
      error: null,
    });
    // 2. Fetch cases
    mockResponses.push({
      data: [
        { id: "c1", firm_id: TEST_FIRM_A.id, title: "Smith v Jones" },
      ],
      error: null,
    });
    // 3. Fetch tasks
    mockResponses.push({
      data: [
        { id: "t1", case_id: "c1", label: "Review", done: false },
      ],
      error: null,
    });
    // 4. Fetch documents (metadata only)
    mockResponses.push({
      data: [
        { id: "d1", case_id: "c1", file_name: "brief.pdf" },
      ],
      error: null,
    });
    // 5. Fetch deadlines
    mockResponses.push({
      data: [
        { id: "dl1", firm_id: TEST_FIRM_A.id, title: "Court date" },
      ],
      error: null,
    });
    // 6. Fetch users
    mockResponses.push({
      data: [
        {
          id: TEST_PARTNER.id,
          firm_id: TEST_FIRM_A.id,
          name: "Jessica Townsend",
          email: "jessica@townsend.law",
          password_hash: "$2a$10$hashedpasswordhere",
          role: "partner",
        },
      ],
      error: null,
    });
    // 7. Audit log insert — no terminal, not consumed

    const res = await authedReq("GET", "/api/export/firm", partnerTokenPayload());

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.clients).toHaveLength(2);
    expect(body.cases).toHaveLength(1);
    expect(body.tasks).toHaveLength(1);
    expect(body.documents).toHaveLength(1);
    expect(body.deadlines).toHaveLength(1);
    expect(body.users).toHaveLength(1);
    expect(body.exported_at).toBeDefined();
  });

  it("Firm data export excludes password hashes", async () => {
    // 1. Fetch clients
    mockResponses.push({ data: [], error: null });
    // 2. Fetch cases
    mockResponses.push({ data: [], error: null });
    // 3. Fetch tasks
    mockResponses.push({ data: [], error: null });
    // 4. Fetch documents
    mockResponses.push({ data: [], error: null });
    // 5. Fetch deadlines
    mockResponses.push({ data: [], error: null });
    // 6. Fetch users
    mockResponses.push({
      data: [
        {
          id: TEST_PARTNER.id,
          firm_id: TEST_FIRM_A.id,
          name: "Jessica Townsend",
          email: "jessica@townsend.law",
          password_hash: "$2a$10$hashedpasswordhere",
          role: "partner",
        },
      ],
      error: null,
    });
    // 7. Audit log insert — no terminal, not consumed

    const res = await authedReq("GET", "/api/export/firm", partnerTokenPayload());

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.users).toHaveLength(1);
    // password_hash should be stripped
    expect(body.users[0]).not.toHaveProperty("password_hash");
    // But other fields should still be present
    expect(body.users[0].name).toBe("Jessica Townsend");
    expect(body.users[0].email).toBe("jessica@townsend.law");
  });

  it("Firm data export requires partner role", async () => {
    const res = await authedReq("GET", "/api/export/firm", associateTokenPayload());

    expect(res.status).toBe(403);
  });
});
