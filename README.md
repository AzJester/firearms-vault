# Firearms Vault

A private, login-protected application for inventory, ammunition, accessories,
NFA records, maintenance, documents, receipts, reminders, sharing, and recovery.
The production URL is `https://vault.st-dba.com/`.

The application is a static PWA backed by Supabase Auth, Postgres, and private
Storage. Inventory, exports, credentials, and recovery files must never be
committed to this repository or included in the deployment artifact.

## Current status

The application and its Supabase project are active. The hosted build is
published from this repository through a test-gated GitHub Pages workflow.
Open registration is disabled; access is limited to accounts created by the
administrator.

Version 2.2 adds Collection Health, searchable field-by-field activity history
with single-record restore, mobile Quick Capture, encrypted insurance/theft
packages with redacted share copies, and verified weekly encrypted backups to a
user-selected folder outside Supabase. Version 2.1 established the underlying
durable local state, pending-change queue, and revision-aware cloud sync.

## Architecture

```text
vault.st-dba.com (isolated static origin)
  ├─ authentication and application shell
  ├─ user-scoped IndexedDB state, outbox, and recovery points
  ├─ self-hosted feature libraries loaded on demand
  └─ service worker with a small versioned core cache
                    │ HTTPS + authenticated session
                    ▼
Supabase
  ├─ Auth: administrator-created users
  ├─ collections: revisioned owner document, protected by RLS
  ├─ collection_versions: owner-only recovery history
  ├─ media: private owner paths, protected by RLS
  ├─ shares: expiring/revocable snapshots exposed by random token RPC
  └─ health_checks: isolated authenticated monitoring canary
```

The dedicated subdomain is deliberate: WordPress scripts, plugins, and browser
storage cannot access the vault origin.

## Data-safety contract

- A successful local save is considered durable even when Supabase is offline.
- Pending changes stay in a user-specific outbox until the server accepts them.
- Cloud writes use a revision precondition; a stale client cannot silently
  replace a revision it did not load.
- Non-overlapping changes are merged in the background. A user-facing alert is
  reserved for a change that cannot be preserved automatically.
- Account changes never hydrate another account's local collection.
- Full recovery backups carry a format version and SHA-256 integrity check and
  can optionally be encrypted with AES-256-GCM.
- Independent weekly backups use a device-local non-extractable key plus a
  password-wrapped recovery key, reopen and restore-validate every written file,
  and retain only verified files owned by that backup installation. Browser
  scheduling runs when the vault is open; it cannot guarantee a closed-browser
  background job.

## Security controls

- RLS restricts rows and private media to `auth.uid()`.
- No service-role key is shipped to the browser.
- Executable dependencies are self-hosted; optional large libraries load only
  when their feature is used.
- Rich text and imported records are sanitized and schema-normalized.
- Share links are revocable and expire; sensitive fields are opt-in.
- The deployed vendor and file integrity manifests include SHA-256 checksums.
- Production should be served by a host/proxy that enforces `_headers` or
  `.htaccess`. GitHub Pages does **not** apply either file as HTTP headers.

## Development

Requires Node.js 22.

```powershell
npm ci
npm test
```

`npm test` syntax-checks both editions, validates static references, builds the
exact deployment artifact, enforces the core payload budget, and runs Playwright
against that artifact when `TEST_SITE_DIR=dist` is set by CI.

The standalone `local-edition/` remains offline-only and is excluded from the
hosted artifact.

## Supabase configuration

For a new environment:

1. Create a Supabase project and run `supabase/schema.sql` in the SQL Editor.
2. Disable open sign-ups, require confirmed email, and create intended accounts
   administratively.
3. Copy `js/config.example.js` to `js/config.js`; set only the project URL and
   public anonymous key. Never use a secret or service-role key.
4. Set the Auth Site URL to `https://vault.st-dba.com` and allow
   `https://vault.st-dba.com/**` as a redirect.
5. Enable TOTP MFA and enhanced MFA security. Set the minimum password length
   to 12 and require the current password for normal password changes.
6. Verify the RLS and migration tests before importing data.

For the existing production environment, apply only migrations that have not
already been applied. See `DEPLOYMENT.md`.

## Monitoring

The daily scheduled health workflow always contacts Supabase and verifies anonymous
privacy first, then runs in production mode and fails closed unless a dedicated
canary account is configured with the repository secrets
`SUPABASE_CANARY_EMAIL` and `SUPABASE_CANARY_PASSWORD`. It verifies Auth
reachability, anonymous RLS, a database write/delete RPC, and a private
Supabase Storage upload/download/checksum/delete cycle, including negative
public-route and anonymous-session download checks. The temporary object is
created under the canary user's `media` path, with cleanup attempted even when
a later check fails. Neither canary reads nor writes inventory. A monthly
activity-marker commit helps prevent GitHub from disabling the public
repository's scheduled workflow after prolonged repository inactivity.

`npm run check:supabase` remains a basic reachability/privacy check when run
without credentials. Set `HEALTH_CHECK_MODE=production` to require the full
authenticated canary. `npm run check:production` verifies the deployed build
revision, content types, integrity-manifest hashes, and response headers.

Free-tier keepalive is best-effort. A paid Supabase plan is the appropriate
choice when non-pausing availability and managed backup guarantees are required.
