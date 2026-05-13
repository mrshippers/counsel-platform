import { Hono } from "hono";
import type { AppEnv } from "../index";
import { authMiddleware } from "../middleware/auth";
import { createSupabaseAdmin } from "../lib/supabase";
import { logAuditEvent } from "../middleware/audit";
import Stripe from "stripe";

export const invoicesRoutes = new Hono<AppEnv>();

invoicesRoutes.use("*", authMiddleware);

// POST /api/invoices/generate — generate invoice, persist it, optionally create Stripe payment link
invoicesRoutes.post("/generate", async (c) => {
  const user = c.get("user");
  const body = await c.req.json().catch(() => ({}));

  if (!body.case_id) {
    return c.json({ error: "case_id is required" }, 400);
  }

  const supabase = createSupabaseAdmin(c.env);

  const [caseResult, firmResult] = await Promise.all([
    supabase
      .from("cases")
      .select("*, clients(name, email, phone)")
      .eq("id", body.case_id)
      .eq("firm_id", user.firm_id)
      .single(),
    supabase
      .from("firms")
      .select("id, name")
      .eq("id", user.firm_id)
      .single(),
  ]);

  if (!caseResult.data) {
    return c.json({ error: "Case not found" }, 404);
  }

  const caseData = caseResult.data;
  const firm = firmResult.data;

  // Get unbilled time entries (exclude already-invoiced ones if invoice_id FK exists)
  const { data: entries } = await supabase
    .from("time_entries")
    .select("*")
    .eq("case_id", body.case_id)
    .eq("firm_id", user.firm_id)
    .eq("billable", true)
    .order("date", { ascending: true });

  const billableEntries = (entries || []).filter((e: { billable: boolean }) => e.billable);

  const lineItems = billableEntries.map((e: {
    id: string; description: string; duration_minutes: number;
    rate_pence: number; date: string;
  }) => {
    const amountPence = Math.round((e.duration_minutes / 60) * e.rate_pence);
    return {
      time_entry_id: e.id,
      date: e.date,
      description: e.description,
      duration_minutes: e.duration_minutes,
      rate_pence: e.rate_pence,
      amount_pence: amountPence,
    };
  });

  const subtotalPence = lineItems.reduce((sum: number, item: { amount_pence: number }) => sum + item.amount_pence, 0);
  const vatRate = body.vat_rate !== undefined ? Number(body.vat_rate) : 20;
  const vatPence = Math.round(subtotalPence * (vatRate / 100));
  const totalPence = subtotalPence + vatPence;

  const clientData = caseData.clients as { name: string; email?: string; phone?: string } | null;
  const firmName = firm?.name || "Unknown Firm";
  const clientName = clientData?.name || "Unknown Client";
  const invoiceDate = new Date().toISOString().split("T")[0];
  const invoiceNumber = `INV-${Date.now().toString(36).toUpperCase()}`;

  // Persist invoice record
  const { data: savedInvoice, error: invoiceError } = await supabase
    .from("invoices")
    .insert({
      firm_id: user.firm_id,
      case_id: body.case_id,
      invoice_number: invoiceNumber,
      invoice_date: invoiceDate,
      subtotal_pence: subtotalPence,
      vat_rate: vatRate,
      vat_pence: vatPence,
      total_pence: totalPence,
      created_by: user.sub,
    })
    .select()
    .single();

  if (invoiceError || !savedInvoice) {
    return c.json({ error: "Failed to save invoice" }, 500);
  }

  // Optionally create Stripe payment link
  let paymentUrl: string | null = null;
  if (body.create_payment_link && totalPence > 0 && c.env.STRIPE_SECRET_KEY) {
    try {
      const stripe = new Stripe(c.env.STRIPE_SECRET_KEY);
      const session = await stripe.checkout.sessions.create({
        mode: "payment",
        payment_method_types: ["card"],
        line_items: [
          {
            price_data: {
              currency: "gbp",
              unit_amount: totalPence,
              product_data: {
                name: `Invoice ${invoiceNumber}`,
                description: `${caseData.title} — ${firmName}`,
              },
            },
            quantity: 1,
          },
        ],
        metadata: {
          invoice_id: savedInvoice.id,
          firm_id: user.firm_id,
          case_id: body.case_id,
        },
        success_url: "https://counsel-app.co.uk/invoices/paid?session_id={CHECKOUT_SESSION_ID}",
        cancel_url: "https://counsel-app.co.uk/invoices",
      });

      paymentUrl = session.url;

      await supabase
        .from("invoices")
        .update({ stripe_payment_link: session.url, stripe_payment_link_id: session.id })
        .eq("id", savedInvoice.id);

      savedInvoice.stripe_payment_link = session.url;
      savedInvoice.stripe_payment_link_id = session.id;
    } catch {
      // Payment link failure is non-fatal — invoice is saved
    }
  }

  await logAuditEvent(c, "invoice_generated", "invoice", savedInvoice.id);

  const invoicePayload = {
    invoice_number: invoiceNumber,
    invoice_date: invoiceDate,
    firm_name: firmName,
    client_name: clientName,
    client_email: clientData?.email || null,
    case_title: caseData.title,
    case_type: caseData.type,
    line_items: lineItems,
    subtotal_pence: subtotalPence,
    vat_rate: vatRate,
    vat_pence: vatPence,
    total_pence: totalPence,
    currency: "GBP",
  };

  return c.json({
    invoice: { ...savedInvoice, ...invoicePayload },
    html: generateInvoiceHtml(invoicePayload),
    payment_url: paymentUrl,
  }, 201);
});

// GET /api/invoices — list invoices for the firm
invoicesRoutes.get("/", async (c) => {
  const user = c.get("user");
  const supabase = createSupabaseAdmin(c.env);

  const caseId = c.req.query("case_id");

  let query = supabase
    .from("invoices")
    .select("*, cases(title, status), users(name)")
    .eq("firm_id", user.firm_id)
    .order("created_at", { ascending: false });

  if (caseId) {
    query = query.eq("case_id", caseId);
  }

  const { data, error } = await query;

  if (error) {
    return c.json({ error: "Failed to fetch invoices" }, 500);
  }

  return c.json({ data }, 200);
});

// GET /api/invoices/:id — single invoice
invoicesRoutes.get("/:id", async (c) => {
  const user = c.get("user");
  const invoiceId = c.req.param("id");
  const supabase = createSupabaseAdmin(c.env);

  const { data, error } = await supabase
    .from("invoices")
    .select("*, cases(title, type, clients(name, email))")
    .eq("id", invoiceId)
    .eq("firm_id", user.firm_id)
    .single();

  if (!data || error) {
    return c.json({ error: "Invoice not found" }, 404);
  }

  return c.json({ data }, 200);
});

// PATCH /api/invoices/:id/mark-paid — manually mark invoice paid
invoicesRoutes.patch("/:id/mark-paid", async (c) => {
  const user = c.get("user");
  const invoiceId = c.req.param("id");
  const supabase = createSupabaseAdmin(c.env);

  const { data: existing } = await supabase
    .from("invoices")
    .select("id")
    .eq("id", invoiceId)
    .eq("firm_id", user.firm_id)
    .single();

  if (!existing) {
    return c.json({ error: "Invoice not found" }, 404);
  }

  const { data: updated } = await supabase
    .from("invoices")
    .update({ paid_at: new Date().toISOString() })
    .eq("id", invoiceId)
    .select()
    .single();

  await logAuditEvent(c, "invoice_marked_paid", "invoice", invoiceId);

  return c.json({ data: updated }, 200);
});

function generateInvoiceHtml(inv: {
  invoice_number: string; invoice_date: string;
  firm_name: string; client_name: string;
  case_title: string;
  line_items: Array<{ date: string; description: string; duration_minutes: number; rate_pence: number; amount_pence: number }>;
  subtotal_pence: number; vat_rate: number; vat_pence: number; total_pence: number;
}): string {
  const fmt = (pence: number) => `£${(pence / 100).toFixed(2)}`;

  const rows = inv.line_items.map((item) => `
    <tr>
      <td>${item.date}</td>
      <td>${item.description}</td>
      <td>${item.duration_minutes} min</td>
      <td>${fmt(item.rate_pence)}/hr</td>
      <td style="text-align:right">${fmt(item.amount_pence)}</td>
    </tr>
  `).join("");

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Invoice ${inv.invoice_number}</title>
<style>
  body{font-family:Arial,sans-serif;max-width:800px;margin:0 auto;padding:40px;color:#333}
  h1{color:#1a1a2e;margin-bottom:4px}
  table{width:100%;border-collapse:collapse;margin:20px 0}
  th,td{padding:8px 12px;border-bottom:1px solid #ddd;text-align:left}
  th{background:#f5f5f5}
  .total-row td{font-weight:bold;border-top:2px solid #333}
  .header{display:flex;justify-content:space-between}
  .meta{color:#666;font-size:14px}
  @media print{body{padding:20px}}
</style></head><body>
<div class="header">
  <div><h1>${inv.firm_name}</h1>
    <p class="meta">Invoice ${inv.invoice_number}</p>
    <p class="meta">Date: ${inv.invoice_date}</p>
  </div>
  <div><p><strong>Bill To:</strong></p><p>${inv.client_name}</p></div>
</div>
<p><strong>Re:</strong> ${inv.case_title}</p>
<table>
  <thead><tr><th>Date</th><th>Description</th><th>Duration</th><th>Rate</th><th style="text-align:right">Amount</th></tr></thead>
  <tbody>
    ${rows}
    <tr><td colspan="4" style="text-align:right">Subtotal</td><td style="text-align:right">${fmt(inv.subtotal_pence)}</td></tr>
    <tr><td colspan="4" style="text-align:right">VAT (${inv.vat_rate}%)</td><td style="text-align:right">${fmt(inv.vat_pence)}</td></tr>
    <tr class="total-row"><td colspan="4" style="text-align:right">Total</td><td style="text-align:right">${fmt(inv.total_pence)}</td></tr>
  </tbody>
</table>
<p class="meta">Payment terms: 30 days. All amounts in GBP.</p>
</body></html>`;
}
