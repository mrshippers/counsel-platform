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
        select: () => createChainableMock(getNext, table),
        insert: (data: unknown) => createChainableMock(getNext, table),
        update: (data: unknown) => createChainableMock(getNext, table),
        delete: () => createChainableMock(getNext, table),
      };
    },
  }),
}));

// Mock global fetch for external API calls
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const UK_ENV = {
  ...TEST_ENV,
  STRIPE_SECRET_KEY: "sk_test",
  STRIPE_WEBHOOK_SECRET: "whsec_test",
  COMPANIES_HOUSE_API_KEY: "ch_test_key",
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
  return app.request(path, init, UK_ENV);
}

// ── COMPANIES HOUSE SEARCH ─────────────────────────────────────────

describe("UK Services — Companies House Search", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResponses = [];
    // Reset fetch mock — override the default Hono internal fetch
    mockFetch.mockReset();
    // Default: pass through to real Hono fetch for non-external URLs
    mockFetch.mockImplementation(async (input: string | Request) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.includes("api.company-information.service.gov.uk")) {
        return new Response(JSON.stringify({ items: [] }), { status: 200 });
      }
      // Fall through for internal requests
      return undefined;
    });
  });

  it("searches Companies House by company name", async () => {
    mockFetch.mockImplementation(async (input: string | Request) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.includes("api.company-information.service.gov.uk")) {
        return new Response(JSON.stringify({
          items: [
            { company_number: "12345678", title: "ACME CORP LTD", company_status: "active", date_of_creation: "2020-01-15" },
            { company_number: "87654321", title: "ACME TRADING LTD", company_status: "active", date_of_creation: "2019-06-01" },
          ],
          total_results: 2,
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
    });

    const res = await authedReq("GET", "/api/uk/companies-house/search?q=ACME", partnerTokenPayload());

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results).toHaveLength(2);
    expect(body.results[0].company_number).toBe("12345678");
    expect(body.results[0].title).toBe("ACME CORP LTD");
  });

  it("requires search query parameter", async () => {
    const res = await authedReq("GET", "/api/uk/companies-house/search", partnerTokenPayload());

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/query/i);
  });
});

// ── COMPANIES HOUSE COMPANY DETAIL ─────────────────────────────────

describe("UK Services — Companies House Detail", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResponses = [];
    mockFetch.mockReset();
  });

  it("fetches company details by number", async () => {
    mockFetch.mockImplementation(async (input: string | Request) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.includes("api.company-information.service.gov.uk")) {
        return new Response(JSON.stringify({
          company_number: "12345678",
          company_name: "ACME CORP LTD",
          company_status: "active",
          registered_office_address: { address_line_1: "123 High Street", locality: "London", postal_code: "EC1A 1BB" },
          type: "ltd",
          date_of_creation: "2020-01-15",
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
    });

    const res = await authedReq("GET", "/api/uk/companies-house/12345678", partnerTokenPayload());

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.company.company_name).toBe("ACME CORP LTD");
    expect(body.company.company_status).toBe("active");
    expect(body.company.registered_office_address.postal_code).toBe("EC1A 1BB");
  });

  it("returns 404 for non-existent company", async () => {
    mockFetch.mockImplementation(async () => {
      return new Response(JSON.stringify({ errors: [{ error: "company-profile-not-found" }] }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    });

    const res = await authedReq("GET", "/api/uk/companies-house/99999999", partnerTokenPayload());

    expect(res.status).toBe(404);
  });
});

// ── LAND REGISTRY SEARCH ───────────────────────────────────────────

describe("UK Services — Land Registry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResponses = [];
    mockFetch.mockReset();
  });

  it("searches Land Registry by postcode", async () => {
    mockFetch.mockImplementation(async (input: string | Request) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.includes("landregistry.data.gov.uk")) {
        return new Response(JSON.stringify({
          result: {
            primaryTopic: {
              member: [
                { title: "Title ABC123", propertyAddress: "1 High Street, London", pricePaid: 350000, transactionDate: "2023-06-15" },
              ],
            },
          },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
    });

    const res = await authedReq("GET", "/api/uk/land-registry/search?postcode=EC1A+1BB", partnerTokenPayload());

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results).toBeDefined();
    expect(body.results.length).toBeGreaterThanOrEqual(0);
  });

  it("requires postcode parameter", async () => {
    const res = await authedReq("GET", "/api/uk/land-registry/search", partnerTokenPayload());

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/postcode/i);
  });
});
