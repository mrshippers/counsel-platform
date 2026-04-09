import { Hono } from "hono";
import type { AppEnv } from "../index";
import { authMiddleware } from "../middleware/auth";

export const ukServicesRoutes = new Hono<AppEnv>();

ukServicesRoutes.use("*", authMiddleware);

// GET /api/uk/companies-house/search?q=X — search Companies House
ukServicesRoutes.get("/companies-house/search", async (c) => {
  const query = c.req.query("q");

  if (!query || !query.trim()) {
    return c.json({ error: "Search query 'q' is required" }, 400);
  }

  const apiKey = c.env.COMPANIES_HOUSE_API_KEY;
  const encoded = encodeURIComponent(query.trim());
  const url = `https://api.company-information.service.gov.uk/search/companies?q=${encoded}&items_per_page=20`;

  const response = await fetch(url, {
    headers: {
      Authorization: `Basic ${btoa(apiKey + ":")}`,
    },
  });

  if (!response.ok) {
    return c.json({ error: "Companies House search failed" }, 502);
  }

  const data = await response.json() as { items?: unknown[]; total_results?: number };

  return c.json({
    results: data.items || [],
    total_results: data.total_results || 0,
  }, 200);
});

// GET /api/uk/companies-house/:number — get company details
ukServicesRoutes.get("/companies-house/:number", async (c) => {
  const companyNumber = c.req.param("number");
  const apiKey = c.env.COMPANIES_HOUSE_API_KEY;
  const url = `https://api.company-information.service.gov.uk/company/${companyNumber}`;

  const response = await fetch(url, {
    headers: {
      Authorization: `Basic ${btoa(apiKey + ":")}`,
    },
  });

  if (response.status === 404) {
    return c.json({ error: "Company not found" }, 404);
  }

  if (!response.ok) {
    return c.json({ error: "Companies House lookup failed" }, 502);
  }

  const company = await response.json();

  return c.json({ company }, 200);
});

// GET /api/uk/land-registry/search?postcode=X — search Land Registry price paid data
ukServicesRoutes.get("/land-registry/search", async (c) => {
  const postcode = c.req.query("postcode");

  if (!postcode || !postcode.trim()) {
    return c.json({ error: "postcode query parameter is required" }, 400);
  }

  const encoded = encodeURIComponent(postcode.trim().toUpperCase());
  const url = `https://landregistry.data.gov.uk/data/ppi/transaction-record.json?propertyAddress.postcode=${encoded}&_pageSize=20`;

  const response = await fetch(url);

  if (!response.ok) {
    return c.json({ error: "Land Registry search failed" }, 502);
  }

  const data = await response.json() as { result?: { items?: unknown[] } };

  return c.json({
    results: data.result?.items || [],
  }, 200);
});
