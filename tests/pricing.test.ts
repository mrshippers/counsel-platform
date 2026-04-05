import { describe, it, expect } from "vitest";
import { app } from "../src/index";

const TEST_ENV = {
  SUPABASE_URL: "http://localhost:54321",
  SUPABASE_ANON_KEY: "test-anon-key",
  SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
  JWT_SECRET: "test-secret-for-counsel-app-unit-tests-only",
  RESEND_API_KEY: "re_test_key",
  ENVIRONMENT: "test",
};

function req(method: string, path: string) {
  return app.request(path, { method }, TEST_ENV);
}

describe("Pricing — Public endpoint", () => {
  it("GET /api/pricing returns all 4 plans in GBP", async () => {
    const res = await req("GET", "/api/pricing");

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.currency).toBe("GBP");
    expect(body.plans).toHaveLength(4);

    const ids = body.plans.map((p: { id: string }) => p.id);
    expect(ids).toContain("solo");
    expect(ids).toContain("starter");
    expect(ids).toContain("professional");
    expect(ids).toContain("enterprise");
  });

  it("Solo plan is £19/mo", async () => {
    const res = await req("GET", "/api/pricing");
    const body = await res.json();
    const solo = body.plans.find((p: { id: string }) => p.id === "solo");

    expect(solo.monthly).toBe(1900);
    expect(solo.monthly_display).toBe("£19");
    expect(solo.max_users).toBe(1);
    expect(solo.storage_gb).toBe(5);
  });

  it("Enterprise plan is £179/mo with unlimited storage", async () => {
    const res = await req("GET", "/api/pricing");
    const body = await res.json();
    const enterprise = body.plans.find((p: { id: string }) => p.id === "enterprise");

    expect(enterprise.monthly).toBe(17900);
    expect(enterprise.monthly_display).toBe("£179");
    expect(enterprise.storage_display).toBe("Unlimited");
  });

  it("Annual pricing has ~20% discount", async () => {
    const res = await req("GET", "/api/pricing");
    const body = await res.json();
    const pro = body.plans.find((p: { id: string }) => p.id === "professional");

    // Monthly: £99 * 12 = £1188, Annual: £950 = ~20% discount
    const monthlyTotal = pro.monthly * 12;
    const discount = ((monthlyTotal - pro.annual) / monthlyTotal) * 100;
    expect(discount).toBeGreaterThanOrEqual(19);
    expect(discount).toBeLessThanOrEqual(21);
  });
});

describe("Pricing — Plan recommendation", () => {
  it("recommends solo for 1 user", async () => {
    const res = await req("GET", "/api/pricing/recommend?users=1");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.recommended).toBe("solo");
  });

  it("recommends starter for 3 users", async () => {
    const res = await req("GET", "/api/pricing/recommend?users=3");
    const body = await res.json();
    expect(body.recommended).toBe("starter");
  });

  it("recommends professional for 8 users", async () => {
    const res = await req("GET", "/api/pricing/recommend?users=8");
    const body = await res.json();
    expect(body.recommended).toBe("professional");
  });

  it("recommends enterprise for 15 users", async () => {
    const res = await req("GET", "/api/pricing/recommend?users=15");
    const body = await res.json();
    expect(body.recommended).toBe("enterprise");
  });

  it("returns 400 for invalid users param", async () => {
    const res = await req("GET", "/api/pricing/recommend?users=abc");
    expect(res.status).toBe(400);
  });
});
