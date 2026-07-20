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

async function revealEmptyApp(page) {
  await page.evaluate(() => {
    document.getElementById('authOverlay').style.display = 'none';
    document.getElementById('appRoot').style.display = '';
    window.render();
    window.enhanceInteractiveContent(document);
  });
}

test('login and empty application shell have no serious axe violations', async ({ browser }) => {
  const context = await browser.newContext({ bypassCSP: true });
  const page = await context.newPage();
  await mockSignedOutSupabase(page);
  await page.goto('/index.html');
  await page.addScriptTag({ path: axePath });
  const login = await page.evaluate(async () => axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] } }));
  expect(login.violations.filter(item => ['critical', 'serious'].includes(item.impact))).toEqual([]);

  await revealEmptyApp(page);
  const shell = await page.evaluate(async () => axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] } }));
  expect(shell.violations.filter(item => ['critical', 'serious'].includes(item.impact))).toEqual([]);
  await context.close();
});

test('mobile chrome stays compact and tables scroll inside their region', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockSignedOutSupabase(page);
  await page.goto('/index.html');
  await revealEmptyApp(page);

  const tab = page.locator('.tab[data-tab="ammo"]');
  await page.locator('[data-bottomtab="ammo"]').click();
  await expect(tab).toHaveAttribute('aria-selected', 'true');
  await page.evaluate(() => {
    db.ammo.push({ id: 'ammo-mobile-test', brand: 'Example', caliber: '9mm', quantity: 50, purchaseDate: '2026-01-01', pricePerRound: 0.25, location: 'Safe' });
    render();
  });

  const measurements = await page.evaluate(() => {
    const toolbar = document.querySelector('.toolbar');
    const table = document.querySelector('.table-container');
    return {
      viewport: document.documentElement.clientWidth,
      pageWidth: document.documentElement.scrollWidth,
      toolbarHeight: toolbar ? Math.round(toolbar.getBoundingClientRect().height) : 0,
      tableClient: table ? table.clientWidth : 0,
      tableScroll: table ? table.scrollWidth : 0,
      tableRole: table && table.getAttribute('role'),
      tableTabIndex: table && table.tabIndex
    };
  });
  expect(measurements.pageWidth).toBeLessThanOrEqual(measurements.viewport + 1);
  expect(measurements.toolbarHeight).toBeLessThanOrEqual(180);
  expect(measurements.tableScroll).toBeGreaterThan(measurements.tableClient);
  expect(measurements.tableRole).toBe('region');
  expect(measurements.tableTabIndex).toBe(0);
});

test('desktop tabs support arrow-key navigation', async ({ page }) => {
  await mockSignedOutSupabase(page);
  await page.goto('/index.html');
  await revealEmptyApp(page);

  const activeTab = page.locator('.tab[data-tab="all"]');
  const nextTab = page.locator('.tab[data-tab="ammo"]');
  await activeTab.focus();
  await page.keyboard.press('ArrowRight');
  await expect(nextTab).toBeFocused();
  await expect(nextTab).toHaveAttribute('aria-selected', 'true');
});

test('privacy toggle exposes state without relying on color', async ({ page }) => {
  await mockSignedOutSupabase(page);
  await page.goto('/index.html');
  await revealEmptyApp(page);
  const toggle = page.locator('#privacyToggle');
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('body')).toHaveClass(/privacy-mode/);
  await expect(toggle).toHaveAttribute('aria-label', /Reveal/);
});
