import { test, expect } from '@playwright/test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const axePath = require.resolve('axe-core/axe.min.js');

async function mockSignedOutSupabase(page) {
  await page.route('**/vendor/supabase.js', route => route.fulfill({
    contentType: 'application/javascript',
    body: `window.supabase={createClient:function(){return {auth:{getSession:async function(){return {data:{session:null},error:null}},onAuthStateChange:function(){return {data:{subscription:{unsubscribe:function(){}}}}}}}}};`
  }));
}

async function revealApp(page) {
  await page.evaluate(() => {
    document.getElementById('authOverlay').style.display = 'none';
    document.getElementById('appRoot').style.display = '';
    db.firearms = [{
      id: 'feature-ui-firearm', make: 'Example Arms', model: 'Review', serial: 'PRIVATE-100',
      caliber: '9mm', barrel: '4', type: 'Pistol', status: 'Active', images: [], documents: [], tags: []
    }];
    db.auditTrail = [VaultActivity.createEntry('edit', 'firearm', 'Example Arms Review', 'Changed model', {
      collection: 'firearms', recordId: 'feature-ui-firearm',
      before: { ...db.firearms[0], model: 'Earlier' }, after: db.firearms[0]
    })];
    render();
  });
}

test('new feature centers are accessible and stay inside desktop and phone viewports', async ({ browser }) => {
  const context = await browser.newContext({ bypassCSP: true });
  const page = await context.newPage();
  await mockSignedOutSupabase(page);
  await page.goto('/index.html');
  await page.addScriptTag({ path: axePath });
  await revealApp(page);

  const features = [
    ['healthModal', async () => page.evaluate(() => openCollectionHealth()), async () => page.evaluate(() => closeCollectionHealth())],
    ['activityCenterModal', async () => page.evaluate(() => openActivityCenter()), async () => page.evaluate(() => closeActivityCenter())],
    ['quickCaptureModal', async () => page.evaluate(() => document.getElementById('quickCaptureModal').classList.add('open')), async () => page.evaluate(() => closeQuickCaptureModal())],
    ['reportPackageModal', async () => page.evaluate(() => openReportPackageModal()), async () => page.evaluate(() => closeReportPackageModal())],
    ['backupModal', async () => page.evaluate(() => openBackupModal()), async () => page.evaluate(() => closeBackupModal())]
  ];

  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    for (const [id, open, close] of features) {
      await open();
      const modal = page.locator('#' + id);
      await expect(modal).toBeVisible();
      const bounds = await modal.locator('.modal').evaluate(element => {
        const rect = element.getBoundingClientRect();
        return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
      });
      expect(bounds.left).toBeGreaterThanOrEqual(-1);
      expect(bounds.top).toBeGreaterThanOrEqual(-1);
      expect(bounds.right).toBeLessThanOrEqual(viewport.width + 1);
      expect(bounds.bottom).toBeLessThanOrEqual(viewport.height + 1);
      const audit = await page.evaluate(async modalId => axe.run(document.getElementById(modalId), {
        runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] }
      }), id);
      expect(audit.violations.filter(item => ['critical', 'serious'].includes(item.impact)), id).toEqual([]);
      await close();
    }
  }
  await context.close();
});
