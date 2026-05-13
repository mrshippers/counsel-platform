import { Hono } from "hono";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import type { Env } from "./types";
import { authRoutes } from "./routes/auth";
import { casesRoutes } from "./routes/cases";
import { clientsRoutes } from "./routes/clients";
import { tasksRoutes } from "./routes/tasks";
import { documentsRoutes } from "./routes/documents";
import { calendarRoutes } from "./routes/calendar";
import { deadlinesRoutes } from "./routes/deadlines";
import { lawyersRoutes } from "./routes/lawyers";
import { dashboardRoutes } from "./routes/dashboard";
import { onboardingRoutes } from "./routes/onboarding";
import { exportRoutes } from "./routes/export";
import { gdprRoutes } from "./routes/gdpr";
import { pricingRoutes } from "./routes/pricing";
import { timeEntriesRoutes } from "./routes/time-entries";
import { conflictsRoutes } from "./routes/conflicts";
import { billingRoutes } from "./routes/billing";
import { invoicesRoutes } from "./routes/invoices";
import { emailsRoutes } from "./routes/emails";
import { ukServicesRoutes } from "./routes/uk-services";
import { portalRoutes } from "./routes/portal";
import { reportsRoutes } from "./routes/reports";
import { validateBodyLengths } from "./middleware/validate";
import { rateLimitAuth } from "./middleware/validate";
import { createSupabaseAdmin } from "./lib/supabase";

export type AppEnv = { Bindings: Env };

const app = new Hono<AppEnv>();

// Security headers (X-Content-Type-Options, X-Frame-Options, etc.)
app.use("*", secureHeaders());

// CORS — only allow Counsel origins
app.use(
  "/api/*",
  cors({
    origin: (origin) => {
      const allowed = [
        "https://counsel-app.co.uk",
        "https://www.counsel-app.co.uk",
        "https://counsol-app.jtow187.workers.dev",
      ];
      if (!origin || allowed.includes(origin)) return origin || "";
      return "";
    },
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
    maxAge: 86400,
  })
);

// Input validation — enforce field length limits on all write operations
app.use("/api/*", validateBodyLengths);

// Rate limiting on auth endpoints
app.use("/api/auth/*", rateLimitAuth());

// Health check
app.get("/api/health", (c) =>
  c.json({ status: "ok", version: "0.1.0", region: "eu-west" })
);

// Mount routes
app.route("/api/auth", authRoutes);
app.route("/api/cases", casesRoutes);
app.route("/api/clients", clientsRoutes);
app.route("/api/tasks", tasksRoutes);
app.route("/api/documents", documentsRoutes);
app.route("/api/calendar", calendarRoutes);
app.route("/api/deadlines", deadlinesRoutes);
app.route("/api/lawyers", lawyersRoutes);
app.route("/api/dashboard", dashboardRoutes);
app.route("/api/onboarding", onboardingRoutes);
app.route("/api/export", exportRoutes);
app.route("/api/gdpr", gdprRoutes);
app.route("/api/pricing", pricingRoutes);
app.route("/api/time-entries", timeEntriesRoutes);
app.route("/api/conflicts", conflictsRoutes);
app.route("/api/billing", billingRoutes);
app.route("/api/invoices", invoicesRoutes);
app.route("/api/emails", emailsRoutes);
app.route("/api/uk", ukServicesRoutes);
app.route("/api/portal", portalRoutes);
app.route("/api/reports", reportsRoutes);

// Serve frontend HTML for non-API routes
app.get("*", async (c) => {
  // Try to serve from static assets binding first
  const env = c.env as unknown as Record<string, unknown>;
  if (env.ASSETS) {
    const assetResponse = await (env.ASSETS as { fetch: (req: Request) => Promise<Response> }).fetch(c.req.raw);
    if (assetResponse.status !== 404) return assetResponse;
  }
  return c.text("Counsel — Case Management for UK Law Firms", 200);
});

export default {
  fetch: app.fetch,

  // Cloudflare Email Routing handler — receives emails sent to case-<uuid>@counsel-app.co.uk
  async email(message: ForwardableEmailMessage, env: Env, _ctx: ExecutionContext) {
    // Expect recipient format: case-<uuid>@counsel-app.co.uk
    const match = message.to.match(/^case-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})@/i);

    if (!match) {
      // Not a case address — reject silently
      message.setReject("Unknown address");
      return;
    }

    const caseId = match[1];
    const supabase = createSupabaseAdmin(env);

    const { data: caseData } = await supabase
      .from("cases")
      .select("id, firm_id, lawyer_id")
      .eq("id", caseId)
      .single();

    if (!caseData) {
      message.setReject("Case not found");
      return;
    }

    const subject = message.headers.get("subject") || "(no subject)";

    // Read raw email body (best-effort — full MIME stored for completeness)
    let rawBody = "";
    try {
      rawBody = await new Response(message.raw).text();
    } catch {
      rawBody = "(body unavailable)";
    }

    await supabase.from("case_emails").insert({
      firm_id: caseData.firm_id,
      case_id: caseId,
      filed_by: caseData.lawyer_id,
      subject,
      from_address: message.from,
      body: rawBody,
      received_date: new Date().toISOString(),
    });
  },

  async scheduled(_event: ScheduledEvent, _env: Env, _ctx: ExecutionContext) {
    // Daily 8am UTC — trigger deadline reminder emails
    const url = new URL("/api/deadlines/reminders", "http://internal");
    const req = new Request(url.toString(), { method: "POST" });
    await app.fetch(req, _env);
  },
};
export { app };
