# Firearms Vault deployment and recovery

Production: `https://vault.st-dba.com/`

## Normal release

1. Work on a branch and run `npm ci && npm test`.
2. Merge or push the reviewed commit to `main`.
3. The `Test and deploy to GitHub Pages` workflow installs pinned dependencies,
   validates and builds `dist/`, tests that exact artifact, then deploys it.
4. A production smoke job verifies the vault shell, expected Git revision,
   content types, `integrity-manifest.json` hashes, and response-header policy.
5. Confirm the application reports the expected build and a successful sync.

A failed validation or browser test prevents deployment. The build also emits
`integrity-manifest.json`, `vendor/manifest.json`, and complete license notices.

## Database migrations

`supabase/schema.sql` is idempotent and represents the complete desired schema.
Before deploying client code that requires a new RPC or column:

1. Open the existing project in Supabase.
2. Run unapplied files from `supabase/migrations/` in filename order. For this
   release, run `20260720000001_sync_safety.sql`, then
   `20260720000002_share_safety.sql`. Use `schema.sql` only for a fresh project.
3. Verify anonymous reads return no rows.
4. Verify an authenticated owner can read/write only its own rows.
5. Run a revision-conflict and recovery-version test with non-production data.

Never place a database password, service-role key, user password, exported
inventory, or recovery archive in this repository.

## Authentication baseline

Production uses closed sign-ups, confirmed email, a 12-character minimum
password, current-password verification for normal password changes, TOTP MFA,
and Supabase enhanced MFA security. The Site URL is
`https://vault.st-dba.com` and the redirect allowlist contains
`https://vault.st-dba.com/**`.

Strengthening the project password rules can require an existing user with a
weaker password to use the recovery flow before signing in again. Test password
recovery after changing Auth settings and keep the redirect allowlist current.

## HTTP security headers

The repository supplies equivalent rules in `_headers` and `.htaccess`.
GitHub Pages serves neither as configuration, so it cannot enforce the intended
HTTP CSP/frame protections. Keep the `vault.st-dba.com` hostname but place it
behind a header-capable static host/proxy (for example Cloudflare Pages) or an
isolated Apache document root before considering the header work complete.

After a hosting change, verify response headers for `/`, `/sw.js`, and
`/js/config.js`; the latter two must revalidate rather than remain publicly
cached for long periods. Verify a different origin cannot frame the vault.
Then set the GitHub repository variable `SECURITY_HEADER_POLICY` to `required`.
It defaults to `report` while GitHub Pages remains the origin, so the deployment
summary exposes every gap without blocking an otherwise valid release.

## Recovery drill

Perform this with a test account or disposable project:

1. Create an encrypted full backup and record its displayed checksum.
2. Confirm every primary collection and media manifest is included.
3. Delete the test collection.
4. Restore the backup and wait for local and cloud status to succeed.
5. Compare record counts and media hashes with the backup manifest.
6. Confirm the restored account is invisible to another authenticated user and
   to an anonymous request.

Do not treat session undo history as a disaster-recovery backup. Maintain an
encrypted copy outside the browser and use Supabase managed backups/PITR when
the collection requires guaranteed recovery.

## Monitoring canary

The scheduled workflow runs daily. It always performs the basic
reachability and anonymous-privacy request first, so the project is contacted
even if the authenticated monitor is not configured. It then runs in
`production` mode and fails closed unless a dedicated canary account is
configured with these GitHub repository secrets:

- `SUPABASE_CANARY_EMAIL`
- `SUPABASE_CANARY_PASSWORD`

The account should be used only for monitoring, have no collection data, and
must not opt in to account-level TOTP because this non-interactive password
probe cannot complete an AAL2 challenge. Give it a unique random password.

Each run verifies Auth reachability, anonymous RLS, the isolated
`run_health_check_canary` database write/delete RPC, and a private Storage
upload/download/SHA-256/delete cycle in the `media` bucket. It also proves the
temporary object is rejected through both the public-object route and an
anonymous Supabase session. A cleanup attempt is made after every partial
Storage failure. Workflow failure notifications are the operational alert; no
inventory table or inventory object is accessed.

Because GitHub disables schedules in inactive public repositories after 60
days, a second monthly schedule refreshes `.github/supabase-monitor-heartbeat`
on `main`. This is a best-effort activity marker and will fail visibly if branch
protection or token permissions prevent the push. Supabase Free can still pause
projects it judges insufficiently active; only a paid plan guarantees that
inactivity pausing is disabled.

The health script emits stable stages and exit codes for alert routing:

| Exit | Stage |
| ---: | --- |
| 2 | Configuration or missing production credentials |
| 3 | Auth/project reachability |
| 4 | Anonymous privacy/RLS |
| 5 | Canary authentication |
| 6 | Database write/delete |
| 7 | Storage upload/download/checksum/delete |
| 8 | Cleanup failure with possible orphaned canary object |
