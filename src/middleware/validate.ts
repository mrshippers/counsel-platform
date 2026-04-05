import { Context, Next } from "hono";
import type { AppEnv } from "../index";

// Max lengths for string fields — prevents memory exhaustion
const FIELD_LIMITS: Record<string, number> = {
  title: 500,
  name: 200,
  email: 254,
  phone: 30,
  notes: 10000,
  note: 5000,
  label: 500,
  file_name: 255,
  password: 128,
  current_password: 128,
  new_password: 128,
};

// Validate request body string field lengths
export async function validateBodyLengths(c: Context<AppEnv>, next: Next) {
  if (["POST", "PUT", "PATCH"].includes(c.req.method)) {
    try {
      const body = await c.req.json();
      for (const [key, value] of Object.entries(body)) {
        if (typeof value === "string") {
          const limit = FIELD_LIMITS[key] || 2000; // default 2KB for unknown fields
          if (value.length > limit) {
            return c.json(
              { error: `Field '${key}' exceeds maximum length of ${limit} characters` },
              400
            );
          }
        }
      }
      // Re-set the body so downstream handlers can read it
      // Hono caches the parsed body, so this is fine
    } catch {
      // Not JSON or empty body — let the route handler deal with it
    }
  }
  await next();
}

// Rate limiting state (in-memory, per-worker instance)
// For production: use Cloudflare KV or Durable Objects
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();

const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute
const RATE_LIMIT_MAX_REQUESTS = 30; // 30 requests per minute per IP on auth endpoints

export function rateLimitAuth() {
  return async (c: Context<AppEnv>, next: Next) => {
    const ip = c.req.header("CF-Connecting-IP") ||
      c.req.header("X-Forwarded-For") ||
      "unknown";

    const now = Date.now();
    const key = `auth:${ip}`;
    const entry = rateLimitMap.get(key);

    if (entry && entry.resetAt > now) {
      if (entry.count >= RATE_LIMIT_MAX_REQUESTS) {
        const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
        return c.json({ error: "Too many requests" }, {
          status: 429,
          headers: { "Retry-After": String(retryAfter) },
        });
      }
      entry.count++;
    } else {
      rateLimitMap.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    }

    // Cleanup old entries periodically (every 100 requests)
    if (rateLimitMap.size > 1000) {
      for (const [k, v] of rateLimitMap) {
        if (v.resetAt < now) rateLimitMap.delete(k);
      }
    }

    await next();
  };
}
