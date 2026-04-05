import { Context, Next } from "hono";
import type { AppEnv } from "../index";

export function requireRole(...roles: Array<"partner" | "associate">) {
  return async (c: Context<AppEnv>, next: Next) => {
    const user = c.get("user");
    if (!user) {
      return c.json({ error: "Not authenticated" }, 401);
    }
    if (!roles.includes(user.role)) {
      return c.json({ error: "Forbidden" }, 403);
    }
    await next();
  };
}

export function partnerOnly() {
  return requireRole("partner");
}
