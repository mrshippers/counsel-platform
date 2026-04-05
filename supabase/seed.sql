-- Counsel — Seed data for development/testing
-- Run AFTER schema.sql
-- Creates test firm + partner user (jamal@driiva) + sample data

-- Test firm
INSERT INTO firms (id, name, plan) VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Townsend & Associates', 'professional');

-- Test user: jamal@driiva (password: Counsel2026!)
-- Password hash generated with PBKDF2-SHA256, 100k iterations
-- For dev only — production users go through onboarding
INSERT INTO users (id, firm_id, name, email, password_hash, role) VALUES
  ('11111111-1111-1111-1111-111111111111',
   'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'Jamal Townsend', 'jamal@driiva',
   -- This is a placeholder hash. After deploying, use the /api/onboarding endpoint
   -- to create a real account with proper PBKDF2 hashing.
   'PLACEHOLDER_USE_ONBOARDING_ENDPOINT',
   'partner');

-- Associate
INSERT INTO users (id, firm_id, name, email, password_hash, role) VALUES
  ('22222222-2222-2222-2222-222222222222',
   'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'Amir Khalil', 'amir@townsend.law',
   'PLACEHOLDER_USE_ONBOARDING_ENDPOINT',
   'associate');

-- Clients
INSERT INTO clients (id, firm_id, name, email, type) VALUES
  ('cccccccc-cccc-cccc-cccc-cccccccccc01', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Hadid Developments Ltd', 'info@hadid-dev.co.uk', 'corporate'),
  ('cccccccc-cccc-cccc-cccc-cccccccccc02', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'R. Mensah', 'r.mensah@gmail.com', 'individual'),
  ('cccccccc-cccc-cccc-cccc-cccccccccc03', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Whitmore & Sons', 'legal@whitmore.co.uk', 'corporate'),
  ('cccccccc-cccc-cccc-cccc-cccccccccc04', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'S. Okonkwo', 's.okonkwo@outlook.com', 'individual'),
  ('cccccccc-cccc-cccc-cccc-cccccccccc05', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Aspire Capital Partners', 'deals@aspirecap.com', 'corporate');

-- Cases
INSERT INTO cases (id, firm_id, client_id, lawyer_id, title, type, status, priority, progress, deadline) VALUES
  ('dddddddd-dddd-dddd-dddd-dddddddddd01', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'cccccccc-cccc-cccc-cccc-cccccccccc01', '11111111-1111-1111-1111-111111111111', 'Commercial Lease Agreement', 'real_estate', 'in_progress', 'high', 75, '2026-04-10'),
  ('dddddddd-dddd-dddd-dddd-dddddddddd02', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'cccccccc-cccc-cccc-cccc-cccccccccc02', '22222222-2222-2222-2222-222222222222', 'Unfair Dismissal Claim', 'employment', 'in_progress', 'urgent', 50, '2026-04-07'),
  ('dddddddd-dddd-dddd-dddd-dddddddddd03', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'cccccccc-cccc-cccc-cccc-cccccccccc03', '22222222-2222-2222-2222-222222222222', 'Supplier Contract Dispute', 'civil', 'pending', 'high', 25, '2026-04-12'),
  ('dddddddd-dddd-dddd-dddd-dddddddddd04', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'cccccccc-cccc-cccc-cccc-cccccccccc04', '11111111-1111-1111-1111-111111111111', 'Tier 2 Visa Application', 'other', 'pending', 'normal', 0, NULL),
  ('dddddddd-dddd-dddd-dddd-dddddddddd05', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'cccccccc-cccc-cccc-cccc-cccccccccc05', '11111111-1111-1111-1111-111111111111', 'Acquisition Due Diligence', 'corporate', 'in_progress', 'high', 50, '2026-04-15');

-- Tasks for each case (4 defaults)
INSERT INTO tasks (case_id, label, done, order_index) VALUES
  -- Case 1: Commercial Lease (75% = 3/4 done)
  ('dddddddd-dddd-dddd-dddd-dddddddddd01', 'Initial Review & Client Meeting', true, 0),
  ('dddddddd-dddd-dddd-dddd-dddddddddd01', 'Document Collection & Filing', true, 1),
  ('dddddddd-dddd-dddd-dddd-dddddddddd01', 'Case Research & Preparation', true, 2),
  ('dddddddd-dddd-dddd-dddd-dddddddddd01', 'Resolution & Case Closure', false, 3),
  -- Case 2: Unfair Dismissal (50% = 2/4 done)
  ('dddddddd-dddd-dddd-dddd-dddddddddd02', 'Initial Review & Client Meeting', true, 0),
  ('dddddddd-dddd-dddd-dddd-dddddddddd02', 'Document Collection & Filing', true, 1),
  ('dddddddd-dddd-dddd-dddd-dddddddddd02', 'Case Research & Preparation', false, 2),
  ('dddddddd-dddd-dddd-dddd-dddddddddd02', 'Resolution & Case Closure', false, 3),
  -- Case 3: Supplier Dispute (25% = 1/4 done)
  ('dddddddd-dddd-dddd-dddd-dddddddddd03', 'Initial Review & Client Meeting', true, 0),
  ('dddddddd-dddd-dddd-dddd-dddddddddd03', 'Document Collection & Filing', false, 1),
  ('dddddddd-dddd-dddd-dddd-dddddddddd03', 'Case Research & Preparation', false, 2),
  ('dddddddd-dddd-dddd-dddd-dddddddddd03', 'Resolution & Case Closure', false, 3),
  -- Case 4: Visa Application (0%)
  ('dddddddd-dddd-dddd-dddd-dddddddddd04', 'Initial Review & Client Meeting', false, 0),
  ('dddddddd-dddd-dddd-dddd-dddddddddd04', 'Document Collection & Filing', false, 1),
  ('dddddddd-dddd-dddd-dddd-dddddddddd04', 'Case Research & Preparation', false, 2),
  ('dddddddd-dddd-dddd-dddd-dddddddddd04', 'Resolution & Case Closure', false, 3),
  -- Case 5: Acquisition DD (50% = 2/4 done)
  ('dddddddd-dddd-dddd-dddd-dddddddddd05', 'Initial Review & Client Meeting', true, 0),
  ('dddddddd-dddd-dddd-dddd-dddddddddd05', 'Document Collection & Filing', true, 1),
  ('dddddddd-dddd-dddd-dddd-dddddddddd05', 'Case Research & Preparation', false, 2),
  ('dddddddd-dddd-dddd-dddd-dddddddddd05', 'Resolution & Case Closure', false, 3);

-- Deadlines
INSERT INTO deadlines (firm_id, case_id, lawyer_id, created_by, title, date) VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'dddddddd-dddd-dddd-dddd-dddddddddd02', '22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', 'Witness Statement Filing', '2026-04-07'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'dddddddd-dddd-dddd-dddd-dddddddddd01', '11111111-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111', 'Contract Exchange', '2026-04-10'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'dddddddd-dddd-dddd-dddd-dddddddddd03', '22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', 'Mediation Brief Submission', '2026-04-12'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'dddddddd-dddd-dddd-dddd-dddddddddd05', '11111111-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111', 'DD Review Deadline', '2026-04-15');
