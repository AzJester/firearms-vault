import fs from 'node:fs';
import path from 'node:path';

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
  'manifest.webmanifest', 'robots.txt'
];
const directories = ['css', 'icons', 'js', 'vendor'];

for (const file of files) {
  fs.copyFileSync(path.join(root, file), path.join(dist, file));
}
for (const directory of directories) {
  fs.cpSync(path.join(root, directory), path.join(dist, directory), { recursive: true });
}

// Source-only configuration guidance must not be served from the private app.
fs.rmSync(path.join(dist, 'js', 'config.example.js'), { force: true });
console.log(`Built deployable site at ${dist}`);
