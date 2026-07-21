import crypto from 'node:crypto';
import fs from 'node:fs';

const EXIT = Object.freeze({
  configuration: 2,
  reachability: 3,
  privacy: 4,
  authentication: 5,
  database: 6,
  storage: 7,
  cleanup: 8
});
const REQUEST_TIMEOUT_MS = Number(process.env.HEALTH_REQUEST_TIMEOUT_MS || 15000);

class HealthCheckError extends Error {
  constructor(stage, message, exitCode, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = 'HealthCheckError';
    this.stage = stage;
    this.exitCode = exitCode;
  }
}

function failure(stage, message, cause) {
  return new HealthCheckError(stage, message, EXIT[stage] || 1, cause);
}

function cleanMessage(value) {
  return String(value || 'Unknown failure').replace(/[\r\n]+/g, ' ').slice(0, 1000);
}

function ok(stage, message) {
  console.log(`CHECK_OK stage=${stage} ${message}`);
}

function readPublicConfig() {
  const config = fs.readFileSync('js/config.js', 'utf8');
  return {
    url: process.env.SUPABASE_URL || config.match(/SUPABASE_URL\s*=\s*['"]([^'"]+)['"]/)?.[1],
    anonKey: process.env.SUPABASE_ANON_KEY || config.match(/SUPABASE_ANON_KEY\s*=\s*['"]([^'"]+)['"]/)?.[1]
  };
}

function validateConfiguration() {
  const mode = String(process.env.HEALTH_CHECK_MODE || 'basic').trim().toLowerCase();
  if (!['basic', 'production'].includes(mode)) {
    throw failure('configuration', 'HEALTH_CHECK_MODE must be either "basic" or "production".');
  }
  const { url: rawUrl, anonKey } = readPublicConfig();
  if (!rawUrl || !anonKey) throw failure('configuration', 'Supabase public client configuration is missing.');

  let parsed;
  try { parsed = new URL(rawUrl); } catch (error) {
    throw failure('configuration', 'SUPABASE_URL is not a valid URL.', error);
  }
  const localHost = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  const allowLocalHttp = process.env.ALLOW_INSECURE_SUPABASE === 'true' && localHost;
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && allowLocalHttp)) {
    throw failure('configuration', 'SUPABASE_URL must use HTTPS. Plain HTTP is allowed only for an explicitly enabled local test server.');
  }

  const email = String(process.env.CANARY_EMAIL || '').trim();
  const password = String(process.env.CANARY_PASSWORD || '');
  if ((email && !password) || (!email && password)) {
    throw failure('configuration', 'CANARY_EMAIL and CANARY_PASSWORD must be configured together.');
  }
  if (mode === 'production' && (!email || !password)) {
    throw failure(
      'configuration',
      'Production health mode requires CANARY_EMAIL and CANARY_PASSWORD; refusing to report a reachability-only check as healthy.'
    );
  }

  const bucket = String(process.env.CANARY_STORAGE_BUCKET || 'media').trim();
  if (!/^[a-z0-9][a-z0-9._-]{0,62}$/i.test(bucket)) {
    throw failure('configuration', 'CANARY_STORAGE_BUCKET contains unsupported characters.');
  }
  if (!Number.isFinite(REQUEST_TIMEOUT_MS) || REQUEST_TIMEOUT_MS < 1000 || REQUEST_TIMEOUT_MS > 120000) {
    throw failure('configuration', 'HEALTH_REQUEST_TIMEOUT_MS must be between 1000 and 120000.');
  }

  return {
    mode,
    url: parsed.href.replace(/\/$/, ''),
    anonKey,
    email,
    password,
    bucket
  };
}

async function request(stage, url, options) {
  try {
    return await fetch(url, {
      ...options,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
  } catch (error) {
    throw failure(stage, `Request failed before an HTTP response was received: ${cleanMessage(error.message)}`, error);
  }
}

async function errorDetail(response) {
  try {
    const body = cleanMessage(await response.text());
    return body ? ` Response: ${body.slice(0, 240)}` : '';
  } catch (_) {
    return '';
  }
}

function authenticatedHeaders(config, accessToken, contentType) {
  const headers = {
    apikey: config.anonKey,
    Authorization: `Bearer ${accessToken}`
  };
  if (contentType) headers['Content-Type'] = contentType;
  return headers;
}

function encodeObjectPath(path) {
  return String(path).split('/').map((segment) => encodeURIComponent(segment)).join('/');
}

async function verifyReachability(config) {
  const response = await request('reachability', `${config.url}/auth/v1/settings`, {
    headers: { apikey: config.anonKey }
  });
  if (!response.ok) {
    throw failure('reachability', `Supabase Auth settings returned HTTP ${response.status}.${await errorDetail(response)}`);
  }
  ok('reachability', `http=${response.status}`);
}

async function verifyAnonymousPrivacy(config) {
  const response = await request('privacy', `${config.url}/rest/v1/collections?select=user_id&limit=1`, {
    headers: authenticatedHeaders(config, config.anonKey)
  });
  if (response.ok) {
    let rows;
    try { rows = await response.json(); } catch (error) {
      throw failure('privacy', 'Anonymous collection response was not valid JSON.', error);
    }
    if (!Array.isArray(rows) || rows.length !== 0) {
      throw failure('privacy', 'Privacy failure: anonymous collection rows were visible.');
    }
  } else if (![401, 403].includes(response.status)) {
    throw failure('privacy', `Anonymous privacy probe returned unexpected HTTP ${response.status}.${await errorDetail(response)}`);
  }
  ok('privacy', `anonymous_http=${response.status} visible_rows=0`);
}

async function authenticateCanary(config) {
  const response = await request('authentication', `${config.url}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: config.anonKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: config.email, password: config.password })
  });
  if (!response.ok) {
    throw failure('authentication', `Canary authentication returned HTTP ${response.status}.${await errorDetail(response)}`);
  }
  let session;
  try { session = await response.json(); } catch (error) {
    throw failure('authentication', 'Canary authentication response was not valid JSON.', error);
  }
  if (!session.access_token) throw failure('authentication', 'Canary authentication returned no access token.');

  let userId = session.user && session.user.id;
  if (!userId) {
    const user = await request('authentication', `${config.url}/auth/v1/user`, {
      headers: authenticatedHeaders(config, session.access_token)
    });
    if (!user.ok) throw failure('authentication', `Canary user lookup returned HTTP ${user.status}.${await errorDetail(user)}`);
    const profile = await user.json();
    userId = profile && profile.id;
  }
  if (!/^[A-Za-z0-9-]{8,128}$/.test(String(userId || ''))) {
    throw failure('authentication', 'Canary authentication returned an invalid user identifier.');
  }
  ok('authentication', 'session=authenticated');
  return { accessToken: session.access_token, userId: String(userId) };
}

async function verifyDatabaseCanary(config, session) {
  const response = await request('database', `${config.url}/rest/v1/rpc/run_health_check_canary`, {
    method: 'POST',
    headers: authenticatedHeaders(config, session.accessToken, 'application/json'),
    body: JSON.stringify({ p_source: 'github-actions' })
  });
  if (!response.ok) {
    throw failure(
      'database',
      `Database write/delete RPC returned HTTP ${response.status}; apply the sync-safety migration and verify the canary account.${await errorDetail(response)}`
    );
  }
  let result;
  try { result = await response.json(); } catch (error) {
    throw failure('database', 'Database canary response was not valid JSON.', error);
  }
  if (!result || result.ok !== true || Number(result.deleted) !== 1) {
    throw failure('database', 'Database canary did not confirm its isolated write/delete cycle.');
  }
  ok('database', 'write=passed delete=passed');
}

async function deleteStorageObject(config, session, objectPath, stage = 'storage') {
  const response = await request(stage, `${config.url}/storage/v1/object/${encodeURIComponent(config.bucket)}`, {
    method: 'DELETE',
    headers: authenticatedHeaders(config, session.accessToken, 'application/json'),
    body: JSON.stringify({ prefixes: [objectPath] })
  });
  if (!response.ok) {
    throw failure(stage, `Storage delete returned HTTP ${response.status}.${await errorDetail(response)}`);
  }
}

async function verifyStorageCanary(config, session) {
  const probeId = crypto.randomUUID();
  const objectPath = `${session.userId}/health-canary/${probeId}.txt`;
  const objectUrl = `${config.url}/storage/v1/object/${encodeURIComponent(config.bucket)}/${encodeObjectPath(objectPath)}`;
  const publicObjectUrl = `${config.url}/storage/v1/object/public/${encodeURIComponent(config.bucket)}/${encodeObjectPath(objectPath)}`;
  const payload = Buffer.from(`firearms-vault-health:${probeId}:${new Date().toISOString()}`, 'utf8');
  const expectedChecksum = crypto.createHash('sha256').update(payload).digest('hex');
  let uploaded = false;
  let deleteConfirmed = false;
  let primaryError = null;

  try {
    const upload = await request('storage', objectUrl, {
      method: 'POST',
      headers: {
        ...authenticatedHeaders(config, session.accessToken, 'text/plain; charset=utf-8'),
        'cache-control': '0',
        'x-upsert': 'false'
      },
      body: payload
    });
    if (!upload.ok) throw failure('storage', `Storage upload returned HTTP ${upload.status}.${await errorDetail(upload)}`);
    uploaded = true;

    const publicDownload = await request('privacy', `${publicObjectUrl}?cacheNonce=${encodeURIComponent(crypto.randomUUID())}`, {});
    if (publicDownload.ok) {
      throw failure('privacy', 'Privacy failure: Storage canary object was downloadable through the public bucket route.');
    }
    if (![400, 401, 403, 404].includes(publicDownload.status)) {
      throw failure('privacy', `Public Storage privacy probe returned unexpected HTTP ${publicDownload.status}.${await errorDetail(publicDownload)}`);
    }

    const anonymousDownload = await request('privacy', `${objectUrl}?cacheNonce=${encodeURIComponent(crypto.randomUUID())}`, {
      headers: authenticatedHeaders(config, config.anonKey)
    });
    if (anonymousDownload.ok) {
      throw failure('privacy', 'Privacy failure: Storage canary object was downloadable by an anonymous Supabase session.');
    }
    if (![400, 401, 403, 404].includes(anonymousDownload.status)) {
      throw failure('privacy', `Anonymous Storage privacy probe returned unexpected HTTP ${anonymousDownload.status}.${await errorDetail(anonymousDownload)}`);
    }
    ok('privacy', `storage_public_http=${publicDownload.status} storage_anon_http=${anonymousDownload.status} visible_objects=0`);

    const download = await request('storage', `${objectUrl}?cacheNonce=${encodeURIComponent(probeId)}`, {
      headers: authenticatedHeaders(config, session.accessToken)
    });
    if (!download.ok) throw failure('storage', `Storage download returned HTTP ${download.status}.${await errorDetail(download)}`);
    const downloaded = Buffer.from(await download.arrayBuffer());
    const actualChecksum = crypto.createHash('sha256').update(downloaded).digest('hex');
    if (actualChecksum !== expectedChecksum) {
      throw failure('storage', 'Storage download checksum did not match the uploaded canary payload.');
    }

    await deleteStorageObject(config, session, objectPath);

    const afterDelete = await request('storage', `${objectUrl}?cacheNonce=${encodeURIComponent(crypto.randomUUID())}`, {
      headers: authenticatedHeaders(config, session.accessToken)
    });
    if (afterDelete.ok) {
      throw failure('storage', 'Storage object remained downloadable after the delete canary.');
    }
    if (![400, 404].includes(afterDelete.status)) {
      throw failure('storage', `Storage delete verification returned unexpected HTTP ${afterDelete.status}.${await errorDetail(afterDelete)}`);
    }
    deleteConfirmed = true;
    ok('storage', `bucket=${config.bucket} privacy=passed upload=passed download=passed checksum=passed delete=passed`);
  } catch (error) {
    primaryError = error instanceof HealthCheckError ? error : failure('storage', cleanMessage(error.message), error);
  } finally {
    if (uploaded && !deleteConfirmed) {
      try {
        await deleteStorageObject(config, session, objectPath, 'cleanup');
        console.log('CHECK_OK stage=cleanup orphan_removed=true');
      } catch (cleanupError) {
        console.error(`CHECK_FAILED stage=cleanup code=${EXIT.cleanup} message=${cleanMessage(cleanupError.message)}`);
        primaryError = failure(
          'cleanup',
          `${cleanMessage(cleanupError.message)}${primaryError ? ` Original ${primaryError.stage} failure: ${cleanMessage(primaryError.message)}` : ''}`,
          cleanupError
        );
      }
    }
  }
  if (primaryError) throw primaryError;
}

async function main() {
  const config = validateConfiguration();
  console.log(`CHECK_START mode=${config.mode} authenticated=${Boolean(config.email)} storage_bucket=${config.bucket}`);
  await verifyReachability(config);
  await verifyAnonymousPrivacy(config);

  if (!config.email) {
    console.log('CHECK_SKIPPED stage=authenticated reason=canary_credentials_not_configured mode=basic');
    console.log('CHECK_COMPLETE status=healthy authenticated=false database=false storage=false');
    return;
  }

  const session = await authenticateCanary(config);
  await verifyDatabaseCanary(config, session);
  await verifyStorageCanary(config, session);
  console.log('CHECK_COMPLETE status=healthy authenticated=true database=true storage=true');
}

main().catch((error) => {
  const stage = error && error.stage ? error.stage : 'unknown';
  const exitCode = Number(error && error.exitCode) || 1;
  const message = cleanMessage(error && error.message);
  console.error(`CHECK_FAILED stage=${stage} code=${exitCode} message=${message}`);
  if (process.env.GITHUB_ACTIONS === 'true') {
    console.error(`::error title=Firearms Vault ${stage} health check failed::${message}`);
  }
  process.exitCode = exitCode;
});
