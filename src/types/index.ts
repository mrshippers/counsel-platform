// -- Database row types (match Supabase schema exactly) --

export interface Firm {
  id: string;
  name: string;
  plan: "solo" | "starter" | "professional" | "enterprise";
  active: boolean;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface User {
  id: string;
  firm_id: string;
  name: string;
  email: string;
  password_hash: string;
  role: "partner" | "associate";
  avatar_initials: string | null;
  active: boolean;
  last_login: string | null;
  reminder_emails_enabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface Client {
  id: string;
  firm_id: string;
  name: string;
  email: string | null;
  phone: string | null;
  type: "individual" | "corporate";
  companies_house_number: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export type CaseType =
  | "corporate"
  | "criminal"
  | "family"
  | "civil"
  | "real_estate"
  | "employment"
  | "other";

export type CaseStatus = "pending" | "in_progress" | "completed";
export type CasePriority = "urgent" | "high" | "normal";

export interface Case {
  id: string;
  firm_id: string;
  client_id: string;
  lawyer_id: string;
  title: string;
  type: CaseType;
  status: CaseStatus;
  priority: CasePriority;
  progress: number;
  opened_date: string;
  deadline: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface Task {
  id: string;
  case_id: string;
  label: string;
  done: boolean;
  order_index: number;
  created_at: string;
  updated_at: string;
}

export interface Document {
  id: string;
  case_id: string;
  uploaded_by: string;
  file_name: string;
  file_type: string | null;
  file_size_bytes: number | null;
  storage_path: string;
  storage_bucket: string;
  created_at: string;
  updated_at: string;
}

export interface Deadline {
  id: string;
  firm_id: string;
  case_id: string | null;
  lawyer_id: string | null;
  created_by: string;
  title: string;
  date: string;
  note: string | null;
  created_at: string;
  updated_at: string;
}

export interface AuditLogEntry {
  id: string;
  firm_id: string;
  user_id: string;
  action: string;
  entity_type: string;
  entity_id: string | null;
  ip_address: string | null;
  timestamp: string;
}

export interface TimeEntry {
  id: string;
  firm_id: string;
  case_id: string;
  lawyer_id: string;
  description: string;
  duration_minutes: number;
  date: string;
  billable: boolean;
  rate_pence: number;
  created_at: string;
  updated_at: string;
}

export type ConflictPartyType = "client" | "opposing" | "witness" | "related";

export interface ConflictParty {
  id: string;
  firm_id: string;
  case_id: string | null;
  client_id: string | null;
  party_name: string;
  party_type: ConflictPartyType;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface CaseEmail {
  id: string;
  firm_id: string;
  case_id: string;
  filed_by: string;
  subject: string;
  from_address: string;
  body: string | null;
  received_date: string | null;
  created_at: string;
  updated_at: string;
}

export interface ClientPortalToken {
  id: string;
  firm_id: string;
  client_id: string;
  token: string;
  expires_at: string;
  created_at: string;
}

export interface UserInvite {
  id: string;
  firm_id: string;
  email: string;
  name: string;
  role: "partner" | "associate";
  token: string;
  expires_at: string;
  accepted_at: string | null;
  invited_by: string;
  created_at: string;
}

export interface Invoice {
  id: string;
  firm_id: string;
  case_id: string;
  invoice_number: string;
  invoice_date: string;
  subtotal_pence: number;
  vat_rate: number;
  vat_pence: number;
  total_pence: number;
  stripe_payment_link: string | null;
  stripe_payment_link_id: string | null;
  paid_at: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

// -- API types --

export interface LoginRequest {
  email: string;
  password: string;
}

export interface LoginResponse {
  access_token: string;
  user: Omit<User, "password_hash">;
}

export interface JWTPayload {
  sub: string;
  firm_id: string;
  role: "partner" | "associate";
  email: string;
  exp: number;
  iat: number;
}

export interface CreateCaseRequest {
  client_id: string;
  lawyer_id: string;
  title: string;
  type: CaseType;
  priority?: CasePriority;
  deadline?: string;
  notes?: string;
}

export interface CreateClientRequest {
  name: string;
  email?: string;
  phone?: string;
  type?: "individual" | "corporate";
  notes?: string;
}

export interface Env {
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  JWT_SECRET: string;
  RESEND_API_KEY: string;
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  COMPANIES_HOUSE_API_KEY: string;
  ENVIRONMENT: string;
  R2_DOCUMENTS: R2Bucket;
}

// Default tasks auto-created with every new case
export const DEFAULT_CASE_TASKS = [
  "Initial Review & Client Meeting",
  "Document Collection & Filing",
  "Case Research & Preparation",
  "Resolution & Case Closure",
] as const;
