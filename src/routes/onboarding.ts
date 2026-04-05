import { Hono } from "hono";
import type { AppEnv } from "../index";
import { createSupabaseAdmin } from "../lib/supabase";
import { hashPassword, validatePassword } from "../lib/password";
import { signJWT } from "../middleware/auth";
import { DEFAULT_CASE_TASKS } from "../types";

export const onboardingRoutes = new Hono<AppEnv>();

// POST /api/onboarding — create firm + partner user + optional first case
onboardingRoutes.post("/", async (c) => {
  const body = await c.req.json().catch(() => ({}));

  // Validate required fields
  if (!body.firm_name || !body.user_name || !body.user_email || !body.password) {
    return c.json({
      error: "Required: firm_name, user_name, user_email, password",
    }, 400);
  }

  // Validate password
  const passwordError = validatePassword(body.password);
  if (passwordError) {
    return c.json({ error: passwordError }, 400);
  }

  const supabase = createSupabaseAdmin(c.env);

  // Create firm
  const { data: firm, error: firmError } = await supabase
    .from("firms")
    .insert({ name: body.firm_name, plan: "solo" })
    .select()
    .single();

  if (firmError || !firm) {
    return c.json({ error: "Failed to create firm" }, 500);
  }

  // Create partner user
  const passwordHash = await hashPassword(body.password);
  const { data: user, error: userError } = await supabase
    .from("users")
    .insert({
      firm_id: firm.id,
      name: body.user_name,
      email: body.user_email,
      password_hash: passwordHash,
      role: "partner",
    })
    .select()
    .single();

  if (userError || !user) {
    return c.json({ error: "Failed to create user" }, 500);
  }

  let firstCase = null;

  // Optionally create first case with client
  if (body.first_case_title && body.first_case_type && body.first_client_name) {
    // Create client
    const { data: client } = await supabase
      .from("clients")
      .insert({ firm_id: firm.id, name: body.first_client_name })
      .select()
      .single();

    if (client) {
      // Create case
      const { data: caseData } = await supabase
        .from("cases")
        .insert({
          firm_id: firm.id,
          client_id: client.id,
          lawyer_id: user.id,
          title: body.first_case_title,
          type: body.first_case_type,
          status: "pending",
          priority: "normal",
          progress: 0,
        })
        .select()
        .single();

      if (caseData) {
        firstCase = caseData;
        // Create 4 default tasks
        await supabase.from("tasks").insert(
          DEFAULT_CASE_TASKS.map((label, i) => ({
            case_id: caseData.id,
            label,
            done: false,
            order_index: i,
          }))
        );
      }
    }
  }

  // Generate JWT
  const token = await signJWT(
    { sub: user.id, firm_id: firm.id, role: "partner", email: user.email },
    c.env.JWT_SECRET,
    8
  );

  const { password_hash, ...safeUser } = user;

  return c.json({
    access_token: token,
    firm,
    user: safeUser,
    first_case: firstCase,
  }, 201);
});
