import fs from 'node:fs';

const config = fs.readFileSync('js/config.js', 'utf8');
const url = config.match(/SUPABASE_URL\s*=\s*['"]([^'"]+)['"]/)?.[1];
const anonKey = config.match(/SUPABASE_ANON_KEY\s*=\s*['"]([^'"]+)['"]/)?.[1];
if (!url || !anonKey) throw new Error('Supabase public client configuration is missing.');

const reachability = await fetch(`${url}/auth/v1/settings`, {
  headers: { apikey: anonKey }
});
if (!reachability.ok) throw new Error(`Supabase reachability check failed with HTTP ${reachability.status}.`);

const anonymous = await fetch(`${url}/rest/v1/collections?select=user_id&limit=1`, {
  headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}` }
});
if (anonymous.ok) {
  const rows = await anonymous.json();
  if (!Array.isArray(rows) || rows.length !== 0) throw new Error('Privacy failure: anonymous collection rows were visible.');
} else if (![401, 403].includes(anonymous.status)) {
  throw new Error(`Anonymous privacy check failed unexpectedly with HTTP ${anonymous.status}.`);
}
console.log('Supabase reachability and anonymous privacy checks passed.');

const email = process.env.CANARY_EMAIL || '';
const password = process.env.CANARY_PASSWORD || '';
if (!email || !password) {
  console.log('Authenticated canary secrets are not configured; reachability/RLS check only.');
  process.exit(0);
}

const auth = await fetch(`${url}/auth/v1/token?grant_type=password`, {
  method: 'POST',
  headers: { apikey: anonKey, 'Content-Type': 'application/json' },
  body: JSON.stringify({ email, password })
});
if (!auth.ok) throw new Error(`Canary authentication failed with HTTP ${auth.status}.`);
const session = await auth.json();
const headers = { apikey: anonKey, Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' };
const canary = await fetch(`${url}/rest/v1/rpc/run_health_check_canary`, {
  method: 'POST', headers,
  body: JSON.stringify({ p_source: 'github-actions' })
});
if (!canary.ok) throw new Error(`Canary RPC failed with HTTP ${canary.status}. Apply the sync-safety migration and verify the canary account.`);
const canaryResult = await canary.json();
if (!canaryResult || canaryResult.ok !== true || Number(canaryResult.deleted) !== 1) {
  throw new Error('Canary RPC did not confirm its isolated write/delete cycle.');
}
console.log('Authenticated write/delete canary passed.');
