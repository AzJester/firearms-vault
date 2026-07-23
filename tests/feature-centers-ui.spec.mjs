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
    db.auditTrail = Array.from({ length: 151 }, (_, index) =>
      VaultActivity.createEntry('edit', 'firearm', 'Example Arms Review ' + (index + 1), 'Changed model', {
        timestamp: new Date(Date.UTC(2026, 6, 22, 20, 0, index)).toISOString(),
        collection: 'firearms', recordId: 'feature-ui-firearm',
        before: { ...db.firearms[0], model: 'Earlier ' + index }, after: db.firearms[0]
      }));
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

  const viewports = [
    { width: 1440, height: 900 },
    { width: 1360, height: 1530 },
    { width: 768, height: 1024 },
    { width: 700, height: 900 },
    { width: 844, height: 390 },
    { width: 390, height: 844 },
    { width: 360, height: 640 }
  ];
  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    for (const [id, open, close] of features) {
      await open();
      const modal = page.locator('#' + id);
      await expect(modal).toBeVisible();
      const geometry = await modal.locator('.modal').evaluate(element => {
        const rect = element.getBoundingClientRect();
        const body = element.querySelector(':scope > .modal-body');
        const footer = element.querySelector(':scope > .modal-footer');
        const overlay = element.parentElement;
        return {
          modal: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
          overlay: { clientHeight: overlay.clientHeight, scrollHeight: overlay.scrollHeight },
          children: [...element.children].map(child => {
            const childRect = child.getBoundingClientRect();
            return { top: childRect.top, bottom: childRect.bottom };
          }),
          overflow: getComputedStyle(element).overflow,
          body: body ? {
            clientHeight: body.clientHeight,
            scrollHeight: body.scrollHeight,
            overflowY: getComputedStyle(body).overflowY
          } : null,
          footer: footer ? {
            top: footer.getBoundingClientRect().top,
            bottom: footer.getBoundingClientRect().bottom
          } : null
        };
      });
      expect(geometry.modal.left).toBeGreaterThanOrEqual(-1);
      expect(geometry.modal.top).toBeGreaterThanOrEqual(-1);
      expect(geometry.modal.right).toBeLessThanOrEqual(viewport.width + 1);
      expect(geometry.modal.bottom).toBeLessThanOrEqual(viewport.height + 1);
      expect(geometry.overlay.scrollHeight, `${id} overlay scroll at ${viewport.width}x${viewport.height}`)
        .toBeLessThanOrEqual(geometry.overlay.clientHeight + 1);
      expect(geometry.overflow, `${id} shell overflow at ${viewport.width}x${viewport.height}`).toBe('hidden');
      for (const child of geometry.children) {
        expect(child.top, `${id} child top at ${viewport.width}x${viewport.height}`).toBeGreaterThanOrEqual(geometry.modal.top - 1);
        expect(child.bottom, `${id} child bottom at ${viewport.width}x${viewport.height}`).toBeLessThanOrEqual(geometry.modal.bottom + 1);
      }
      if (geometry.body) expect(geometry.body.overflowY).toBe('auto');
      if (geometry.footer) {
        expect(geometry.footer.top).toBeGreaterThanOrEqual(geometry.modal.top - 1);
        expect(geometry.footer.bottom).toBeLessThanOrEqual(geometry.modal.bottom + 1);
      }
      if (id === 'activityCenterModal') {
        expect(geometry.body.scrollHeight).toBeGreaterThan(geometry.body.clientHeight);
        const scrolled = await modal.locator('.modal-body').evaluate(body => {
          const footer = body.parentElement.querySelector(':scope > .modal-footer');
          const before = footer.getBoundingClientRect();
          body.scrollTop = body.scrollHeight;
          const after = footer.getBoundingClientRect();
          return {
            scrollTop: body.scrollTop,
            footerStayedPut: Math.abs(after.top - before.top) < 1 && Math.abs(after.bottom - before.bottom) < 1
          };
        });
        expect(scrolled.scrollTop).toBeGreaterThan(0);
        expect(scrolled.footerStayedPut).toBe(true);
      }
      if ((viewport.width === 1440 && viewport.height === 900) || (viewport.width === 390 && viewport.height === 844)) {
        const audit = await page.evaluate(async modalId => axe.run(document.getElementById(modalId), {
          runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] }
        }), id);
        expect(audit.violations.filter(item => ['critical', 'serious'].includes(item.impact)), id).toEqual([]);
      }
      await close();
    }
  }
  await context.close();
});
