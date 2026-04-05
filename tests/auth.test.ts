import { describe, it, expect, vi, beforeEach } from "vitest";
import { app } from "../src/index";
import {
  TEST_ENV,
  TEST_PARTNER,
  createTestToken,
  createExpiredToken,
  partnerTokenPayload,
} from "./helpers";

// Mock password module
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
const mockVerifyPassword = vi.mocked(verifyPassword);

// Flexible Supabase mock that tracks query chains
function createChainableMock(resolveWith: () => { data: unknown; error: unknown; count?: number }) {
  let depth = 0;
  const proxy = (): unknown => {
    depth++;
    return new Proxy({} as Record<string, unknown>, {
      get(_target, prop) {
        // After sufficient chaining without a terminal, resolve as thenable
        if (prop === "then") {
          if (depth >= 2) {
            return (resolve: (v: unknown) => void) => resolve({ data: null, error: null });
          }
          return undefined;
        }
        return (..._args: unknown[]) => {
          if (prop === "single" || prop === "limit" || prop === "order") {
            return Promise.resolve(resolveWith());
          }
          return proxy();
        };
      },
    });
  };
  return proxy();
}

let mockResponses: Array<{ data: unknown; error: unknown }> = [];
let mockInsertLog: unknown[] = [];

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: (_table: string) => {
      const getNext = () => mockResponses.shift() || { data: null, error: null };
      return {
        select: (..._args: unknown[]) => createChainableMock(getNext),
        insert: (data: unknown) => {
          mockInsertLog.push(data);
          return createChainableMock(getNext);
        },
        update: (_data: unknown) => createChainableMock(getNext),
        delete: () => createChainableMock(getNext),
      };
    },
  }),
}));

function req(method: string, path: string, body?: unknown, headers?: Record<string, string>) {
  const init: RequestInit = {
    method,
    headers: { "Content-Type": "application/json", ...headers },
  };
  if (body) init.body = JSON.stringify(body);
  return app.request(path, init, TEST_ENV);
}

describe("Auth — Login", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResponses = [];
    mockInsertLog = [];
  });

  it("returns JWT on valid login", async () => {
    mockResponses.push({
      data: { ...TEST_PARTNER, password_hash: "100000:salt:hash", failed_login_attempts: 0, locked_until: null },
      error: null,
    });
    mockVerifyPassword.mockResolvedValueOnce(true);
    // update last_login
    mockResponses.push({ data: null, error: null });
    // audit log insert
    mockResponses.push({ data: null, error: null });

    const res = await req("POST", "/api/auth/login", {
      email: "jessica@townsend.law",
      password: "SecurePass1",
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("access_token");
    expect(typeof body.access_token).toBe("string");
    expect(body.access_token.split(".")).toHaveLength(3);
    expect(body.user).toHaveProperty("email", "jessica@townsend.law");
    expect(body.user).not.toHaveProperty("password_hash");
  });

  it("returns 401 on wrong password", async () => {
    mockResponses.push({
      data: { ...TEST_PARTNER, password_hash: "100000:salt:hash", failed_login_attempts: 0, locked_until: null },
      error: null,
    });
    mockVerifyPassword.mockResolvedValueOnce(false);
    // audit log
    mockResponses.push({ data: null, error: null });
    // update failed attempts
    mockResponses.push({ data: null, error: null });

    const res = await req("POST", "/api/auth/login", {
      email: "jessica@townsend.law",
      password: "wrongpassword1",
    });

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toHaveProperty("error");
    expect(body).not.toHaveProperty("access_token");
  });

  it("returns 401 when user not found", async () => {
    mockResponses.push({ data: null, error: { message: "not found" } });

    const res = await req("POST", "/api/auth/login", {
      email: "nobody@example.com",
      password: "anything1",
    });

    expect(res.status).toBe(401);
  });

  it("returns 400 on missing email", async () => {
    const res = await req("POST", "/api/auth/login", { password: "SecurePass1" });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/email/i);
  });

  it("returns 400 on missing password", async () => {
    const res = await req("POST", "/api/auth/login", { email: "jessica@townsend.law" });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/password/i);
  });

  it("locks account after 10 failed attempts", async () => {
    // User already has 10 failed attempts
    mockResponses.push({
      data: {
        ...TEST_PARTNER,
        password_hash: "100000:salt:hash",
        failed_login_attempts: 10,
        locked_until: null,
      },
      error: null,
    });
    // Lock update
    mockResponses.push({ data: null, error: null });

    const res = await req("POST", "/api/auth/login", {
      email: "jessica@townsend.law",
      password: "SecurePass1",
    });

    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error).toMatch(/locked/i);
  });

  it("returns 429 when account is already locked", async () => {
    mockResponses.push({
      data: {
        ...TEST_PARTNER,
        password_hash: "100000:salt:hash",
        failed_login_attempts: 12,
        locked_until: new Date(Date.now() + 30 * 60000).toISOString(),
      },
      error: null,
    });

    const res = await req("POST", "/api/auth/login", {
      email: "jessica@townsend.law",
      password: "SecurePass1",
    });

    expect(res.status).toBe(429);
  });

  it("logs failed login attempt with IP", async () => {
    mockResponses.push({
      data: { ...TEST_PARTNER, password_hash: "100000:salt:hash", failed_login_attempts: 0, locked_until: null },
      error: null,
    });
    mockVerifyPassword.mockResolvedValueOnce(false);
    // audit log
    mockResponses.push({ data: null, error: null });
    // update failed attempts
    mockResponses.push({ data: null, error: null });

    await req("POST", "/api/auth/login", {
      email: "jessica@townsend.law",
      password: "wrong1",
    }, { "X-Forwarded-For": "192.168.1.100" });

    expect(mockInsertLog).toContainEqual(
      expect.objectContaining({
        action: "login_failed",
        entity_type: "auth",
        ip_address: "192.168.1.100",
      })
    );
  });
});

describe("Auth — Session", () => {
  beforeEach(() => {
    mockResponses = [];
    mockInsertLog = [];
  });

  it("rejects expired token with 401", async () => {
    const expiredToken = await createExpiredToken(partnerTokenPayload());

    const res = await req("GET", "/api/cases", undefined, {
      Authorization: `Bearer ${expiredToken}`,
    });

    expect(res.status).toBe(401);
  });

  it("rejects request without authorization header", async () => {
    const res = await req("GET", "/api/cases");
    expect(res.status).toBe(401);
  });

  it("rejects malformed token", async () => {
    const res = await req("GET", "/api/cases", undefined, {
      Authorization: "Bearer not.a.valid.jwt",
    });
    expect(res.status).toBe(401);
  });
});

describe("Auth — Password Validation", () => {
  beforeEach(() => {
    mockResponses = [];
    mockInsertLog = [];
  });

  it("rejects password shorter than 8 characters", async () => {
    const res = await req("POST", "/api/auth/password-reset/confirm", {
      token: "valid-reset-token",
      password: "short1",
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/8.*char/i);
  });

  it("rejects password without a number", async () => {
    const res = await req("POST", "/api/auth/password-reset/confirm", {
      token: "valid-reset-token",
      password: "nonumberhere",
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/number/i);
  });

  it("accepts valid password with 8+ chars and a number", async () => {
    // Reset token lookup
    mockResponses.push({
      data: { user_id: TEST_PARTNER.id, expires_at: new Date(Date.now() + 3600000).toISOString() },
      error: null,
    });
    // Delete token FIRST (new order after CR fix)
    // delete().eq() has no terminal — not consumed
    // Update password
    mockResponses.push({ data: null, error: null });

    const res = await req("POST", "/api/auth/password-reset/confirm", {
      token: "valid-reset-token",
      password: "valid1234",
    });

    expect(res.status).toBe(200);
  });
});

describe("Auth — Password Reset", () => {
  beforeEach(() => {
    mockResponses = [];
    mockInsertLog = [];
  });

  it("sends reset email for existing user", async () => {
    mockResponses.push({ data: TEST_PARTNER, error: null });
    // Insert reset token
    mockResponses.push({ data: null, error: null });

    const res = await req("POST", "/api/auth/password-reset", {
      email: "jessica@townsend.law",
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.message).toMatch(/sent/i);
  });

  it("returns 200 for nonexistent email (no leak)", async () => {
    mockResponses.push({ data: null, error: { message: "not found" } });

    const res = await req("POST", "/api/auth/password-reset", {
      email: "nobody@example.com",
    });

    expect(res.status).toBe(200);
  });

  it("rejects expired reset token", async () => {
    mockResponses.push({
      data: { user_id: TEST_PARTNER.id, expires_at: new Date(Date.now() - 1000).toISOString() },
      error: null,
    });

    const res = await req("POST", "/api/auth/password-reset/confirm", {
      token: "expired-token",
      password: "newpass123",
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/expired/i);
  });
});
