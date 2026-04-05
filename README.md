# Counsel

Case management SaaS for UK small law firms (1-15 lawyers).

## Stack

- **Frontend:** Cloudflare Workers (HTML/CSS/JS)
- **Backend API:** Cloudflare Workers + Hono
- **Database:** Supabase PostgreSQL (EU West / London)
- **Auth:** JWT sessions (8hr expiry), PBKDF2 password hashing
- **File Storage:** Supabase Storage (EU region, 50MB max)
- **Email:** Resend

## Setup

### 1. Supabase

Create a new Supabase project in **EU West (London)** region. Run the schema:

```bash
# Copy supabase/schema.sql into the Supabase SQL Editor and execute
```

### 2. Environment

```bash
cp .env.example .dev.vars
# Fill in your Supabase and Resend credentials
```

For production, use Wrangler secrets:

```bash
wrangler secret put SUPABASE_URL
wrangler secret put SUPABASE_ANON_KEY
wrangler secret put SUPABASE_SERVICE_ROLE_KEY
wrangler secret put JWT_SECRET
wrangler secret put RESEND_API_KEY
```

### 3. Install & Run

```bash
npm install
npm run dev        # Local dev server
npm test           # Run test suite
npm run typecheck  # TypeScript check
npm run deploy     # Deploy to Cloudflare
```

## API Routes

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | /api/auth/login | No | Login, returns JWT |
| POST | /api/auth/password-reset | No | Request password reset |
| POST | /api/auth/password-reset/confirm | No | Use reset token |
| GET | /api/cases | Yes | List cases (firm-scoped) |
| POST | /api/cases | Yes | Create case + 4 default tasks |
| GET | /api/cases/:id | Yes | Get case detail |
| GET | /api/clients | Yes | List clients |
| POST | /api/clients | Yes | Create client |
| GET | /api/clients/:id | Yes | Client detail + cases |
| PATCH | /api/tasks/:id | Yes | Toggle task + recalc progress |
| GET | /api/calendar | Yes | Deadlines calendar |
| GET | /api/lawyers | Partner | Lawyer workload |
| GET | /api/dashboard | Yes | Triage intelligence board |

## Roles

- **Partner:** Full firm access, lawyer management, audit log
- **Associate:** Own cases only, no lawyer tab

## GDPR

- Supabase EU West region only
- RLS + application-level firm isolation (belt and braces)
- Immutable audit log (REVOKE UPDATE/DELETE)
- Right to erasure cascades all related data
- Subject access request exports client data as JSON
- Account lockout after 10 failed login attempts
- Failed logins logged with IP address

## Testing

TDD — all features built test-first. Run:

```bash
npm test
```
