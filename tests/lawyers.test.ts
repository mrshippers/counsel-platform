import { describe, it, expect, vi, beforeEach } from "vitest";
import { app } from "../src/index";
import {
  TEST_ENV,
  TEST_FIRM_A,
  TEST_PARTNER,
  TEST_ASSOCIATE,
  createTestToken,
  partnerTokenPayload,
  associateTokenPayload,
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
let mockStorageSignedUrl: { data: unknown; error: unknown } = { data: null, error: null };

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
    storage: {
      from: (_bucket: string) => ({
        createSignedUrl: vi.fn().mockImplementation(() => Promise.resolve(mockStorageSignedUrl)),
      }),
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
// POST /api/lawyers — Add new lawyer
// ============================================================

describe("POST /api/lawyers — Add new lawyer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResponses = []; mockInsertLog = []; mockUpdateLog = [];
    mockDeleteLog = []; mockQueryLog = [];
    mockStorageSignedUrl = { data: null, error: null };
  });

  it("POST /api/lawyers creates new lawyer", async () => {
    // Insert user
    mockResponses.push({
      data: {
        id: "new-lawyer-id",
        firm_id: TEST_FIRM_A.id,
        name: "Sarah Connor",
        email: "sarah@townsend.law",
        role: "associate",
        avatar_initials: "SC",
        active: true,
        last_login: null,
        created_at: "2026-04-06T00:00:00Z",
        updated_at: "2026-04-06T00:00:00Z",
      },
      error: null,
    });
    // Audit log
    mockResponses.push({ data: null, error: null });

    const res = await authedReq("POST", "/api/lawyers", partnerTokenPayload(), {
      name: "Sarah Connor",
      email: "sarah@townsend.law",
      password: "Secure1Pass",
      role: "associate",
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data).toHaveProperty("name", "Sarah Connor");
    expect(body.data).toHaveProperty("role", "associate");
    expect(body.data).not.toHaveProperty("password_hash");
  });

  it("requires partner role", async () => {
    const res = await authedReq("POST", "/api/lawyers", associateTokenPayload(), {
      name: "Sarah Connor",
      email: "sarah@townsend.law",
      password: "Secure1Pass",
      role: "associate",
    });

    expect(res.status).toBe(403);
  });

  it("validates required fields", async () => {
    const res = await authedReq("POST", "/api/lawyers", partnerTokenPayload(), {
      email: "sarah@townsend.law",
      password: "Secure1Pass",
      role: "associate",
      // missing name
    });

    expect(res.status).toBe(400);
  });

  it("validates password strength", async () => {
    const res = await authedReq("POST", "/api/lawyers", partnerTokenPayload(), {
      name: "Sarah Connor",
      email: "sarah@townsend.law",
      password: "weak",
      role: "associate",
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/password/i);
  });

  it("hashes password before storing", async () => {
    // Insert user
    mockResponses.push({
      data: {
        id: "new-lawyer-id",
        firm_id: TEST_FIRM_A.id,
        name: "Sarah Connor",
        email: "sarah@townsend.law",
        role: "associate",
      },
      error: null,
    });
    // Audit log
    mockResponses.push({ data: null, error: null });

    await authedReq("POST", "/api/lawyers", partnerTokenPayload(), {
      name: "Sarah Connor",
      email: "sarah@townsend.law",
      password: "Secure1Pass",
      role: "associate",
    });

    // Check the insert log — password_hash should be the hashed value, not plaintext
    const userInsert = mockInsertLog.find(
      (entry) => typeof entry === "object" && entry !== null && "password_hash" in (entry as Record<string, unknown>)
    ) as Record<string, unknown> | undefined;
    expect(userInsert).toBeDefined();
    expect(userInsert!.password_hash).toBe("100000:fakesalt:fakehash");
    expect(userInsert!.password_hash).not.toBe("Secure1Pass");
  });

  it("sets firm_id from JWT not request", async () => {
    // Insert user
    mockResponses.push({
      data: {
        id: "new-lawyer-id",
        firm_id: TEST_FIRM_A.id,
        name: "Sarah Connor",
        email: "sarah@townsend.law",
        role: "associate",
      },
      error: null,
    });
    // Audit log
    mockResponses.push({ data: null, error: null });

    await authedReq("POST", "/api/lawyers", partnerTokenPayload(), {
      name: "Sarah Connor",
      email: "sarah@townsend.law",
      password: "Secure1Pass",
      role: "associate",
      firm_id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", // attacker tries to set different firm
    });

    // The insert should use the JWT firm_id, not the body firm_id
    const userInsert = mockInsertLog.find(
      (entry) => typeof entry === "object" && entry !== null && "firm_id" in (entry as Record<string, unknown>)
    ) as Record<string, unknown> | undefined;
    expect(userInsert).toBeDefined();
    expect(userInsert!.firm_id).toBe(TEST_FIRM_A.id);
  });
});

// ============================================================
// GET /api/documents/:id/download-url — Signed URL
// ============================================================

describe("GET /api/documents/:id/download-url", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResponses = []; mockInsertLog = []; mockUpdateLog = [];
    mockDeleteLog = []; mockQueryLog = [];
    mockStorageSignedUrl = { data: null, error: null };
  });

  it("returns signed download URL for document in own firm", async () => {
    // Fetch document
    mockResponses.push({
      data: {
        id: "doc-1",
        case_id: "c1",
        storage_path: "firms/aaa/cases/c1/file.pdf",
        storage_bucket: "documents",
        file_name: "file.pdf",
      },
      error: null,
    });
    // Verify case belongs to firm
    mockResponses.push({
      data: { id: "c1", firm_id: TEST_FIRM_A.id },
      error: null,
    });

    mockStorageSignedUrl = {
      data: { signedUrl: "https://supabase.co/storage/v1/sign/documents/firms/aaa/cases/c1/file.pdf?token=abc" },
      error: null,
    };

    const res = await authedReq("GET", "/api/documents/doc-1/download-url", partnerTokenPayload());

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("url");
    expect(body).toHaveProperty("expires_in", 3600);
  });

  it("returns 404 for document from another firm", async () => {
    // Fetch document
    mockResponses.push({
      data: {
        id: "doc-1",
        case_id: "c1",
        storage_path: "firms/other/cases/c1/file.pdf",
        storage_bucket: "documents",
      },
      error: null,
    });
    // Case not in firm
    mockResponses.push({ data: null, error: { message: "not found" } });

    const res = await authedReq("GET", "/api/documents/doc-1/download-url", partnerTokenPayload());

    expect(res.status).toBe(404);
  });
});
