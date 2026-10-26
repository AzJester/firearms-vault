import { test, expect } from '@playwright/test';

test.use({ serviceWorkers: 'block' });

test.beforeEach(async ({ page }) => {
  await page.goto('/index.html');
  await expect.poll(() => page.evaluate(() => typeof window.ReportPackages?.mediaDescriptors)).toBe('function');
  await page.evaluate(() => {
    const photo = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=';
    const receipt = 'data:application/pdf;base64,JVBERi0xLjcKJUVPRgo=';
    db.firearms = [
      { id: 'host-a', make: 'Host', model: 'A', type: 'Rifle', price: '1000', images: ['host-photo'] },
      { id: 'host-b', make: 'Host', model: 'B', type: 'Pistol', price: '500', images: [] },
      { id: 'can', make: 'Suppressor', model: 'One', type: 'Silencer', price: '700', hostFirearmIds: ['host-a', 'host-b'], currentHostId: 'host-a', images: ['can-photo'], receipt }
    ];
    db.accessories = [
      { id: 'optic', name: 'PRIVATE OPTIC NAME', category: 'Optic', price: '100', hostFirearmIds: ['host-a', 'host-b'], currentHostId: 'host-a', firearmId: 'host-a', images: ['optic-photo'], receipt },
      { id: 'elsewhere', name: 'Elsewhere', price: '200', hostFirearmIds: ['host-a', 'host-b'], currentHostId: 'host-b', firearmId: 'host-b', images: ['elsewhere-photo'], receipt }
    ];
    Object.assign(imagesDb, { 'host-photo': photo, 'can-photo': photo, 'optic-photo': photo, 'elsewhere-photo': photo });
  });
});

test('current equipment media matches expanded snapshot item keys and includes accessory source attachments once', async ({ page }) => {
  const result = await page.evaluate(() => {
    const records = [db.firearms[0]];
    const options = { mode: 'full', includeAccessories: true, includePhotos: true, includeReceipts: true };
    const snapshot = ReportPackages.buildSnapshot(records, options, db);
    const descriptors = ReportPackages.mediaDescriptors(records, options, db);
    return { snapshot, descriptors };
  });
  expect(result.snapshot.items).toHaveLength(2);
  expect(result.snapshot.totals.documentedValue).toBe(1800);
  expect(result.snapshot.accessories).toHaveLength(1);
  expect(result.descriptors.map(item => item.key)).toEqual([
    'host-photo', 'can-photo', 'receipt:firearm:can', 'optic-photo', 'receipt:accessory:optic'
  ]);
  const optic = result.descriptors.filter(item => item.recordId === 'optic');
  expect(optic).toHaveLength(2);
  expect(optic.every(item => item.recordKind === 'accessory' && item.itemKey === result.snapshot.accessories[0].itemKey)).toBe(true);
  expect(result.descriptors.find(item => item.recordId === 'can').itemKey).toBe(result.snapshot.items[1].itemKey);
  expect(optic.every(item => !item.basePath.includes('PRIVATE'))).toBe(true);
});

test('equipment media honors photo, receipt, accessory options and deduplicates shared keys', async ({ page }) => {
  const result = await page.evaluate(() => {
    const records = [db.firearms[0]];
    const redacted = ReportPackages.mediaDescriptors(records, { mode: 'redacted', includeAccessories: true, includePhotos: false, includeReceipts: false }, db);
    const noAccessories = ReportPackages.mediaDescriptors(records, { mode: 'full', includeAccessories: false, includePhotos: true, includeReceipts: true }, db);
    db.accessories[0].images.push('host-photo', 'optic-photo');
    db.accessories[0].receipt = '@media:receipt:accessory:optic';
    const all = ReportPackages.mediaDescriptors(records, { mode: 'full', includeAccessories: true, includePhotos: true, includeReceipts: true }, db);
    const receipts = ReportPackages.mediaDescriptors(records, { mode: 'full', includeAccessories: true, includePhotos: false, includeReceipts: true }, db);
    return { redacted, noAccessories, all, receipts };
  });
  expect(result.redacted).toEqual([]);
  expect(result.noAccessories.map(item => item.key)).toEqual(['host-photo']);
  expect(new Set(result.all.map(item => item.key)).size).toBe(result.all.length);
  expect(result.all.find(item => item.recordId === 'optic' && item.kind === 'receipt')).toMatchObject({ key: 'receipt:accessory:optic', fallbackData: null });
  expect(result.receipts.every(item => item.kind === 'receipt')).toBe(true);
  expect(result.receipts).toHaveLength(2);
});

test('full report ZIP packages current accessory photos and receipts with generic paths', async ({ page }) => {
  const result = await page.evaluate(async () => {
    window.ensureReferencedMediaReady = async ({ keys }) => { window.__equipmentReportKeys = keys; return { ok: true, missing: [] }; };
    const options = { mode: 'full', scope: 'selected', ids: ['host-a'], includeAccessories: true, includePhotos: true, includeReceipts: true, includeDocuments: false, includeTaxStamps: false };
    const records = ReportPackages.recordsForOptions(options, db);
    const built = await ReportPackages.buildZip(records, options, db);
    const zip = await JSZip.loadAsync(built.bytes);
    const inventory = JSON.parse(await zip.file('inventory.json').async('string'));
    const media = built.manifest.files.filter(file => /^media[_/]/.test(file.path));
    const opticPhoto = media.find(file => /accessory-001[_/]photo-01/.test(file.path));
    const opticReceipt = media.find(file => /accessory-001[_/]receipt/.test(file.path));
    return {
      total: inventory.totals.documentedValue,
      mediaCount: media.length,
      opticPhoto: opticPhoto && { path: opticPhoto.path, mime: opticPhoto.mime, bytes: (await zip.file(opticPhoto.path).async('uint8array')).length },
      opticReceipt: opticReceipt && { path: opticReceipt.path, mime: opticReceipt.mime, bytes: (await zip.file(opticReceipt.path).async('uint8array')).length },
      requestedKeys: window.__equipmentReportKeys,
      privatePath: media.some(file => file.path.includes('PRIVATE'))
    };
  });
  expect(result.total).toBe(1800);
  expect(result.mediaCount).toBe(5);
  expect(result.opticPhoto).toMatchObject({ mime: 'image/png' });
  expect(result.opticPhoto.bytes).toBeGreaterThan(0);
  expect(result.opticReceipt).toMatchObject({ mime: 'application/pdf' });
  expect(result.opticReceipt.bytes).toBeGreaterThan(0);
  expect(result.requestedKeys).toContain('receipt:accessory:optic');
  expect(result.requestedKeys).not.toContain('elsewhere-photo');
  expect(result.privatePath).toBe(false);
});
