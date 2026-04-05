import { describe, it, expect, vi, beforeEach } from "vitest";
import { app } from "../src/index";
import {
  TEST_ENV,
  TEST_FIRM_A,
  TEST_PARTNER,
  createTestToken,
  partnerTokenPayload,
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

describe("Cases — Create", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResponses = [];
    mockInsertLog = [];
    mockQueryLog = [];
  });

  it("creates case with 4 default tasks", async () => {
    const newCase = {
      id: "c-new",
      firm_id: TEST_FIRM_A.id,
      client_id: "client-1",
      lawyer_id: TEST_PARTNER.id,
      title: "Commercial Lease Agreement",
      type: "real_estate",
      status: "pending",
      priority: "normal",
      progress: 0,
    };

    // Client ownership check
    mockResponses.push({ data: { id: "client-1" }, error: null });
    // Lawyer ownership check
    mockResponses.push({ data: { id: TEST_PARTNER.id }, error: null });
    // Case insert returns the new case
    mockResponses.push({ data: newCase, error: null });
    // Tasks insert (no terminal — not consumed)
    // Audit log insert (no terminal — not consumed)

    const res = await authedReq("POST", "/api/cases", partnerTokenPayload(), {
      client_id: "client-1",
      lawyer_id: TEST_PARTNER.id,
      title: "Commercial Lease Agreement",
      type: "real_estate",
    });

    expect(res.status).toBe(201);

    // Find the tasks insert call
    const taskInsert = mockInsertLog.find(
      (item) => Array.isArray(item) && item.length === 4 && item[0]?.label
    );
    expect(taskInsert).toBeDefined();

    const tasks = taskInsert as Array<{ label: string; done: boolean }>;
    expect(tasks).toHaveLength(4);
    expect(tasks[0].label).toBe("Initial Review & Client Meeting");
    expect(tasks[1].label).toBe("Document Collection & Filing");
    expect(tasks[2].label).toBe("Case Research & Preparation");
    expect(tasks[3].label).toBe("Resolution & Case Closure");
    expect(tasks.every((t) => t.done === false)).toBe(true);
  });

  it("rejects invalid case type", async () => {
    const res = await authedReq("POST", "/api/cases", partnerTokenPayload(), {
      client_id: "client-1",
      lawyer_id: TEST_PARTNER.id,
      title: "Bad Case",
      type: "invalid_type",
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/type/i);
  });

  it("rejects invalid priority", async () => {
    const res = await authedReq("POST", "/api/cases", partnerTokenPayload(), {
      client_id: "client-1",
      lawyer_id: TEST_PARTNER.id,
      title: "Bad Case",
      type: "corporate",
      priority: "critical",
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/priority/i);
  });

  it("auto-sets firm_id from JWT, not from request body", async () => {
    const newCase = { id: "c-new", firm_id: TEST_FIRM_A.id };
    mockResponses.push({ data: { id: "client-1" }, error: null }); // client check
    mockResponses.push({ data: { id: TEST_PARTNER.id }, error: null }); // lawyer check
    mockResponses.push({ data: newCase, error: null }); // case insert

    const res = await authedReq("POST", "/api/cases", partnerTokenPayload(), {
      client_id: "client-1",
      lawyer_id: TEST_PARTNER.id,
      title: "Test Case",
      type: "corporate",
      firm_id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", // attacker tries different firm
    });

    expect(res.status).toBe(201);

    // The case insert should use firm_id from JWT
    const caseInsert = mockInsertLog.find(
      (item) => !Array.isArray(item) && (item as Record<string, unknown>).title === "Test Case"
    ) as Record<string, unknown>;
    expect(caseInsert).toBeDefined();
    expect(caseInsert.firm_id).toBe(TEST_FIRM_A.id);
  });
});

describe("Cases — Search & Filter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResponses = [];
    mockInsertLog = [];
    mockQueryLog = [];
  });

  it("searches cases by title", async () => {
    const searchResults = [
      { id: "c1", title: "Smith Contract", firm_id: TEST_FIRM_A.id },
      { id: "c3", title: "Smith Estate", firm_id: TEST_FIRM_A.id },
    ];

    mockResponses.push({ data: searchResults, error: null });

    const res = await authedReq("GET", "/api/cases?search=Smith", partnerTokenPayload());

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(2);

    // Verify ilike was used for search
    const ilikeCalls = mockQueryLog.filter((l) => l.method === "ilike");
    expect(ilikeCalls.length).toBeGreaterThan(0);
    expect(ilikeCalls[0].args[0]).toBe("title");
    expect(ilikeCalls[0].args[1]).toBe("%Smith%");
  });

  it("filters cases by status", async () => {
    const pendingCases = [
      { id: "c4", title: "Pending Case", status: "pending", firm_id: TEST_FIRM_A.id },
    ];

    mockResponses.push({ data: pendingCases, error: null });

    const res = await authedReq("GET", "/api/cases?status=pending", partnerTokenPayload());

    expect(res.status).toBe(200);
    const body = await res.json();
    body.data.forEach((c: { status: string }) => {
      expect(c.status).toBe("pending");
    });
  });
});

describe("Tasks — Progress Calculation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResponses = [];
    mockInsertLog = [];
    mockQueryLog = [];
  });

  it("checking a task recalculates case progress", async () => {
    // Get task
    mockResponses.push({
      data: { id: "t1", case_id: "c1", done: false, order_index: 0, label: "Task 1" },
      error: null,
    });
    // Verify parent case firm isolation
    mockResponses.push({
      data: { firm_id: TEST_FIRM_A.id, lawyer_id: TEST_PARTNER.id },
      error: null,
    });
    // Update task
    mockResponses.push({ data: { id: "t1", done: true }, error: null });
    // Get all tasks for progress calc (1 of 4 done)
    mockResponses.push({
      data: [
        { id: "t1", done: true },
        { id: "t2", done: false },
        { id: "t3", done: false },
        { id: "t4", done: false },
      ],
      error: null,
    });
    // Update case progress
    mockResponses.push({ data: null, error: null });
    // Audit log
    mockResponses.push({ data: null, error: null });

    const res = await authedReq("PATCH", "/api/tasks/t1", partnerTokenPayload(), {
      done: true,
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.case_progress).toBe(25);
    expect(body.case_status).toBe("in_progress");
  });

  it("completing all tasks sets progress to 100 and status completed", async () => {
    // Get task
    mockResponses.push({
      data: { id: "t4", case_id: "c1", done: false },
      error: null,
    });
    // Verify parent case firm isolation
    mockResponses.push({
      data: { firm_id: TEST_FIRM_A.id, lawyer_id: TEST_PARTNER.id },
      error: null,
    });
    // Update task
    mockResponses.push({ data: { id: "t4", done: true }, error: null });
    // All 4 now done
    mockResponses.push({
      data: [
        { id: "t1", done: true },
        { id: "t2", done: true },
        { id: "t3", done: true },
        { id: "t4", done: true },
      ],
      error: null,
    });
    // Update case
    mockResponses.push({ data: null, error: null });
    // Audit
    mockResponses.push({ data: null, error: null });

    const res = await authedReq("PATCH", "/api/tasks/t4", partnerTokenPayload(), {
      done: true,
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.case_progress).toBe(100);
    expect(body.case_status).toBe("completed");
  });

  it("unchecking a task recalculates progress downward", async () => {
    // Get task (currently done)
    mockResponses.push({
      data: { id: "t3", case_id: "c1", done: true },
      error: null,
    });
    // Verify parent case firm isolation
    mockResponses.push({
      data: { firm_id: TEST_FIRM_A.id, lawyer_id: TEST_PARTNER.id },
      error: null,
    });
    // Update task to undone
    mockResponses.push({ data: { id: "t3", done: false }, error: null });
    // 3 of 4 done after unchecking t3
    mockResponses.push({
      data: [
        { id: "t1", done: true },
        { id: "t2", done: true },
        { id: "t3", done: false },
        { id: "t4", done: true },
      ],
      error: null,
    });
    // Update case
    mockResponses.push({ data: null, error: null });
    // Audit
    mockResponses.push({ data: null, error: null });

    const res = await authedReq("PATCH", "/api/tasks/t3", partnerTokenPayload(), {
      done: false,
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.case_progress).toBe(75);
    expect(body.case_status).toBe("in_progress");
  });
});
