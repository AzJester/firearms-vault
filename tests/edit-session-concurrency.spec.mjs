import { test, expect } from '@playwright/test';

test.use({ serviceWorkers: 'block' });

async function openTestApp(page) {
  await page.goto('/index.html');
  await expect.poll(() => page.evaluate(() => typeof window.mergeRecordEdit)).toBe('function');
  await page.evaluate(() => {
    document.getElementById('authOverlay').style.display = 'none';
    document.getElementById('firstRunPanel').style.display = 'none';
    document.getElementById('appRoot').style.display = '';
    window.saveData = async () => true;
    window.render = () => {};
  });
}

test.beforeEach(async ({ page }) => {
  await openTestApp(page);
});

test('all edit forms preserve untouched background changes and apply only local fields', async ({ page }) => {
  const result = await page.evaluate(async () => {
    db = {
      version: 3, encrypted: false, backups: [], settings: {}, auditTrail: [], valueHistory: [],
      firearms: [{
        id: 'firearm-one', make: 'Original Arms', model: 'Model A', serial: 'SER-1', caliber: '5.56',
        type: 'Rifle', condition: 'New', status: 'Active', images: [], tags: [], documents: [],
        customFields: [], maintenanceLog: [], notes: ''
      }],
      ammo: [{ id: 'ammo-one', caliber: '5.56', brand: 'Original Ammo', quantity: '100', notes: '' }],
      accessories: [{ id: 'accessory-one', name: 'Original Optic', category: 'Optic', model: 'A1', condition: 'New', notes: '' }],
      wishlist: [{ id: 'wish-one', make: 'Original', model: 'Wish A', dealer: 'Dealer A', type: 'Rifle', priority: 'medium', notes: '', dateAdded: '2026-01-01' }],
      dealers: [{ id: 'dealer-one', name: 'Original Dealer', phone: '111', email: 'old@example.test', favorite: false, notes: '' }]
    };

    openEditModal('firearm-one');
    document.getElementById('fModel').value = 'Locally edited model';
    db.firearms[0].make = 'Remote Arms';
    db.firearms[0].maintenanceLog = [{ id: 'remote-maint', date: '2026-07-20', description: 'Remote entry' }];
    db.firearms[0].remoteOnly = 'preserved';
    await saveFirearm();

    editAmmo('ammo-one');
    document.getElementById('aBrand').value = 'Locally edited ammo';
    db.ammo[0].quantity = '250';
    db.ammo[0].remoteOnly = 'preserved';
    await saveAmmo();

    openAccessoryModal('accessory-one');
    document.getElementById('accModel').value = 'Locally edited optic';
    db.accessories[0].category = 'Light';
    db.accessories[0].remoteOnly = 'preserved';
    await saveAccessory();

    openWishlistModal('wish-one');
    document.getElementById('wModel').value = 'Locally edited wish';
    db.wishlist[0].dealer = 'Remote Dealer';
    db.wishlist[0].remoteOnly = 'preserved';
    await saveWishlistItem();

    openDealerModal('dealer-one');
    document.getElementById('dPhone').value = '222';
    db.dealers[0].email = 'remote@example.test';
    db.dealers[0].favorite = true;
    db.dealers[0].remoteOnly = 'preserved';
    await saveDealer();

    return {
      firearm: db.firearms[0], ammo: db.ammo[0], accessory: db.accessories[0],
      wishlist: db.wishlist[0], dealer: db.dealers[0]
    };
  });

  expect(result.firearm).toMatchObject({
    make: 'Remote Arms', model: 'Locally edited model', remoteOnly: 'preserved'
  });
  expect(result.firearm.maintenanceLog).toEqual([{ id: 'remote-maint', date: '2026-07-20', description: 'Remote entry' }]);
  expect(result.ammo).toMatchObject({ brand: 'Locally edited ammo', quantity: '250', remoteOnly: 'preserved' });
  expect(result.accessory).toMatchObject({ model: 'Locally edited optic', category: 'Light', remoteOnly: 'preserved' });
  expect(result.wishlist).toMatchObject({ model: 'Locally edited wish', dealer: 'Remote Dealer', remoteOnly: 'preserved' });
  expect(result.dealer).toMatchObject({ phone: '222', email: 'remote@example.test', favorite: true, remoteOnly: 'preserved' });
});

test('overlapping fields show an explicit choice and can keep the latest saved value', async ({ page }) => {
  await page.evaluate(() => {
    db.ammo = [{ id: 'ammo-conflict', caliber: '9mm', brand: 'Original', quantity: '100', notes: '' }];
    editAmmo('ammo-conflict');
    document.getElementById('aBrand').value = 'My edit';
    db.ammo[0].brand = 'Other device edit';
    db.ammo[0].quantity = '200';
    window.__editSave = saveAmmo();
  });

  const dialog = page.locator('.app-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Brand or type changed on another device');
  await expect(dialog).toContainText('Other device edit');
  await expect(dialog).toContainText('My edit');
  await dialog.getByRole('button', { name: 'Use latest saved value' }).click();
  await page.evaluate(() => window.__editSave);

  const record = await page.evaluate(() => db.ammo.find(item => item.id === 'ammo-conflict'));
  expect(record).toMatchObject({ brand: 'Other device edit', quantity: '200' });
});

test('overlapping fields can explicitly keep the form value without losing other remote fields', async ({ page }) => {
  await page.evaluate(() => {
    db.dealers = [{
      id: 'dealer-conflict', name: 'Example Dealer', phone: '111', email: 'before@example.test',
      address: '', website: '', notes: '', favorite: false
    }];
    openDealerModal('dealer-conflict');
    document.getElementById('dPhone').value = 'My phone';
    db.dealers[0].phone = 'Other phone';
    db.dealers[0].email = 'remote@example.test';
    db.dealers[0].favorite = true;
    window.__editSave = saveDealer();
  });

  const dialog = page.locator('.app-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Phone changed on another device');
  await dialog.getByRole('button', { name: 'Keep my change' }).click();
  await page.evaluate(() => window.__editSave);

  const record = await page.evaluate(() => db.dealers.find(item => item.id === 'dealer-conflict'));
  expect(record).toMatchObject({ phone: 'My phone', email: 'remote@example.test', favorite: true });
});

test('a remotely deleted record is not silently recreated', async ({ page }) => {
  await page.evaluate(() => {
    db.wishlist = [{
      id: 'wish-deleted', make: 'Example', model: 'Carbine', type: 'Rifle', priority: 'medium', notes: '', dateAdded: '2026-01-01'
    }];
    openWishlistModal('wish-deleted');
    document.getElementById('wModel').value = 'My edited model';
    db.wishlist = [];
    window.__editSave = saveWishlistItem();
  });

  const dialog = page.locator('.app-dialog');
  await expect(dialog).toContainText('deleted on another device');
  await dialog.getByRole('button', { name: 'Leave deleted' }).click();
  await page.evaluate(() => window.__editSave);

  expect(await page.evaluate(() => db.wishlist.length)).toBe(0);
  await expect(page.locator('#wishlistModal')).toHaveClass(/open/);
});

test('failed edit rollback preserves a cloud update received during conflict resolution', async ({ page }) => {
  await page.evaluate(() => {
    db = {
      version: 3, encrypted: false, backups: [], settings: {}, auditTrail: [], valueHistory: [],
      firearms: [],
      ammo: [{ id: 'rollback-ammo', caliber: '9mm', brand: 'Original', quantity: '100', notes: '' }],
      accessories: [], wishlist: [], dealers: []
    };
    editAmmo('rollback-ammo');
    document.getElementById('aBrand').value = 'My edit';
    db.ammo[0].brand = 'Other device edit';
    const originalSave = saveData;
    saveData = async () => false;
    window.__rollbackSave = saveAmmo().finally(() => { saveData = originalSave; });
  });

  const dialog = page.locator('.app-dialog');
  await expect(dialog).toContainText('Brand or type changed on another device');
  await page.evaluate(() => {
    db.accessories.push({
      id: 'cloud-accessory', name: 'Arrived while resolving conflict', category: 'Optic', condition: 'New'
    });
  });
  await dialog.getByRole('button', { name: 'Use latest saved value' }).click();
  await page.evaluate(() => window.__rollbackSave);

  const result = await page.evaluate(() => ({
    brand: db.ammo.find(item => item.id === 'rollback-ammo')?.brand,
    cloudAccessory: db.accessories.find(item => item.id === 'cloud-accessory'),
    modalOpen: document.getElementById('ammoModal').classList.contains('open'),
    modalDirty: document.getElementById('ammoModal').dataset.dirty
  }));
  expect(result.brand).toBe('Other device edit');
  expect(result.cloudAccessory).toMatchObject({ id: 'cloud-accessory', name: 'Arrived while resolving conflict' });
  expect(result.modalOpen).toBe(true);
  expect(result.modalDirty).toBe('true');
});
