import { Hono } from "hono";
import type { AppEnv } from "../index";

export const pricingRoutes = new Hono<AppEnv>();

// Pricing tiers — GBP only
const PLANS = {
  solo: {
    name: "Solo",
    monthly: 1900, // pence
    annual: 18200,
    max_users: 1,
    storage_gb: 5,
    features: ["Case management", "Client portal", "Document storage", "Calendar & deadlines"],
  },
  starter: {
    name: "Starter",
    monthly: 4900,
    annual: 47000,
    max_users: 5,
    storage_gb: 25,
    features: ["Everything in Solo", "Team collaboration", "Workload dashboard", "Email reminders"],
  },
  professional: {
    name: "Professional",
    monthly: 9900,
    annual: 95000,
    max_users: 10,
    storage_gb: 100,
    features: ["Everything in Starter", "GDPR compliance tools", "Data export", "Priority support"],
  },
  enterprise: {
    name: "Enterprise",
    monthly: 17900,
    annual: 171800,
    max_users: 20,
    storage_gb: -1, // unlimited
    features: ["Everything in Professional", "Unlimited storage", "Custom integrations", "Dedicated account manager"],
  },
} as const;

type PlanId = keyof typeof PLANS;

// GET /api/pricing — public, no auth required
pricingRoutes.get("/", (c) => {
  const plans = Object.entries(PLANS).map(([id, plan]) => ({
    id,
    ...plan,
    monthly_display: `£${(plan.monthly / 100).toFixed(0)}`,
    annual_display: `£${(plan.annual / 100).toFixed(0)}`,
    annual_monthly_equivalent: `£${((plan.annual / 12) / 100).toFixed(0)}`,
    storage_display: plan.storage_gb === -1 ? "Unlimited" : `${plan.storage_gb} GB`,
  }));

  return c.json({ plans, currency: "GBP" }, 200);
});

// GET /api/pricing/recommend?users=N — recommend a plan based on firm size
pricingRoutes.get("/recommend", (c) => {
  const usersParam = c.req.query("users");
  const users = usersParam ? parseInt(usersParam, 10) : 1;

  if (isNaN(users) || users < 1) {
    return c.json({ error: "Invalid users parameter" }, 400);
  }

  let recommended: PlanId;
  if (users <= 1) recommended = "solo";
  else if (users <= 5) recommended = "starter";
  else if (users <= 10) recommended = "professional";
  else recommended = "enterprise";

  return c.json({
    recommended,
    plan: PLANS[recommended],
    users_requested: users,
  }, 200);
});
