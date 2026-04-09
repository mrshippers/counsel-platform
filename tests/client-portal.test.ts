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

function req(method: string, path: string, body?: unknown) {
  const init: RequestInit = {
    method,
    headers: { "Content-Type": "application/json" },
  };
  if (body) init.body = JSON.stringify(body);
  return app.request(path, init, FULL_ENV);
}

// ── INVITE CLIENT ──────────────────────────────────────────────────

describe("Client Portal — Invite", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResponses = [];
    mockInsertLog = [];
    mockQueryLog = [];
  });

  it("generates a portal access token for a client", async () => {
    // Client ownership check
    mockResponses.push({
      data: { id: "client-1", firm_id: TEST_FIRM_A.id, name: "John Smith", email: "john@example.com" },
      error: null,
    });
    // Token insert
    mockResponses.push({
      data: { id: "cpt-1", token: "abc123", client_id: "client-1" },
      error: null,
    });

    const res = await authedReq("POST", "/api/portal/invite", partnerTokenPayload(), {
      client_id: "client-1",
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.portal_url).toContain("portal");
    expect(body.portal_url).toContain("token=");
  });

  it("rejects invite without client_id", async () => {
    const res = await authedReq("POST", "/api/portal/invite", partnerTokenPayload(), {});

    expect(res.status).toBe(400);
  });
});

// ── CLIENT LOGIN ───────────────────────────────────────────────────

describe("Client Portal — Login", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResponses = [];
    mockInsertLog = [];
    mockQueryLog = [];
  });

  it("client logs in with valid token", async () => {
    // Token lookup
    mockResponses.push({
      data: {
        id: "cpt-1",
        token: "valid-token-123",
        client_id: "client-1",
        firm_id: TEST_FIRM_A.id,
        expires_at: new Date(Date.now() + 86400000).toISOString(),
      },
      error: null,
    });
    // Client data
    mockResponses.push({
      data: { id: "client-1", name: "John Smith", firm_id: TEST_FIRM_A.id },
      error: null,
    });

    const res = await req("POST", "/api/portal/login", {
      token: "valid-token-123",
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.access_token).toBeDefined();
    expect(body.client.name).toBe("John Smith");
  });

  it("rejects expired token", async () => {
    mockResponses.push({
      data: {
        id: "cpt-1",
        token: "expired-token",
        client_id: "client-1",
        firm_id: TEST_FIRM_A.id,
        expires_at: new Date(Date.now() - 1000).toISOString(), // expired
      },
      error: null,
    });

    const res = await req("POST", "/api/portal/login", {
      token: "expired-token",
    });

    expect(res.status).toBe(401);
  });

  it("rejects invalid token", async () => {
    mockResponses.push({ data: null, error: { message: "not found" } });

    const res = await req("POST", "/api/portal/login", {
      token: "invalid",
    });

    expect(res.status).toBe(401);
  });
});

// ── CLIENT VIEW CASES ──────────────────────────────────────────────

describe("Client Portal — View Cases", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResponses = [];
    mockInsertLog = [];
    mockQueryLog = [];
  });

  it("client sees their cases with progress", async () => {
    mockResponses.push({
      data: [
        {
          id: "case-1",
          title: "Contract Dispute",
          status: "in_progress",
          progress: 50,
          type: "civil",
          opened_date: "2026-01-15",
          deadline: "2026-05-01",
          users: { name: "Jessica Townsend" },
        },
      ],
      error: null,
    });

    // Create a client JWT
    const token = await createTestToken({
      sub: "client-1",
      firm_id: TEST_FIRM_A.id,
      role: "client" as "partner", // client role
      email: "john@example.com",
    });

    const res = await app.request(
      "/api/portal/cases",
      {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
      },
      FULL_ENV
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].title).toBe("Contract Dispute");
    expect(body.data[0].progress).toBe(50);
    // Should NOT expose internal notes
    expect(body.data[0].notes).toBeUndefined();
  });
});

// ── CLIENT VIEW DOCUMENTS ──────────────────────────────────────────

describe("Client Portal — View Documents", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResponses = [];
    mockInsertLog = [];
    mockQueryLog = [];
  });

  it("client sees documents for their case", async () => {
    // Verify case belongs to client
    mockResponses.push({
      data: { id: "case-1", client_id: "client-1", firm_id: TEST_FIRM_A.id },
      error: null,
    });
    // Documents
    mockResponses.push({
      data: [
        { id: "doc-1", file_name: "contract.pdf", file_type: "application/pdf", created_at: "2026-04-01" },
        { id: "doc-2", file_name: "evidence.jpg", file_type: "image/jpeg", created_at: "2026-04-02" },
      ],
      error: null,
    });

    const token = await createTestToken({
      sub: "client-1",
      firm_id: TEST_FIRM_A.id,
      role: "client" as "partner",
      email: "john@example.com",
    });

    const res = await app.request(
      "/api/portal/cases/case-1/documents",
      {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
      },
      FULL_ENV
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(2);
  });
});
