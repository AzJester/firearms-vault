import { test, expect } from '@playwright/test';

test.use({ serviceWorkers: 'block' });

const uid = 'de7a1100-1111-4111-8111-111111111111';
const storageKey = 'item-details-local-test-database';
const pixel = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const pdf = 'data:application/pdf;base64,JVBERi0xLjQKJSBjb3B5IHRlc3QK';
const source = {
  id: 'original-sbr', make: 'Example Arms', model: 'Original SBR', serial: 'ONLY-ORIGINAL',
  type: 'SBR', caliber: '5.56', barrel: '10.5', condition: 'Good', status: 'Sold',
  price: '900', dateAcquired: '2024-01-01', isNFA: true, nfaType: 'SBR',
  formType: 'Form 4', stampStatus: 'Approved', regType: 'Trust',
  dateSubmitted: '2023-01-01', dateApproved: '2023-03-01', stampPdf: pdf, stampPdfName: 'original-stamp.pdf',
  receipt: pdf, receiptName: 'original-receipt.pdf',
  documents: [{ id: 'original-document', name: 'appraisal.pdf', type: 'application/pdf', data: pdf }],
  images: ['original-photo'], tags: ['Original tag'], notes: '<b>Original notes</b>',
  dispDate: '2025-01-01', dispBuyer: 'Original buyer', dispPrice: '950', dispFFL: 'Example FFL', dispNotes: 'Original sale',
  roundCount: 1200, warrantyExp: '2029-01-01', customFields: [{ name: 'Personal history', value: 'Original' }],
  maintenanceLog: [{ id: 'original-maintenance', date: '2024-01-01', type: 'Cleaning' }],
  acquisitionStage: 'At gunsmith', orderDate: '2023-12-01', expectedArrival: '2023-12-20', orderReference: 'OLD-123',
  trackingUrl: 'https://example.com/original', serviceNotes: 'Original work',
  replacementValue: '1500', valuationDate: '2025-01-01', valuationSource: 'Original appraisal',
  hostFirearmIds: ['other-host'], rangeSessions: [{ id: 'original-session', rounds: 1200 }]
};

async function initialize(page, restore = false) {
  await expect.poll(() => page.evaluate(() => typeof window.VaultItemDetails)).toBe('object');
  await page.evaluate(async ({ uid, source, pixel, storageKey, restore }) => {
    await openImageDB();
    await openStateDB();
    await CloudSync.activateUser(uid);
    document.getElementById('authOverlay').style.display = 'none';
    document.getElementById('firstRunPanel').style.display = 'none';
    document.getElementById('appRoot').style.display = '';
    const stored = restore && sessionStorage.getItem(storageKey);
    db = stored ? JSON.parse(stored) : {
      version: 3, encrypted: false, firearms: [source], ammo: [], accessories: [], wishlist: [], dealers: [],
      backups: [], settings: {}, auditTrail: [], valueHistory: []
    };
    imagesDb = { 'original-photo': pixel };
    await idbPut('original-photo', pixel);
    window.__itemSaveCalls = 0;
    window.saveData = async () => {
      window.__itemSaveCalls++;
      sessionStorage.setItem(storageKey, JSON.stringify(db));
      return true;
    };
    currentTab = 'all';
    currentView = 'cards';
    render();
  }, { uid, source, pixel, storageKey, restore });
}

async function openDuplicate(page, options = []) {
  await page.evaluate(() => duplicateFirearm('original-sbr'));
  await expect(page.locator('#duplicateOptionsModal')).toHaveClass(/\bopen\b/);
  for (const option of options) await page.locator('#duplicate' + option).check();
  await page.locator('#duplicateOptionsModal [data-copy-action="create"]').click();
  await expect(page.locator('#duplicateOptionsModal')).not.toHaveClass(/\bopen\b/);
  await expect(page.locator('#formModal')).toHaveClass(/\bopen\b/);
}

test.beforeEach(async ({ page }) => {
  // This suite only exercises local test data, with every remote request blocked.
  await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1'
    ? route.continue() : route.abort());
  await page.goto('/index.html');
  await initialize(page);
});

test('duplicate is unsaved, clears item history and attachments, and leaves its source unchanged', async ({ page }) => {
  await page.evaluate(() => duplicateFirearm('original-sbr'));
  for (const id of ['Photos', 'Notes', 'Documents', 'Approvals']) await expect(page.locator('#duplicate' + id)).not.toBeChecked();
  await page.locator('#duplicateOptionsModal [data-copy-action="create"]').click();
  await expect(page.locator('#formModal')).toHaveClass(/\bopen\b/);
  await expect(page.locator('#modalTitle')).toHaveText('Duplicate Firearm');
  expect(await page.evaluate(() => ({ editingId, saves: window.__itemSaveCalls, count: db.firearms.length }))).toEqual({ editingId: null, saves: 0, count: 1 });
  for (const id of ['fSerial', 'fDateAcquired', 'fPrice', 'fDateSubmitted', 'fDateApproved', 'fStampStatus', 'fFormType', 'fRegType', 'fOrderDate', 'fExpectedArrival', 'fOrderReference', 'fTrackingUrl', 'fServiceNotes', 'fReplacementValue', 'fValuationDate', 'fValuationSource', 'fWarrantyExp']) await expect(page.locator('#' + id)).toHaveValue('');
  await expect(page.locator('#fStatus')).toHaveValue('Active');
  await expect(page.locator('#fAcquisitionStage')).toHaveValue('In possession');
  expect(await page.evaluate(() => ({ tempImages, tempDocs, tempTags, tempStampPdf, receipt: tempReceipts.f }))).toEqual({ tempImages: [], tempDocs: [], tempTags: [], tempStampPdf: null, receipt: null });
  await page.locator('#fSerial').fill('NEW-SERIAL');
  await page.locator('#saveBtn').click();
  await expect(page.locator('#formModal')).not.toHaveClass(/\bopen\b/);
  const saved = await page.evaluate(() => structuredClone(db.firearms));
  expect(saved).toHaveLength(2);
  expect(saved.find(record => record.id === source.id)).toEqual(source);
  expect(saved.find(record => record.id !== source.id)).toMatchObject({
    serial: 'NEW-SERIAL', price: '', dateAcquired: '', status: 'Active', roundCount: 0,
    maintenanceLog: [], stampPdf: null, receipt: null, documents: [], images: [], tags: [],
    replacementValue: '', valuationDate: '', acquisitionStage: 'In possession'
  });
});

test('canceling duplicate options does not add or save a record', async ({ page }) => {
  await page.evaluate(() => duplicateFirearm('original-sbr'));
  await page.locator('#duplicateOptionsModal [data-copy-action="cancel"]').first().click();
  await expect(page.locator('#duplicateOptionsModal')).not.toHaveClass(/\bopen\b/);
  expect(await page.evaluate(() => ({ count: db.firearms.length, saves: window.__itemSaveCalls }))).toEqual({ count: 1, saves: 0 });
});

for (const [option, copied] of [
  ['Photos', { images: source.images }],
  ['Notes', { notes: source.notes, tags: source.tags }],
  ['Documents', { documents: source.documents, receipt: source.receipt, receiptName: source.receiptName }],
  ['Approvals', { formType: source.formType, stampStatus: source.stampStatus, regType: source.regType, dateSubmitted: source.dateSubmitted, dateApproved: source.dateApproved, stampPdf: source.stampPdf }]
]) {
  test(`duplicate ${option.toLowerCase()} copy is explicit and independent of other copy options`, async ({ page }) => {
    await openDuplicate(page, [option]);
    const pending = await page.evaluate(() => collectFirearmFormRecord('test-copy'));
    expect(pending).toMatchObject(copied);
    if (option !== 'Photos') expect(pending.images).toEqual([]);
    if (option !== 'Notes') { expect(pending.notes).toBe(''); expect(pending.tags).toEqual([]); }
    if (option !== 'Documents') { expect(pending.documents).toEqual([]); expect(pending.receipt).toBeNull(); }
    if (option !== 'Approvals') { expect(pending.stampPdf).toBeNull(); expect(pending.stampStatus).toBe(''); }
    expect(await page.evaluate(() => db.firearms[0])).toEqual(source);
    expect(await page.evaluate(() => window.__itemSaveCalls)).toBe(0);
  });
}

test('duplicate protects a previous Add draft and restores it after the copy is saved', async ({ page }) => {
  const oldKey = await page.evaluate(async () => {
    await openAddModal();
    document.getElementById('fMake').value = 'Unfinished manufacturer';
    document.getElementById('fModel').value = 'Unfinished purchase';
    document.getElementById('fOrderReference').value = 'KEEP-DRAFT-ORDER';
    document.getElementById('formModal').dataset.dirty = 'true';
    await flushFirearmDraft();
    const key = document.getElementById('formModal').dataset.firearmDraftKey;
    closeModal();
    return key;
  });
  await openDuplicate(page);
  expect(await page.evaluate(() => document.getElementById('formModal').dataset.firearmDraftKey)).not.toBe(oldKey);
  expect(await page.evaluate(async key => (await CloudSync.storeGet('meta', key)).value.values.fModel, oldKey)).toBe('Unfinished purchase');
  await page.locator('#fSerial').fill('COPY-ONLY');
  await page.locator('#saveBtn').click();
  await expect(page.locator('#formModal')).not.toHaveClass(/\bopen\b/);
  await page.evaluate(() => openAddModal());
  await expect(page.locator('#fModel')).toHaveValue('Unfinished purchase');
  await expect(page.locator('#fOrderReference')).toHaveValue('KEEP-DRAFT-ORDER');
  expect(await page.evaluate(() => db.firearms.some(record => record.model === 'Unfinished purchase'))).toBe(false);
});

test('duplicating while an Add form is open flushes and preserves its latest unsaved fields', async ({ page }) => {
  await page.evaluate(() => openAddModal());
  await page.locator('#fMake').fill('Still editing');
  await page.locator('#fModel').fill('Latest unsaved draft');
  const oldKey = await page.evaluate(() => document.getElementById('formModal').dataset.firearmDraftKey);
  await openDuplicate(page);
  await expect(page.locator('#fMake')).toHaveValue(source.make);
  await expect(page.locator('#fModel')).toHaveValue(source.model);
  const preserved = await page.evaluate(async key => {
    const snapshot = await CloudSync.storeGet('meta', key);
    return snapshot && snapshot.value.values;
  }, oldKey);
  expect(preserved).toMatchObject({ fMake: 'Still editing', fModel: 'Latest unsaved draft' });
  expect(await page.evaluate(() => ({ saves: window.__itemSaveCalls, count: db.firearms.length }))).toEqual({ saves: 0, count: 1 });
});

test('order metadata and replacement valuation save and reopen separately from purchase cost and disposition', async ({ page }) => {
  await page.evaluate(() => openEditModal('original-sbr'));
  await page.locator('#fAcquisitionStage').selectOption('Ordered');
  await page.locator('#fOrderDate').fill('2026-10-20');
  await page.locator('#fExpectedArrival').fill('2026-11-02');
  await page.locator('#fOrderReference').fill('NEW-ORDER-99');
  await page.locator('#fTrackingUrl').fill('https://example.com/tracking?id=99');
  await page.locator('#fServiceNotes').fill('Contact dealer before pickup.');
  await page.locator('#fReplacementValue').fill('1775.50');
  await page.locator('#fValuationDate').fill('2026-10-26');
  await page.locator('#fValuationSource').fill('Independent appraisal');
  await page.locator('#saveBtn').click();
  await expect(page.locator('#formModal')).not.toHaveClass(/\bopen\b/);
  const expected = { ...source,
    acquisitionStage: 'Ordered', orderDate: '2026-10-20', expectedArrival: '2026-11-02',
    orderReference: 'NEW-ORDER-99', trackingUrl: 'https://example.com/tracking?id=99',
    serviceNotes: 'Contact dealer before pickup.', replacementValue: '1775.50',
    valuationDate: '2026-10-26', valuationSource: 'Independent appraisal'
  };
  expect(await page.evaluate(() => db.firearms[0])).toMatchObject(expected);
  await page.reload();
  await initialize(page, true);
  await page.evaluate(() => openEditModal('original-sbr'));
  await expect(page.locator('#fAcquisitionStage')).toHaveValue('Ordered');
  await expect(page.locator('#fStatus')).toHaveValue('Sold');
  await expect(page.locator('#fPrice')).toHaveValue('900');
  await expect(page.locator('#fReplacementValue')).toHaveValue('1775.50');
  await expect(page.locator('#fValuationSource')).toHaveValue('Independent appraisal');
  await page.evaluate(() => { closeModal(); openDetail('original-sbr'); });
  await expect(page.locator('#detailView .item-purchase-details')).toContainText('Ordered');
  await expect(page.locator('#detailView .item-purchase-details')).toContainText('$900.00');
  await expect(page.locator('#detailView .item-valuation-details')).toContainText('$1,775.50');
  await expect(page.locator('#detailView .item-purchase-details a')).toHaveAttribute('rel', 'noopener noreferrer');
});

test('old records display an availability default without migrating or replacing existing approval records', async ({ page }) => {
  const before = await page.evaluate(() => {
    const record = db.firearms[0];
    for (const key of ['acquisitionStage', 'orderDate', 'expectedArrival', 'orderReference', 'trackingUrl', 'serviceNotes', 'replacementValue', 'valuationDate', 'valuationSource']) delete record[key];
    const before = structuredClone(record);
    openEditModal(record.id);
    return before;
  });
  await expect(page.locator('#fAcquisitionStage')).toHaveValue('In possession');
  await expect(page.locator('#fReplacementValue')).toHaveValue('');
  expect(await page.evaluate(() => db.firearms[0])).toEqual(before);
  expect(await page.evaluate(() => window.__itemSaveCalls)).toBe(0);
  await page.evaluate(() => { closeModal(); openDetail('original-sbr'); });
  await expect(page.locator('#detailView .item-purchase-details')).toContainText('In possession');
  await expect(page.locator('#detailView .item-valuation-details')).toContainText('Not recorded');
  expect(await page.evaluate(() => db.firearms[0])).toEqual(before);
});

test('negative valuations and unsafe tracking links are rejected before a database save', async ({ page }) => {
  await page.evaluate(() => openEditModal('original-sbr'));
  await page.locator('#fReplacementValue').fill('-1');
  await page.locator('#saveBtn').click();
  await expect(page.locator('#formModal')).toHaveClass(/\bopen\b/);
  expect(await page.evaluate(() => window.__itemSaveCalls)).toBe(0);
  await page.locator('#fReplacementValue').fill('0');
  await page.locator('#fTrackingUrl').fill('javascript:alert(1)');
  await page.locator('#saveBtn').click();
  expect(await page.evaluate(() => window.__itemSaveCalls)).toBe(0);
  expect(await page.evaluate(() => db.firearms[0])).toEqual(source);
  const unsafeDetail = await page.evaluate(() => VaultItemDetails.detailHTML({ trackingUrl: 'javascript:alert(1)', serviceNotes: '<img src=x onerror=alert(1)>', valuationSource: '<script>alert(1)</script>' }));
  expect(unsafeDetail).not.toContain('href=');
  expect(unsafeDetail).not.toContain('<script>');
  expect(unsafeDetail).not.toContain('<img');
  await page.locator('#fTrackingUrl').fill('https://example.com/safe');
  await page.locator('#saveBtn').click();
  await expect(page.locator('#formModal')).not.toHaveClass(/\bopen\b/);
  expect(await page.evaluate(() => db.firearms[0].replacementValue)).toBe('0');
});
