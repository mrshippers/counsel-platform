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

let mockResponses: Array<{ data: unknown; error: unknown; count?: number | null }> = [];
let mockInsertLog: unknown[] = [];
let mockUpdateLog: Array<{ data: unknown; table?: string }> = [];
let mockDeleteLog: Array<{ table: string }> = [];
let mockQueryLog: Array<{ table: string; method: string; args: unknown[] }> = [];

function createChainableMock(
  getNext: () => { data: unknown; error: unknown; count?: number | null },
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
// DASHBOARD — Case stats & deadline count
// ============================================================

describe("Dashboard — Case stats", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResponses = []; mockInsertLog = []; mockUpdateLog = [];
    mockDeleteLog = []; mockQueryLog = [];
  });

  it("dashboard returns case stats by status", async () => {
    // Existing dashboard queries (Promise.all):
    // 1. Active cases (.order() terminal) — consumed
    mockResponses.push({
      data: [
        { id: "c1", firm_id: TEST_FIRM_A.id, status: "pending", priority: "normal", lawyer_id: TEST_PARTNER.id, progress: 25, deadline: null, updated_at: "2026-04-01T00:00:00Z" },
        { id: "c2", firm_id: TEST_FIRM_A.id, status: "in_progress", priority: "urgent", lawyer_id: TEST_ASSOCIATE.id, progress: 50, deadline: "2026-04-06", updated_at: "2026-04-04T00:00:00Z" },
      ],
      error: null,
    });
    // 2. Lawyers (.eq().eq() — auto-resolved, NOT consumed)
    // 3. Deadlines (.order().limit() terminal) — consumed
    mockResponses.push({
      data: [
        { id: "dl-1", date: "2026-04-10", cases: { title: "Case A", status: "pending" } },
      ],
      error: null,
    });
    // 4. Clients (.eq() — auto-resolved, NOT consumed)
    // 5. All cases for stats (.order() terminal) — consumed
    mockResponses.push({
      data: [
        { id: "c1", status: "pending" },
        { id: "c2", status: "in_progress" },
        { id: "c3", status: "in_progress" },
        { id: "c4", status: "completed" },
      ],
      error: null,
    });
    // 6. Upcoming deadlines count (.order() terminal) — consumed
    mockResponses.push({
      data: [
        { id: "dl-1", date: "2026-04-10" },
        { id: "dl-2", date: "2026-04-20" },
        { id: "dl-3", date: "2026-04-30" },
      ],
      error: null,
    });

    const res = await authedReq("GET", "/api/dashboard", partnerTokenPayload());

    expect(res.status).toBe(200);
    const body = await res.json();

    // Verify case_stats are returned
    expect(body.case_stats).toBeDefined();
    expect(body.case_stats.pending).toBe(1);
    expect(body.case_stats.in_progress).toBe(2);
    expect(body.case_stats.completed).toBe(1);
    expect(body.case_stats.total).toBe(4);
  });

  it("dashboard returns deadline count", async () => {
    // 1. Active cases
    mockResponses.push({ data: [], error: null });
    // 2. Deadlines for triage
    mockResponses.push({ data: [], error: null });
    // 3. All cases for stats
    mockResponses.push({ data: [], error: null });
    // 4. Upcoming deadlines count
    mockResponses.push({
      data: [
        { id: "dl-1", date: "2026-04-10" },
        { id: "dl-2", date: "2026-04-15" },
        { id: "dl-3", date: "2026-04-20" },
        { id: "dl-4", date: "2026-04-25" },
        { id: "dl-5", date: "2026-04-30" },
      ],
      error: null,
    });

    const res = await authedReq("GET", "/api/dashboard", partnerTokenPayload());

    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.deadline_count).toBe(5);
  });

  it("associate dashboard shows only their case stats", async () => {
    // 1. Active cases (filtered by associate in JS — but query returns all firm active cases)
    mockResponses.push({
      data: [
        { id: "c1", firm_id: TEST_FIRM_A.id, status: "pending", priority: "normal", lawyer_id: TEST_PARTNER.id, progress: 25, deadline: null, updated_at: "2026-04-01T00:00:00Z" },
        { id: "c2", firm_id: TEST_FIRM_A.id, status: "in_progress", priority: "urgent", lawyer_id: TEST_ASSOCIATE.id, progress: 50, deadline: null, updated_at: "2026-04-04T00:00:00Z" },
      ],
      error: null,
    });
    // 2. Deadlines for triage
    mockResponses.push({ data: [], error: null });
    // 3. All cases for stats
    mockResponses.push({
      data: [
        { id: "c1", status: "pending", lawyer_id: TEST_PARTNER.id },
        { id: "c2", status: "in_progress", lawyer_id: TEST_ASSOCIATE.id },
        { id: "c3", status: "completed", lawyer_id: TEST_ASSOCIATE.id },
        { id: "c4", status: "completed", lawyer_id: TEST_PARTNER.id },
      ],
      error: null,
    });
    // 4. Upcoming deadlines count
    mockResponses.push({
      data: [
        { id: "dl-1", date: "2026-04-10" },
      ],
      error: null,
    });

    const res = await authedReq("GET", "/api/dashboard", associateTokenPayload());

    expect(res.status).toBe(200);
    const body = await res.json();

    // Associate should only see their own case stats
    expect(body.case_stats).toBeDefined();
    expect(body.case_stats.pending).toBe(0);        // c1 belongs to partner
    expect(body.case_stats.in_progress).toBe(1);     // c2 belongs to associate
    expect(body.case_stats.completed).toBe(1);        // c3 belongs to associate
    expect(body.case_stats.total).toBe(2);             // only associate's cases

    // Triage should be filtered too (existing behaviour)
    expect(body.triage.total_active).toBe(1); // only c2
  });
});

// ============================================================
// LAWYERS — Workload stats
// ============================================================

describe("Lawyers — Workload stats", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResponses = []; mockInsertLog = []; mockUpdateLog = [];
    mockDeleteLog = []; mockQueryLog = [];
  });

  it("lawyers endpoint returns workload per lawyer", async () => {
    const sevenDaysFromNow = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];

    // 1. Users query (.order() terminal) — consumed
    mockResponses.push({
      data: [
        { id: TEST_ASSOCIATE.id, name: "Amir Khalil", email: "amir@townsend.law", role: "associate" },
        { id: TEST_PARTNER.id, name: "Jessica Townsend", email: "jessica@townsend.law", role: "partner" },
      ],
      error: null,
    });
    // 2. Cases for workload (.order() terminal) — consumed
    mockResponses.push({
      data: [
        { id: "c1", lawyer_id: TEST_PARTNER.id, status: "pending", priority: "urgent", deadline: sevenDaysFromNow },
        { id: "c2", lawyer_id: TEST_PARTNER.id, status: "in_progress", priority: "normal", deadline: null },
        { id: "c3", lawyer_id: TEST_ASSOCIATE.id, status: "in_progress", priority: "urgent", deadline: "2027-01-01" },
        { id: "c4", lawyer_id: TEST_ASSOCIATE.id, status: "completed", priority: "normal", deadline: null },
      ],
      error: null,
    });

    const res = await authedReq("GET", "/api/lawyers", partnerTokenPayload());

    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.data).toHaveLength(2);

    // Find each lawyer in the response
    const partner = body.data.find((u: { id: string }) => u.id === TEST_PARTNER.id);
    const associate = body.data.find((u: { id: string }) => u.id === TEST_ASSOCIATE.id);

    expect(partner).toBeDefined();
    expect(partner.workload).toBeDefined();
    expect(partner.workload.active_cases).toBe(2);    // c1 (pending) + c2 (in_progress)
    expect(partner.workload.urgent_cases).toBe(1);     // c1 is urgent
    expect(partner.workload.deadline_pressure).toBe(1); // c1 has deadline within 7 days

    expect(associate).toBeDefined();
    expect(associate.workload).toBeDefined();
    expect(associate.workload.active_cases).toBe(1);   // c3 (in_progress), c4 is completed
    expect(associate.workload.urgent_cases).toBe(1);    // c3 is urgent
    expect(associate.workload.deadline_pressure).toBe(0); // c3 deadline is 2027, not within 7 days
  });

  it("lawyers workload is firm-scoped", async () => {
    // 1. Users query
    mockResponses.push({
      data: [
        { id: TEST_FIRM_B_USER.id, name: "David Smith", email: "david@smith.law", role: "partner" },
      ],
      error: null,
    });
    // 2. Cases for workload
    mockResponses.push({
      data: [],
      error: null,
    });

    const res = await authedReq("GET", "/api/lawyers", firmBTokenPayload());

    expect(res.status).toBe(200);
    const body = await res.json();

    // Verify firm_id scoping is applied on both queries
    const usersFirmFilter = mockQueryLog.find(
      (l) => l.table === "users" && l.method === "eq" && l.args[0] === "firm_id"
    );
    expect(usersFirmFilter).toBeDefined();
    expect(usersFirmFilter!.args[1]).toBe(TEST_FIRM_B_USER.firm_id);

    const casesFirmFilter = mockQueryLog.find(
      (l) => l.table === "cases" && l.method === "eq" && l.args[0] === "firm_id"
    );
    expect(casesFirmFilter).toBeDefined();
    expect(casesFirmFilter!.args[1]).toBe(TEST_FIRM_B_USER.firm_id);

    // Firm B user should only see their own data
    expect(body.data).toHaveLength(1);
    expect(body.data[0].id).toBe(TEST_FIRM_B_USER.id);
    expect(body.data[0].workload.active_cases).toBe(0);
  });

  it("overloaded lawyers flagged with 8+ active cases", async () => {
    const overloadedLawyerId = TEST_PARTNER.id;

    // 1. Users query
    mockResponses.push({
      data: [
        { id: overloadedLawyerId, name: "Jessica Townsend", email: "jessica@townsend.law", role: "partner" },
      ],
      error: null,
    });

    // 2. Cases for workload — 8 active cases for the partner
    const activeCases = Array.from({ length: 8 }, (_, i) => ({
      id: `c${i + 1}`,
      lawyer_id: overloadedLawyerId,
      status: "in_progress",
      priority: "normal",
      deadline: null,
    }));
    mockResponses.push({
      data: activeCases,
      error: null,
    });

    const res = await authedReq("GET", "/api/lawyers", partnerTokenPayload());

    expect(res.status).toBe(200);
    const body = await res.json();

    const lawyer = body.data.find((u: { id: string }) => u.id === overloadedLawyerId);
    expect(lawyer).toBeDefined();
    expect(lawyer.workload.active_cases).toBe(8);
    expect(lawyer.workload.overloaded).toBe(true);
  });
});
