import { Context, Next } from "hono";
import * as jose from "jose";
import type { AppEnv } from "../index";
import type { JWTPayload } from "../types";

// Augment Hono context with authenticated user
declare module "hono" {
  interface ContextVariableMap {
    user: JWTPayload;
    ip: string;
  }
}

export async function authMiddleware(c: Context<AppEnv>, next: Next) {
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return c.json({ error: "Missing or invalid authorization header" }, 401);
  }

  const token = authHeader.slice(7);

  try {
    const secret = new TextEncoder().encode(c.env.JWT_SECRET);
    const { payload } = await jose.jwtVerify(token, secret, {
      algorithms: ["HS256"],
    });

    const user = payload as unknown as JWTPayload;

    // Check expiry (jose does this, but belt and braces)
    if (user.exp && user.exp < Math.floor(Date.now() / 1000)) {
      return c.json({ error: "Token expired" }, 401);
    }

    c.set("user", user);
    c.set("ip", c.req.header("CF-Connecting-IP") || c.req.header("X-Forwarded-For") || "unknown");

    await next();
  } catch (err) {
    if (err instanceof jose.errors.JWTExpired) {
      return c.json({ error: "Token expired" }, 401);
    }
    return c.json({ error: "Invalid token" }, 401);
  }
}

export async function signJWT(
  payload: Omit<JWTPayload, "exp" | "iat">,
  secret: string,
  expiresInHours: number = 8
): Promise<string> {
  const secretKey = new TextEncoder().encode(secret);
  return new jose.SignJWT(payload as unknown as jose.JWTPayload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${expiresInHours}h`)
    .sign(secretKey);
}
