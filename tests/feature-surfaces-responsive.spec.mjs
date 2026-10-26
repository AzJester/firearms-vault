import { test, expect } from '@playwright/test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const axePath = require.resolve('axe-core/axe.min.js');
test.use({ serviceWorkers: 'block', bypassCSP: true });

async function setup(page) {
  await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
  await page.goto('/index.html');
  await page.waitForFunction(() => window.VaultItemDetails && window.VaultEquipment && window.VaultRange && window.VaultCollectionTools);
  await page.evaluate(() => {
    document.getElementById('authOverlay').style.display = 'none';
    document.getElementById('firstRunPanel').style.display = 'none';
    document.getElementById('appRoot').style.display = '';
    const hosts = Array.from({ length: 12 }, (_, index) => ({
      id: 'surface-host-' + index, make: 'Example Arms', model: 'Representative carbine with a long model name ' + (index + 1),
      serial: 'EXAMPLE-ONLY-' + index, type: 'Rifle', caliber: '5.56', status: 'Active',
      condition: 'Good', price: '1000', images: [], tags: [], documents: [], customFields: [], maintenanceLog: []
    }));
    db = {
      version: 3, encrypted: false,
      firearms: [...hosts, { id: 'surface-suppressor', make: 'Example', model: 'One serialized suppressor',
        serial: 'EXAMPLE-CAN', type: 'Silencer', isNFA: true, nfaType: 'Suppressor', status: 'Active',
        price: '700', images: [], tags: [], documents: [], maintenanceLog: [],
        hostFirearmIds: ['surface-host-0', 'surface-host-1'], currentHostId: 'surface-host-0' }],
      ammo: [{ id: 'surface-ammo', brand: 'Example ammunition', caliber: '5.56', quantity: '250', lot: 'EXAMPLE-LOT' }],
      accessories: [], wishlist: [], dealers: [], backups: [], auditTrail: [], valueHistory: [],
      settings: { savedCollectionViews: [{ id: 'surface-view', name: 'Representative saved collection view with a long name', tab: 'all', view: 'cards', filters: {} }] }
    };
    window.saveData = async () => true;
    currentTab = 'all'; currentView = 'cards';
    bulkSelected = new Set();
    render();
    enhanceInteractiveContent(document);
  });
  await page.addScriptTag({ path: axePath });
}

async function seriousViolations(page) {
  return page.evaluate(async () => {
    const result = await axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] } });
    return result.violations.filter(item => ['critical', 'serious'].includes(item.impact)).map(item => ({
      id: item.id, impact: item.impact, description: item.description,
      nodes: item.nodes.map(node => ({ target: node.target, failureSummary: node.failureSummary }))
    }));
  });
}

for (const width of [360, 768, 1024]) {
  test(`saved Views panel stays inside the viewport and remains accessible at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await setup(page);
    await page.locator('#collectionViewsMenu > summary').click();
    const dimensions = await page.locator('.collection-view-panel').evaluate(panel => {
      const rect = panel.getBoundingClientRect();
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
        width: document.documentElement.clientWidth, height: document.documentElement.clientHeight,
        pageWidth: document.documentElement.scrollWidth, scrollWidth: panel.scrollWidth, clientWidth: panel.clientWidth };
    });
    await page.screenshot({ path: testInfo.outputPath('views-panel.png'), fullPage: true });
    expect.soft(dimensions.left, JSON.stringify(dimensions)).toBeGreaterThanOrEqual(-1);
    expect.soft(dimensions.right, JSON.stringify(dimensions)).toBeLessThanOrEqual(dimensions.width + 1);
    expect.soft(dimensions.top, JSON.stringify(dimensions)).toBeGreaterThanOrEqual(-1);
    expect.soft(dimensions.bottom, JSON.stringify(dimensions)).toBeLessThanOrEqual(dimensions.height + 1);
    expect.soft(dimensions.pageWidth).toBeLessThanOrEqual(dimensions.width + 1);
    expect.soft(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth + 1);
    expect.soft(await seriousViolations(page)).toEqual([]);
  });
}

const surfaces = [
  ['duplicateOptionsModal', () => duplicateFirearm('surface-host-0')],
  ['equipmentLinksModal', () => VaultEquipment.open('surface-host-0', 'firearms', 'surface-suppressor')],
  ['rangeSessionModal', () => VaultRange.open('surface-host-0')],
  ['batchEditModal', () => { bulkSelected = new Set(['surface-host-0', 'surface-host-1']); updateBulkBar(); VaultCollectionTools.openBatch(); }]
];

for (const viewport of [{ width: 360, height: 700 }, { width: 1024, height: 900 }]) {
  for (const [id, opener] of surfaces) {
    test(`${id} owns its scrolling and contains buttons without serious accessibility issues at ${viewport.width}x${viewport.height}`, async ({ page }, testInfo) => {
      await page.setViewportSize(viewport);
      await setup(page);
      await page.evaluate(opener);
      await expect(page.locator('#' + id)).toHaveClass(/\bopen\b/);
      // Wait for the shared dialog manager to establish focus and isolation.
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const measure = () => page.locator('#' + id + ' > .modal').evaluate(modal => {
        const box = modal.getBoundingClientRect(), overlay = modal.parentElement;
        const body = modal.querySelector('.modal-body'), footer = modal.querySelector('.modal-footer');
        const footerBox = footer.getBoundingClientRect();
        return {
          modal: { left: box.left, right: box.right, top: box.top, bottom: box.bottom },
          viewport: { width: document.documentElement.clientWidth, height: document.documentElement.clientHeight },
          modalOverflow: getComputedStyle(modal).overflow,
          overlay: { clientHeight: overlay.clientHeight, scrollHeight: overlay.scrollHeight, scrollTop: overlay.scrollTop },
          body: { overflowY: getComputedStyle(body).overflowY, clientWidth: body.clientWidth, scrollWidth: body.scrollWidth },
          footer: { top: footerBox.top, bottom: footerBox.bottom }
        };
      });
      const dimensions = await measure();
      await page.screenshot({ path: testInfo.outputPath('modal-layout.png'), fullPage: true });
      expect.soft(dimensions.modal.left, JSON.stringify(dimensions)).toBeGreaterThanOrEqual(-1);
      expect.soft(dimensions.modal.right, JSON.stringify(dimensions)).toBeLessThanOrEqual(dimensions.viewport.width + 1);
      expect.soft(dimensions.modal.top, JSON.stringify(dimensions)).toBeGreaterThanOrEqual(-1);
      expect.soft(dimensions.modal.bottom, JSON.stringify(dimensions)).toBeLessThanOrEqual(dimensions.viewport.height + 1);
      expect.soft(dimensions.modalOverflow).toBe('hidden');
      expect.soft(dimensions.overlay.scrollHeight).toBeLessThanOrEqual(dimensions.overlay.clientHeight + 1);
      expect.soft(['auto', 'scroll']).toContain(dimensions.body.overflowY);
      expect.soft(dimensions.body.scrollWidth).toBeLessThanOrEqual(dimensions.body.clientWidth + 1);
      expect.soft(dimensions.footer.top).toBeGreaterThanOrEqual(dimensions.modal.top - 1);
      expect.soft(dimensions.footer.bottom).toBeLessThanOrEqual(dimensions.modal.bottom + 1);
      const buttons = page.locator('#' + id + ' button:visible');
      for (let index = 0; index < await buttons.count(); index++) {
        const button = buttons.nth(index);
        await button.scrollIntoViewIfNeeded();
        const bounds = await button.boundingBox();
        const label = id + ': ' + await button.getAttribute('aria-label') + ' ' + await button.textContent();
        expect.soft(bounds.x, label).toBeGreaterThanOrEqual(dimensions.modal.left - 1);
        expect.soft(bounds.x + bounds.width, label).toBeLessThanOrEqual(dimensions.modal.right + 1);
        expect.soft(bounds.y, label).toBeGreaterThanOrEqual(dimensions.modal.top - 1);
        expect.soft(bounds.y + bounds.height, label).toBeLessThanOrEqual(dimensions.modal.bottom + 1);
      }
      expect.soft((await measure()).overlay.scrollTop).toBe(0);
      expect.soft(await seriousViolations(page)).toEqual([]);
    });
  }
}
