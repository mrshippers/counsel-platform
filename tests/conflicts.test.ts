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
  firmBTokenPayload,
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

// ── CONFLICT CHECK ─────────────────────────────────────────────────

describe("Conflicts — Check", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResponses = [];
    mockInsertLog = [];
    mockQueryLog = [];
  });

  it("returns conflict when party name matches existing opposing party", async () => {
    const existingParties = [
      {
        id: "cp-1",
        party_name: "John Smith",
        party_type: "opposing",
        case_id: "case-old",
        client_id: "client-old",
        cases: { title: "Smith v Jones" },
        clients: { name: "Sarah Jones" },
      },
    ];

    mockResponses.push({ data: existingParties, error: null });

    const res = await authedReq("POST", "/api/conflicts/check", partnerTokenPayload(), {
      party_name: "John Smith",
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.has_conflict).toBe(true);
    expect(body.matches).toHaveLength(1);
    expect(body.matches[0].party_name).toBe("John Smith");
    expect(body.matches[0].party_type).toBe("opposing");
  });

  it("returns no conflict when name is not found", async () => {
    mockResponses.push({ data: [], error: null });

    const res = await authedReq("POST", "/api/conflicts/check", partnerTokenPayload(), {
      party_name: "Brand New Person",
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.has_conflict).toBe(false);
    expect(body.matches).toHaveLength(0);
  });

  it("performs case-insensitive search", async () => {
    mockResponses.push({ data: [], error: null });

    const res = await authedReq("POST", "/api/conflicts/check", partnerTokenPayload(), {
      party_name: "john smith",
    });

    expect(res.status).toBe(200);

    // Verify ilike was used for case-insensitive matching
    const ilikeCalls = mockQueryLog.filter((l) => l.method === "ilike");
    expect(ilikeCalls.length).toBeGreaterThan(0);
  });

  it("rejects check without party_name", async () => {
    const res = await authedReq("POST", "/api/conflicts/check", partnerTokenPayload(), {});

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/party_name/i);
  });

  it("also checks against client names", async () => {
    // First query: conflict_parties table
    mockResponses.push({ data: [], error: null });
    // Second query: clients table
    mockResponses.push({
      data: [
        { id: "client-1", name: "Acme Corp", type: "corporate" },
      ],
      error: null,
    });

    const res = await authedReq("POST", "/api/conflicts/check", partnerTokenPayload(), {
      party_name: "Acme Corp",
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.has_conflict).toBe(true);
    expect(body.client_matches).toHaveLength(1);
    expect(body.client_matches[0].name).toBe("Acme Corp");
  });
});

// ── ADD PARTY ──────────────────────────────────────────────────────

describe("Conflicts — Add Party", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResponses = [];
    mockInsertLog = [];
    mockQueryLog = [];
  });

  it("adds an opposing party to a case", async () => {
    const newParty = {
      id: "cp-new",
      firm_id: TEST_FIRM_A.id,
      case_id: "case-1",
      party_name: "Opposing Corp Ltd",
      party_type: "opposing",
    };

    // Case ownership check
    mockResponses.push({ data: { id: "case-1", firm_id: TEST_FIRM_A.id }, error: null });
    // Insert party
    mockResponses.push({ data: newParty, error: null });
    // Audit
    mockResponses.push({ data: null, error: null });

    const res = await authedReq("POST", "/api/conflicts/parties", partnerTokenPayload(), {
      case_id: "case-1",
      party_name: "Opposing Corp Ltd",
      party_type: "opposing",
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.party_name).toBe("Opposing Corp Ltd");
    expect(body.data.party_type).toBe("opposing");
  });

  it("rejects invalid party_type", async () => {
    const res = await authedReq("POST", "/api/conflicts/parties", partnerTokenPayload(), {
      case_id: "case-1",
      party_name: "Someone",
      party_type: "invalid",
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/party_type/i);
  });

  it("rejects missing required fields", async () => {
    const res = await authedReq("POST", "/api/conflicts/parties", partnerTokenPayload(), {
      case_id: "case-1",
      // missing party_name and party_type
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/required/i);
  });

  it("sets firm_id from JWT, not request body", async () => {
    mockResponses.push({ data: { id: "case-1", firm_id: TEST_FIRM_A.id }, error: null });
    mockResponses.push({ data: { id: "cp-new" }, error: null });
    mockResponses.push({ data: null, error: null }); // audit

    const res = await authedReq("POST", "/api/conflicts/parties", partnerTokenPayload(), {
      case_id: "case-1",
      party_name: "Test Party",
      party_type: "witness",
      firm_id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", // attacker
    });

    expect(res.status).toBe(201);

    const partyInsert = mockInsertLog.find(
      (item) => !Array.isArray(item) && (item as Record<string, unknown>).party_name === "Test Party"
    ) as Record<string, unknown>;
    expect(partyInsert.firm_id).toBe(TEST_FIRM_A.id);
  });
});

// ── LIST PARTIES ───────────────────────────────────────────────────

describe("Conflicts — List Parties", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResponses = [];
    mockInsertLog = [];
    mockQueryLog = [];
  });

  it("lists all parties for a case", async () => {
    const parties = [
      { id: "cp-1", party_name: "John Smith", party_type: "opposing" },
      { id: "cp-2", party_name: "Jane Doe", party_type: "witness" },
    ];

    mockResponses.push({ data: parties, error: null });

    const res = await authedReq("GET", "/api/conflicts/parties?case_id=case-1", partnerTokenPayload());

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(2);
  });

  it("requires case_id parameter", async () => {
    const res = await authedReq("GET", "/api/conflicts/parties", partnerTokenPayload());

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/case_id/i);
  });
});

// ── DELETE PARTY ───────────────────────────────────────────────────

describe("Conflicts — Delete Party", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResponses = [];
    mockInsertLog = [];
    mockQueryLog = [];
  });

  it("partner can delete a party record", async () => {
    mockResponses.push({
      data: { id: "cp-1", firm_id: TEST_FIRM_A.id },
      error: null,
    });
    mockResponses.push({ data: null, error: null }); // delete
    mockResponses.push({ data: null, error: null }); // audit

    const res = await authedReq("DELETE", "/api/conflicts/parties/cp-1", partnerTokenPayload());

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.message).toMatch(/deleted/i);
  });

  it("associate cannot delete party records", async () => {
    const res = await authedReq("DELETE", "/api/conflicts/parties/cp-1", associateTokenPayload());

    expect(res.status).toBe(403);
  });
});
