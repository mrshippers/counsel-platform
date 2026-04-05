import { describe, it, expect, vi, beforeEach } from "vitest";
import { app } from "../src/index";
import {
  TEST_ENV,
  TEST_FIRM_A,
  TEST_FIRM_B,
  createTestToken,
  partnerTokenPayload,
  associateTokenPayload,
  firmBTokenPayload,
} from "./helpers";

// Mock password module (imported by auth routes)
vi.mock("../src/lib/password", () => ({
  verifyPassword: vi.fn(),
  hashPassword: vi.fn(),
  validatePassword: vi.fn(() => null),
}));

let mockResponses: Array<{ data: unknown; error: unknown; count?: number }> = [];
let mockQueryLog: Array<{ table: string; method: string; args: unknown[] }> = [];

function createChainableMock(
  getNext: () => { data: unknown; error: unknown },
  table: string
) {
  const proxy = (): unknown => {
    return new Proxy({} as Record<string, unknown>, {
      get(_target, prop: string) {
        if (prop === "then") return undefined;
        return (...args: unknown[]) => {
          mockQueryLog.push({ table, method: prop, args });
          if (["single", "limit"].includes(prop)) {
            return Promise.resolve(getNext());
          }
          // For terminal methods that don't use single()
          if (prop === "order") {
            // order is terminal if it returns a promise
            const result = getNext();
            const val = {
              ...result,
              order: (...a: unknown[]) => {
                mockQueryLog.push({ table, method: "order", args: a });
                return Promise.resolve(result);
              },
            };
            return Promise.resolve(result);
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
      const getNext = () => mockResponses.shift() || { data: [], error: null };
      return {
        select: (...args: unknown[]) => {
          mockQueryLog.push({ table, method: "select", args });
          return createChainableMock(getNext, table);
        },
        insert: (data: unknown) => {
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

describe("RBAC — Partner access", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResponses = [];
    mockQueryLog = [];
  });

  it("partner can view all firm cases", async () => {
    const firmACases = [
      { id: "c1", firm_id: TEST_FIRM_A.id, title: "Case 1", lawyer_id: "11111111-1111-1111-1111-111111111111" },
      { id: "c2", firm_id: TEST_FIRM_A.id, title: "Case 2", lawyer_id: "22222222-2222-2222-2222-222222222222" },
    ];

    mockResponses.push({ data: firmACases, error: null });

    const res = await authedReq("GET", "/api/cases", partnerTokenPayload());

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(2);
    expect(body.data.map((c: { title: string }) => c.title)).toContain("Case 1");
    expect(body.data.map((c: { title: string }) => c.title)).toContain("Case 2");
  });

  it("partner can access lawyers tab", async () => {
    mockResponses.push({ data: [], error: null });

    const res = await authedReq("GET", "/api/lawyers", partnerTokenPayload());
    expect(res.status).toBe(200);
  });
});

describe("RBAC — Associate restrictions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResponses = [];
    mockQueryLog = [];
  });

  it("associate can only view their assigned cases", async () => {
    const associateCases = [
      { id: "c2", firm_id: TEST_FIRM_A.id, title: "My Case", lawyer_id: "22222222-2222-2222-2222-222222222222" },
    ];

    mockResponses.push({ data: associateCases, error: null });

    const res = await authedReq("GET", "/api/cases", associateTokenPayload());

    expect(res.status).toBe(200);
    const body = await res.json();
    body.data.forEach((c: { lawyer_id: string }) => {
      expect(c.lawyer_id).toBe("22222222-2222-2222-2222-222222222222");
    });

    // Verify the query included lawyer_id filter
    const eqCalls = mockQueryLog.filter((l) => l.method === "eq");
    const lawyerFilter = eqCalls.find((l) => l.args[0] === "lawyer_id");
    expect(lawyerFilter).toBeDefined();
  });

  it("associate cannot access lawyers tab — returns 403", async () => {
    const res = await authedReq("GET", "/api/lawyers", associateTokenPayload());
    expect(res.status).toBe(403);
  });
});

describe("RBAC — Firm isolation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResponses = [];
    mockQueryLog = [];
  });

  it("user cannot query another firm's data — queries use their own firm_id", async () => {
    mockResponses.push({ data: [], error: null });

    await authedReq("GET", "/api/cases", firmBTokenPayload());

    const eqCalls = mockQueryLog.filter((l) => l.method === "eq");
    const firmFilter = eqCalls.find((l) => l.args[0] === "firm_id");
    expect(firmFilter).toBeDefined();
    expect(firmFilter!.args[1]).toBe(TEST_FIRM_B.id);
  });

  it("API always filters by authenticated user's firm_id on cases", async () => {
    mockResponses.push({ data: [], error: null });

    await authedReq("GET", "/api/cases", partnerTokenPayload());

    const eqCalls = mockQueryLog.filter((l) => l.method === "eq");
    const firmFilter = eqCalls.find((l) => l.args[0] === "firm_id");
    expect(firmFilter).toBeDefined();
    expect(firmFilter!.args[1]).toBe(TEST_FIRM_A.id);
  });

  it("API always filters by authenticated user's firm_id on clients", async () => {
    mockResponses.push({ data: [], error: null });

    await authedReq("GET", "/api/clients", partnerTokenPayload());

    const eqCalls = mockQueryLog.filter((l) => l.method === "eq");
    const firmFilter = eqCalls.find((l) => l.args[0] === "firm_id");
    expect(firmFilter).toBeDefined();
    expect(firmFilter!.args[1]).toBe(TEST_FIRM_A.id);
  });

  it("API always filters by authenticated user's firm_id on deadlines", async () => {
    mockResponses.push({ data: [], error: null });

    await authedReq("GET", "/api/calendar", partnerTokenPayload());

    const eqCalls = mockQueryLog.filter((l) => l.method === "eq");
    const firmFilter = eqCalls.find((l) => l.args[0] === "firm_id");
    expect(firmFilter).toBeDefined();
    expect(firmFilter!.args[1]).toBe(TEST_FIRM_A.id);
  });
});
