# Firearms Vault recovery and deployment

Target URL: `https://vault.st-dba.com/`

The dedicated subdomain is intentional. It gives the vault a separate browser
origin from the WordPress site, preventing WordPress plugins or page scripts
from reading the vault's authentication session or IndexedDB cache.

## Current recovery state

- The original GitHub repository is no longer in the `AzJester` account.
- GitHub's deleted-repository list does not contain it.
- The old Supabase project hostname no longer resolves.
- A complete source copy was recovered from OneDrive.
- The June 17 JSON backup is valid and contains the collection and media.
- The source passes structural validation and all Playwright smoke tests.

## Rebuild checklist

1. Create a new private Supabase project.
2. Run `supabase/schema.sql` in its SQL Editor.
3. Create only the intended user in Authentication; disable open sign-ups.
4. Copy `js/config.example.js` to `js/config.js` and set the new project URL
   and public anon key. Never use a service-role or secret key in this app.
5. In Supabase Auth URL configuration, set the Site URL to
   `https://vault.st-dba.com/` and allow that same redirect URL.
6. Run `npm test`, then `npm run build`.
7. Upload the contents of `dist/` to the isolated subdomain document root.
8. Sign in and restore
   `C:\Users\shane\OneDrive\05 - FIREARMS\firearms_backup_2026-06-17T03-43-07.json`.
9. Wait for the sync indicator to show `Synced`, then verify on a second device.

The backup contains sensitive inventory records and embedded media. It is not
copied into this source tree or deployment package.
