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
          if (["single", "limit", "in"].includes(prop)) return Promise.resolve(getNext());
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
// DEADLINES — CRUD
// ============================================================

describe("Deadlines — Create", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResponses = []; mockInsertLog = []; mockUpdateLog = [];
    mockDeleteLog = []; mockQueryLog = [];
  });

  it("POST /api/deadlines creates a deadline linked to case", async () => {
    // Insert deadline
    mockResponses.push({
      data: {
        id: "dl-1",
        firm_id: TEST_FIRM_A.id,
        case_id: "c1",
        lawyer_id: TEST_PARTNER.id,
        created_by: TEST_PARTNER.id,
        title: "File court documents",
        date: "2026-05-01",
        note: "Submit before noon",
      },
      error: null,
    });
    // Audit
    mockResponses.push({ data: null, error: null });

    const res = await authedReq("POST", "/api/deadlines", partnerTokenPayload(), {
      title: "File court documents",
      date: "2026-05-01",
      case_id: "c1",
      lawyer_id: TEST_PARTNER.id,
      note: "Submit before noon",
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.title).toBe("File court documents");
    expect(body.data.firm_id).toBe(TEST_FIRM_A.id);
    expect(body.data.case_id).toBe("c1");

    // Verify firm_id was set from JWT in the insert
    const deadlineInsert = mockInsertLog.find(
      (entry: unknown) => (entry as Record<string, unknown>).firm_id === TEST_FIRM_A.id
    );
    expect(deadlineInsert).toBeDefined();
  });

  it("deadline creation validates required fields (title, date)", async () => {
    // Missing title
    const res1 = await authedReq("POST", "/api/deadlines", partnerTokenPayload(), {
      date: "2026-05-01",
    });
    expect(res1.status).toBe(400);

    // Missing date
    const res2 = await authedReq("POST", "/api/deadlines", partnerTokenPayload(), {
      title: "Something",
    });
    expect(res2.status).toBe(400);

    // Missing both
    const res3 = await authedReq("POST", "/api/deadlines", partnerTokenPayload(), {});
    expect(res3.status).toBe(400);
  });
});

// ============================================================
// DEADLINES — Calendar Read (role-based)
// ============================================================

describe("Deadlines — Calendar visibility", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResponses = []; mockInsertLog = []; mockUpdateLog = [];
    mockDeleteLog = []; mockQueryLog = [];
  });

  it("partner sees all firm deadlines on calendar", async () => {
    mockResponses.push({
      data: [
        { id: "dl-1", firm_id: TEST_FIRM_A.id, title: "Filing deadline", lawyer_id: TEST_PARTNER.id },
        { id: "dl-2", firm_id: TEST_FIRM_A.id, title: "Court hearing", lawyer_id: TEST_ASSOCIATE.id },
      ],
      error: null,
    });

    const res = await authedReq("GET", "/api/calendar", partnerTokenPayload());

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(2);

    // Partner should NOT have a lawyer_id filter in the query
    const lawyerFilter = mockQueryLog.find(
      (l) => l.table === "deadlines" && l.method === "eq" && l.args[0] === "lawyer_id"
    );
    expect(lawyerFilter).toBeUndefined();
  });

  it("associate sees only own deadlines", async () => {
    mockResponses.push({
      data: [
        { id: "dl-2", firm_id: TEST_FIRM_A.id, title: "Court hearing", lawyer_id: TEST_ASSOCIATE.id },
      ],
      error: null,
    });

    const res = await authedReq("GET", "/api/calendar", associateTokenPayload());

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(1);

    // Associate SHOULD have a lawyer_id filter
    const lawyerFilter = mockQueryLog.find(
      (l) => l.table === "deadlines" && l.method === "eq" && l.args[0] === "lawyer_id"
    );
    expect(lawyerFilter).toBeDefined();
    expect(lawyerFilter!.args[1]).toBe(TEST_ASSOCIATE.id);
  });
});

// ============================================================
// DEADLINES — Update & Delete
// ============================================================

describe("Deadlines — Update", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResponses = []; mockInsertLog = []; mockUpdateLog = [];
    mockDeleteLog = []; mockQueryLog = [];
  });

  it("PATCH /api/deadlines/:id updates deadline", async () => {
    // Verify deadline exists and belongs to firm
    mockResponses.push({
      data: { id: "dl-1", firm_id: TEST_FIRM_A.id, title: "Old Title", date: "2026-05-01" },
      error: null,
    });
    // Update
    mockResponses.push({
      data: { id: "dl-1", firm_id: TEST_FIRM_A.id, title: "Updated Title", date: "2026-05-15" },
      error: null,
    });
    // Audit
    mockResponses.push({ data: null, error: null });

    const res = await authedReq("PATCH", "/api/deadlines/dl-1", partnerTokenPayload(), {
      title: "Updated Title",
      date: "2026-05-15",
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.title).toBe("Updated Title");
    expect(body.data.date).toBe("2026-05-15");
  });

  it("deadline for another firm returns 404", async () => {
    // Lookup returns null — not in this firm
    mockResponses.push({ data: null, error: { message: "not found" } });

    const res = await authedReq("PATCH", "/api/deadlines/dl-1", firmBTokenPayload(), {
      title: "Hacked",
    });

    expect(res.status).toBe(404);
  });
});

describe("Deadlines — Delete", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResponses = []; mockInsertLog = []; mockUpdateLog = [];
    mockDeleteLog = []; mockQueryLog = [];
  });

  it("DELETE /api/deadlines/:id removes deadline", async () => {
    // Verify deadline exists and belongs to firm
    mockResponses.push({
      data: { id: "dl-1", firm_id: TEST_FIRM_A.id },
      error: null,
    });
    // Delete (no terminal — not consumed by mock)
    // Audit
    mockResponses.push({ data: null, error: null });

    const res = await authedReq("DELETE", "/api/deadlines/dl-1", partnerTokenPayload());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.message).toBe("Deadline deleted");
  });
});

// ============================================================
// DEADLINES — Upcoming (dashboard)
// ============================================================

describe("Deadlines — Upcoming", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResponses = []; mockInsertLog = []; mockUpdateLog = [];
    mockDeleteLog = []; mockQueryLog = [];
  });

  it("GET /api/deadlines/upcoming returns next 5 sorted by date", async () => {
    mockResponses.push({
      data: [
        { id: "dl-1", title: "First", date: "2026-04-10" },
        { id: "dl-2", title: "Second", date: "2026-04-12" },
        { id: "dl-3", title: "Third", date: "2026-04-15" },
        { id: "dl-4", title: "Fourth", date: "2026-04-18" },
        { id: "dl-5", title: "Fifth", date: "2026-04-20" },
      ],
      error: null,
    });

    const res = await authedReq("GET", "/api/deadlines/upcoming", partnerTokenPayload());

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(5);
    expect(body.data[0].title).toBe("First");

    // Verify the query used limit(5) and ordered by date ascending
    const limitCall = mockQueryLog.find(
      (l) => l.table === "deadlines" && l.method === "limit"
    );
    expect(limitCall).toBeDefined();
    expect(limitCall!.args[0]).toBe(5);

    const orderCall = mockQueryLog.find(
      (l) => l.table === "deadlines" && l.method === "order"
    );
    expect(orderCall).toBeDefined();
    expect(orderCall!.args[0]).toBe("date");
  });
});

// ============================================================
// DEADLINES — Email reminders
// ============================================================

describe("Deadlines — Reminders", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResponses = []; mockInsertLog = []; mockUpdateLog = [];
    mockDeleteLog = []; mockQueryLog = [];
  });

  it("email reminder data includes case title, client name, lawyer email", async () => {
    // Fetch deadlines within 48 hours
    mockResponses.push({
      data: [
        {
          id: "dl-1",
          firm_id: TEST_FIRM_A.id,
          case_id: "c1",
          lawyer_id: TEST_PARTNER.id,
          title: "Court submission",
          date: "2026-04-06",
          cases: { title: "Smith v Jones", id: "c1" },
        },
      ],
      error: null,
    });
    // Separate user lookup (refactored to avoid ambiguous FK)
    mockResponses.push({
      data: [
        {
          id: TEST_PARTNER.id,
          name: TEST_PARTNER.name,
          email: TEST_PARTNER.email,
          reminder_emails_enabled: true,
        },
      ],
      error: null,
    });

    const res = await authedReq("POST", "/api/deadlines/send-reminders", partnerTokenPayload());

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.reminders).toBeDefined();
    expect(body.reminders).toHaveLength(1);

    const reminder = body.reminders[0];
    expect(reminder.lawyer_email).toBe(TEST_PARTNER.email);
    expect(reminder.case_title).toBe("Smith v Jones");
    expect(reminder.deadline_date).toBe("2026-04-06");
  });

  it("reminder respects per-lawyer toggle", async () => {
    // Fetch deadlines within 48 hours — lawyer has reminders disabled
    mockResponses.push({
      data: [
        {
          id: "dl-1",
          firm_id: TEST_FIRM_A.id,
          case_id: "c1",
          lawyer_id: TEST_ASSOCIATE.id,
          title: "Court submission",
          date: "2026-04-06",
          cases: { title: "Smith v Jones", id: "c1" },
        },
      ],
      error: null,
    });
    // Separate user lookup
    mockResponses.push({
      data: [
        {
          id: TEST_ASSOCIATE.id,
          name: TEST_ASSOCIATE.name,
          email: TEST_ASSOCIATE.email,
          reminder_emails_enabled: false,
        },
      ],
      error: null,
    });

    const res = await authedReq("POST", "/api/deadlines/send-reminders", partnerTokenPayload());

    expect(res.status).toBe(200);
    const body = await res.json();
    // The lawyer with reminder_emails_enabled=false should be skipped
    expect(body.reminders).toHaveLength(0);
    expect(body.skipped).toBe(1);
  });
});
