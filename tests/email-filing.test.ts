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

const FULL_ENV = { ...TEST_ENV, STRIPE_SECRET_KEY: "sk_test", STRIPE_WEBHOOK_SECRET: "whsec_test" };

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

// ── FILE EMAIL TO CASE ─────────────────────────────────────────────

describe("Email Filing — File Email", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResponses = [];
    mockInsertLog = [];
    mockQueryLog = [];
  });

  it("files an email against a case", async () => {
    // Case ownership check
    mockResponses.push({ data: { id: "case-1", firm_id: TEST_FIRM_A.id, lawyer_id: TEST_PARTNER.id }, error: null });
    // Insert email
    mockResponses.push({
      data: {
        id: "em-1",
        case_id: "case-1",
        subject: "Re: Contract Terms",
        from_address: "client@example.com",
        body: "Please find the updated terms attached.",
        received_date: "2026-04-07T10:30:00Z",
      },
      error: null,
    });
    // Audit
    mockResponses.push({ data: null, error: null });

    const res = await authedReq("POST", "/api/emails/file", partnerTokenPayload(), {
      case_id: "case-1",
      subject: "Re: Contract Terms",
      from_address: "client@example.com",
      body: "Please find the updated terms attached.",
      received_date: "2026-04-07T10:30:00Z",
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.subject).toBe("Re: Contract Terms");
    expect(body.data.from_address).toBe("client@example.com");
  });

  it("rejects email without required fields", async () => {
    const res = await authedReq("POST", "/api/emails/file", partnerTokenPayload(), {
      case_id: "case-1",
      // missing subject, from_address
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/required/i);
  });

  it("sets firm_id from JWT, not request body", async () => {
    mockResponses.push({ data: { id: "case-1", firm_id: TEST_FIRM_A.id, lawyer_id: TEST_PARTNER.id }, error: null });
    mockResponses.push({ data: { id: "em-2" }, error: null });
    mockResponses.push({ data: null, error: null }); // audit

    await authedReq("POST", "/api/emails/file", partnerTokenPayload(), {
      case_id: "case-1",
      subject: "Test",
      from_address: "test@example.com",
      body: "Test body",
      firm_id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", // attacker
    });

    const emailInsert = mockInsertLog.find(
      (item) => !Array.isArray(item) && (item as Record<string, unknown>).subject === "Test"
    ) as Record<string, unknown>;
    expect(emailInsert.firm_id).toBe(TEST_FIRM_A.id);
  });

  it("associate can file emails to their own cases", async () => {
    mockResponses.push({ data: { id: "case-2", firm_id: TEST_FIRM_A.id, lawyer_id: TEST_ASSOCIATE.id }, error: null });
    mockResponses.push({ data: { id: "em-3" }, error: null });
    mockResponses.push({ data: null, error: null });

    const res = await authedReq("POST", "/api/emails/file", associateTokenPayload(), {
      case_id: "case-2",
      subject: "Client Follow-up",
      from_address: "client@example.com",
      body: "Following up on our meeting.",
    });

    expect(res.status).toBe(201);
  });
});

// ── LIST FILED EMAILS ──────────────────────────────────────────────

describe("Email Filing — List", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResponses = [];
    mockInsertLog = [];
    mockQueryLog = [];
  });

  it("lists emails for a case", async () => {
    mockResponses.push({
      data: [
        { id: "em-1", subject: "Contract Terms", from_address: "client@example.com" },
        { id: "em-2", subject: "Meeting Notes", from_address: "lawyer@firm.com" },
      ],
      error: null,
    });

    const res = await authedReq("GET", "/api/emails?case_id=case-1", partnerTokenPayload());

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(2);
  });

  it("requires case_id parameter", async () => {
    const res = await authedReq("GET", "/api/emails", partnerTokenPayload());

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/case_id/i);
  });
});

// ── DELETE FILED EMAIL ─────────────────────────────────────────────

describe("Email Filing — Delete", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResponses = [];
    mockInsertLog = [];
    mockQueryLog = [];
  });

  it("partner can delete a filed email", async () => {
    mockResponses.push({ data: { id: "em-1", firm_id: TEST_FIRM_A.id }, error: null });
    mockResponses.push({ data: null, error: null }); // delete
    mockResponses.push({ data: null, error: null }); // audit

    const res = await authedReq("DELETE", "/api/emails/em-1", partnerTokenPayload());

    expect(res.status).toBe(200);
  });

  it("associate cannot delete filed emails", async () => {
    const res = await authedReq("DELETE", "/api/emails/em-1", associateTokenPayload());

    expect(res.status).toBe(403);
  });
});
