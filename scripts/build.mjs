import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const root = process.cwd();
const dist = path.join(root, 'dist');
if (path.dirname(dist) !== root || path.basename(dist) !== 'dist') {
  throw new Error('Refusing to build outside this project.');
}

const config = fs.readFileSync(path.join(root, 'js', 'config.js'), 'utf8');
if (/YOUR_PROJECT_REF|YOUR_PUBLIC_ANON_KEY/.test(config)) {
  throw new Error('js/config.js still contains placeholder Supabase settings.');
}
if (/(?:SERVICE_ROLE_KEY|SUPABASE_SERVICE_KEY)\s*=/i.test(config)) {
  throw new Error('js/config.js must never contain a Supabase service role key.');
}

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });

const files = [
  '.htaccess', '_headers', 'CNAME', 'index.html', 'share.html', 'sw.js',
  'manifest.webmanifest', 'robots.txt', 'THIRD_PARTY_NOTICES.md'
];
const directories = ['css', 'icons', 'js', 'vendor'];

for (const file of files) {
  fs.copyFileSync(path.join(root, file), path.join(dist, file));
}
for (const directory of directories) {
  fs.cpSync(path.join(root, directory), path.join(dist, directory), { recursive: true });
}

// Ship all third-party notices that already accompany the standalone build.
const additionalLicenses = path.join(root, 'local-edition', 'vendor', 'licenses');
if (fs.existsSync(additionalLicenses)) {
  fs.cpSync(additionalLicenses, path.join(dist, 'vendor', 'licenses'), { recursive: true });
}

let gitRevision = process.env.GITHUB_SHA || 'development';
try { gitRevision = execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(); } catch (_) {}
const packageInfo = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const builtAt = new Date().toISOString();
const buildId = `${packageInfo.version}-${gitRevision}`;
const buildInfo = { name: packageInfo.name, version: packageInfo.version, revision: gitRevision, buildId, builtAt };
fs.writeFileSync(path.join(dist, 'build-info.json'), JSON.stringify(buildInfo, null, 2) + '\n');

// Give each deployment its own cache namespace without hand-editing sw.js.
const swPath = path.join(dist, 'sw.js');
fs.writeFileSync(swPath, fs.readFileSync(swPath, 'utf8').replaceAll('__VAULT_BUILD_ID__', buildId));

const vendorCatalog = [
  ['xlsx.full.min.js', 'SheetJS Community Edition', '0.18.5', 'Apache-2.0', 'https://github.com/SheetJS/sheetjs'],
  ['jspdf.umd.min.js', 'jsPDF', '2.5.1', 'MIT', 'https://github.com/parallax/jsPDF'],
  ['jspdf.plugin.autotable.min.js', 'jsPDF-AutoTable', '3.8.2', 'MIT', 'https://github.com/simonbengtsson/jsPDF-AutoTable'],
  ['jszip.min.js', 'JSZip', '3.10.1', 'MIT or GPL-3.0', 'https://github.com/Stuk/jszip'],
  ['qrcode.min.js', 'QRCode.js', '1.0.0', 'MIT', 'https://github.com/davidshimjs/qrcodejs'],
  ['chart.umd.js', 'Chart.js', '4.4.1', 'MIT', 'https://github.com/chartjs/Chart.js'],
  ['supabase.js', 'Supabase JavaScript Client', '2.110.7', 'MIT', 'https://github.com/supabase/supabase-js'],
  ['tesseract/tesseract.min.js', 'Tesseract.js', '5.1.1', 'Apache-2.0', 'https://github.com/naptha/tesseract.js'],
  ['fonts/InterVariable.woff2', 'Inter', 'variable', 'OFL-1.1', 'https://github.com/rsms/inter']
];
const vendors = vendorCatalog.map(([file, name, version, license, source]) => {
  const deployed = path.join(dist, 'vendor', file);
  return {
    file, name, version, license, source,
    bytes: fs.statSync(deployed).size,
    sha256: crypto.createHash('sha256').update(fs.readFileSync(deployed)).digest('hex')
  };
});
fs.writeFileSync(path.join(dist, 'vendor', 'manifest.json'), JSON.stringify({ generatedAt: builtAt, vendors }, null, 2) + '\n');

// Source-only configuration guidance must not be served from the private app.
fs.rmSync(path.join(dist, 'js', 'config.example.js'), { force: true });

// Generate a deployed-file integrity manifest for support and recovery audits.
const integrity = {};
function hashTree(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) hashTree(full);
    else {
      const relative = path.relative(dist, full).replaceAll('\\', '/');
      if (relative === 'integrity-manifest.json') continue;
      integrity[relative] = {
        bytes: fs.statSync(full).size,
        sha256: crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex')
      };
    }
  }
}
hashTree(dist);
fs.writeFileSync(path.join(dist, 'integrity-manifest.json'), JSON.stringify({ build: buildInfo, files: integrity }, null, 2) + '\n');
console.log(`Built deployable site ${buildId} at ${dist}`);
