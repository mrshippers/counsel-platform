import { describe, it, expect, vi, beforeEach } from "vitest";
import { app } from "../src/index";
import {
  TEST_ENV,
  TEST_FIRM_A,
  TEST_PARTNER,
  createTestToken,
  partnerTokenPayload,
} from "./helpers";

const mockSendEmail = vi.fn().mockResolvedValue({ id: "email-123" });

vi.mock("../src/lib/password", () => ({
  verifyPassword: vi.fn(),
  hashPassword: vi.fn(),
  validatePassword: vi.fn(() => null),
}));

vi.mock("resend", () => ({
  Resend: class {
    emails = { send: mockSendEmail };
  },
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
          if (["single", "limit", "order", "in"].includes(prop)) {
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

// ── DEADLINE REMINDER EMAILS ───────────────────────────────────────

describe("Email Notifications — Deadline Reminders", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResponses = [];
    mockInsertLog = [];
    mockQueryLog = [];
  });

  it("sends reminder emails for deadlines within 48 hours", async () => {
    // Deadlines within 48hrs
    mockResponses.push({
      data: [
        {
          id: "dl-1",
          lawyer_id: TEST_PARTNER.id,
          date: "2026-04-08",
          title: "Filing deadline",
          cases: { title: "Smith v Jones", id: "case-1" },
        },
      ],
      error: null,
    });
    // Lawyer data
    mockResponses.push({
      data: [
        {
          id: TEST_PARTNER.id,
          name: "Jessica Townsend",
          email: "jessica@townsend.law",
          reminder_emails_enabled: true,
        },
      ],
      error: null,
    });

    const res = await authedReq("POST", "/api/deadlines/send-reminders", partnerTokenPayload());

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.reminders).toHaveLength(1);
    expect(body.emails_sent).toBe(1);

    // Verify Resend was called
    expect(mockSendEmail).toHaveBeenCalledOnce();
    const emailCall = mockSendEmail.mock.calls[0][0];
    expect(emailCall.to).toBe("jessica@townsend.law");
    expect(emailCall.subject).toContain("Smith v Jones");
  });

  it("skips lawyers with reminders disabled", async () => {
    mockResponses.push({
      data: [
        { id: "dl-1", lawyer_id: "lawyer-no-email", date: "2026-04-08", title: "Deadline", cases: null },
      ],
      error: null,
    });
    mockResponses.push({
      data: [
        { id: "lawyer-no-email", name: "Quiet Lawyer", email: "quiet@firm.law", reminder_emails_enabled: false },
      ],
      error: null,
    });

    const res = await authedReq("POST", "/api/deadlines/send-reminders", partnerTokenPayload());

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.skipped).toBe(1);
    expect(mockSendEmail).not.toHaveBeenCalled();
  });
});

// ── PASSWORD RESET EMAILS ──────────────────────────────────────────

describe("Email Notifications — Password Reset", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResponses = [];
    mockInsertLog = [];
    mockQueryLog = [];
  });

  it("sends password reset email when user exists", async () => {
    // User lookup
    mockResponses.push({
      data: { id: TEST_PARTNER.id, name: "Jessica Townsend", email: "jessica@townsend.law", firm_id: TEST_FIRM_A.id },
      error: null,
    });
    // Token insert
    mockResponses.push({ data: null, error: null });

    const res = await app.request(
      "/api/auth/password-reset",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "jessica@townsend.law" }),
      },
      FULL_ENV
    );

    expect(res.status).toBe(200);

    // Verify email was sent
    expect(mockSendEmail).toHaveBeenCalledOnce();
    const emailCall = mockSendEmail.mock.calls[0][0];
    expect(emailCall.to).toBe("jessica@townsend.law");
    expect(emailCall.subject).toContain("Password reset");
    expect(emailCall.html).toContain("reset");
  });

  it("does not send email for non-existent user (but returns 200)", async () => {
    // User not found
    mockResponses.push({ data: null, error: { message: "not found" } });

    const res = await app.request(
      "/api/auth/password-reset",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "nobody@example.com" }),
      },
      FULL_ENV
    );

    expect(res.status).toBe(200);
    expect(mockSendEmail).not.toHaveBeenCalled();
  });
});
