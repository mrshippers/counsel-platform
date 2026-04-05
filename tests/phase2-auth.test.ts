import { describe, it, expect, vi, beforeEach } from "vitest";
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
    if (!/\d/.test(pw)) return "Password must contain at least one number";
    return null;
  }),
}));

import { verifyPassword } from "../src/lib/password";
const mockVerify = vi.mocked(verifyPassword);

let mockResponses: Array<{ data: unknown; error: unknown }> = [];
let mockInsertLog: unknown[] = [];

function createChainableMock(getNext: () => { data: unknown; error: unknown }) {
  const proxy = (): unknown =>
    new Proxy({} as Record<string, unknown>, {
      get(_target, prop: string) {
        if (prop === "then") return undefined;
        return (..._args: unknown[]) => {
          if (["single", "limit", "order"].includes(prop)) return Promise.resolve(getNext());
          return proxy();
        };
      },
    });
  return proxy();
}

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: (_table: string) => {
      const getNext = () => mockResponses.shift() || { data: null, error: null };
      return {
        select: () => createChainableMock(getNext),
        insert: (data: unknown) => { mockInsertLog.push(data); return createChainableMock(getNext); },
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

async function authedReq(
  method: string, path: string,
  tokenPayload: Parameters<typeof createTestToken>[0],
  body?: unknown
) {
  const token = await createTestToken(tokenPayload);
  return req(method, path, body, { Authorization: `Bearer ${token}` });
}

describe("Auth — Logout", () => {
  beforeEach(() => { vi.clearAllMocks(); mockResponses = []; mockInsertLog = []; });

  it("POST /api/auth/logout returns 200 with valid token", async () => {
    mockResponses.push({ data: null, error: null });

    const res = await authedReq("POST", "/api/auth/logout", partnerTokenPayload());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.message).toMatch(/logged out/i);
  });

  it("logout logs the event in audit trail", async () => {
    mockResponses.push({ data: null, error: null });

    await authedReq("POST", "/api/auth/logout", partnerTokenPayload());

    expect(mockInsertLog).toContainEqual(
      expect.objectContaining({ action: "logout", entity_type: "auth" })
    );
  });

  it("logout without token returns 401", async () => {
    const res = await req("POST", "/api/auth/logout");
    expect(res.status).toBe(401);
  });
});

describe("Auth — Change Password (authenticated)", () => {
  beforeEach(() => { vi.clearAllMocks(); mockResponses = []; mockInsertLog = []; });

  it("changes password with correct current password", async () => {
    mockResponses.push({ data: { ...TEST_PARTNER, password_hash: "old-hash" }, error: null });
    mockVerify.mockResolvedValueOnce(true);
    mockResponses.push({ data: null, error: null }); // update
    mockResponses.push({ data: null, error: null }); // audit

    const res = await authedReq("POST", "/api/auth/change-password", partnerTokenPayload(), {
      current_password: "OldPass123",
      new_password: "NewPass456",
    });

    expect(res.status).toBe(200);
  });

  it("rejects change with wrong current password", async () => {
    mockResponses.push({ data: { ...TEST_PARTNER, password_hash: "old-hash" }, error: null });
    mockVerify.mockResolvedValueOnce(false);

    const res = await authedReq("POST", "/api/auth/change-password", partnerTokenPayload(), {
      current_password: "WrongPass1",
      new_password: "NewPass456",
    });

    expect(res.status).toBe(401);
  });

  it("validates new password strength on change", async () => {
    const res = await authedReq("POST", "/api/auth/change-password", partnerTokenPayload(), {
      current_password: "OldPass123",
      new_password: "weak",
    });

    expect(res.status).toBe(400);
  });
});

describe("Auth — Rate limiting", () => {
  beforeEach(() => { vi.clearAllMocks(); mockResponses = []; mockInsertLog = []; });

  it("returns Retry-After header on account lockout", async () => {
    mockResponses.push({
      data: {
        ...TEST_PARTNER,
        failed_login_attempts: 10,
        locked_until: new Date(Date.now() + 30 * 60000).toISOString(),
      },
      error: null,
    });

    const res = await req("POST", "/api/auth/login", {
      email: "jessica@townsend.law",
      password: "anything1",
    });

    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBeDefined();
  });
});
