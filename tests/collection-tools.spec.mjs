import { test, expect } from '@playwright/test';

test.use({ serviceWorkers: 'block' });
const ownerA = 'c011ec70-1111-4111-8111-111111111111';
const ownerB = 'c011ec70-2222-4222-8222-222222222222';
const storagePrefix = 'collection-tools-mock-account:';
const pdf = 'data:application/pdf;base64,JVBERi0xLjQKJSBsb2NhbCB0ZXN0Cg==';
const base = {
  status: 'Active', images: [], tags: [], customFields: [], documents: [], maintenanceLog: [],
  notes: '', condition: 'Good', serial: 'TEST-SERIAL', caliber: '5.56', type: 'Rifle'
};
const records = [
  { ...base, id: 'alpha-carbine', make: 'Alpha Arms', model: 'Carbine', price: '1000', replacementValue: '1300',
    dateAcquired: '2026-10-01', isNFA: true, nfaType: 'SBR', formType: 'Form 4', stampStatus: 'Approved',
    dateSubmitted: '2024-01-01', dateApproved: '2024-02-01', stampPdf: pdf, stampPdfName: 'original-stamp.pdf',
    documents: [{ id: 'original-document', name: 'original.pdf', type: 'application/pdf', data: pdf }] },
  { ...base, id: 'alpha-pistol', make: 'Alpha Arms', model: 'Pistol', type: 'Pistol', price: '600', replacementValue: '',
    dateAcquired: '2026-08-01', acquisitionStage: 'Ordered', receipt: pdf, receiptName: 'receipt.pdf', images: ['example-photo'], tags: ['Carry'] },
  { ...base, id: 'beta-shotgun', make: 'Beta Arms', model: 'Shotgun', type: 'Shotgun', price: '0', replacementValue: '0',
    dateAcquired: '2025-01-01', acquisitionStage: 'At gunsmith', serial: '' },
  { ...base, id: 'disposed', make: 'Past Arms', model: 'Disposed', price: '200', status: 'Sold' }
];

async function initialize(page, { owner = ownerA, restore = false } = {}) {
  await expect.poll(() => page.evaluate(() => typeof window.VaultCollectionTools)).toBe('object');
  await page.evaluate(async ({ owner, restore, records, storagePrefix }) => {
    await openImageDB();
    await openStateDB();
    await CloudSync.activateUser(owner);
    document.getElementById('authOverlay').style.display = 'none';
    document.getElementById('firstRunPanel').style.display = 'none';
    document.getElementById('appRoot').style.display = '';
    const stored = restore && sessionStorage.getItem(storagePrefix + owner);
    db = stored ? JSON.parse(stored) : {
      version: 3, encrypted: false, firearms: records, ammo: [], accessories: [], wishlist: [], dealers: [],
      backups: [], settings: {}, auditTrail: [], valueHistory: []
    };
    window.__collectionSaveCalls = 0;
    window.saveData = async () => {
      window.__collectionSaveCalls++;
      sessionStorage.setItem(storagePrefix + CloudSync.uid, JSON.stringify(db));
      return true;
    };
    currentTab = 'all'; currentView = 'cards';
    bulkSelected = new Set();
    render();
  }, { owner, restore, records, storagePrefix });
}

async function cards(page, ids) {
  await expect.poll(() => page.locator('#cardGrid [data-card-id]').evaluateAll(nodes => nodes.map(node => node.dataset.cardId).sort())).toEqual(ids.slice().sort());
}

async function openFilters(page) {
  if (!await page.locator('#filterMake').isVisible()) await page.locator('#filterBtn').click();
}

async function clearFilters(page) {
  await page.locator('#filterChips .chip-clear').click();
}

async function openViews(page) {
  if (!await page.locator('#collectionViewsMenu').evaluate(element => element.open)) await page.locator('#collectionViewsMenu > summary').click();
}

async function closeViews(page) {
  if (await page.locator('#collectionViewsMenu').evaluate(element => element.open)) await page.locator('#collectionViewsMenu > summary').click();
}

async function setDefaultView(page) {
  await openViews(page);
  await page.locator('#defaultCollectionViewBtn').click();
  await closeViews(page);
}

async function createView(page, name) {
  await openViews(page);
  await page.locator('#saveCollectionViewBtn').click();
  await page.locator('#_dlgInput').fill(name);
  await page.locator('.app-dialog [data-dlg="ok"]').click();
  await expect.poll(() => page.evaluate(name => (db.settings.savedCollectionViews || []).some(view => view.name === name), name)).toBe(true);
  const id = await page.evaluate(name => db.settings.savedCollectionViews.find(view => view.name === name).id, name);
  await expect(page.locator('#savedCollectionView')).toHaveValue(id);
  await closeViews(page);
  return id;
}

async function selectForBatch(page, ids = ['alpha-carbine', 'alpha-pistol']) {
  for (const id of ids) await page.locator(`#cardGrid .card-checkbox[data-item-id="${id}"]`).check();
  await page.locator('#bulkEditRecordsBtn').click();
  await expect(page.locator('#batchEditModal')).toHaveClass(/\bopen\b/);
}

test.beforeEach(async ({ page }) => {
  // Real integrated modules and UI, with all services outside localhost blocked.
  await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
  await page.goto('/index.html');
  await initialize(page);
});

test('advanced filters combine purchase stage, manufacturer, dates, cost, and missing records, and Clear all resets every field', async ({ page }) => {
  await cards(page, ['alpha-carbine', 'alpha-pistol', 'beta-shotgun']);
  await openFilters(page);
  await page.locator('#filterMake').fill('ALPHA');
  await page.locator('#filterStage').selectOption('In possession');
  await page.locator('#filterAcquiredFrom').fill('2026-09-01');
  await page.locator('#filterAcquiredTo').fill('2026-10-20');
  await page.locator('#filterValueMin').fill('900');
  await page.locator('#filterValueMax').fill('1100');
  await page.locator('#filterMissing').selectOption('receipt');
  await cards(page, ['alpha-carbine']);
  await expect(page.locator('#filterChips')).toContainText('Manufacturer: ALPHA');
  await clearFilters(page);
  for (const id of ['filterMake', 'filterStage', 'filterAcquiredFrom', 'filterAcquiredTo', 'filterValueMin', 'filterValueMax', 'filterMissing']) await expect(page.locator('#' + id)).toHaveValue('');
  await cards(page, ['alpha-carbine', 'alpha-pistol', 'beta-shotgun']);
  await page.locator('#filterValueMin').fill('0');
  await page.locator('#filterValueMax').fill('0');
  await cards(page, ['beta-shotgun']);
  await clearFilters(page);
  await page.locator('#filterMissing').selectOption('valuation');
  await cards(page, ['alpha-pistol']);
  await clearFilters(page);
  await page.locator('#filterStage').selectOption('Ordered');
  await cards(page, ['alpha-pistol']);
  expect(await page.evaluate(() => db.firearms)).toEqual(records);
});

test('named views save, apply, become the account default, survive reload, and remove through their UI', async ({ page }) => {
  await openFilters(page);
  await page.locator('#filterMake').fill('Alpha');
  await page.locator('#filterStage').selectOption('Ordered');
  const viewId = await createView(page, 'Incoming Alpha');
  await expect(page.locator('#savedCollectionView')).toHaveValue(viewId);
  await setDefaultView(page);
  await expect.poll(() => page.evaluate(() => db.settings.defaultCollectionView)).toBe(viewId);
  await clearFilters(page);
  await cards(page, ['alpha-carbine', 'alpha-pistol', 'beta-shotgun']);
  await openViews(page);
  await page.locator('#savedCollectionView').selectOption(viewId);
  await closeViews(page);
  await cards(page, ['alpha-pistol']);
  await expect(page.locator('#filterStage')).toHaveValue('Ordered');
  const stored = await page.evaluate(({ storagePrefix, ownerA }) => JSON.parse(sessionStorage.getItem(storagePrefix + ownerA)), { storagePrefix, ownerA });
  expect(stored.settings).toMatchObject({ defaultCollectionView: viewId, savedCollectionViews: [{ id: viewId, name: 'Incoming Alpha' }] });
  await page.reload();
  await initialize(page, { restore: true });
  await cards(page, ['alpha-pistol']);
  await expect(page.locator('#savedCollectionView')).toHaveValue(viewId);
  await openViews(page);
  await page.locator('#deleteCollectionViewBtn').click();
  await page.locator('.app-dialog [data-dlg="ok"]').click();
  await expect.poll(() => page.evaluate(() => db.settings.savedCollectionViews)).toEqual([]);
  expect(await page.evaluate(() => db.settings.defaultCollectionView)).toBeUndefined();
  await expect(page.locator('#savedCollectionView')).toHaveValue('');
  await expect(page.locator('#deleteCollectionViewBtn')).toBeDisabled();
  expect(await page.evaluate(() => db.firearms)).toEqual(records);
});

test('batch edits require a preview and update selected records while retaining receipts, documents, and approvals', async ({ page }) => {
  await selectForBatch(page);
  await expect(page.locator('#batchApplyBtn')).toBeDisabled();
  await page.locator('#batchType').selectOption('SBS');
  await page.locator('#batchCondition').selectOption('Excellent');
  await page.locator('#batchStage').selectOption('Awaiting pickup');
  await expect(page.locator('#batchApplyBtn')).toBeDisabled();
  await page.locator('#batchReviewBtn').click();
  await expect(page.locator('#batchPreview')).toContainText('2 records will change');
  await expect(page.locator('#batchPreview')).toContainText('Alpha Arms Carbine');
  await expect(page.locator('#batchPreview')).not.toContainText('Beta Arms');
  expect(await page.evaluate(() => db.firearms)).toEqual(records);
  await page.locator('#batchApplyBtn').click();
  await expect(page.locator('#batchEditModal')).not.toHaveClass(/\bopen\b/);
  const result = await page.evaluate(() => ({ firearms: structuredClone(db.firearms), count: bulkSelected.size, calls: window.__collectionSaveCalls }));
  for (const original of records.slice(0, 2)) expect(result.firearms.find(record => record.id === original.id)).toEqual({ ...original, type: 'SBS', nfaType: 'SBS', isNFA: true, condition: 'Excellent', acquisitionStage: 'Awaiting pickup' });
  expect(result.firearms.slice(2)).toEqual(records.slice(2));
  expect(result.count).toBe(0);
  expect(result.calls).toBe(1);
});

test('changing a batch choice invalidates its old preview until reviewed again', async ({ page }) => {
  await selectForBatch(page);
  await page.locator('#batchCondition').selectOption('Excellent');
  await page.locator('#batchReviewBtn').click();
  await expect(page.locator('#batchApplyBtn')).toBeEnabled();
  await page.locator('#batchCondition').selectOption('Fair');
  await expect(page.locator('#batchApplyBtn')).toBeDisabled();
  await expect(page.locator('#batchPreview')).toHaveText('');
  expect(await page.evaluate(() => db.firearms)).toEqual(records);
});

test('a stale batch preview rejects the whole action before any record or audit is changed', async ({ page }) => {
  await selectForBatch(page);
  await page.locator('#batchCondition').selectOption('Excellent');
  await page.locator('#batchReviewBtn').click();
  await page.evaluate(() => { db.firearms.find(record => record.id === 'alpha-pistol').notes = 'Newer cloud note'; });
  const before = await page.evaluate(() => structuredClone(db));
  await page.locator('#batchApplyBtn').click();
  await expect(page.locator('#batchApplyBtn')).toBeDisabled();
  await expect(page.locator('#batchEditModal')).toHaveClass(/\bopen\b/);
  expect(await page.evaluate(() => db)).toEqual(before);
  expect(await page.evaluate(() => window.__collectionSaveCalls)).toBe(0);
  await expect(page.locator('#toastHost')).toContainText('changed while you were reviewing');
});

test('a failed durable batch save rolls back all selected changes while preserving concurrent unrelated updates', async ({ page }) => {
  await selectForBatch(page);
  await page.locator('#batchCondition').selectOption('Excellent');
  await page.locator('#batchStage').selectOption('At gunsmith');
  await page.locator('#batchReviewBtn').click();
  await page.evaluate(() => {
    window.saveData = async () => {
      window.__collectionSaveCalls++;
      db.firearms.find(record => record.id === 'alpha-carbine').notes = 'Concurrent cloud note';
      db.firearms.find(record => record.id === 'beta-shotgun').model = 'Concurrent unrelated model';
      db.settings.unrelatedSetting = 'Keep this';
      db.auditTrail.push({ id: 'concurrent-audit', action: 'edit', details: 'Concurrent external update' });
      return false;
    };
  });
  await page.locator('#batchApplyBtn').click();
  await expect(page.locator('#batchApplyBtn')).toBeDisabled();
  await expect(page.locator('#batchEditModal')).toHaveClass(/\bopen\b/);
  const result = await page.evaluate(async () => ({ db: structuredClone(db), durableRollback: await stateGet('db'), calls: window.__collectionSaveCalls }));
  expect(result.db.firearms[0]).toEqual({ ...records[0], notes: 'Concurrent cloud note' });
  expect(result.db.firearms[1]).toEqual(records[1]);
  expect(result.db.firearms[2]).toEqual({ ...records[2], model: 'Concurrent unrelated model' });
  expect(result.db.settings.unrelatedSetting).toBe('Keep this');
  expect(result.db.auditTrail).toEqual([{ id: 'concurrent-audit', action: 'edit', details: 'Concurrent external update' }]);
  expect(result.durableRollback.firearms).toEqual(result.db.firearms);
  expect(result.durableRollback.settings).toEqual(result.db.settings);
  expect(result.durableRollback.auditTrail).toEqual(result.db.auditTrail);
  expect(result.calls).toBe(1);
  await expect(page.locator('#toastHost')).toContainText('could not be saved');
});

test('saved view defaults belong to their account and a second account without views receives no previous account filter', async ({ page }) => {
  await openFilters(page);
  await page.locator('#filterMake').fill('Alpha');
  const viewA = await createView(page, 'Account A view');
  await setDefaultView(page);
  await expect.poll(() => page.evaluate(() => db.settings.defaultCollectionView)).toBe(viewA);
  await initialize(page, { owner: ownerB });
  await expect(page.locator('#savedCollectionView option')).toHaveCount(1);
  expect(await page.evaluate(() => db.settings.savedCollectionViews)).toBeUndefined();
  await expect(page.locator('#filterMake')).toHaveValue('');
  await cards(page, ['alpha-carbine', 'alpha-pistol', 'beta-shotgun']);
  await openFilters(page);
  await page.locator('#filterMake').fill('Beta');
  const viewB = await createView(page, 'Account B view');
  await setDefaultView(page);
  await initialize(page, { owner: ownerA, restore: true });
  await expect(page.locator('#savedCollectionView')).toHaveValue(viewA);
  await expect(page.locator('#filterMake')).toHaveValue('Alpha');
  await expect(page.locator('#savedCollectionView option[value="' + viewB + '"]')).toHaveCount(0);
  const accounts = await page.evaluate(({ storagePrefix, ownerA, ownerB }) => ({
    a: JSON.parse(sessionStorage.getItem(storagePrefix + ownerA)).settings,
    b: JSON.parse(sessionStorage.getItem(storagePrefix + ownerB)).settings
  }), { storagePrefix, ownerA, ownerB });
  expect(accounts.a.savedCollectionViews.map(view => view.name)).toEqual(['Account A view']);
  expect(accounts.b.savedCollectionViews.map(view => view.name)).toEqual(['Account B view']);
});

test('replacement reports use an explicit basis, preserve zero and unknown values, and count linked suppressors once', async ({ page }) => {
  const result = await page.evaluate(() => {
    const host = db.firearms.find(record => record.id === 'alpha-carbine');
    const secondHost = db.firearms.find(record => record.id === 'beta-shotgun');
    const suppressor = { id: 'shared-suppressor', make: 'Example', model: 'One serialized suppressor', serial: 'CAN-ONE',
      type: 'Silencer', status: 'Active', price: '700', replacementValue: '900', images: [], tags: [],
      hostFirearmIds: [host.id, secondHost.id], currentHostId: host.id };
    db.firearms.push(suppressor);
    const base = { mode: 'redacted', scope: 'selected', ids: [host.id, secondHost.id], includeValues: true, includeAccessories: true };
    const purchase = ReportPackages.buildSnapshot(undefined, { ...base, valueBasis: 'purchase' }, db);
    const replacement = ReportPackages.buildSnapshot(undefined, { ...base, valueBasis: 'replacement' }, db);
    const allReplacement = ReportPackages.buildSnapshot(db.firearms.filter(record => record.status === 'Active'), { ...base, valueBasis: 'replacement' }, db);
    const activeIds = ReportPackages.recordsForOptions({ scope: 'active' }, db).map(record => record.id).sort();
    return { purchase, replacement, allReplacement, activeIds };
  });
  expect(result.purchase.valueBasis).toBe('purchase');
  expect(result.purchase.totals).toMatchObject({ firearms: 3, documentedValue: 1700, missingValues: 0 });
  expect(result.replacement.valueBasis).toBe('replacement');
  expect(result.replacement.totals).toMatchObject({ firearms: 3, documentedValue: 2200, missingValues: 0 });
  expect(result.replacement.items.filter(item => item.model === 'One serialized suppressor')).toHaveLength(1);
  expect(result.replacement.items.find(item => item.model === 'Shotgun').documentedValue).toBe(0);
  expect(result.allReplacement.totals).toMatchObject({ firearms: 4, documentedValue: 2200, missingValues: 1 });
  expect(result.allReplacement.items.find(item => item.model === 'Pistol').documentedValue).toBeNull();
  expect(result.activeIds).toEqual(['alpha-carbine', 'beta-shotgun', 'shared-suppressor']);
  await page.evaluate(() => openReportPackageModal());
  await page.locator('#reportPackageValueBasis').selectOption('replacement');
  expect(await page.evaluate(() => ReportPackages.optionsFromDOM().valueBasis)).toBe('replacement');
});
