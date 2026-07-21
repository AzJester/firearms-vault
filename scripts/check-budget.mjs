import fs from 'node:fs';
import path from 'node:path';

const dist = path.join(process.cwd(), 'dist');
const core = [
  'index.html', 'css/fonts.css', 'css/styles.css', 'css/vault-ui.css', 'js/config.js',
  'js/security.js', 'js/data-safety.js', 'js/asset-loader.js', 'js/data-quality.js', 'js/supabase-client.js',
  'js/app.js', 'js/cloud-sync.js', 'js/auth.js', 'js/action-runtime.js', 'js/ui-shell.js', 'js/pwa-register.js', 'vendor/supabase.js',
  'vendor/fonts/InterVariable.woff2', 'manifest.webmanifest', 'icons/icon.svg'
];
const bytes = core.reduce((total, relative) => {
  const file = path.join(dist, relative);
  if (!fs.existsSync(file)) throw new Error(`Core budget file is missing: ${relative}`);
  return total + fs.statSync(file).size;
}, 0);
const limit = 3 * 1024 * 1024;
if (bytes > limit) throw new Error(`Core application payload ${(bytes / 1048576).toFixed(2)} MiB exceeds the 3 MiB budget.`);
console.log(`Core application payload: ${(bytes / 1048576).toFixed(2)} MiB / 3.00 MiB budget.`);
