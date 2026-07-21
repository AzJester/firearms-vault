import { test, expect } from '@playwright/test';

test.use({ serviceWorkers: 'block' });

test.beforeEach(async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForFunction(() => typeof window.VaultActivity === 'object');
  await page.evaluate(() => {
    window.render = () => {};
    window.toast = () => {};
  });
});

test('legacy activity IDs stay stable when entries are reordered', async ({ page }) => {
  const result = await page.evaluate(() => {
    db.auditTrail = [
      { timestamp: '2026-07-20T01:00:00.000Z', action: 'edit', itemType: 'firearm', itemName: 'First', details: 'Updated' },
      { timestamp: '2026-07-20T02:00:00.000Z', action: 'edit', itemType: 'firearm', itemName: 'Second', details: 'Updated' }
    ];
    VaultActivity.render();
    const first = Object.fromEntries(db.auditTrail.map(entry => [entry.itemName, entry.id]));
    db.auditTrail.reverse();
    VaultActivity.render();
    const second = Object.fromEntries(db.auditTrail.map(entry => [entry.itemName, entry.id]));
    return { first, second };
  });

  expect(result.second).toEqual(result.first);
  expect(result.first.First).toMatch(/^legacy-/);
});

test('one-record restore leaves every unrelated record unchanged', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const before = { id: 'one', make: 'Before Arms', model: 'A', serial: 'OLD-1', images: [], documents: [], tags: [] };
    const after = { ...before, make: 'After Arms', serial: 'NEW-1' };
    const unrelated = { id: 'two', make: 'Unrelated', model: 'B', serial: 'KEEP-2', images: [], documents: [], tags: ['Keep'] };
    db.firearms = [structuredClone(after), structuredClone(unrelated)];
    db.auditTrail = [VaultActivity.createEntry('edit', 'firearm', 'After Arms A', 'Changed manufacturer and serial', {
      collection: 'firearms', recordId: 'one', before, after
    })];
    const entryId = db.auditTrail[0].id;
    window.confirmDialog = async () => true;
    window.saveData = async () => true;
    const untouched = JSON.stringify(db.firearms[1]);
    const restored = await VaultActivity.restore(entryId);
    return {
      restored,
      first: db.firearms.find(item => item.id === 'one'),
      unrelated: db.firearms.find(item => item.id === 'two'),
      untouched,
      restoreEvents: db.auditTrail.filter(entry => entry.action === 'restore').length
    };
  });

  expect(result.restored.status).toBe('restored');
  expect(result.first.make).toBe('Before Arms');
  expect(result.first.serial).toBe('OLD-1');
  expect(JSON.stringify(result.unrelated)).toBe(result.untouched);
  expect(result.restoreEvents).toBe(1);
});

test('failed durable save rolls back only the attempted restore', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const before = { id: 'one', make: 'Earlier', model: 'A', images: [], documents: [] };
    const current = { ...before, make: 'Current' };
    db.firearms = [structuredClone(current), { id: 'two', make: 'Untouched', images: [], documents: [] }];
    db.auditTrail = [VaultActivity.createEntry('edit', 'firearm', 'Current A', '', {
      collection: 'firearms', recordId: 'one', before, after: current
    })];
    const originalAuditLength = db.auditTrail.length;
    window.confirmDialog = async () => true;
    window.saveData = async () => false;
    const outcome = await VaultActivity.restore(db.auditTrail[0].id);
    return { outcome, firearms: structuredClone(db.firearms), auditLength: db.auditTrail.length, originalAuditLength };
  });

  expect(result.outcome.status).toBe('save-failed');
  expect(result.firearms[0].make).toBe('Current');
  expect(result.firearms[1].make).toBe('Untouched');
  expect(result.auditLength).toBe(result.originalAuditLength);
});

test('missing historical media cannot be reported as a full restore', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const before = { id: 'one', make: 'Earlier', model: 'A', images: ['expired-photo'], documents: [] };
    const current = { id: 'one', make: 'Current', model: 'A', images: [], documents: [] };
    db.firearms = [structuredClone(current)];
    db.auditTrail = [VaultActivity.createEntry('edit', 'firearm', 'Current A', '', {
      collection: 'firearms', recordId: 'one', before, after: current,
      mediaManifest: { 'expired-photo': { sha256: 'a'.repeat(64), path: 'expired-photo' } }
    })];
    const confirmations = [true, false];
    window.confirmDialog = async () => confirmations.shift();
    window.saveData = async () => true;
    const originalDownload = CloudSync.downloadMedia;
    const originalResident = CloudSync.residentMedia;
    CloudSync.downloadMedia = async () => ({ ok: false, failures: [{ key: 'expired-photo' }] });
    CloudSync.residentMedia = () => null;
    const outcome = await VaultActivity.restore(db.auditTrail[0].id);
    CloudSync.downloadMedia = originalDownload;
    CloudSync.residentMedia = originalResident;
    return { outcome, record: structuredClone(db.firearms[0]) };
  });

  expect(result.outcome.status).toBe('attachment-unavailable');
  expect(result.outcome.missingMedia).toEqual(['expired-photo']);
  expect(result.record.make).toBe('Current');
  expect(result.record.images).toEqual([]);
});

test('serial and value comparisons are marked for privacy masking', async ({ page }) => {
  const sensitiveCount = await page.evaluate(() => {
    const before = { id: 'one', serial: 'PRIVATE-1', price: '100', images: [], documents: [] };
    const after = { ...before, serial: 'PRIVATE-2', price: '200' };
    db.auditTrail = [VaultActivity.createEntry('edit', 'firearm', 'Private item', '', {
      collection: 'firearms', recordId: 'one', before, after
    })];
    VaultActivity.open();
    document.querySelector('[data-activity-toggle]').click();
    return document.querySelectorAll('#activityList [data-sensitive]').length;
  });

  expect(sensitiveCount).toBe(4);
});
