import { Hono } from "hono";
import type { AppEnv } from "../src/index";
import * as jose from "jose";
import type { JWTPayload, User, Firm } from "../src/types";

// Test JWT secret — never used in production
export const TEST_JWT_SECRET = "test-secret-for-counsel-app-unit-tests-only";

// Test data
export const TEST_FIRM_A: Firm = {
  id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  name: "Townsend & Associates",
  plan: "professional",
  active: true,
  stripe_customer_id: null,
  stripe_subscription_id: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

export const TEST_FIRM_B: Firm = {
  id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
  name: "Smith & Co Solicitors",
  plan: "starter",
  active: true,
  stripe_customer_id: null,
  stripe_subscription_id: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

export const TEST_PARTNER: User = {
  id: "11111111-1111-1111-1111-111111111111",
  firm_id: TEST_FIRM_A.id,
  name: "Jessica Townsend",
  email: "jessica@townsend.law",
  password_hash: "$2a$10$hashedpasswordhere",
  role: "partner",
  avatar_initials: "JT",
  active: true,
  last_login: null,
  reminder_emails_enabled: true,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

export const TEST_ASSOCIATE: User = {
  id: "22222222-2222-2222-2222-222222222222",
  firm_id: TEST_FIRM_A.id,
  name: "Amir Khalil",
  email: "amir@townsend.law",
  password_hash: "$2a$10$hashedpasswordhere",
  role: "associate",
  avatar_initials: "AK",
  active: true,
  last_login: null,
  reminder_emails_enabled: true,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

export const TEST_FIRM_B_USER: User = {
  id: "33333333-3333-3333-3333-333333333333",
  firm_id: TEST_FIRM_B.id,
  name: "David Smith",
  email: "david@smith.law",
  password_hash: "$2a$10$hashedpasswordhere",
  role: "partner",
  avatar_initials: "DS",
  active: true,
  last_login: null,
  reminder_emails_enabled: true,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

export const TEST_ENV = {
  SUPABASE_URL: "http://localhost:54321",
  SUPABASE_ANON_KEY: "test-anon-key",
  SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
  JWT_SECRET: TEST_JWT_SECRET,
  RESEND_API_KEY: "re_test_key",
  ENVIRONMENT: "test",
};

export async function createTestToken(
  payload: Omit<JWTPayload, "exp" | "iat">,
  expiresInHours: number = 8
): Promise<string> {
  const secret = new TextEncoder().encode(TEST_JWT_SECRET);
  return new jose.SignJWT(payload as unknown as jose.JWTPayload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${expiresInHours}h`)
    .sign(secret);
}

export async function createExpiredToken(
  payload: Omit<JWTPayload, "exp" | "iat">
): Promise<string> {
  const secret = new TextEncoder().encode(TEST_JWT_SECRET);
  // Create a token that expired 1 second ago
  const now = Math.floor(Date.now() / 1000);
  return new jose.SignJWT({
    ...payload,
    iat: now - 3600,
    exp: now - 1,
  } as unknown as jose.JWTPayload)
    .setProtectedHeader({ alg: "HS256" })
    .sign(secret);
}

export function partnerTokenPayload(): Omit<JWTPayload, "exp" | "iat"> {
  return {
    sub: TEST_PARTNER.id,
    firm_id: TEST_PARTNER.firm_id,
    role: "partner",
    email: TEST_PARTNER.email,
  };
}

export function associateTokenPayload(): Omit<JWTPayload, "exp" | "iat"> {
  return {
    sub: TEST_ASSOCIATE.id,
    firm_id: TEST_ASSOCIATE.firm_id,
    role: "associate",
    email: TEST_ASSOCIATE.email,
  };
}

export function firmBTokenPayload(): Omit<JWTPayload, "exp" | "iat"> {
  return {
    sub: TEST_FIRM_B_USER.id,
    firm_id: TEST_FIRM_B_USER.firm_id,
    role: "partner",
    email: TEST_FIRM_B_USER.email,
  };
}
