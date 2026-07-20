import { test, expect } from '@playwright/test';

async function loadSafetyRuntime(page) {
  await page.goto('/robots.txt');
  await page.addScriptTag({ url: '/js/security.js' });
  await page.addScriptTag({ url: '/js/data-safety.js' });
}

test('rich text sanitizer preserves formatting and removes executable markup', async ({ page }) => {
  await loadSafetyRuntime(page);
  const result = await page.evaluate(() => window.VaultSecurity.sanitizeRichText(`
    <p onclick="window.__owned=true">Safe <strong>formatting</strong></p>
    <img src=x onerror="window.__owned=true">
    <a href="javascript:window.__owned=true">bad link</a>
    <a href="https://example.com/path">good link</a>
    <svg><script>window.__owned=true</script></svg>
  `));
  expect(result).toContain('<strong>formatting</strong>');
  expect(result).toContain('https://example.com/path');
  expect(result).not.toMatch(/onclick|onerror|javascript:|<img|<svg|<script/i);
  expect(await page.evaluate(() => window.__owned)).toBeUndefined();
});

test('backup normalization strips prototype keys, unsafe URLs, and duplicate IDs', async ({ page }) => {
  await loadSafetyRuntime(page);
  const normalized = await page.evaluate(() => window.VaultSecurity.safeJSONParse(JSON.stringify({
    version: 3,
    firearms: [
      { id: 'same', notes: '<b>ok</b><img src=x onerror=alert(1)>', website: 'javascript:alert(1)' },
      { id: 'same', notes: '<em>also ok</em>' }
    ],
    ammo: [], accessories: [], wishlist: [], dealers: [], auditTrail: [], valueHistory: [], backups: [],
    settings: JSON.parse('{"__proto__":{"polluted":true},"theme":"dark"}')
  })));
  expect(normalized.data.firearms[0].notes).toBe('<b>ok</b>');
  expect(normalized.data.firearms[0].website).toBe('');
  expect(normalized.data.firearms[0].id).not.toBe(normalized.data.firearms[1].id);
  expect(normalized.data.settings.__proto__.polluted).toBeUndefined();
  expect(normalized.warnings.length).toBeGreaterThan(0);
});

test('local safety storage isolates accounts and keeps a durable outbox', async ({ page }) => {
  await loadSafetyRuntime(page);
  const result = await page.evaluate(async () => {
    const userA = '11111111-1111-4111-8111-111111111111';
    const userB = '22222222-2222-4222-8222-222222222222';
    const empty = { version: 3, firearms: [], ammo: [], accessories: [], wishlist: [], dealers: [], backups: [], settings: {}, auditTrail: [], valueHistory: [] };
    const accountA = structuredClone(empty);
    accountA.firearms.push({ id: 'record-a', make: 'Private record' });
    await VaultDataSafety.clearState(userA);
    await VaultDataSafety.clearState(userB);
    await VaultDataSafety.putState(userA, accountA);
    await VaultDataSafety.putState(userB, empty);
    const queued = await VaultDataSafety.enqueue(userA, accountA, 4);
    return {
      aCount: (await VaultDataSafety.getState(userA)).data.firearms.length,
      bCount: (await VaultDataSafety.getState(userB)).data.firearms.length,
      outboxCount: (await VaultDataSafety.listOutbox(userA)).length,
      otherOutboxCount: (await VaultDataSafety.listOutbox(userB)).length,
      baseRevision: queued.baseRevision
    };
  });
  expect(result).toEqual({ aCount: 1, bCount: 0, outboxCount: 1, otherOutboxCount: 0, baseRevision: 4 });
});

test('encrypted full backup round-trips and detects a wrong password', async ({ page }) => {
  await loadSafetyRuntime(page);
  const result = await page.evaluate(async () => {
    const data = {
      version: 3,
      firearms: [{ id: 'record-1', notes: '<strong>maintained</strong>' }],
      ammo: [], accessories: [], wishlist: [], dealers: [], backups: [], settings: {}, auditTrail: [], valueHistory: []
    };
    const envelope = await VaultDataSafety.exportEnvelope('11111111-1111-4111-8111-111111111111', data, 'correct horse battery staple');
    const restored = await VaultDataSafety.importEnvelope(envelope, 'correct horse battery staple');
    let wrongPassword = '';
    try { await VaultDataSafety.importEnvelope(envelope, 'this password is wrong'); } catch (error) { wrongPassword = error.message; }
    return { encrypted: envelope.encrypted, count: restored.data.firearms.length, wrongPassword };
  });
  expect(result.encrypted).toBe(true);
  expect(result.count).toBe(1);
  expect(result.wrongPassword).toMatch(/incorrect|damaged/i);
});
