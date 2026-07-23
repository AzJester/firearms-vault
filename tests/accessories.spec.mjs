import { test, expect } from '@playwright/test';

test.use({ serviceWorkers: 'block' });

async function openApp(page) {
  await page.goto('/index.html');
  await expect(page.locator('#authForm')).toBeVisible({ timeout: 15000 });
  await page.evaluate(() => {
    document.getElementById('authOverlay').style.display = 'none';
    document.getElementById('firstRunPanel').style.display = 'none';
    document.getElementById('appRoot').style.display = '';
  });
}

test('accessories can be sorted and grouped by item, manufacturer, or weapon system', async ({ page }) => {
  await openApp(page);
  await page.evaluate(() => {
    db.firearms = [
      { id: 'alpha-system', make: 'Alpha Arms', model: 'Carbine', status: 'Active', images: [] },
      { id: 'zulu-system', make: 'Zulu Works', model: 'Pistol', status: 'Active', images: [] }
    ];
    db.accessories = [
      { id: 'light', name: 'Weapon Light', brand: 'SureFire', model: 'X300', firearmId: 'zulu-system', price: '300', images: [] },
      { id: 'optic', name: 'Red Dot', brand: 'Aimpoint', model: 'T-2', firearmId: 'alpha-system', price: '850', images: [] },
      { id: 'sling', name: 'Sling', brand: 'Blue Force Gear', model: 'VCAS', firearmId: '', price: '65', images: [] }
    ];
    currentTab = 'accessories';
    render();
  });

  await expect(page.locator('#accessorySort')).toHaveValue('item');
  await expect(page.locator('#accessoryGroup')).toHaveValue('none');

  await page.locator('#accessorySort').selectOption('manufacturer');
  const sortedNames = await page.locator('.accessory-table tbody tr:not(.accessory-group-row) td:nth-child(2)').allTextContents();
  expect(sortedNames).toEqual(['Red Dot', 'Sling', 'Weapon Light']);

  await page.locator('#accessoryGroup').selectOption('weapon');
  const groupHeadings = await page.locator('.accessory-group-row th span:first-child').allTextContents();
  expect(groupHeadings).toEqual(['Alpha Arms Carbine', 'In storage / unassigned', 'Zulu Works Pistol']);

  await page.locator('#accessorySort').selectOption('weapon');
  await page.locator('#accessoryGroup').selectOption('manufacturer');
  await expect(page.locator('.accessory-group-row')).toHaveCount(3);
  await expect(page.locator('#accessorySort')).toHaveValue('weapon');
  await expect(page.locator('#accessoryGroup')).toHaveValue('manufacturer');
});

test('accessory photos are captured, previewed, and included in cloud media', async ({ page }) => {
  await openApp(page);
  const result = await page.evaluate(async () => {
    await openImageDB();
    db.firearms = [];
    db.accessories = [];
    openAccessoryModal();
    document.getElementById('accName').value = 'Test Optic';
    document.getElementById('accBrand').value = 'Example Optics';

    const encoded = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=';
    const bytes = Uint8Array.from(atob(encoded), char => char.charCodeAt(0));
    const file = new File([bytes], 'optic.png', { type: 'image/png' });
    const imageId = await queueAccessoryImage(file);
    const record = collectAccessoryFormRecord('accessory-photo-record');
    db.accessories = [record];

    const media = CloudSync.collectMedia();
    const keys = CloudSync.referencedMediaKeys(db);
    const description = CloudSync.describeMediaKey(imageId);
    return {
      imageId,
      imageCount: record.images.length,
      galleryCount: document.querySelectorAll('#accImgGallery img').length,
      referenced: keys.includes(imageId),
      mediaStored: typeof media[imageId] === 'string' && media[imageId].startsWith('data:image/'),
      recordKind: description.recordKind,
      recordName: description.recordName
    };
  });

  expect(result.imageId).toBeTruthy();
  expect(result.imageCount).toBe(1);
  expect(result.galleryCount).toBe(1);
  expect(result.referenced).toBe(true);
  expect(result.mediaStored).toBe(true);
  expect(result.recordKind).toBe('accessory');
  expect(result.recordName).toBe('Test Optic');
});
