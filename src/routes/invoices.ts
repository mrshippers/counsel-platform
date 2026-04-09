import { Hono } from "hono";
import type { AppEnv } from "../index";
import { authMiddleware } from "../middleware/auth";
import { createSupabaseAdmin } from "../lib/supabase";

export const invoicesRoutes = new Hono<AppEnv>();

invoicesRoutes.use("*", authMiddleware);

// POST /api/invoices/generate — generate invoice from time entries for a case
invoicesRoutes.post("/generate", async (c) => {
  const user = c.get("user");
  const body = await c.req.json().catch(() => ({}));

  if (!body.case_id) {
    return c.json({ error: "case_id is required" }, 400);
  }

  const supabase = createSupabaseAdmin(c.env);

  // Get case with client details
  const { data: caseData } = await supabase
    .from("cases")
    .select("*, clients(name, email, phone)")
    .eq("id", body.case_id)
    .eq("firm_id", user.firm_id)
    .single();

  if (!caseData) {
    return c.json({ error: "Case not found" }, 404);
  }

  // Get firm name
  const { data: firm } = await supabase
    .from("firms")
    .select("id, name")
    .eq("id", user.firm_id)
    .single();

  // Get billable time entries
  const { data: entries } = await supabase
    .from("time_entries")
    .select("*")
    .eq("case_id", body.case_id)
    .eq("firm_id", user.firm_id)
    .order("date", { ascending: true });

  const allEntries = entries || [];
  const billableEntries = allEntries.filter((e: { billable: boolean }) => e.billable);

  // Build line items
  const lineItems = billableEntries.map((e: {
    id: string; description: string; duration_minutes: number;
    rate_pence: number; date: string; lawyer_id: string;
  }) => {
    const amountPence = Math.round((e.duration_minutes / 60) * e.rate_pence);
    return {
      date: e.date,
      description: e.description,
      duration_minutes: e.duration_minutes,
      rate_pence: e.rate_pence,
      amount_pence: amountPence,
    };
  });

  const subtotalPence = lineItems.reduce((sum: number, item: { amount_pence: number }) => sum + item.amount_pence, 0);
  const vatRate = body.vat_rate !== undefined ? body.vat_rate : 20;
  const vatPence = Math.round(subtotalPence * (vatRate / 100));
  const totalPence = subtotalPence + vatPence;

  const clientData = caseData.clients as { name: string; email?: string; phone?: string } | null;
  const firmName = firm?.name || "Unknown Firm";
  const clientName = clientData?.name || "Unknown Client";
  const invoiceDate = new Date().toISOString().split("T")[0];
  const invoiceNumber = `INV-${Date.now().toString(36).toUpperCase()}`;

  const invoice = {
    invoice_number: invoiceNumber,
    invoice_date: invoiceDate,
    firm_name: firmName,
    client_name: clientName,
    client_email: clientData?.email || null,
    client_phone: clientData?.phone || null,
    case_title: caseData.title,
    case_type: caseData.type,
    line_items: lineItems,
    subtotal_pence: subtotalPence,
    vat_rate: vatRate,
    vat_pence: vatPence,
    total_pence: totalPence,
    currency: "GBP",
  };

  // Generate HTML invoice
  const html = generateInvoiceHtml(invoice);

  return c.json({ invoice, html }, 200);
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
<style>body{font-family:Arial,sans-serif;max-width:800px;margin:0 auto;padding:40px;color:#333}
h1{color:#1a1a2e;margin-bottom:4px}table{width:100%;border-collapse:collapse;margin:20px 0}
th,td{padding:8px 12px;border-bottom:1px solid #ddd;text-align:left}th{background:#f5f5f5}
.total-row td{font-weight:bold;border-top:2px solid #333}.header{display:flex;justify-content:space-between}
.meta{color:#666;font-size:14px}</style></head><body>
<div class="header"><div><h1>${inv.firm_name}</h1><p class="meta">Invoice ${inv.invoice_number}</p>
<p class="meta">Date: ${inv.invoice_date}</p></div>
<div><p><strong>Bill To:</strong></p><p>${inv.client_name}</p></div></div>
<p><strong>Re:</strong> ${inv.case_title}</p>
<table><thead><tr><th>Date</th><th>Description</th><th>Duration</th><th>Rate</th><th style="text-align:right">Amount</th></tr></thead>
<tbody>${rows}
<tr><td colspan="4" style="text-align:right">Subtotal</td><td style="text-align:right">${fmt(inv.subtotal_pence)}</td></tr>
<tr><td colspan="4" style="text-align:right">VAT (${inv.vat_rate}%)</td><td style="text-align:right">${fmt(inv.vat_pence)}</td></tr>
<tr class="total-row"><td colspan="4" style="text-align:right">Total</td><td style="text-align:right">${fmt(inv.total_pence)}</td></tr>
</tbody></table>
<p class="meta">Payment terms: 30 days. All amounts in GBP.</p></body></html>`;
}
