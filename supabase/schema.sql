-- Counsel — Case Management for UK Law Firms
-- Run this in Supabase SQL Editor
-- Project MUST be EU West (London) region for UK GDPR compliance

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Firms
CREATE TABLE firms (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT NOT NULL,
  plan TEXT NOT NULL DEFAULT 'solo' CHECK (plan IN ('solo','starter','professional','enterprise')),
  active BOOLEAN NOT NULL DEFAULT true,
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Users
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  firm_id UUID NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'associate' CHECK (role IN ('partner','associate')),
  avatar_initials TEXT,
  active BOOLEAN NOT NULL DEFAULT true,
  last_login TIMESTAMPTZ,
  reminder_emails_enabled BOOLEAN NOT NULL DEFAULT true,
  failed_login_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Clients
CREATE TABLE clients (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  firm_id UUID NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  type TEXT NOT NULL DEFAULT 'individual' CHECK (type IN ('individual','corporate')),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Cases
CREATE TABLE cases (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  firm_id UUID NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  lawyer_id UUID NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('corporate','criminal','family','civil','real_estate','employment','other')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','in_progress','completed')),
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('urgent','high','normal')),
  progress INTEGER NOT NULL DEFAULT 0 CHECK (progress >= 0 AND progress <= 100),
  opened_date DATE NOT NULL DEFAULT CURRENT_DATE,
  deadline DATE,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Tasks
CREATE TABLE tasks (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  case_id UUID NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  done BOOLEAN NOT NULL DEFAULT false,
  order_index INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Documents
CREATE TABLE documents (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  case_id UUID NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  uploaded_by UUID NOT NULL REFERENCES users(id),
  file_name TEXT NOT NULL,
  file_type TEXT,
  file_size_bytes BIGINT,
  storage_path TEXT NOT NULL,
  storage_bucket TEXT NOT NULL DEFAULT 'case-documents',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Deadlines
CREATE TABLE deadlines (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  firm_id UUID NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
  case_id UUID REFERENCES cases(id) ON DELETE CASCADE,
  lawyer_id UUID REFERENCES users(id),
  created_by UUID NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  date DATE NOT NULL,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Audit Log (IMMUTABLE — no UPDATE or DELETE allowed)
CREATE TABLE audit_log (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  firm_id UUID NOT NULL REFERENCES firms(id),
  user_id UUID NOT NULL REFERENCES users(id),
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id UUID,
  ip_address INET,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Password reset tokens
CREATE TABLE password_resets (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes
CREATE INDEX idx_users_firm ON users(firm_id);
CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_clients_firm ON clients(firm_id);
CREATE INDEX idx_cases_firm ON cases(firm_id);
CREATE INDEX idx_cases_lawyer ON cases(lawyer_id);
CREATE INDEX idx_cases_client ON cases(client_id);
CREATE INDEX idx_tasks_case ON tasks(case_id);
CREATE INDEX idx_documents_case ON documents(case_id);
CREATE INDEX idx_deadlines_firm ON deadlines(firm_id);
CREATE INDEX idx_deadlines_date ON deadlines(date);
CREATE INDEX idx_audit_log_firm ON audit_log(firm_id);
CREATE INDEX idx_audit_log_timestamp ON audit_log(timestamp);
CREATE INDEX idx_password_resets_token ON password_resets(token);

-- Auto-update updated_at trigger
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER set_updated_at_firms BEFORE UPDATE ON firms FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER set_updated_at_users BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER set_updated_at_clients BEFORE UPDATE ON clients FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER set_updated_at_cases BEFORE UPDATE ON cases FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER set_updated_at_tasks BEFORE UPDATE ON tasks FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER set_updated_at_documents BEFORE UPDATE ON documents FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER set_updated_at_deadlines BEFORE UPDATE ON deadlines FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Auto-generate avatar initials
CREATE OR REPLACE FUNCTION generate_avatar_initials()
RETURNS TRIGGER AS $$
BEGIN
  NEW.avatar_initials = UPPER(
    SUBSTRING(SPLIT_PART(NEW.name, ' ', 1) FROM 1 FOR 1) ||
    COALESCE(SUBSTRING(SPLIT_PART(NEW.name, ' ', 2) FROM 1 FOR 1), '')
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER set_avatar_initials BEFORE INSERT OR UPDATE OF name ON users FOR EACH ROW EXECUTE FUNCTION generate_avatar_initials();

-- Lock audit log — IMMUTABLE (GDPR requirement)
REVOKE UPDATE, DELETE ON audit_log FROM PUBLIC;

-- Row Level Security (RLS) — firm isolation at database level
ALTER TABLE firms ENABLE ROW LEVEL SECURITY;
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE deadlines ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;

-- RLS policies: users can only access data from their own firm
CREATE POLICY firm_isolation_firms ON firms FOR ALL USING (id = (current_setting('app.firm_id', true))::uuid);
CREATE POLICY firm_isolation_users ON users FOR ALL USING (firm_id = (current_setting('app.firm_id', true))::uuid);
CREATE POLICY firm_isolation_clients ON clients FOR ALL USING (firm_id = (current_setting('app.firm_id', true))::uuid);
CREATE POLICY firm_isolation_cases ON cases FOR ALL USING (firm_id = (current_setting('app.firm_id', true))::uuid);
CREATE POLICY firm_isolation_tasks ON tasks FOR ALL USING (
  case_id IN (SELECT id FROM cases WHERE firm_id = (current_setting('app.firm_id', true))::uuid)
);
CREATE POLICY firm_isolation_documents ON documents FOR ALL USING (
  case_id IN (SELECT id FROM cases WHERE firm_id = (current_setting('app.firm_id', true))::uuid)
);
CREATE POLICY firm_isolation_deadlines ON deadlines FOR ALL USING (firm_id = (current_setting('app.firm_id', true))::uuid);
CREATE POLICY audit_log_insert_only ON audit_log FOR INSERT WITH CHECK (firm_id = (current_setting('app.firm_id', true))::uuid);
CREATE POLICY audit_log_read ON audit_log FOR SELECT USING (firm_id = (current_setting('app.firm_id', true))::uuid);

-- Time Entries (billable hours)
CREATE TABLE time_entries (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  firm_id UUID NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
  case_id UUID NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  lawyer_id UUID NOT NULL REFERENCES users(id),
  description TEXT NOT NULL,
  duration_minutes INTEGER NOT NULL CHECK (duration_minutes > 0),
  date DATE NOT NULL DEFAULT CURRENT_DATE,
  billable BOOLEAN NOT NULL DEFAULT true,
  rate_pence INTEGER NOT NULL CHECK (rate_pence >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Conflict Parties (SRA conflict of interest tracking)
CREATE TABLE conflict_parties (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  firm_id UUID NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
  case_id UUID REFERENCES cases(id) ON DELETE CASCADE,
  client_id UUID REFERENCES clients(id) ON DELETE SET NULL,
  party_name TEXT NOT NULL,
  party_type TEXT NOT NULL CHECK (party_type IN ('client','opposing','witness','related')),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes for new tables
CREATE INDEX idx_time_entries_firm ON time_entries(firm_id);
CREATE INDEX idx_time_entries_case ON time_entries(case_id);
CREATE INDEX idx_time_entries_lawyer ON time_entries(lawyer_id);
CREATE INDEX idx_time_entries_date ON time_entries(date);
CREATE INDEX idx_conflict_parties_firm ON conflict_parties(firm_id);
CREATE INDEX idx_conflict_parties_case ON conflict_parties(case_id);
CREATE INDEX idx_conflict_parties_name ON conflict_parties(party_name);

-- Triggers for new tables
CREATE TRIGGER set_updated_at_time_entries BEFORE UPDATE ON time_entries FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER set_updated_at_conflict_parties BEFORE UPDATE ON conflict_parties FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- RLS for new tables
ALTER TABLE time_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE conflict_parties ENABLE ROW LEVEL SECURITY;
CREATE POLICY firm_isolation_time_entries ON time_entries FOR ALL USING (firm_id = (current_setting('app.firm_id', true))::uuid);
CREATE POLICY firm_isolation_conflict_parties ON conflict_parties FOR ALL USING (firm_id = (current_setting('app.firm_id', true))::uuid);

-- Case Emails (filed emails linked to cases)
CREATE TABLE case_emails (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  firm_id UUID NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
  case_id UUID NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  filed_by UUID NOT NULL REFERENCES users(id),
  subject TEXT NOT NULL,
  from_address TEXT NOT NULL,
  body TEXT,
  received_date TIMESTAMPTZ DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Client Portal Tokens (self-serve access for clients)
CREATE TABLE client_portal_tokens (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  firm_id UUID NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes
CREATE INDEX idx_case_emails_firm ON case_emails(firm_id);
CREATE INDEX idx_case_emails_case ON case_emails(case_id);
CREATE INDEX idx_client_portal_tokens_token ON client_portal_tokens(token);
CREATE INDEX idx_client_portal_tokens_client ON client_portal_tokens(client_id);

-- Triggers
CREATE TRIGGER set_updated_at_case_emails BEFORE UPDATE ON case_emails FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- RLS
ALTER TABLE case_emails ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_portal_tokens ENABLE ROW LEVEL SECURITY;
CREATE POLICY firm_isolation_case_emails ON case_emails FOR ALL USING (firm_id = (current_setting('app.firm_id', true))::uuid);
CREATE POLICY firm_isolation_client_portal_tokens ON client_portal_tokens FOR ALL USING (firm_id = (current_setting('app.firm_id', true))::uuid);
