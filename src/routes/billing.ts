import { Hono } from "hono";
import type { AppEnv } from "../index";
import { authMiddleware } from "../middleware/auth";
import { createSupabaseAdmin } from "../lib/supabase";
import Stripe from "stripe";

// Pricing tiers — must match pricing.ts PLANS
const PRICE_LOOKUP: Record<string, Record<string, number>> = {
  solo: { monthly: 1900, annual: 18200 },
  starter: { monthly: 4900, annual: 47000 },
  professional: { monthly: 9900, annual: 95000 },
  enterprise: { monthly: 17900, annual: 171800 },
};

const VALID_PLANS = Object.keys(PRICE_LOOKUP);
const VALID_CYCLES = ["monthly", "annual"];

function getStripe(secretKey: string): Stripe {
  return new Stripe(secretKey);
}

export const billingRoutes = new Hono<AppEnv>();

// POST /api/billing/checkout — create Stripe checkout session (partner only)
billingRoutes.use("/checkout", authMiddleware);
billingRoutes.post("/checkout", async (c) => {
  const user = c.get("user");

  if (user.role !== "partner") {
    return c.json({ error: "Forbidden" }, 403);
  }

  const body = await c.req.json().catch(() => ({}));

  if (!body.plan || !VALID_PLANS.includes(body.plan)) {
    return c.json({ error: `Invalid plan. Must be one of: ${VALID_PLANS.join(", ")}` }, 400);
  }

  if (!body.billing_cycle || !VALID_CYCLES.includes(body.billing_cycle)) {
    return c.json({ error: `Invalid billing_cycle. Must be one of: ${VALID_CYCLES.join(", ")}` }, 400);
  }

  const supabase = createSupabaseAdmin(c.env);

  // Get firm info
  const { data: firm } = await supabase
    .from("firms")
    .select("id, name, stripe_customer_id")
    .eq("id", user.firm_id)
    .single();

  if (!firm) {
    return c.json({ error: "Firm not found" }, 404);
  }

  const stripe = getStripe(c.env.STRIPE_SECRET_KEY);
  const amountPence = PRICE_LOOKUP[body.plan][body.billing_cycle];

  const sessionParams: Record<string, unknown> = {
    mode: "subscription",
    payment_method_types: ["card"],
    currency: "gbp",
    line_items: [
      {
        price_data: {
          currency: "gbp",
          unit_amount: amountPence,
          product_data: {
            name: `Counsel ${body.plan.charAt(0).toUpperCase() + body.plan.slice(1)} Plan`,
            description: `${body.billing_cycle === "annual" ? "Annual" : "Monthly"} subscription`,
          },
          recurring: {
            interval: body.billing_cycle === "annual" ? "year" : "month",
          },
        },
        quantity: 1,
      },
    ],
    metadata: {
      firm_id: user.firm_id,
      plan: body.plan,
    },
    success_url: "https://counsel-app.co.uk/billing/success?session_id={CHECKOUT_SESSION_ID}",
    cancel_url: "https://counsel-app.co.uk/billing/cancel",
  };

  // Use existing customer or let Stripe create one
  if (firm.stripe_customer_id) {
    sessionParams.customer = firm.stripe_customer_id;
  } else {
    sessionParams.customer_email = user.email;
  }

  const session = await stripe.checkout.sessions.create(sessionParams);

  return c.json({ checkout_url: session.url }, 200);
});

// GET /api/billing/subscription — get current subscription status (partner only)
billingRoutes.use("/subscription", authMiddleware);
billingRoutes.get("/subscription", async (c) => {
  const user = c.get("user");
  const supabase = createSupabaseAdmin(c.env);

  const { data: firm } = await supabase
    .from("firms")
    .select("id, plan, stripe_customer_id, stripe_subscription_id")
    .eq("id", user.firm_id)
    .single();

  if (!firm) {
    return c.json({ error: "Firm not found" }, 404);
  }

  // No subscription yet
  if (!firm.stripe_subscription_id) {
    return c.json({
      status: "none",
      plan: firm.plan,
      currency: "GBP",
    }, 200);
  }

  const stripe = getStripe(c.env.STRIPE_SECRET_KEY);
  const subscription = await stripe.subscriptions.retrieve(firm.stripe_subscription_id) as unknown as {
    status: string;
    current_period_end: number;
    items: { data: Array<{ price: { unit_amount: number; recurring: { interval: string } } }> };
  };

  const priceItem = subscription.items.data[0]?.price;

  return c.json({
    status: subscription.status,
    plan: firm.plan,
    current_period_end: subscription.current_period_end,
    amount_pence: priceItem?.unit_amount,
    interval: priceItem?.recurring?.interval,
    currency: "GBP",
  }, 200);
});

// POST /api/billing/portal — create customer portal session (partner only)
billingRoutes.use("/portal", authMiddleware);
billingRoutes.post("/portal", async (c) => {
  const user = c.get("user");

  if (user.role !== "partner") {
    return c.json({ error: "Forbidden" }, 403);
  }

  const supabase = createSupabaseAdmin(c.env);

  const { data: firm } = await supabase
    .from("firms")
    .select("id, stripe_customer_id")
    .eq("id", user.firm_id)
    .single();

  if (!firm || !firm.stripe_customer_id) {
    return c.json({ error: "No active subscription found. Please subscribe first." }, 400);
  }

  const stripe = getStripe(c.env.STRIPE_SECRET_KEY);
  const session = await stripe.billingPortal.sessions.create({
    customer: firm.stripe_customer_id,
    return_url: "https://counsel-app.co.uk/billing",
  });

  return c.json({ portal_url: session.url }, 200);
});

// POST /api/billing/webhook — handle Stripe webhooks (no auth — Stripe calls this)
billingRoutes.post("/webhook", async (c) => {
  const signature = c.req.header("stripe-signature");
  const body = await c.req.text();

  const stripe = getStripe(c.env.STRIPE_SECRET_KEY);

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(body, signature || "", c.env.STRIPE_WEBHOOK_SECRET);
  } catch {
    return c.json({ error: "Invalid webhook signature" }, 400);
  }

  const supabase = createSupabaseAdmin(c.env);

  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session;
      const firmId = session.metadata?.firm_id;
      const plan = session.metadata?.plan;

      if (firmId && plan) {
        await supabase
          .from("firms")
          .update({
            plan,
            stripe_customer_id: session.customer as string,
            stripe_subscription_id: session.subscription as string,
          })
          .eq("id", firmId)
          .single();
      }
      break;
    }

    case "customer.subscription.deleted": {
      const subscription = event.data.object as Stripe.Subscription;
      const customerId = subscription.customer as string;

      // Find firm by stripe_customer_id
      const { data: firm } = await supabase
        .from("firms")
        .select("id")
        .eq("stripe_customer_id", customerId)
        .single();

      if (firm) {
        await supabase
          .from("firms")
          .update({
            plan: "solo",
            stripe_subscription_id: null,
          })
          .eq("id", firm.id)
          .single();
      }
      break;
    }
  }

  return c.json({ received: true }, 200);
});
