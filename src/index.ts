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
import { validateBodyLengths } from "./middleware/validate";
import { rateLimitAuth } from "./middleware/validate";

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

// Serve static frontend files for non-API routes
app.get("*", async (c) => {
  return c.text("Counsel — Case Management for UK Law Firms", 200);
});

export default app;
export { app };
