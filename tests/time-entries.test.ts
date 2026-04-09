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
  firmBTokenPayload,
} from "./helpers";

vi.mock("../src/lib/password", () => ({
  verifyPassword: vi.fn(),
  hashPassword: vi.fn(),
  validatePassword: vi.fn(() => null),
}));

let mockResponses: Array<{ data: unknown; error: unknown }> = [];
let mockInsertLog: unknown[] = [];
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
          if (["single", "limit", "order"].includes(prop)) {
            return Promise.resolve(getNext());
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
          mockQueryLog.push({ table, method: "update", args: [data] });
          return createChainableMock(getNext, table);
        },
        delete: () => {
          mockQueryLog.push({ table, method: "delete", args: [] });
          return createChainableMock(getNext, table);
        },
      };
    },
  }),
}));

async function authedReq(
  method: string,
  path: string,
  tokenPayload: Parameters<typeof createTestToken>[0],
  body?: unknown
) {
  const token = await createTestToken(tokenPayload);
  const init: RequestInit = {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
  };
  if (body) init.body = JSON.stringify(body);
  return app.request(path, init, TEST_ENV);
}

// ── CREATE TIME ENTRY ──────────────────────────────────────────────

describe("Time Entries — Create", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResponses = [];
    mockInsertLog = [];
    mockQueryLog = [];
  });

  it("creates a billable time entry against a case", async () => {
    const newEntry = {
      id: "te-1",
      firm_id: TEST_FIRM_A.id,
      case_id: "case-1",
      lawyer_id: TEST_PARTNER.id,
      description: "Reviewed contract clauses 4-7",
      duration_minutes: 90,
      date: "2026-04-06",
      billable: true,
      rate_pence: 25000, // £250/hr
    };

    // Case ownership check
    mockResponses.push({ data: { id: "case-1", firm_id: TEST_FIRM_A.id, lawyer_id: TEST_PARTNER.id }, error: null });
    // Insert time entry
    mockResponses.push({ data: newEntry, error: null });
    // Audit log
    mockResponses.push({ data: null, error: null });

    const res = await authedReq("POST", "/api/time-entries", partnerTokenPayload(), {
      case_id: "case-1",
      description: "Reviewed contract clauses 4-7",
      duration_minutes: 90,
      date: "2026-04-06",
      billable: true,
      rate_pence: 25000,
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.id).toBe("te-1");
    expect(body.data.duration_minutes).toBe(90);
    expect(body.data.rate_pence).toBe(25000);
  });

  it("rejects time entry without required fields", async () => {
    const res = await authedReq("POST", "/api/time-entries", partnerTokenPayload(), {
      case_id: "case-1",
      // missing description, duration_minutes, rate_pence
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/required/i);
  });

  it("rejects zero or negative duration", async () => {
    const res = await authedReq("POST", "/api/time-entries", partnerTokenPayload(), {
      case_id: "case-1",
      description: "Some work",
      duration_minutes: 0,
      rate_pence: 25000,
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/duration/i);
  });

  it("rejects negative rate", async () => {
    const res = await authedReq("POST", "/api/time-entries", partnerTokenPayload(), {
      case_id: "case-1",
      description: "Some work",
      duration_minutes: 30,
      rate_pence: -100,
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/rate/i);
  });

  it("sets firm_id from JWT, not request body", async () => {
    const newEntry = { id: "te-2", firm_id: TEST_FIRM_A.id };

    mockResponses.push({ data: { id: "case-1", firm_id: TEST_FIRM_A.id, lawyer_id: TEST_PARTNER.id }, error: null });
    mockResponses.push({ data: newEntry, error: null });
    mockResponses.push({ data: null, error: null }); // audit

    const res = await authedReq("POST", "/api/time-entries", partnerTokenPayload(), {
      case_id: "case-1",
      description: "Work done",
      duration_minutes: 60,
      rate_pence: 20000,
      firm_id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", // attacker tries different firm
    });

    expect(res.status).toBe(201);

    const entryInsert = mockInsertLog.find(
      (item) => !Array.isArray(item) && (item as Record<string, unknown>).description === "Work done"
    ) as Record<string, unknown>;
    expect(entryInsert).toBeDefined();
    expect(entryInsert.firm_id).toBe(TEST_FIRM_A.id);
  });

  it("associate can log time against their own case", async () => {
    const newEntry = { id: "te-3", firm_id: TEST_FIRM_A.id, lawyer_id: TEST_ASSOCIATE.id };

    // Case check — associate's own case
    mockResponses.push({ data: { id: "case-2", firm_id: TEST_FIRM_A.id, lawyer_id: TEST_ASSOCIATE.id }, error: null });
    mockResponses.push({ data: newEntry, error: null });
    mockResponses.push({ data: null, error: null }); // audit

    const res = await authedReq("POST", "/api/time-entries", associateTokenPayload(), {
      case_id: "case-2",
      description: "Client call",
      duration_minutes: 30,
      rate_pence: 15000,
    });

    expect(res.status).toBe(201);
  });

  it("defaults billable to true when not specified", async () => {
    mockResponses.push({ data: { id: "case-1", firm_id: TEST_FIRM_A.id, lawyer_id: TEST_PARTNER.id }, error: null });
    mockResponses.push({ data: { id: "te-4", billable: true }, error: null });
    mockResponses.push({ data: null, error: null }); // audit

    const res = await authedReq("POST", "/api/time-entries", partnerTokenPayload(), {
      case_id: "case-1",
      description: "Research",
      duration_minutes: 45,
      rate_pence: 25000,
    });

    expect(res.status).toBe(201);

    const entryInsert = mockInsertLog.find(
      (item) => !Array.isArray(item) && (item as Record<string, unknown>).description === "Research"
    ) as Record<string, unknown>;
    expect(entryInsert.billable).toBe(true);
  });
});

// ── LIST TIME ENTRIES ──────────────────────────────────────────────

describe("Time Entries — List", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResponses = [];
    mockInsertLog = [];
    mockQueryLog = [];
  });

  it("lists time entries for a case", async () => {
    const entries = [
      { id: "te-1", case_id: "case-1", duration_minutes: 60, description: "Review" },
      { id: "te-2", case_id: "case-1", duration_minutes: 30, description: "Call" },
    ];

    mockResponses.push({ data: entries, error: null });

    const res = await authedReq("GET", "/api/time-entries?case_id=case-1", partnerTokenPayload());

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(2);
  });

  it("associate only sees entries for their own cases", async () => {
    const entries = [
      { id: "te-5", case_id: "case-2", lawyer_id: TEST_ASSOCIATE.id, duration_minutes: 45 },
    ];

    mockResponses.push({ data: entries, error: null });

    const res = await authedReq("GET", "/api/time-entries?case_id=case-2", associateTokenPayload());

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(1);

    // Verify lawyer_id filter was applied
    const eqCalls = mockQueryLog.filter((l) => l.method === "eq");
    const lawyerFilter = eqCalls.find((l) => l.args[0] === "lawyer_id");
    expect(lawyerFilter).toBeDefined();
  });
});

// ── BILLING SUMMARY ────────────────────────────────────────────────

describe("Time Entries — Billing Summary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResponses = [];
    mockInsertLog = [];
    mockQueryLog = [];
  });

  it("returns billing summary for a case in GBP", async () => {
    const entries = [
      { id: "te-1", duration_minutes: 60, rate_pence: 25000, billable: true },
      { id: "te-2", duration_minutes: 90, rate_pence: 25000, billable: true },
      { id: "te-3", duration_minutes: 30, rate_pence: 25000, billable: false },
    ];

    mockResponses.push({ data: entries, error: null });

    const res = await authedReq("GET", "/api/time-entries/summary?case_id=case-1", partnerTokenPayload());

    expect(res.status).toBe(200);
    const body = await res.json();

    // 60 + 90 = 150 billable minutes = 2.5 hours at £250/hr = £625
    expect(body.total_billable_minutes).toBe(150);
    expect(body.total_amount_pence).toBe(62500);
    expect(body.total_entries).toBe(3);
    expect(body.billable_entries).toBe(2);
    expect(body.currency).toBe("GBP");
  });
});

// ── UPDATE TIME ENTRY ──────────────────────────────────────────────

describe("Time Entries — Update", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResponses = [];
    mockInsertLog = [];
    mockQueryLog = [];
  });

  it("updates a time entry", async () => {
    // Fetch existing entry
    mockResponses.push({
      data: { id: "te-1", firm_id: TEST_FIRM_A.id, lawyer_id: TEST_PARTNER.id, case_id: "case-1" },
      error: null,
    });
    // Update
    mockResponses.push({
      data: { id: "te-1", description: "Updated description", duration_minutes: 120 },
      error: null,
    });
    // Audit
    mockResponses.push({ data: null, error: null });

    const res = await authedReq("PATCH", "/api/time-entries/te-1", partnerTokenPayload(), {
      description: "Updated description",
      duration_minutes: 120,
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.description).toBe("Updated description");
  });

  it("associate can only update their own time entries", async () => {
    // Entry belongs to partner, not associate
    mockResponses.push({
      data: { id: "te-1", firm_id: TEST_FIRM_A.id, lawyer_id: TEST_PARTNER.id },
      error: null,
    });

    const res = await authedReq("PATCH", "/api/time-entries/te-1", associateTokenPayload(), {
      description: "Trying to edit partner's entry",
    });

    expect(res.status).toBe(403);
  });
});

// ── DELETE TIME ENTRY ──────────────────────────────────────────────

describe("Time Entries — Delete", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResponses = [];
    mockInsertLog = [];
    mockQueryLog = [];
  });

  it("partner can delete a time entry", async () => {
    mockResponses.push({
      data: { id: "te-1", firm_id: TEST_FIRM_A.id },
      error: null,
    });
    // delete
    mockResponses.push({ data: null, error: null });
    // audit
    mockResponses.push({ data: null, error: null });

    const res = await authedReq("DELETE", "/api/time-entries/te-1", partnerTokenPayload());

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.message).toMatch(/deleted/i);
  });

  it("associate cannot delete time entries", async () => {
    const res = await authedReq("DELETE", "/api/time-entries/te-1", associateTokenPayload());

    expect(res.status).toBe(403);
  });
});
