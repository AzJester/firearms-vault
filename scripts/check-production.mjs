import crypto from 'node:crypto';
import fs from 'node:fs';

const EXIT = Object.freeze({ configuration: 2, network: 3, content: 4, revision: 5, integrity: 6, headers: 7 });

class ProductionProbeError extends Error {
  constructor(stage, message, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = 'ProductionProbeError';
    this.stage = stage;
    this.exitCode = EXIT[stage] || 1;
  }
}

const clean = (value) => String(value || 'Unknown failure').replace(/[\r\n]+/g, ' ').slice(0, 1200);
const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const digest = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

function fail(stage, message, cause) {
  return new ProductionProbeError(stage, message, cause);
}

function numberSetting(name, fallback, minimum, maximum) {
  const value = Number(process.env[name] || fallback);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw fail('configuration', `${name} must be an integer from ${minimum} through ${maximum}.`);
  }
  return value;
}

function configuration() {
  const rawUrl = process.env.PRODUCTION_URL || 'https://vault.st-dba.com/';
  let baseUrl;
  try { baseUrl = new URL(rawUrl); } catch (error) {
    throw fail('configuration', 'PRODUCTION_URL is not a valid URL.', error);
  }
  const allowInsecure = process.env.ALLOW_INSECURE_PROBE === 'true';
  const localHost = ['localhost', '127.0.0.1', '[::1]'].includes(baseUrl.hostname);
  if (baseUrl.protocol !== 'https:' && !(allowInsecure && localHost && baseUrl.protocol === 'http:')) {
    throw fail('configuration', 'Production probes require HTTPS. Set ALLOW_INSECURE_PROBE=true only for a local test server.');
  }
  const headerPolicy = String(process.env.SECURITY_HEADER_POLICY || 'report').trim().toLowerCase();
  if (!['off', 'report', 'required'].includes(headerPolicy)) {
    throw fail('configuration', 'SECURITY_HEADER_POLICY must be off, report, or required.');
  }
  const expectedRevision = String(process.env.EXPECTED_REVISION || '').trim().toLowerCase();
  if (expectedRevision && !/^[a-f0-9]{7,64}$/.test(expectedRevision)) {
    throw fail('configuration', 'EXPECTED_REVISION must be a hexadecimal Git revision.');
  }
  return {
    baseUrl,
    expectedRevision,
    headerPolicy,
    attempts: numberSetting('PROBE_ATTEMPTS', 5, 1, 10),
    retryMs: numberSetting('PROBE_RETRY_MS', 10000, 0, 60000),
    timeoutMs: numberSetting('PROBE_REQUEST_TIMEOUT_MS', 20000, 1000, 120000)
  };
}

function withCacheBust(baseUrl, relativePath) {
  const url = new URL(relativePath, baseUrl);
  url.searchParams.set('vault_probe', `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`);
  return url;
}

async function fetchResource(config, relativePath, label) {
  const url = withCacheBust(config.baseUrl, relativePath);
  let response;
  try {
    response = await fetch(url, {
      cache: 'no-store',
      redirect: 'follow',
      headers: { Accept: '*/*', 'User-Agent': 'firearms-vault-production-probe/1.0' },
      signal: AbortSignal.timeout(config.timeoutMs)
    });
  } catch (error) {
    throw fail('network', `${label} request failed before an HTTP response was received: ${clean(error.message)}`, error);
  }
  if (!response.ok) throw fail('network', `${label} returned HTTP ${response.status}.`);
  const finalUrl = new URL(response.url);
  if (finalUrl.origin !== config.baseUrl.origin) {
    throw fail('network', `${label} redirected to an unexpected origin (${finalUrl.origin}).`);
  }
  return {
    label,
    path: relativePath,
    bytes: Buffer.from(await response.arrayBuffer()),
    headers: response.headers,
    status: response.status,
    finalUrl
  };
}

function requireContentType(resource, expected) {
  const value = resource.headers.get('content-type') || '';
  if (!expected.some((type) => value.toLowerCase().startsWith(type))) {
    throw fail('content', `${resource.label} has unexpected Content-Type "${value || 'missing'}".`);
  }
}

function parseJson(resource) {
  try { return JSON.parse(resource.bytes.toString('utf8')); } catch (error) {
    throw fail('content', `${resource.label} did not contain valid JSON.`, error);
  }
}

function validateBuild(buildInfo, expectedRevision) {
  if (!buildInfo || typeof buildInfo !== 'object') throw fail('content', 'build-info.json is not an object.');
  if (!/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(String(buildInfo.version || ''))) {
    throw fail('content', 'build-info.json has an invalid version.');
  }
  if (!/^[a-f0-9]{7,64}$/i.test(String(buildInfo.revision || ''))) {
    throw fail('content', 'build-info.json has an invalid revision.');
  }
  if (buildInfo.buildId !== `${buildInfo.version}-${buildInfo.revision}`) {
    throw fail('content', 'build-info.json buildId does not match its version and revision.');
  }
  const builtAt = Date.parse(buildInfo.builtAt);
  if (!Number.isFinite(builtAt) || builtAt > Date.now() + 5 * 60 * 1000) {
    throw fail('content', 'build-info.json has an invalid or future builtAt timestamp.');
  }
  if (expectedRevision) {
    const expectedPrefix = expectedRevision.slice(0, 12);
    if (!String(buildInfo.revision).toLowerCase().startsWith(expectedPrefix)) {
      throw fail('revision', `Production revision ${buildInfo.revision} does not match expected ${expectedPrefix}.`);
    }
  }
}

function verifyIntegrity(integrityManifest, buildInfo, resources) {
  if (!integrityManifest || typeof integrityManifest !== 'object' || !integrityManifest.files) {
    throw fail('integrity', 'integrity-manifest.json is missing its files map.');
  }
  if (!integrityManifest.build || integrityManifest.build.buildId !== buildInfo.buildId) {
    throw fail('integrity', 'Integrity manifest build does not match build-info.json.');
  }
  for (const [file, resource] of Object.entries(resources)) {
    const expected = integrityManifest.files[file];
    if (!expected || !/^[a-f0-9]{64}$/.test(String(expected.sha256 || ''))) {
      throw fail('integrity', `Integrity manifest has no valid entry for ${file}.`);
    }
    if (Number(expected.bytes) !== resource.bytes.length) {
      throw fail('integrity', `${file} byte count differs from the integrity manifest.`);
    }
    if (digest(resource.bytes) !== expected.sha256) {
      throw fail('integrity', `${file} checksum differs from the integrity manifest.`);
    }
  }
}

function inspectHeaders(config, resources) {
  if (config.headerPolicy === 'off') return [];
  const missing = [];
  const root = resources['index.html'].headers;
  const requiredRoot = [
    ['content-security-policy', (value) => /frame-ancestors\s+'none'/i.test(value)],
    ['strict-transport-security', (value) => /max-age\s*=\s*\d+/i.test(value)],
    ['x-content-type-options', (value) => /^nosniff$/i.test(value.trim())],
    ['x-frame-options', (value) => /^deny$/i.test(value.trim())],
    ['referrer-policy', (value) => /no-referrer/i.test(value)],
    ['permissions-policy', (value) => /geolocation\s*=\s*\(\)/i.test(value)],
    ['cross-origin-opener-policy', (value) => /same-origin/i.test(value)],
    ['x-robots-tag', (value) => /noindex/i.test(value)]
  ];
  for (const [name, valid] of requiredRoot) {
    const value = root.get(name) || '';
    if (!value || !valid(value)) missing.push(`index.html: ${name}`);
  }

  for (const file of ['sw.js', 'js/config.js', 'build-info.json']) {
    const value = resources[file].headers.get('cache-control') || '';
    if (!/no-cache/i.test(value) || !/no-store/i.test(value) || !/must-revalidate/i.test(value)) {
      missing.push(`${file}: cache-control no-cache, no-store, must-revalidate`);
    }
  }

  if (missing.length && config.headerPolicy === 'required') {
    throw fail('headers', `Required response headers are missing or incomplete: ${missing.join('; ')}`);
  }
  return missing;
}

function writeSummary(config, buildInfo, warnings) {
  if (!process.env.GITHUB_STEP_SUMMARY) return;
  const lines = [
    '### Firearms Vault production probe',
    '',
    `- URL: ${config.baseUrl.origin}${config.baseUrl.pathname}`,
    `- Build: ${buildInfo.buildId}`,
    '- Artifact checksums: verified',
    `- Security header policy: ${config.headerPolicy}`,
    `- Header gaps: ${warnings.length}`,
    ''
  ];
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n'));
}

async function probeOnce(config) {
  const criticalPaths = [
    'css/styles.css', 'css/vault-ui.css',
    'js/app.js', 'js/auth.js', 'js/cloud-sync.js', 'js/action-runtime.js',
    'js/security.js', 'js/data-safety.js', 'js/ui-shell.js', 'js/pwa-register.js'
  ];
  const [index, build, integrity, worker, publicConfig, critical] = await Promise.all([
    fetchResource(config, './', 'application entry point'),
    fetchResource(config, 'build-info.json', 'build information'),
    fetchResource(config, 'integrity-manifest.json', 'integrity manifest'),
    fetchResource(config, 'sw.js', 'service worker'),
    fetchResource(config, 'js/config.js', 'public configuration'),
    Promise.all(criticalPaths.map((file) => fetchResource(config, file, `critical asset ${file}`)))
  ]);

  requireContentType(index, ['text/html']);
  requireContentType(build, ['application/json', 'text/json']);
  requireContentType(integrity, ['application/json', 'text/json']);
  requireContentType(worker, ['application/javascript', 'text/javascript']);
  requireContentType(publicConfig, ['application/javascript', 'text/javascript']);
  critical.forEach((resource) => requireContentType(
    resource,
    resource.path.endsWith('.css') ? ['text/css'] : ['application/javascript', 'text/javascript']
  ));
  const html = index.bytes.toString('utf8');
  if (!/<div\s+id=["']appRoot["']/i.test(html) || !/<form\s+id=["']authForm["']/i.test(html)) {
    throw fail('content', 'The production entry point does not contain the expected vault application shell.');
  }

  const buildInfo = parseJson(build);
  validateBuild(buildInfo, config.expectedRevision);
  const integrityManifest = parseJson(integrity);
  const resources = {
    'index.html': index,
    'build-info.json': build,
    'sw.js': worker,
    'js/config.js': publicConfig
  };
  critical.forEach((resource) => { resources[resource.path] = resource; });
  verifyIntegrity(integrityManifest, buildInfo, resources);
  const warnings = inspectHeaders(config, resources);
  return { buildInfo, warnings };
}

async function main() {
  const config = configuration();
  console.log(`PROBE_START url=${config.baseUrl.origin}${config.baseUrl.pathname} expected_revision=${config.expectedRevision.slice(0, 12) || 'any'} header_policy=${config.headerPolicy}`);
  let lastError;
  for (let attempt = 1; attempt <= config.attempts; attempt += 1) {
    try {
      const result = await probeOnce(config);
      result.warnings.forEach((warning) => console.warn(`PROBE_WARNING stage=headers message=${warning}`));
      console.log(`PROBE_OK build=${result.buildInfo.buildId} integrity=verified header_gaps=${result.warnings.length}`);
      writeSummary(config, result.buildInfo, result.warnings);
      return;
    } catch (error) {
      lastError = error;
      console.warn(`PROBE_RETRY attempt=${attempt}/${config.attempts} stage=${error.stage || 'unknown'} message=${clean(error.message)}`);
      if (attempt < config.attempts && config.retryMs) await pause(config.retryMs);
    }
  }
  throw lastError || fail('network', 'Production probe failed without an error detail.');
}

main().catch((error) => {
  const stage = error && error.stage ? error.stage : 'unknown';
  const exitCode = Number(error && error.exitCode) || 1;
  const message = clean(error && error.message);
  console.error(`PROBE_FAILED stage=${stage} code=${exitCode} message=${message}`);
  if (process.env.GITHUB_ACTIONS === 'true') {
    console.error(`::error title=Firearms Vault production ${stage} probe failed::${message}`);
  }
  process.exitCode = exitCode;
});
