# Firearms Vault — Local Edition

A private, **offline** collection manager for firearms, ammunition, accessories,
NFA items, wishlists, and FFL dealers. Everything you enter is stored **only on
your device** — there is no account, no login, and nothing is ever uploaded.

---

## Part 1 — For the buyer (end user)

### What this is
A self-contained app you run in your web browser (or install as an app). Your
data lives in the browser's on-device storage. Your records never leave your
computer.

### How to run it
**Easiest — open it directly**
1. Unzip this folder somewhere permanent (e.g. Documents).
2. Double-click `index.html` to open it in your browser.
   - For full functionality (charts, install-as-app, offline shell), it's best
     served over `http://` rather than `file://` — see "Install as an app".

**Install as an app (recommended)**
Serve the folder locally, then install it from the browser:
1. Open a terminal in this folder and run one of:
   - `python3 -m http.server 8000`  (Python), or
   - `npx serve .`  (Node)
2. Visit `http://localhost:8000` in Chrome or Edge.
3. Click the **Install** icon in the address bar to add it as a desktop/start-menu app.

### Your data & backups (important)
- Because data is stored only on your device, **you are responsible for backups.**
- Use **Backup Now** or **Save to File** regularly and keep the file somewhere safe
  (external drive, etc.).
- Use **Restore from File** to load a backup back in (this replaces your current data).
- Clearing your browser data, uninstalling, or moving to a new device will not
  carry your data over unless you restore from a backup file.

### First run
On first launch you can load a few **sample entries** to explore, or start empty.
Sample entries use placeholder serial numbers — edit or delete them freely.

### Privacy & terms
See `PRIVACY.txt`, `LICENSE.txt`, and `THIRD-PARTY-LICENSES.txt` in this folder.
This app is a record-keeping convenience only — it is **not** legal/compliance
advice and is **not** an official record. Always follow the laws that apply to you.

### Need internet?
**No — the app runs fully offline.** All code libraries (charts, Excel/PDF
export, QR codes, zip) and the Inter font are bundled in `vendor/`, and your data
always stays on this device. The **only** feature that needs internet is the
optional **Scan Serial (OCR)** tool, which downloads its recognition engine on
demand. Everything else works with no connection.

---

## Part 2 — For the seller (packaging notes — delete before shipping)

This `local-edition/` folder is the sellable artifact. It is fully self-contained
and contains **no personal data** and **no Supabase keys** — it does not talk to
any backend.

**Before you list it:**
1. **Branding:** rename "Firearms Vault" if you like (in `index.html` title +
   `<span class="version-badge">`, `manifest.webmanifest`, the About modal, and
   these docs). Replace the icons in `icons/` with your own.
2. **Legal:** fill in every `[BRACKETED]` placeholder in `LICENSE.txt` and
   `PRIVACY.txt`, and have a lawyer review them. Consider forming an LLC.
3. **Zip it:** zip the entire `local-edition/` folder. That zip is your product
   download.
4. **Where to sell:** software-friendly marketplaces (Gumroad, Payhip, Lemon
   Squeezy, itch.io) are a better fit than Etsy, whose policies restrict
   firearms-related listings and aren't built for software.

**Offline status (done):**
- The libraries and the Inter font are vendored in `vendor/` (with their license
  texts in `vendor/licenses/`), so the app needs zero internet. The single
  exception is the optional **Scan Serial (OCR)** tool, which still pulls its
  engine from a CDN at runtime — to make that offline too, bundle `tesseract.js`,
  `tesseract.js-core`, and an `eng.traineddata` file and point the OCR init at
  local paths.

**For a true desktop installer:**
- Wrap this folder with **Tauri** or **Electron** (point the window at
  `index.html`). Because every asset is now local, the packaged app runs with no
  network at all.

**Keeping in sync with the online edition:**
`css/styles.css` is a byte-for-byte copy of the main app. `js/app.js` is the
same except for product-edition changes: the two cloud-only command-palette
entries ("Share inventory" / "Sync now") are removed, and the dealer **starter
list is fictional sample data** with a generic city-based area filter (the main
app ships a real regional list). Core improvements port over by re-copying and
re-applying those edits. The only other edition-specific glue is
`js/local-store.js` (replaces the cloud stack) and the edits in `index.html`
(no login, no cloud/sync/share UI, sample-data onboarding, About).

### Demo / sample data
This build ships with **no real data** — no personal collection, no Supabase
keys, no embedded photos. The only bundled content is fictional, clearly-labeled
sample data to demonstrate the app:
- A first-run prompt can load 3 sample firearms + 1 sample ammo entry (placeholder
  serials like `SAMPLE-0001`).
- The dealer import offers "Load sample dealers" — 8 invented FFLs with `555`
  phone numbers and `Anytown, ST 00000` addresses.
All of it is meant to be edited or deleted by the buyer.
