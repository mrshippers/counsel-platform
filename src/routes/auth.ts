import { Hono } from "hono";
import type { AppEnv } from "../index";
import { createSupabaseAdmin } from "../lib/supabase";
import { verifyPassword, hashPassword, validatePassword } from "../lib/password";
import { authMiddleware, signJWT } from "../middleware/auth";
import { logAuditEvent } from "../middleware/audit";
import { createEmailClient, sendPasswordResetEmail } from "../lib/email";
import type { LoginRequest } from "../types";

export const authRoutes = new Hono<AppEnv>();

// POST /api/auth/login
authRoutes.post("/login", async (c) => {
  const body = await c.req.json<LoginRequest>().catch(() => ({} as Partial<LoginRequest>));

  if (!body.email) {
    return c.json({ error: "Email is required" }, 400);
  }
  if (!body.password) {
    return c.json({ error: "Password is required" }, 400);
  }

  const supabase = createSupabaseAdmin(c.env);
  const ip = c.req.header("CF-Connecting-IP") || c.req.header("X-Forwarded-For") || "unknown";

  // Look up user by email
  const { data: user, error } = await supabase
    .from("users")
    .select("*")
    .eq("email", body.email)
    .eq("active", true)
    .single();

  if (!user || error) {
    return c.json({ error: "Invalid email or password" }, 401);
  }

  // Check account lockout
  if (user.locked_until && new Date(user.locked_until) > new Date()) {
    const retryAfterSecs = Math.ceil((new Date(user.locked_until).getTime() - Date.now()) / 1000);
    return c.json({ error: "Account locked. Try again in 30 minutes." }, {
      status: 429,
      headers: { "Retry-After": String(retryAfterSecs) },
    });
  }

  // Check failed attempts threshold
  if (user.failed_login_attempts >= 10) {
    const lockUntil = new Date(Date.now() + 30 * 60000).toISOString();
    await supabase
      .from("users")
      .update({ locked_until: lockUntil })
      .eq("id", user.id);

    return c.json({ error: "Account locked. Too many failed attempts." }, {
      status: 429,
      headers: { "Retry-After": "1800" },
    });
  }

  // Verify password
  const valid = await verifyPassword(body.password, user.password_hash);
  if (!valid) {
    // Log failed attempt
    await supabase.from("audit_log").insert({
      firm_id: user.firm_id,
      user_id: user.id,
      action: "login_failed",
      entity_type: "auth",
      ip_address: ip,
    });

    // Increment failed attempts
    await supabase
      .from("users")
      .update({ failed_login_attempts: (user.failed_login_attempts || 0) + 1 })
      .eq("id", user.id);

    return c.json({ error: "Invalid email or password" }, 401);
  }

  // Successful login — reset failed attempts, update last_login
  await supabase
    .from("users")
    .update({ failed_login_attempts: 0, locked_until: null, last_login: new Date().toISOString() })
    .eq("id", user.id);

  // Log successful login
  await supabase.from("audit_log").insert({
    firm_id: user.firm_id,
    user_id: user.id,
    action: "login_success",
    entity_type: "auth",
    ip_address: ip,
  });

  // Generate JWT (8hr expiry)
  const token = await signJWT(
    {
      sub: user.id,
      firm_id: user.firm_id,
      role: user.role,
      email: user.email,
    },
    c.env.JWT_SECRET,
    8
  );

  // Return token + user (sans password_hash)
  const { password_hash, ...safeUser } = user;
  return c.json({ access_token: token, user: safeUser }, 200);
});

// POST /api/auth/password-reset — request reset link
authRoutes.post("/password-reset", async (c) => {
  const body = await c.req.json<{ email: string }>().catch(() => ({ email: "" }));

  // Always return 200 to prevent email enumeration
  if (!body.email) {
    return c.json({ message: "If the email exists, a reset link has been sent." }, 200);
  }

  const supabase = createSupabaseAdmin(c.env);
  const { data: user } = await supabase
    .from("users")
    .select("id, name, email, firm_id")
    .eq("email", body.email)
    .single();

  if (user) {
    // Generate 256-bit cryptographically random reset token
    const rawToken = crypto.getRandomValues(new Uint8Array(32));
    const resetToken = Array.from(rawToken).map(b => b.toString(16).padStart(2, "0")).join("");
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour

    await supabase.from("password_resets").insert({
      user_id: user.id,
      token: resetToken,
      expires_at: expiresAt,
    });

    // Send password reset email via Resend
    const emailClient = createEmailClient(c.env);
    const baseUrl = "https://counsel-app.co.uk";
    try {
      await sendPasswordResetEmail(emailClient, user.email, user.name, resetToken, baseUrl);
    } catch {
      // Log but don't reveal email failure to user (security)
    }
  }

  return c.json({ message: "If the email exists, a reset link has been sent." }, 200);
});

// POST /api/auth/password-reset/confirm — use reset token to set new password
authRoutes.post("/password-reset/confirm", async (c) => {
  const body = await c.req.json<{ token: string; password: string }>().catch(() => ({
    token: "",
    password: "",
  }));

  // Validate new password
  const passwordError = validatePassword(body.password);
  if (passwordError) {
    return c.json({ error: passwordError }, 400);
  }

  const supabase = createSupabaseAdmin(c.env);

  // Look up reset token
  const { data: resetRecord } = await supabase
    .from("password_resets")
    .select("user_id, expires_at")
    .eq("token", body.token)
    .single();

  if (!resetRecord) {
    return c.json({ error: "Invalid reset token" }, 400);
  }

  // Check token expiry
  if (new Date(resetRecord.expires_at) < new Date()) {
    return c.json({ error: "Reset token has expired" }, 400);
  }

  // Delete token FIRST to prevent race condition (atomic single-use)
  const { error: deleteError } = await supabase
    .from("password_resets")
    .delete()
    .eq("token", body.token);

  if (deleteError) {
    return c.json({ error: "Failed to process reset" }, 500);
  }

  // Now hash and update password
  const newHash = await hashPassword(body.password);
  await supabase
    .from("users")
    .update({ password_hash: newHash, failed_login_attempts: 0, locked_until: null })
    .eq("id", resetRecord.user_id);

  return c.json({ message: "Password updated successfully" }, 200);
});

// POST /api/auth/logout — invalidate session (audit log)
authRoutes.post("/logout", authMiddleware, async (c) => {
  const user = c.get("user");
  const ip = c.get("ip");
  const supabase = createSupabaseAdmin(c.env);

  await supabase.from("audit_log").insert({
    firm_id: user.firm_id,
    user_id: user.sub,
    action: "logout",
    entity_type: "auth",
    ip_address: ip || null,
  });

  return c.json({ message: "Logged out successfully" }, 200);
});

// POST /api/auth/change-password — authenticated password change
authRoutes.post("/change-password", authMiddleware, async (c) => {
  const user = c.get("user");
  const body = await c.req.json<{ current_password: string; new_password: string }>().catch(() => ({
    current_password: "",
    new_password: "",
  }));

  // Validate new password first
  const passwordError = validatePassword(body.new_password);
  if (passwordError) {
    return c.json({ error: passwordError }, 400);
  }

  const supabase = createSupabaseAdmin(c.env);

  // Get current user's password hash
  const { data: userData } = await supabase
    .from("users")
    .select("password_hash")
    .eq("id", user.sub)
    .single();

  if (!userData) {
    return c.json({ error: "User not found" }, 404);
  }

  // Verify current password
  const valid = await verifyPassword(body.current_password, userData.password_hash);
  if (!valid) {
    return c.json({ error: "Current password is incorrect" }, 401);
  }

  // Hash and update
  const newHash = await hashPassword(body.new_password);
  await supabase
    .from("users")
    .update({ password_hash: newHash })
    .eq("id", user.sub);

  // Audit
  await logAuditEvent(c, "password_changed", "auth");

  return c.json({ message: "Password changed successfully" }, 200);
});
