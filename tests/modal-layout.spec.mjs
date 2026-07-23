import { test, expect } from '@playwright/test';

async function mockSignedOutSupabase(page) {
  await page.route('**/vendor/supabase.js', route => route.fulfill({
    contentType: 'application/javascript',
    body: `window.supabase={createClient:function(){return {auth:{getSession:async function(){return {data:{session:null},error:null}},onAuthStateChange:function(){return {data:{subscription:{unsubscribe:function(){}}}}}}}}};`
  }));
}

async function revealApp(page) {
  await page.evaluate(() => {
    document.getElementById('authOverlay').style.display = 'none';
    document.getElementById('firstRunPanel').style.display = 'none';
    document.getElementById('appRoot').style.display = '';
    db.firearms = [{
      id: 'modal-layout-firearm',
      make: 'Example Arms',
      model: 'Layout Fixture With A Deliberately Long Model Name',
      type: 'Rifle',
      caliber: '5.56',
      status: 'Active',
      images: [],
      tags: ['Layout'],
      documents: [],
      maintenanceLog: Array.from({ length: 12 }, (_, index) => ({
        id: 'maintenance-' + index,
        date: '2026-07-22',
        type: 'Inspection',
        notes: 'Representative maintenance history row ' + (index + 1)
      }))
    }];
    render();
  });
}

test('every modal, dialog, and detail surface contains its own content at supported viewport shapes', async ({ page }) => {
  await mockSignedOutSupabase(page);
  await page.goto('/index.html');
  await revealApp(page);

  const modalIds = [
    'passwordModal',
    'backupModal',
    'activityCenterModal',
    'healthModal',
    'quickCaptureModal',
    'reportPackageModal',
    'cameraModal',
    'maintenanceModal',
    'remindersModal',
    'shareModal',
    'syncCenterModal',
    'formModal',
    'ammoModal',
    'accessoryModal',
    'wishlistModal',
    'dealerModal',
    'dealerImportModal',
    'cropModal',
    'qrModal',
    'shortcutsModal',
    'reportBuilderModal',
    'settingsModal'
  ];
  const viewports = [
    { width: 360, height: 640 },
    { width: 390, height: 844 },
    { width: 700, height: 900 },
    { width: 768, height: 1024 },
    { width: 844, height: 390 },
    { width: 1360, height: 1530 }
  ];

  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    for (const id of modalIds) {
      await page.evaluate(modalId => {
        document.querySelectorAll('.modal-overlay.open').forEach(element => element.classList.remove('open'));
        document.getElementById(modalId).classList.add('open');
      }, id);
      const measurements = await page.locator(`#${id} > .modal`).evaluate(element => {
        const modal = element.getBoundingClientRect();
        const overlay = element.parentElement;
        return {
          modal: { left: modal.left, top: modal.top, right: modal.right, bottom: modal.bottom },
          overlay: { clientHeight: overlay.clientHeight, scrollHeight: overlay.scrollHeight },
          overflow: getComputedStyle(element).overflow,
          children: [...element.children].map(child => {
            const rect = child.getBoundingClientRect();
            return { top: rect.top, bottom: rect.bottom };
          })
        };
      });
      const label = `${id} at ${viewport.width}x${viewport.height}`;
      expect(measurements.modal.left, label).toBeGreaterThanOrEqual(-1);
      expect(measurements.modal.top, label).toBeGreaterThanOrEqual(-1);
      expect(measurements.modal.right, label).toBeLessThanOrEqual(viewport.width + 1);
      expect(measurements.modal.bottom, label).toBeLessThanOrEqual(viewport.height + 1);
      expect(measurements.overflow, label).toBe('hidden');
      expect(measurements.overlay.scrollHeight, label).toBeLessThanOrEqual(measurements.overlay.clientHeight + 1);
      for (const child of measurements.children) {
        expect(child.top, label).toBeGreaterThanOrEqual(measurements.modal.top - 1);
        expect(child.bottom, label).toBeLessThanOrEqual(measurements.modal.bottom + 1);
      }
      await page.evaluate(modalId => document.getElementById(modalId).classList.remove('open'), id);
    }

    await page.evaluate(() => openDetail('modal-layout-firearm'));
    const detail = await page.locator('#detailView .detail-panel').evaluate(element => {
      const rect = element.getBoundingClientRect();
      return {
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        viewportWidth: document.documentElement.clientWidth,
        viewportHeight: document.documentElement.clientHeight
      };
    });
    const detailLabel = `detail view at ${viewport.width}x${viewport.height}`;
    expect(detail.left, detailLabel).toBeGreaterThanOrEqual(-1);
    expect(detail.top, detailLabel).toBeGreaterThanOrEqual(-1);
    expect(detail.right, detailLabel).toBeLessThanOrEqual(detail.viewportWidth + 1);
    expect(detail.bottom, detailLabel).toBeLessThanOrEqual(detail.viewportHeight + 1);
    await page.evaluate(() => closeDetail());
  }
});
