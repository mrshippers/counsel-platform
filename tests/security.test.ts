import { describe, it, expect, vi } from "vitest";
import { app } from "../src/index";
import {
  TEST_ENV,
  TEST_PARTNER,
  createTestToken,
  partnerTokenPayload,
} from "./helpers";

vi.mock("../src/lib/password", () => ({
  verifyPassword: vi.fn(),
  hashPassword: vi.fn().mockResolvedValue("100000:fakesalt:fakehash"),
  validatePassword: vi.fn((pw: string) => {
    if (!pw || pw.length < 8) return "Password must be at least 8 characters long";
    if (pw.length > 128) return "Password must be 128 characters or fewer";
    if (!/\d/.test(pw)) return "Password must contain at least one number";
    return null;
  }),
}));

let mockResponses: Array<{ data: unknown; error: unknown }> = [];

function createChainableMock(getNext: () => { data: unknown; error: unknown }) {
  let depth = 0;
  const proxy = (): unknown => {
    depth++;
    return new Proxy({} as Record<string, unknown>, {
      get(_target, prop: string) {
        if (prop === "then") {
          if (depth >= 2) return (resolve: (v: unknown) => void) => resolve({ data: null, error: null });
          return undefined;
        }
        return (..._args: unknown[]) => {
          if (["single", "limit"].includes(prop)) return Promise.resolve(getNext());
          if (prop === "order") {
            const result = getNext();
            return { then: (r: (v: unknown) => void) => r(result), limit: () => Promise.resolve(result) };
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
    from: () => {
      const getNext = () => mockResponses.shift() || { data: null, error: null };
      return {
        select: () => createChainableMock(getNext),
        insert: () => createChainableMock(getNext),
        update: () => createChainableMock(getNext),
        delete: () => createChainableMock(getNext),
      };
    },
  }),
}));

function req(method: string, path: string, body?: unknown, headers?: Record<string, string>) {
  const init: RequestInit = { method, headers: { "Content-Type": "application/json", ...headers } };
  if (body) init.body = JSON.stringify(body);
  return app.request(path, init, TEST_ENV);
}

describe("Security — Headers", () => {
  it("health endpoint returns security headers", async () => {
    const res = await req("GET", "/api/health");

    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("X-Frame-Options")).toBe("SAMEORIGIN");
  });
});

describe("Security — CORS", () => {
  it("blocks non-Counsel origins on OPTIONS preflight", async () => {
    const res = await app.request(
      "/api/health",
      {
        method: "OPTIONS",
        headers: { Origin: "https://evil.com", "Access-Control-Request-Method": "GET" },
      },
      TEST_ENV
    );

    const origin = res.headers.get("Access-Control-Allow-Origin");
    expect(origin).not.toBe("https://evil.com");
  });

  it("allows counsel-app.co.uk origin", async () => {
    const res = await app.request(
      "/api/health",
      {
        method: "OPTIONS",
        headers: {
          Origin: "https://counsel-app.co.uk",
          "Access-Control-Request-Method": "GET",
        },
      },
      TEST_ENV
    );

    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://counsel-app.co.uk");
  });
});

describe("Security — Input validation", () => {
  it("rejects oversized title field", async () => {
    const token = await createTestToken(partnerTokenPayload());
    const longTitle = "A".repeat(501);

    const res = await req("POST", "/api/cases", {
      client_id: "cl1",
      lawyer_id: TEST_PARTNER.id,
      title: longTitle,
      type: "corporate",
    }, { Authorization: `Bearer ${token}` });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/title.*500/i);
  });

  it("rejects oversized notes field", async () => {
    const token = await createTestToken(partnerTokenPayload());
    const longNotes = "B".repeat(10001);

    const res = await req("POST", "/api/cases", {
      client_id: "cl1",
      lawyer_id: TEST_PARTNER.id,
      title: "Valid Title",
      type: "corporate",
      notes: longNotes,
    }, { Authorization: `Bearer ${token}` });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/notes.*10000/i);
  });

  it("allows normal-length fields", async () => {
    const token = await createTestToken(partnerTokenPayload());
    // Mock client + lawyer check + case insert
    mockResponses.push({ data: { id: "cl1" }, error: null });
    mockResponses.push({ data: { id: TEST_PARTNER.id }, error: null });
    mockResponses.push({ data: { id: "c-new", firm_id: "aaa" }, error: null });

    const res = await req("POST", "/api/cases", {
      client_id: "cl1",
      lawyer_id: TEST_PARTNER.id,
      title: "Normal Title",
      type: "corporate",
    }, { Authorization: `Bearer ${token}` });

    expect(res.status).toBe(201);
  });
});

describe("Security — Password max length", () => {
  it("rejects password over 128 characters", async () => {
    const longPassword = "A1" + "a".repeat(128);

    const res = await req("POST", "/api/auth/password-reset/confirm", {
      token: "some-token",
      password: longPassword,
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/128/);
  });
});

describe("Security — Rate limiting", () => {
  it("rate limits login endpoint after threshold", async () => {
    // Send 31 requests rapidly — should hit rate limit
    // Note: rate limit is per-worker-instance, resets each test run
    const responses = [];
    for (let i = 0; i < 31; i++) {
      mockResponses.push({ data: null, error: { message: "not found" } });
      const res = await req("POST", "/api/auth/login", {
        email: "test@example.com",
        password: "pass1234",
      });
      responses.push(res.status);
    }

    // At least one should be 429
    expect(responses).toContain(429);
  });
});
