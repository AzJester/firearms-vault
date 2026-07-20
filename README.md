# Personal Firearms Vault

A private, login-protected web app for firearms, ammunition, accessories, NFA
items, maintenance, value history, documents, receipts, and insurance exports.
The target deployment is `https://vault.st-dba.com/`.

The application is a static PWA backed by Supabase Auth, Postgres, and private
Storage. No inventory data belongs in this source tree or deployment package.

## Recovery status

The original `AzJester/firearms-db` repository and its Supabase backend are no
longer available. A complete source copy and valid June 17 backup were recovered
from OneDrive. See `DEPLOYMENT.md` for the exact rebuild sequence.

## Features

- Firearms inventory with photos, condition, value, tags, and notes
- NFA tracking, tax-stamp status, dates, and stamp PDFs
- Ammunition, accessories, maintenance, and round-count tracking
- Disposition records, wishlist, dealer directory, and audit trail
- Dashboard charts and value history
- Receipt/document storage and locally hosted OCR
- Excel, PDF, CSV, JSON, bound-book, and insurance exports
- Optional expiring, revocable read-only share links
- Installable PWA with a local offline cache

## Architecture

```text
vault.st-dba.com (static, isolated origin)
  ├─ login and application shell
  ├─ self-hosted JavaScript, fonts, OCR model, and export libraries
  └─ local IndexedDB cache
               │ HTTPS, authenticated session
               ▼
Supabase
  ├─ Auth: intended user only
  ├─ collections: one JSON document per user, protected by RLS
  ├─ media: private bucket under <user-id>/, protected by RLS
  └─ shares: revocable snapshots exposed only by unguessable token RPC
```

The dedicated subdomain keeps the vault's browser session and offline cache on
a different origin from WordPress. This reduces the impact of a compromised
WordPress plugin or page script.

## Security controls

- Row Level Security restricts database rows and files to `auth.uid()`.
- The service-role key is never shipped to the browser.
- Executable dependencies are self-hosted instead of loaded from public CDNs.
- Deployment headers deny framing, MIME sniffing, indexing, and unnecessary
  browser permissions; CSP limits network access to the app and Supabase.
- Backups and inventory exports are excluded from source and deployment.
- Share links expire when configured and can be revoked immediately.

The local JSON backup is sensitive and currently unencrypted. Keep it in an
encrypted drive or password-manager attachment and do not upload it to source
control or the public WordPress media library.

## Setup

1. Create a new Supabase project.
2. Run `supabase/schema.sql` in its SQL Editor.
3. Disable open sign-ups and create only the intended user.
4. Copy the new project URL and public anon key into `js/config.js` using
   `js/config.example.js` as the template.
5. Configure Supabase's Site URL and allowed redirect URL as
   `https://vault.st-dba.com/`.
6. Run the checks and build:

```powershell
npm install
npm test
npm run build
```

7. Upload the contents of `dist/` to the subdomain document root.
8. Sign in and restore the recovered June 17 backup through the app.

`npm run build` refuses to create a deployable directory while the retired
Supabase project or placeholder credentials remain in `js/config.js`.

## Development

```powershell
npm install
npm test
npx playwright test
```

The Playwright configuration starts a local static server automatically. The
source also includes a standalone `local-edition/` for offline-only use, but it
is deliberately excluded from the hosted build.
