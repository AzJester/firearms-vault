import { test, expect } from '@playwright/test';

test.use({ serviceWorkers: 'block' });

async function revealTestApp(page) {
  await page.goto('/index.html');
  await expect.poll(() => page.evaluate(() => typeof window.mergeRecordEdit)).toBe('function');
  await page.evaluate(() => {
    document.getElementById('authOverlay').style.display = 'none';
    document.getElementById('firstRunPanel').style.display = 'none';
    document.getElementById('appRoot').style.display = '';
    setPrivacyMode(false);
    window.saveData = async () => true;
    window.render = window.render || (() => {});
  });
}

test.beforeEach(async ({ page }) => {
  await revealTestApp(page);
});

test('NFA and privacy toggles remain keyboard operable on mobile', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 700 });
  await page.evaluate(() => document.getElementById('formModal').classList.add('open'));
  await expect(page.locator('#formModal .modal-close')).toBeFocused();

  const nfaToggle = page.getByRole('checkbox', { name: 'This is an NFA Item' });
  await nfaToggle.focus();
  await expect(nfaToggle).toBeFocused();
  await expect(page.locator('#fIsNFA + .slider')).toHaveCSS('outline-style', 'solid');
  await page.keyboard.press('Space');
  await expect(nfaToggle).toBeChecked();
  await expect(page.locator('#nfaFields')).toBeVisible();

  await page.evaluate(() => document.getElementById('formModal').classList.remove('open'));
  const privacyToggle = page.locator('#privacyToggle');
  await expect(privacyToggle).toBeVisible();
  await privacyToggle.focus();
  await page.keyboard.press('Enter');
  await expect(privacyToggle).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('body')).toHaveClass(/privacy-mode/);
});

test('first-run import is a trapped dialog with a keyboard file chooser and live status', async ({ page }) => {
  const panel = page.locator('#firstRunPanel');
  const choose = page.getByRole('button', { name: /Choose backup file/ });
  const skip = page.getByRole('button', { name: /Skip/ });

  await page.evaluate(() => { document.getElementById('firstRunPanel').style.display = 'flex'; });
  await expect(panel).toBeVisible();
  await expect(panel).toHaveAttribute('role', 'dialog');
  await expect(panel).toHaveAttribute('aria-modal', 'true');
  await expect(choose).toBeFocused();
  await expect(page.locator('#firstRunStatus')).toHaveAttribute('aria-live', 'polite');
  await expect.poll(() => page.evaluate(() => document.querySelector('.vault-layout').inert)).toBe(true);

  await choose.focus();
  await page.keyboard.press('Shift+Tab');
  await expect(skip).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(choose).toBeFocused();

  const chooserPromise = page.waitForEvent('filechooser');
  await page.keyboard.press('Enter');
  const chooser = await chooserPromise;
  expect(chooser.isMultiple()).toBe(false);
  await chooser.setFiles([]);
});

test('mobile More menu stays inside the viewport and scrolls to every action', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 568 });
  await page.locator('#bnMoreMenu [data-menu-toggle]').click();
  const panel = page.locator('#bnMoreMenu .menu-panel');
  await expect(panel).toBeVisible();

  const metrics = await page.evaluate(() => {
    const menu = document.querySelector('#bnMoreMenu .menu-panel');
    const nav = document.getElementById('bottomNav');
    const menuRect = menu.getBoundingClientRect();
    const navRect = nav.getBoundingClientRect();
    return {
      top: menuRect.top,
      bottom: menuRect.bottom,
      navTop: navRect.top,
      viewportHeight: innerHeight,
      clientHeight: menu.clientHeight,
      scrollHeight: menu.scrollHeight,
      overflowY: getComputedStyle(menu).overflowY
    };
  });

  expect(metrics.top).toBeGreaterThanOrEqual(0);
  expect(metrics.bottom).toBeLessThanOrEqual(metrics.navTop + 1);
  expect(metrics.bottom).toBeLessThanOrEqual(metrics.viewportHeight);
  expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight);
  expect(metrics.overflowY).toBe('auto');
  const finalAction = panel.getByRole('button', { name: 'Print inventory' });
  await finalAction.scrollIntoViewIfNeeded();
  await expect(finalAction).toBeInViewport();
  await expect.poll(() => panel.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
});

test('mobile notifications and destructive Undo remain clear of the bottom navigation', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 568 });
  await page.evaluate(() => {
    toast('Changes saved.', 'success', 10000);
    document.getElementById('undoToast').style.display = 'flex';
  });

  const metrics = await page.evaluate(() => {
    const host = document.getElementById('toastHost').getBoundingClientRect();
    const undo = document.getElementById('undoToast').getBoundingClientRect();
    const nav = document.getElementById('bottomNav').getBoundingClientRect();
    return {
      hostBottom: host.bottom,
      undoTop: undo.top,
      undoBottom: undo.bottom,
      navTop: nav.top,
      undoZ: Number.parseInt(getComputedStyle(document.getElementById('undoToast')).zIndex, 10),
      navZ: Number.parseInt(getComputedStyle(document.getElementById('bottomNav')).zIndex, 10)
    };
  });

  expect(metrics.hostBottom).toBeLessThanOrEqual(metrics.undoTop + 1);
  expect(metrics.undoBottom).toBeLessThanOrEqual(metrics.navTop + 1);
  expect(metrics.undoZ).toBeGreaterThan(metrics.navZ);
  await expect(page.locator('#undoToast button')).toBeVisible();
});

test('backup file and in-app prompt inputs have programmatic labels', async ({ page }) => {
  await page.evaluate(() => document.getElementById('backupModal').classList.add('open'));
  await expect(page.getByLabel('Backup file')).toBeVisible();

  await page.evaluate(() => { window.__labelPrompt = promptDialog('How many rounds?', '20', { title: 'Add rounds' }); });
  const prompt = page.getByRole('textbox', { name: 'Add rounds' });
  await expect(prompt).toBeVisible();
  await expect(prompt).toHaveAttribute('aria-describedby', '_dlgMessage');
  await page.locator('.app-dialog').getByRole('button', { name: 'Cancel' }).click();
  await page.evaluate(() => window.__labelPrompt);
});

test('detail photos open the lightbox with Enter and return focus when closed', async ({ page }) => {
  await page.evaluate(() => {
    const image = 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%22800%22 height=%22200%22%3E%3Crect width=%22800%22 height=%22200%22 fill=%22%23555%22/%3E%3C/svg%3E';
    imagesDb['keyboard-photo'] = image;
    db.firearms = [{
      id: 'keyboard-firearm', make: 'Example', model: 'Keyboard Carbine', type: 'Rifle',
      caliber: '5.56', status: 'Active', images: ['keyboard-photo'], tags: [], documents: [],
      customFields: [], maintenanceLog: []
    }];
    render();
    openDetail('keyboard-firearm');
  });

  const imageButton = page.getByRole('button', { name: 'Open full-size photo of Example Keyboard Carbine' });
  await imageButton.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#lightbox')).toBeVisible();
  await expect(page.locator('#lightboxImg')).toHaveAttribute('alt', 'Example Keyboard Carbine');
  await expect(page.locator('#lightbox .lightbox-close')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('#lightbox')).toBeHidden();
  await expect(imageButton).toBeFocused();
});

test('attachment reattach selection does not create a false unsaved-changes warning', async ({ page }) => {
  await page.evaluate(() => document.getElementById('syncCenterModal').classList.add('open'));
  await expect(page.locator('#syncCenterModal')).toBeVisible();
  await page.locator('#missingMediaFile').dispatchEvent('change');
  await expect(page.locator('#syncCenterModal')).toHaveAttribute('data-dirty', 'false');

  await page.locator('#syncCenterModal .modal-footer').getByRole('button', { name: 'Close' }).click();
  await expect(page.locator('#syncCenterModal')).toBeHidden();
  await expect(page.locator('.app-dialog')).toHaveCount(0);
});

test('privacy mode removes raw values from edit-conflict dialogs', async ({ page }) => {
  await page.evaluate(() => {
    db.dealers = [{
      id: 'privacy-conflict', name: 'Example Dealer', ffl: '', phone: '',
      email: 'original-secret@example.test', address: '', website: '', notes: '', favorite: false
    }];
    openDealerModal('privacy-conflict');
    setPrivacyMode(true);
    document.getElementById('dEmail').value = 'my-secret@example.test';
    db.dealers[0].email = 'cloud-secret@example.test';
    window.__privacyConflictSave = saveDealer();
  });

  const dialog = page.locator('.app-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Hidden while privacy mode is on');
  await expect(dialog).not.toContainText('my-secret@example.test');
  await expect(dialog).not.toContainText('cloud-secret@example.test');
  await expect.poll(() => dialog.evaluate(element => (element.textContent.match(/Hidden while privacy mode is on/g) || []).length)).toBe(2);
  await dialog.getByRole('button', { name: 'Use latest saved value' }).click();
  await page.evaluate(() => window.__privacyConflictSave);
});
