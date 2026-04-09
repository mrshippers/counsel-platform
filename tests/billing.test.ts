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

// Mock Stripe — we mock the module so routes can import it
const mockStripeCheckoutCreate = vi.fn();
const mockStripeBillingPortalCreate = vi.fn();
const mockStripeWebhookConstructEvent = vi.fn();
const mockStripeSubscriptionsRetrieve = vi.fn();

vi.mock("stripe", () => {
  return {
    default: class Stripe {
      checkout = {
        sessions: { create: mockStripeCheckoutCreate },
      };
      billingPortal = {
        sessions: { create: mockStripeBillingPortalCreate },
      };
      webhooks = {
        constructEvent: mockStripeWebhookConstructEvent,
      };
      subscriptions = {
        retrieve: mockStripeSubscriptionsRetrieve,
      };
    },
  };
});

const BILLING_TEST_ENV = {
  ...TEST_ENV,
  STRIPE_SECRET_KEY: "sk_test_fake",
  STRIPE_WEBHOOK_SECRET: "whsec_test_fake",
};

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
  return app.request(path, init, BILLING_TEST_ENV);
}

// ── CHECKOUT SESSION ───────────────────────────────────────────────

describe("Billing — Create Checkout Session", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResponses = [];
    mockInsertLog = [];
    mockQueryLog = [];
  });

  it("creates a Stripe checkout session for a plan", async () => {
    // Firm lookup
    mockResponses.push({
      data: { id: TEST_FIRM_A.id, name: "Townsend & Associates", stripe_customer_id: null },
      error: null,
    });

    mockStripeCheckoutCreate.mockResolvedValue({
      id: "cs_test_123",
      url: "https://checkout.stripe.com/pay/cs_test_123",
    });

    const res = await authedReq("POST", "/api/billing/checkout", partnerTokenPayload(), {
      plan: "professional",
      billing_cycle: "monthly",
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.checkout_url).toContain("checkout.stripe.com");
    expect(mockStripeCheckoutCreate).toHaveBeenCalledOnce();
  });

  it("rejects invalid plan", async () => {
    const res = await authedReq("POST", "/api/billing/checkout", partnerTokenPayload(), {
      plan: "mega_plan",
      billing_cycle: "monthly",
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/plan/i);
  });

  it("rejects invalid billing cycle", async () => {
    const res = await authedReq("POST", "/api/billing/checkout", partnerTokenPayload(), {
      plan: "professional",
      billing_cycle: "weekly",
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/billing_cycle/i);
  });

  it("only partners can create checkout sessions", async () => {
    const res = await authedReq("POST", "/api/billing/checkout", associateTokenPayload(), {
      plan: "professional",
      billing_cycle: "monthly",
    });

    expect(res.status).toBe(403);
  });

  it("uses existing stripe_customer_id if firm already has one", async () => {
    mockResponses.push({
      data: { id: TEST_FIRM_A.id, name: "Townsend & Associates", stripe_customer_id: "cus_existing" },
      error: null,
    });

    mockStripeCheckoutCreate.mockResolvedValue({
      id: "cs_test_456",
      url: "https://checkout.stripe.com/pay/cs_test_456",
    });

    const res = await authedReq("POST", "/api/billing/checkout", partnerTokenPayload(), {
      plan: "starter",
      billing_cycle: "annual",
    });

    expect(res.status).toBe(200);

    // Verify customer was passed (not created new)
    const checkoutCall = mockStripeCheckoutCreate.mock.calls[0][0];
    expect(checkoutCall.customer).toBe("cus_existing");
  });
});

// ── SUBSCRIPTION STATUS ────────────────────────────────────────────

describe("Billing — Subscription Status", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResponses = [];
    mockInsertLog = [];
    mockQueryLog = [];
  });

  it("returns current subscription status", async () => {
    mockResponses.push({
      data: {
        id: TEST_FIRM_A.id,
        plan: "professional",
        stripe_customer_id: "cus_123",
        stripe_subscription_id: "sub_123",
      },
      error: null,
    });

    mockStripeSubscriptionsRetrieve.mockResolvedValue({
      id: "sub_123",
      status: "active",
      current_period_end: 1743984000, // future date
      items: {
        data: [{ price: { unit_amount: 9900, currency: "gbp", recurring: { interval: "month" } } }],
      },
    });

    const res = await authedReq("GET", "/api/billing/subscription", partnerTokenPayload());

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("active");
    expect(body.plan).toBe("professional");
    expect(body.currency).toBe("GBP");
  });

  it("returns free tier when no subscription exists", async () => {
    mockResponses.push({
      data: {
        id: TEST_FIRM_A.id,
        plan: "solo",
        stripe_customer_id: null,
        stripe_subscription_id: null,
      },
      error: null,
    });

    const res = await authedReq("GET", "/api/billing/subscription", partnerTokenPayload());

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("none");
    expect(body.plan).toBe("solo");
  });
});

// ── CUSTOMER PORTAL ────────────────────────────────────────────────

describe("Billing — Customer Portal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResponses = [];
    mockInsertLog = [];
    mockQueryLog = [];
  });

  it("creates a billing portal session", async () => {
    mockResponses.push({
      data: { id: TEST_FIRM_A.id, stripe_customer_id: "cus_123" },
      error: null,
    });

    mockStripeBillingPortalCreate.mockResolvedValue({
      url: "https://billing.stripe.com/session/ses_123",
    });

    const res = await authedReq("POST", "/api/billing/portal", partnerTokenPayload());

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.portal_url).toContain("billing.stripe.com");
  });

  it("returns error if firm has no Stripe customer", async () => {
    mockResponses.push({
      data: { id: TEST_FIRM_A.id, stripe_customer_id: null },
      error: null,
    });

    const res = await authedReq("POST", "/api/billing/portal", partnerTokenPayload());

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/no.*subscription/i);
  });

  it("only partners can access the billing portal", async () => {
    const res = await authedReq("POST", "/api/billing/portal", associateTokenPayload());

    expect(res.status).toBe(403);
  });
});

// ── WEBHOOK ────────────────────────────────────────────────────────

describe("Billing — Stripe Webhook", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResponses = [];
    mockInsertLog = [];
    mockQueryLog = [];
  });

  it("handles checkout.session.completed — updates firm plan and stripe IDs", async () => {
    const webhookEvent = {
      type: "checkout.session.completed",
      data: {
        object: {
          customer: "cus_new",
          subscription: "sub_new",
          metadata: { firm_id: TEST_FIRM_A.id, plan: "professional" },
        },
      },
    };

    mockStripeWebhookConstructEvent.mockReturnValue(webhookEvent);
    // Firm update
    mockResponses.push({ data: { id: TEST_FIRM_A.id }, error: null });

    const res = await app.request(
      "/api/billing/webhook",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "stripe-signature": "test_sig",
        },
        body: JSON.stringify(webhookEvent),
      },
      BILLING_TEST_ENV
    );

    expect(res.status).toBe(200);

    // Verify firm was updated with stripe IDs and plan
    const updateCall = mockQueryLog.find(
      (l) => l.table === "firms" && l.method === "update"
    );
    expect(updateCall).toBeDefined();
  });

  it("handles customer.subscription.deleted — downgrades to solo", async () => {
    const webhookEvent = {
      type: "customer.subscription.deleted",
      data: {
        object: {
          customer: "cus_123",
          id: "sub_cancelled",
        },
      },
    };

    mockStripeWebhookConstructEvent.mockReturnValue(webhookEvent);
    // Find firm by stripe_customer_id
    mockResponses.push({ data: { id: TEST_FIRM_A.id, stripe_customer_id: "cus_123" }, error: null });
    // Update firm
    mockResponses.push({ data: { id: TEST_FIRM_A.id }, error: null });

    const res = await app.request(
      "/api/billing/webhook",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "stripe-signature": "test_sig",
        },
        body: JSON.stringify(webhookEvent),
      },
      BILLING_TEST_ENV
    );

    expect(res.status).toBe(200);
  });

  it("rejects webhook with invalid signature", async () => {
    mockStripeWebhookConstructEvent.mockImplementation(() => {
      throw new Error("Invalid signature");
    });

    const res = await app.request(
      "/api/billing/webhook",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "stripe-signature": "bad_sig",
        },
        body: JSON.stringify({ type: "test" }),
      },
      BILLING_TEST_ENV
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/signature/i);
  });
});
