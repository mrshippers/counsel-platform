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

vi.mock("stripe", () => ({
  default: class Stripe {
    checkout = { sessions: { create: vi.fn() } };
    billingPortal = { sessions: { create: vi.fn() } };
    webhooks = { constructEvent: vi.fn() };
    subscriptions = { retrieve: vi.fn() };
  },
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
  return app.request(path, init, { ...TEST_ENV, STRIPE_SECRET_KEY: "sk_test", STRIPE_WEBHOOK_SECRET: "whsec_test" });
}

// ── GENERATE INVOICE ───────────────────────────────────────────────

describe("Invoices — Generate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResponses = [];
    mockInsertLog = [];
    mockQueryLog = [];
  });

  it("generates invoice from time entries for a case", async () => {
    // Case with client
    mockResponses.push({
      data: {
        id: "case-1",
        firm_id: TEST_FIRM_A.id,
        title: "Smith Contract Dispute",
        type: "civil",
        clients: { name: "John Smith", email: "john@example.com", phone: "07700900123" },
      },
      error: null,
    });
    // Firm name
    mockResponses.push({
      data: { id: TEST_FIRM_A.id, name: "Townsend & Associates" },
      error: null,
    });
    // Time entries for the case
    mockResponses.push({
      data: [
        { id: "te-1", description: "Initial consultation", duration_minutes: 60, rate_pence: 25000, billable: true, date: "2026-04-01", lawyer_id: TEST_PARTNER.id },
        { id: "te-2", description: "Contract review", duration_minutes: 120, rate_pence: 25000, billable: true, date: "2026-04-02", lawyer_id: TEST_PARTNER.id },
        { id: "te-3", description: "Admin filing", duration_minutes: 30, rate_pence: 25000, billable: false, date: "2026-04-03", lawyer_id: TEST_PARTNER.id },
      ],
      error: null,
    });
    // Invoice INSERT
    mockResponses.push({
      data: { id: "inv-1", firm_id: TEST_FIRM_A.id, case_id: "case-1" },
      error: null,
    });

    const res = await authedReq("POST", "/api/invoices/generate", partnerTokenPayload(), {
      case_id: "case-1",
    });

    expect(res.status).toBe(201);
    const body = await res.json();

    // Only billable entries in line items
    expect(body.invoice.line_items).toHaveLength(2);

    // 60 mins at £250/hr = £250, 120 mins at £250/hr = £500 => subtotal £750
    expect(body.invoice.subtotal_pence).toBe(75000);

    // VAT at 20%
    expect(body.invoice.vat_pence).toBe(15000);

    // Total = subtotal + VAT
    expect(body.invoice.total_pence).toBe(90000);

    expect(body.invoice.currency).toBe("GBP");
    expect(body.invoice.firm_name).toBe("Townsend & Associates");
    expect(body.invoice.client_name).toBe("John Smith");
    expect(body.invoice.case_title).toBe("Smith Contract Dispute");

    // HTML representation included
    expect(body.html).toContain("Townsend & Associates");
    expect(body.html).toContain("John Smith");
    expect(body.html).toContain("£750.00");
  });

  it("rejects invoice without case_id", async () => {
    const res = await authedReq("POST", "/api/invoices/generate", partnerTokenPayload(), {});

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/case_id/i);
  });

  it("returns empty invoice when case has no billable entries", async () => {
    mockResponses.push({
      data: { id: "case-1", firm_id: TEST_FIRM_A.id, title: "Test Case", clients: { name: "Jane" } },
      error: null,
    });
    mockResponses.push({ data: { id: TEST_FIRM_A.id, name: "Test Firm" }, error: null });
    mockResponses.push({ data: [], error: null }); // no time entries
    // Invoice INSERT
    mockResponses.push({ data: { id: "inv-2", firm_id: TEST_FIRM_A.id, case_id: "case-1" }, error: null });

    const res = await authedReq("POST", "/api/invoices/generate", partnerTokenPayload(), {
      case_id: "case-1",
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.invoice.line_items).toHaveLength(0);
    expect(body.invoice.subtotal_pence).toBe(0);
    expect(body.invoice.total_pence).toBe(0);
  });

  it("includes invoice number and date", async () => {
    mockResponses.push({
      data: { id: "case-1", firm_id: TEST_FIRM_A.id, title: "Test", clients: { name: "Bob" } },
      error: null,
    });
    mockResponses.push({ data: { id: TEST_FIRM_A.id, name: "Firm" }, error: null });
    mockResponses.push({ data: [], error: null });
    // Invoice INSERT
    mockResponses.push({ data: { id: "inv-3", firm_id: TEST_FIRM_A.id, case_id: "case-1" }, error: null });

    const res = await authedReq("POST", "/api/invoices/generate", partnerTokenPayload(), {
      case_id: "case-1",
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.invoice.invoice_number).toBeDefined();
    expect(body.invoice.invoice_date).toBeDefined();
  });

  it("allows custom VAT rate", async () => {
    mockResponses.push({
      data: { id: "case-1", firm_id: TEST_FIRM_A.id, title: "Test", clients: { name: "Bob" } },
      error: null,
    });
    mockResponses.push({ data: { id: TEST_FIRM_A.id, name: "Firm" }, error: null });
    mockResponses.push({
      data: [
        { id: "te-1", description: "Work", duration_minutes: 60, rate_pence: 10000, billable: true, date: "2026-04-01" },
      ],
      error: null,
    });
    // Invoice INSERT
    mockResponses.push({ data: { id: "inv-4", firm_id: TEST_FIRM_A.id, case_id: "case-1" }, error: null });

    const res = await authedReq("POST", "/api/invoices/generate", partnerTokenPayload(), {
      case_id: "case-1",
      vat_rate: 0, // VAT exempt
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.invoice.vat_pence).toBe(0);
    expect(body.invoice.total_pence).toBe(10000);
  });
});
