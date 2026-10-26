import { test, expect } from '@playwright/test';

test.use({ serviceWorkers: 'block' });

async function openEquipmentApp(page) {
  await page.goto('/index.html');
  await expect.poll(() => page.evaluate(() => typeof window.mergeRecordEdit)).toBe('function');
  if (!await page.evaluate(() => !!window.VaultCollection)) await page.addScriptTag({ url: '/js/collection-model.js' });
  if (!await page.evaluate(() => !!window.VaultEquipment)) await page.addScriptTag({ url: '/js/equipment-links.js' });
  await page.evaluate(() => {
    document.getElementById('authOverlay').style.display = 'none';
    document.getElementById('firstRunPanel').style.display = 'none';
    document.getElementById('appRoot').style.display = '';
    window.render = () => {};
    window.openDetail = id => { window.__openedEquipmentDetail = id; };
    window.saveData = async () => true;
    window.statePut = async () => true;
    db = {
      version: 3, encrypted: false, backups: [], settings: {}, auditTrail: [], valueHistory: [],
      firearms: [
        { id: 'host-a', make: 'Example Arms', model: 'Carbine', type: 'Rifle', status: 'Active', price: '1000' },
        { id: 'host-b', make: 'Example Arms', model: 'Pistol', type: 'Pistol', status: 'Active', acquisitionStage: 'At gunsmith', price: '500' },
        { id: 'ordered', make: 'Incoming', type: 'SBR', acquisitionStage: 'Ordered', price: '1500' },
        { id: 'sold', make: 'Sold firearm', type: 'Rifle', status: 'Sold' },
        { id: 'can', make: 'Example', model: 'Shared suppressor', type: 'Silencer', price: '700', serial: 'CAN-001', receipt: 'receipt.pdf', images: ['original-photo'] }
      ],
      accessories: [{ id: 'optic', name: 'Shared optic', category: 'Optic', price: '100', firearmId: 'host-a', notes: 'Keep these notes', receipt: 'optic-receipt', images: ['optic-photo'] }],
      ammo: [], wishlist: [], dealers: []
    };
    VaultEquipment.init();
  });
}

test.beforeEach(async ({ page }) => { await openEquipmentApp(page); });

test('legacy assignments and shared suppressor associations have only one current build cost', async ({ page }) => {
  const result = await page.evaluate(() => {
    const suppressor = db.firearms.find(item => item.id === 'can');
    suppressor.hostFirearmIds = ['host-a', 'host-b', 'host-a', '', null];
    suppressor.currentHostId = 'host-a';
    return {
      legacyHosts: VaultEquipment.hostIds(db.accessories[0]),
      legacyCurrent: VaultEquipment.currentHostId(db.accessories[0]),
      suppressorHosts: VaultEquipment.hostIds(suppressor),
      hostACost: VaultEquipment.buildCost(db, 'host-a'),
      hostBCost: VaultEquipment.buildCost(db, 'host-b'),
      sourceCount: db.firearms.filter(item => item.id === 'can').length,
      onA: VaultEquipment.equipmentForHost(db, 'host-a').map(entry => ({ id: entry.record.id, current: entry.current })),
      onB: VaultEquipment.equipmentForHost(db, 'host-b').map(entry => ({ id: entry.record.id, current: entry.current })),
      associatedHTML: VaultEquipment.buildHTML(db.firearms[1]),
      sourceHTML: VaultEquipment.buildHTML(suppressor)
    };
  });
  expect(result.legacyHosts).toEqual(['host-a']);
  expect(result.legacyCurrent).toBe('host-a');
  expect(result.suppressorHosts).toEqual(['host-a', 'host-b']);
  expect(result.hostACost).toBe(1800);
  expect(result.hostBCost).toBe(500);
  expect(result.sourceCount).toBe(1);
  expect(result.onA).toEqual([{ id: 'can', current: true }, { id: 'optic', current: true }]);
  expect(result.onB).toEqual([{ id: 'can', current: false }]);
  expect(result.associatedHTML).toContain('Also associated (1)');
  expect(result.associatedHTML).toContain('Currently on Example Arms Carbine');
  expect(result.sourceHTML).toContain('Current host');
  expect(result.sourceHTML).toContain('Associated host');
});

test('link existing suppressor to several hosts and move current assignment without copying its source', async ({ page }) => {
  await page.evaluate(() => VaultEquipment.open('host-a', 'firearms', 'can'));
  await expect(page.locator('#equipmentLinksModal')).toBeVisible();
  await expect(page.locator('#equipmentHostList input[value="host-a"]')).toBeChecked();
  await expect(page.locator('#equipmentHostList input[value="can"]')).toHaveCount(0);
  await expect(page.locator('#equipmentHostList input[value="ordered"]')).toHaveCount(0);
  await expect(page.locator('#equipmentHostList input[value="sold"]')).toHaveCount(0);
  await page.locator('#equipmentHostList input[value="host-b"]').check();
  await page.locator('#equipmentCurrentHost').selectOption('host-b');
  await page.evaluate(() => { db.firearms.find(item => item.id === 'can').notes = 'Background edit preserved'; });
  await page.getByRole('button', { name: 'Save links', exact: true }).click();
  await expect(page.locator('#equipmentLinksModal')).toBeHidden();
  const result = await page.evaluate(() => ({
    source: db.firearms.find(item => item.id === 'can'),
    firearms: db.firearms.length, accessories: db.accessories.length,
    a: VaultEquipment.buildCost(db, 'host-a'), b: VaultEquipment.buildCost(db, 'host-b'),
    audit: db.auditTrail[0], opened: window.__openedEquipmentDetail
  }));
  expect(result.source).toMatchObject({
    hostFirearmIds: ['host-a', 'host-b'], currentHostId: 'host-b', serial: 'CAN-001', receipt: 'receipt.pdf', images: ['original-photo'], notes: 'Background edit preserved'
  });
  expect(result.firearms).toBe(5);
  expect(result.accessories).toBe(1);
  expect(result.a).toBe(1100);
  expect(result.b).toBe(1200);
  expect(result.audit.details).toBe('Equipment links');
  expect(result.opened).toBe('host-a');
});

test('saving a legacy accessory migrates links lazily and unlinking preserves its other hosts and attachments', async ({ page }) => {
  await page.evaluate(() => VaultEquipment.open('host-b', 'accessories', 'optic'));
  await page.locator('#equipmentCurrentHost').selectOption('host-b');
  await page.getByRole('button', { name: 'Save links', exact: true }).click();
  let source = await page.evaluate(() => db.accessories[0]);
  expect(source).toMatchObject({ hostFirearmIds: ['host-a', 'host-b'], currentHostId: 'host-b', firearmId: 'host-b', receipt: 'optic-receipt', images: ['optic-photo'] });
  await page.evaluate(() => VaultEquipment.open('host-b', 'accessories', 'optic'));
  await page.getByRole('button', { name: 'Unlink from this firearm', exact: true }).click();
  await expect(page.locator('#equipmentLinksModal')).toBeHidden();
  source = await page.evaluate(() => db.accessories[0]);
  expect(source).toMatchObject({ hostFirearmIds: ['host-a'], currentHostId: null, firearmId: '', notes: 'Keep these notes', receipt: 'optic-receipt', images: ['optic-photo'] });
  expect(await page.evaluate(() => VaultEquipment.currentHostId(db.accessories[0]))).toBeNull();
  expect(await page.evaluate(() => VaultEquipment.buildCost(db, 'host-a'))).toBe(1000);
});

test('an open links form rejects concurrent assignment changes without overwriting them', async ({ page }) => {
  await page.evaluate(() => VaultEquipment.open('host-a', 'firearms', 'can'));
  await page.locator('#equipmentCurrentHost').selectOption('host-a');
  await page.evaluate(() => {
    const source = db.firearms.find(item => item.id === 'can');
    source.hostFirearmIds = ['host-b'];
    source.currentHostId = 'host-b';
    source.notes = 'Concurrent assignment preserved';
  });
  await page.getByRole('button', { name: 'Save links', exact: true }).click();
  await expect(page.locator('#equipmentLinksError')).toContainText('changed while this form was open');
  await expect(page.locator('#equipmentLinksModal')).toBeVisible();
  expect(await page.evaluate(() => db.firearms.find(item => item.id === 'can'))).toMatchObject({
    hostFirearmIds: ['host-b'], currentHostId: 'host-b', notes: 'Concurrent assignment preserved'
  });
  expect(await page.evaluate(() => db.auditTrail.length)).toBe(0);
  await page.evaluate(() => VaultEquipment.open('host-a', 'firearms', 'can'));
  await expect(page.locator('#equipmentCurrentHost')).toHaveValue('host-b');
  await page.getByRole('button', { name: 'Save links', exact: true }).click();
  await expect(page.locator('#equipmentLinksModal')).toBeHidden();
  expect(await page.evaluate(() => db.firearms.find(item => item.id === 'can'))).toMatchObject({
    hostFirearmIds: ['host-a', 'host-b'], currentHostId: 'host-b', notes: 'Concurrent assignment preserved'
  });
});

test('forged missing, disposed, self, or unavailable host links are rejected before mutation', async ({ page }) => {
  for (const invalid of ['missing', 'sold', 'can', 'ordered']) {
    await page.evaluate(invalidId => {
      VaultEquipment.open('host-a', 'firearms', 'can');
      const input = document.createElement('input');
      input.type = 'checkbox'; input.value = invalidId; input.checked = true;
      document.getElementById('equipmentHostList').appendChild(input);
    }, invalid);
    await page.getByRole('button', { name: 'Save links', exact: true }).click();
    await expect(page.locator('#equipmentLinksError')).toContainText('no longer available');
    expect(await page.evaluate(() => db.firearms.find(item => item.id === 'can').hostFirearmIds)).toBeUndefined();
  }
  await page.evaluate(() => {
    VaultEquipment.open('host-a', 'firearms', 'can');
    const option = new Option('Unselected host', 'host-b');
    document.getElementById('equipmentCurrentHost').appendChild(option);
    document.getElementById('equipmentCurrentHost').value = 'host-b';
  });
  await page.getByRole('button', { name: 'Save links', exact: true }).click();
  await expect(page.locator('#equipmentLinksError')).toContainText('must also be selected');
  expect(await page.evaluate(() => db.auditTrail.length)).toBe(0);
});

test('failed durable save retains the form and previous links while preserving unrelated background edits', async ({ page }) => {
  await page.evaluate(() => {
    VaultEquipment.open('host-b', 'accessories', 'optic');
    window.saveData = async () => { db.accessories[0].notes = 'Background note'; return false; };
  });
  await page.locator('#equipmentCurrentHost').selectOption('host-b');
  await page.getByRole('button', { name: 'Save links', exact: true }).click();
  await expect(page.locator('#equipmentLinksModal')).toBeVisible();
  await expect(page.locator('#equipmentLinksError')).toContainText('not saved');
  await expect(page.locator('#saveEquipmentLinksBtn')).toBeEnabled();
  await expect(page.locator('#equipmentCurrentHost')).toHaveValue('host-b');
  const result = await page.evaluate(() => ({ source: db.accessories[0], audits: db.auditTrail.length }));
  expect(result.source.firearmId).toBe('host-a');
  expect(result.source.hostFirearmIds).toBeUndefined();
  expect(result.source.currentHostId).toBeUndefined();
  expect(result.source.notes).toBe('Background note');
  expect(result.audits).toBe(0);
});

test('pending saves disable link actions and cannot be dismissed before completion', async ({ page }) => {
  await page.evaluate(() => {
    VaultEquipment.open('host-a', 'firearms', 'can');
    window.saveData = () => new Promise(resolve => { window.__finishEquipmentSave = resolve; });
  });
  await page.locator('#equipmentCurrentHost').selectOption('host-a');
  await page.getByRole('button', { name: 'Save links', exact: true }).click();
  await expect(page.locator('#equipmentSource')).toBeDisabled();
  await expect(page.locator('#equipmentUnlinkBtn')).toBeDisabled();
  expect(await page.evaluate(() => VaultEquipment.close())).toBe(false);
  await expect(page.locator('#equipmentLinksModal')).toBeVisible();
  await page.evaluate(() => window.__finishEquipmentSave(true));
  await expect(page.locator('#equipmentLinksModal')).toBeHidden();
});
