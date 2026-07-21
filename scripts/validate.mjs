// Static structural validation for the Firearms Database (no dependencies).
// Catches the classes of bugs that matter for this static app:
//  - unbalanced <div>s in the HTML pages
//  - getElementById() references with no matching static element
//  - referenced local files (scripts, styles, icons) that don't exist
// Exits non-zero on any failure so CI fails the build.
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const errors = [];
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const exists = (p) => fs.existsSync(path.join(root, p));

// Element IDs that are created dynamically at runtime (not static in HTML).
const DYNAMIC_IDS = new Set(['welcomeOverlay', 'valueChartCanvas', 'typeChartCanvas', 'calChartCanvas', 'mfgChartCanvas',
  'dealerSearch', 'dealerNoMatch', 'dealerShownCount', 'updateBanner']);
const DYNAMIC_SHARE_IDS = new Set([
  'shareRetry', 'shareCodeForm', 'shareViewerCode', 'showShareCode', 'openShareButton', 'printShare'
]);

function divBalance(html, name) {
  const open = (html.match(/<div\b/gi) || []).length;
  const close = (html.match(/<\/div>/gi) || []).length;
  if (open !== close) errors.push(`${name}: <div> imbalance (${open} open / ${close} close)`);
}

function idsIn(html) {
  return new Set([...html.matchAll(/\bid\s*=\s*["']([^"']+)["']/g)].map((m) => m[1]));
}

function refsIn(js) {
  return new Set([...js.matchAll(/getElementById\(\s*["']([^"']+)["']/g)].map((m) => m[1]));
}

function checkLocalRefs(html, name) {
  const re = /(?:src|href)\s*=\s*["'](?!https?:|data:|mailto:|#)([^"']+)["']/g;
  for (const m of html.matchAll(re)) {
    let ref = m[1].split('?')[0].split('#')[0];
    if (!ref || ref.startsWith('//')) continue;
    if (!exists(ref)) errors.push(`${name}: references missing local file "${ref}"`);
  }
}

function checkNoRemoteExecutableAssets(html, name) {
  const remoteScripts = [...html.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']https?:\/\/[^"']+["']/gi)];
  const remoteStyles = [...html.matchAll(/<link\b[^>]*\brel\s*=\s*["']stylesheet["'][^>]*\bhref\s*=\s*["']https?:\/\/[^"']+["']/gi)];
  if (remoteScripts.length) errors.push(`${name}: remote executable script found; vendor it locally`);
  if (remoteStyles.length) errors.push(`${name}: remote stylesheet found; vendor it locally`);
}

// ---- index.html ----
const index = read('index.html');
divBalance(index, 'index.html');
checkLocalRefs(index, 'index.html');
checkNoRemoteExecutableAssets(index, 'index.html');
const staticIds = idsIn(index);
const indexScripts = ['js/app.js', 'js/auth.js', 'js/cloud-sync.js', 'js/pwa-register.js', 'js/ui-shell.js'];
const appRefs = new Set(indexScripts.flatMap((file) => [...refsIn(read(file))]));
for (const id of appRefs) {
  if (!staticIds.has(id) && !DYNAMIC_IDS.has(id)) {
    errors.push(`index.html: getElementById("${id}") has no matching element`);
  }
}

// ---- share.html (standalone viewer) ----
const share = read('share.html');
divBalance(share, 'share.html');
checkLocalRefs(share, 'share.html');
checkNoRemoteExecutableAssets(share, 'share.html');
const shareIds = idsIn(share);
for (const id of refsIn(read('js/share.js'))) {
  if (!shareIds.has(id) && !DYNAMIC_SHARE_IDS.has(id)) errors.push(`share.html: getElementById("${id}") has no matching element`);
}

// ---- service worker shell files must exist ----
const sw = read('sw.js');
for (const m of sw.matchAll(/['"]\.\/([^'"]+)['"]/g)) {
  const ref = m[1];
  if (ref && ref !== '' && !exists(ref)) errors.push(`sw.js: precache references missing file "${ref}"`);
}

if (errors.length) {
  console.error('✗ Validation failed:\n' + errors.map((e) => '  - ' + e).join('\n'));
  process.exit(1);
}
console.log('✓ Structural validation passed (HTML balance, element refs, local files).');
