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
// CASES — Update & Delete
// ============================================================

describe("Cases — Update", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResponses = []; mockInsertLog = []; mockUpdateLog = [];
    mockDeleteLog = []; mockQueryLog = [];
  });

  it("PATCH /api/cases/:id updates case fields", async () => {
    // Verify case exists and belongs to firm
    mockResponses.push({
      data: { id: "c1", firm_id: TEST_FIRM_A.id, title: "Old Title", status: "pending", lawyer_id: TEST_PARTNER.id },
      error: null,
    });
    // Update
    mockResponses.push({
      data: { id: "c1", firm_id: TEST_FIRM_A.id, title: "New Title", status: "in_progress" },
      error: null,
    });
    // Audit
    mockResponses.push({ data: null, error: null });

    const res = await authedReq("PATCH", "/api/cases/c1", partnerTokenPayload(), {
      title: "New Title",
      status: "in_progress",
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.title).toBe("New Title");
  });

  it("rejects update to case in another firm", async () => {
    // Case lookup returns null (not in this firm)
    mockResponses.push({ data: null, error: { message: "not found" } });

    const res = await authedReq("PATCH", "/api/cases/c1", firmBTokenPayload(), {
      title: "Hacked",
    });

    expect(res.status).toBe(404);
  });

  it("associate can update own assigned case", async () => {
    mockResponses.push({
      data: { id: "c2", firm_id: TEST_FIRM_A.id, lawyer_id: TEST_ASSOCIATE.id },
      error: null,
    });
    mockResponses.push({ data: { id: "c2", notes: "Updated" }, error: null });
    mockResponses.push({ data: null, error: null }); // audit

    const res = await authedReq("PATCH", "/api/cases/c2", associateTokenPayload(), {
      notes: "Updated",
    });

    expect(res.status).toBe(200);
  });

  it("associate cannot update another lawyer's case", async () => {
    mockResponses.push({
      data: { id: "c1", firm_id: TEST_FIRM_A.id, lawyer_id: TEST_PARTNER.id },
      error: null,
    });

    const res = await authedReq("PATCH", "/api/cases/c1", associateTokenPayload(), {
      notes: "Trying to edit partner's case",
    });

    expect(res.status).toBe(403);
  });

  it("rejects invalid status on update", async () => {
    mockResponses.push({
      data: { id: "c1", firm_id: TEST_FIRM_A.id, lawyer_id: TEST_PARTNER.id },
      error: null,
    });

    const res = await authedReq("PATCH", "/api/cases/c1", partnerTokenPayload(), {
      status: "invalid_status",
    });

    expect(res.status).toBe(400);
  });

  it("cannot override firm_id on update", async () => {
    mockResponses.push({
      data: { id: "c1", firm_id: TEST_FIRM_A.id, lawyer_id: TEST_PARTNER.id },
      error: null,
    });
    mockResponses.push({ data: { id: "c1" }, error: null });
    mockResponses.push({ data: null, error: null }); // audit

    await authedReq("PATCH", "/api/cases/c1", partnerTokenPayload(), {
      firm_id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
      title: "Legit Update",
    });

    // firm_id should NOT appear in the update payload
    const caseUpdate = mockUpdateLog.find((u) => u.table === "cases");
    expect(caseUpdate).toBeDefined();
    expect((caseUpdate!.data as Record<string, unknown>)).not.toHaveProperty("firm_id");
  });
});

describe("Cases — Delete", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResponses = []; mockInsertLog = []; mockUpdateLog = [];
    mockDeleteLog = []; mockQueryLog = [];
  });

  it("partner can delete a case", async () => {
    // Verify case
    mockResponses.push({ data: { id: "c1", firm_id: TEST_FIRM_A.id }, error: null });
    // Delete
    mockResponses.push({ data: null, error: null });
    // Audit
    mockResponses.push({ data: null, error: null });

    const res = await authedReq("DELETE", "/api/cases/c1", partnerTokenPayload());
    expect(res.status).toBe(200);
  });

  it("associate cannot delete cases", async () => {
    mockResponses.push({ data: { id: "c1", firm_id: TEST_FIRM_A.id, lawyer_id: TEST_ASSOCIATE.id }, error: null });

    const res = await authedReq("DELETE", "/api/cases/c1", associateTokenPayload());
    expect(res.status).toBe(403);
  });

  it("cannot delete case from another firm", async () => {
    mockResponses.push({ data: null, error: { message: "not found" } });

    const res = await authedReq("DELETE", "/api/cases/c1", firmBTokenPayload());
    expect(res.status).toBe(404);
  });
});

// ============================================================
// CLIENTS — Update & Delete
// ============================================================

describe("Clients — Update", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResponses = []; mockInsertLog = []; mockUpdateLog = [];
    mockDeleteLog = []; mockQueryLog = [];
  });

  it("PATCH /api/clients/:id updates client fields", async () => {
    mockResponses.push({ data: { id: "cl1", firm_id: TEST_FIRM_A.id, name: "Old Name" }, error: null });
    mockResponses.push({ data: { id: "cl1", name: "New Name", email: "new@example.com" }, error: null });
    mockResponses.push({ data: null, error: null }); // audit

    const res = await authedReq("PATCH", "/api/clients/cl1", partnerTokenPayload(), {
      name: "New Name",
      email: "new@example.com",
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.name).toBe("New Name");
  });

  it("rejects update to client in another firm", async () => {
    mockResponses.push({ data: null, error: { message: "not found" } });

    const res = await authedReq("PATCH", "/api/clients/cl1", firmBTokenPayload(), {
      name: "Hacked",
    });

    expect(res.status).toBe(404);
  });

  it("strips firm_id from client update payload", async () => {
    mockResponses.push({ data: { id: "cl1", firm_id: TEST_FIRM_A.id }, error: null });
    mockResponses.push({ data: { id: "cl1" }, error: null });
    mockResponses.push({ data: null, error: null }); // audit

    await authedReq("PATCH", "/api/clients/cl1", partnerTokenPayload(), {
      firm_id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
      name: "Legit",
    });

    const clientUpdate = mockUpdateLog.find((u) => u.table === "clients");
    expect(clientUpdate).toBeDefined();
    expect((clientUpdate!.data as Record<string, unknown>)).not.toHaveProperty("firm_id");
  });
});

describe("Clients — Delete", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResponses = []; mockInsertLog = []; mockUpdateLog = [];
    mockDeleteLog = []; mockQueryLog = [];
  });

  it("partner can delete a client (cascades to cases)", async () => {
    mockResponses.push({ data: { id: "cl1", firm_id: TEST_FIRM_A.id }, error: null });
    mockResponses.push({ data: null, error: null }); // delete
    mockResponses.push({ data: null, error: null }); // audit

    const res = await authedReq("DELETE", "/api/clients/cl1", partnerTokenPayload());
    expect(res.status).toBe(200);
  });

  it("associate cannot delete clients", async () => {
    mockResponses.push({ data: { id: "cl1", firm_id: TEST_FIRM_A.id }, error: null });

    const res = await authedReq("DELETE", "/api/clients/cl1", associateTokenPayload());
    expect(res.status).toBe(403);
  });
});

// ============================================================
// TASKS — Add custom task, delete task
// ============================================================

describe("Tasks — Add custom task", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResponses = []; mockInsertLog = []; mockUpdateLog = [];
    mockDeleteLog = []; mockQueryLog = [];
  });

  it("POST /api/tasks creates task linked to case", async () => {
    // Verify case belongs to firm
    mockResponses.push({ data: { id: "c1", firm_id: TEST_FIRM_A.id }, error: null });
    // Insert task
    mockResponses.push({
      data: { id: "t-new", case_id: "c1", label: "Custom Task", done: false, order_index: 4 },
      error: null,
    });
    // Recalculate progress — now 0 of 5
    mockResponses.push({
      data: [
        { id: "t1", done: false }, { id: "t2", done: false },
        { id: "t3", done: false }, { id: "t4", done: false },
        { id: "t-new", done: false },
      ],
      error: null,
    });
    // Update case progress
    mockResponses.push({ data: null, error: null });
    // Audit
    mockResponses.push({ data: null, error: null });

    const res = await authedReq("POST", "/api/tasks", partnerTokenPayload(), {
      case_id: "c1",
      label: "Custom Task",
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.label).toBe("Custom Task");
    expect(body.data.done).toBe(false);
  });

  it("rejects task creation without label", async () => {
    const res = await authedReq("POST", "/api/tasks", partnerTokenPayload(), {
      case_id: "c1",
    });

    expect(res.status).toBe(400);
  });

  it("rejects task creation for case in another firm", async () => {
    mockResponses.push({ data: null, error: { message: "not found" } });

    const res = await authedReq("POST", "/api/tasks", firmBTokenPayload(), {
      case_id: "c1",
      label: "Sneaky Task",
    });

    expect(res.status).toBe(404);
  });
});

describe("Tasks — Delete", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResponses = []; mockInsertLog = []; mockUpdateLog = [];
    mockDeleteLog = []; mockQueryLog = [];
  });

  it("DELETE /api/tasks/:id removes task and recalculates progress", async () => {
    // 1. Get task (.select().eq().single())
    mockResponses.push({ data: { id: "t3", case_id: "c1", done: true, label: "Task 3" }, error: null });
    // 2. Get case (.select().eq().eq().single())
    mockResponses.push({ data: { id: "c1", firm_id: TEST_FIRM_A.id }, error: null });
    // 3. delete().eq() has no terminal — does NOT consume a response
    // 4. recalculateCaseProgress: .select().eq().order() — terminal
    mockResponses.push({
      data: [
        { id: "t1", done: true },
        { id: "t2", done: true },
        { id: "t4", done: false },
      ],
      error: null,
    });
    // 5. recalculateCaseProgress: .update().eq().single()
    mockResponses.push({ data: null, error: null });
    // 6. Audit log .insert() — no terminal, not consumed

    const res = await authedReq("DELETE", "/api/tasks/t3", partnerTokenPayload());
    expect(res.status).toBe(200);
    const body = await res.json();
    // 2 done out of 3 remaining = 67%
    expect(body.case_progress).toBe(67);
  });
});

// ============================================================
// ONBOARDING WIZARD
// ============================================================

describe("Onboarding — Wizard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResponses = []; mockInsertLog = []; mockUpdateLog = [];
    mockDeleteLog = []; mockQueryLog = [];
  });

  it("POST /api/onboarding creates firm, user, and first case", async () => {
    // Create firm
    mockResponses.push({ data: { id: "firm-new", name: "New Firm", plan: "solo" }, error: null });
    // Create user (partner)
    mockResponses.push({
      data: { id: "user-new", firm_id: "firm-new", name: "Jane Doe", role: "partner" },
      error: null,
    });
    // Create first case
    mockResponses.push({
      data: { id: "case-new", firm_id: "firm-new", title: "First Case" },
      error: null,
    });
    // Create 4 default tasks
    mockResponses.push({ data: null, error: null });

    const res = await app.request(
      "/api/onboarding",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          firm_name: "New Firm",
          user_name: "Jane Doe",
          user_email: "jane@newfirm.law",
          password: "SecurePass1",
          first_case_title: "First Case",
          first_case_type: "corporate",
          first_client_name: "First Client Ltd",
        }),
      },
      TEST_ENV
    );

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toHaveProperty("access_token");
    expect(body.firm).toHaveProperty("name", "New Firm");
    expect(body.user).toHaveProperty("role", "partner");
  });

  it("validates required onboarding fields", async () => {
    const res = await app.request(
      "/api/onboarding",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ firm_name: "Incomplete" }),
      },
      TEST_ENV
    );

    expect(res.status).toBe(400);
  });

  it("validates password on onboarding", async () => {
    const res = await app.request(
      "/api/onboarding",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          firm_name: "New Firm",
          user_name: "Jane Doe",
          user_email: "jane@newfirm.law",
          password: "weak", // too short, no number
          first_case_title: "Case",
          first_case_type: "corporate",
          first_client_name: "Client",
        }),
      },
      TEST_ENV
    );

    expect(res.status).toBe(400);
  });
});

// ============================================================
// SECURITY
// ============================================================

describe("Security — Input sanitization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResponses = []; mockInsertLog = []; mockUpdateLog = [];
    mockDeleteLog = []; mockQueryLog = [];
  });

  it("SQL injection attempt in case title is safely handled", async () => {
    // Client check
    mockResponses.push({ data: { id: "cl1" }, error: null });
    // Lawyer check
    mockResponses.push({ data: { id: TEST_PARTNER.id }, error: null });
    // Case insert
    mockResponses.push({
      data: { id: "c-new", firm_id: TEST_FIRM_A.id, title: "'; DROP TABLE cases; --" },
      error: null,
    });

    const res = await authedReq("POST", "/api/cases", partnerTokenPayload(), {
      client_id: "cl1",
      lawyer_id: TEST_PARTNER.id,
      title: "'; DROP TABLE cases; --",
      type: "corporate",
    });

    // Should succeed — Supabase parameterises queries, injection is neutralised
    expect(res.status).toBe(201);
  });

  it("XSS attempt in client name is stored as-is (escaped on render)", async () => {
    mockResponses.push({
      data: { id: "cl-new", firm_id: TEST_FIRM_A.id, name: '<script>alert("xss")</script>' },
      error: null,
    });
    mockResponses.push({ data: null, error: null }); // audit

    const res = await authedReq("POST", "/api/clients", partnerTokenPayload(), {
      name: '<script>alert("xss")</script>',
    });

    // API stores the value — XSS prevention is frontend's responsibility
    // But we verify the API doesn't crash or reject valid-but-dangerous strings
    expect(res.status).toBe(201);
  });

  it("CORS blocks non-Counsel origins", async () => {
    const res = await app.request(
      "/api/health",
      {
        method: "OPTIONS",
        headers: { Origin: "https://evil.com", "Access-Control-Request-Method": "GET" },
      },
      TEST_ENV
    );

    const allowOrigin = res.headers.get("Access-Control-Allow-Origin");
    expect(allowOrigin).not.toBe("https://evil.com");
  });

  it("CORS allows Counsel origins", async () => {
    const res = await app.request(
      "/api/health",
      {
        method: "OPTIONS",
        headers: {
          Origin: "https://counsel-app.co.uk",
          "Access-Control-Request-Method": "GET",
        },
      },
      TEST_ENV
    );

    const allowOrigin = res.headers.get("Access-Control-Allow-Origin");
    expect(allowOrigin).toBe("https://counsel-app.co.uk");
  });

  it("all authenticated endpoints require firm_id check", async () => {
    // Hit various endpoints and verify firm_id is always in the query
    const endpoints = [
      { method: "GET", path: "/api/cases" },
      { method: "GET", path: "/api/clients" },
      { method: "GET", path: "/api/calendar" },
    ];

    for (const ep of endpoints) {
      mockResponses.push({ data: [], error: null });
      mockQueryLog = [];

      await authedReq(ep.method, ep.path, partnerTokenPayload());

      const firmFilter = mockQueryLog.find((l) => l.method === "eq" && l.args[0] === "firm_id");
      expect(firmFilter).toBeDefined();
      expect(firmFilter!.args[1]).toBe(TEST_FIRM_A.id);
    }
  });
});
