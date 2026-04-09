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
  hashPassword: vi.fn().mockResolvedValue("100000:fakesalt:fakehash"),
  validatePassword: vi.fn(() => null),
}));

vi.mock("stripe", () => ({
  default: class Stripe {
    checkout = { sessions: { create: vi.fn() } };
    billingPortal = { sessions: { create: vi.fn() } };
    webhooks = { constructEvent: vi.fn() };
    subscriptions = { retrieve: vi.fn() };
  },
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

const FULL_ENV = { ...TEST_ENV, STRIPE_SECRET_KEY: "sk_test", STRIPE_WEBHOOK_SECRET: "whsec_test", COMPANIES_HOUSE_API_KEY: "ch_test" };

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
  return app.request(path, init, FULL_ENV);
}

// ── PLAN LIMIT ENFORCEMENT ─────────────────────────────────────────

describe("Plan Limits — User Creation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResponses = [];
    mockInsertLog = [];
    mockQueryLog = [];
  });

  it("blocks adding users when solo plan limit (1) reached", async () => {
    // Firm lookup — solo plan
    mockResponses.push({
      data: { id: TEST_FIRM_A.id, plan: "solo" },
      error: null,
    });
    // Current user count — already has 1 user
    mockResponses.push({
      data: [{ id: TEST_PARTNER.id }],
      error: null,
    });

    const res = await authedReq("POST", "/api/lawyers", partnerTokenPayload(), {
      name: "New Lawyer",
      email: "new@firm.law",
      password: "Secure123!",
      role: "associate",
    });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/plan.*limit/i);
  });

  it("allows adding users when under plan limit", async () => {
    // Firm lookup — professional plan (max 10)
    mockResponses.push({
      data: { id: TEST_FIRM_A.id, plan: "professional" },
      error: null,
    });
    // Current user count — only 3 users
    mockResponses.push({
      data: [{ id: "u1" }, { id: "u2" }, { id: "u3" }],
      error: null,
    });
    // User insert succeeds
    mockResponses.push({
      data: { id: "new-lawyer-id", name: "New Lawyer", email: "new@firm.law", role: "associate", firm_id: TEST_FIRM_A.id },
      error: null,
    });
    // Audit log
    mockResponses.push({ data: null, error: null });

    const res = await authedReq("POST", "/api/lawyers", partnerTokenPayload(), {
      name: "New Lawyer",
      email: "new@firm.law",
      password: "Secure123!",
      role: "associate",
    });

    expect(res.status).toBe(201);
  });

  it("blocks at starter limit of 5 users", async () => {
    mockResponses.push({
      data: { id: TEST_FIRM_A.id, plan: "starter" },
      error: null,
    });
    // Already at 5
    mockResponses.push({
      data: [{ id: "u1" }, { id: "u2" }, { id: "u3" }, { id: "u4" }, { id: "u5" }],
      error: null,
    });

    const res = await authedReq("POST", "/api/lawyers", partnerTokenPayload(), {
      name: "Sixth Person",
      email: "sixth@firm.law",
      password: "Secure123!",
      role: "associate",
    });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/plan.*limit/i);
    expect(body.max_users).toBe(5);
    expect(body.current_users).toBe(5);
  });

  it("enterprise allows up to 20 users", async () => {
    mockResponses.push({
      data: { id: TEST_FIRM_A.id, plan: "enterprise" },
      error: null,
    });
    // 19 users — one more slot
    const existingUsers = Array.from({ length: 19 }, (_, i) => ({ id: `u${i}` }));
    mockResponses.push({ data: existingUsers, error: null });
    // User insert
    mockResponses.push({
      data: { id: "new-id", name: "User 20", email: "u20@firm.law", role: "associate", firm_id: TEST_FIRM_A.id },
      error: null,
    });
    mockResponses.push({ data: null, error: null }); // audit

    const res = await authedReq("POST", "/api/lawyers", partnerTokenPayload(), {
      name: "User 20",
      email: "u20@firm.law",
      password: "Secure123!",
      role: "associate",
    });

    expect(res.status).toBe(201);
  });

  it("returns plan upgrade suggestion when limit reached", async () => {
    mockResponses.push({
      data: { id: TEST_FIRM_A.id, plan: "starter" },
      error: null,
    });
    mockResponses.push({
      data: [{ id: "u1" }, { id: "u2" }, { id: "u3" }, { id: "u4" }, { id: "u5" }],
      error: null,
    });

    const res = await authedReq("POST", "/api/lawyers", partnerTokenPayload(), {
      name: "Over Limit",
      email: "over@firm.law",
      password: "Secure123!",
      role: "associate",
    });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.upgrade_to).toBe("professional");
  });
});
