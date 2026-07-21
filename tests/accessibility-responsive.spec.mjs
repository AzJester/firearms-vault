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

test('inventory images fit inside their frames without crop or hover zoom', async ({ page }) => {
  await mockSignedOutSupabase(page);
  await page.goto('/index.html');
  await revealEmptyApp(page);

  await page.evaluate(() => {
    const sample = 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%22800%22 height=%22200%22%3E%3Crect width=%22800%22 height=%22200%22 fill=%22%23999%22/%3E%3C/svg%3E';
    const fixture = document.createElement('div');
    fixture.id = 'image-fit-fixture';
    fixture.innerHTML = `
      <div class="card"><img class="card-img" alt="Test inventory item" src="${sample}"></div>
      <img class="dh-img" alt="Test dashboard item" src="${sample}">
      <img class="img-thumbnail" alt="Test editor thumbnail" src="${sample}">
      <table class="data-table"><tbody><tr><td><img class="thumb" alt="" src="${sample}"></td></tr></tbody></table>
      <div class="detail-img-container"><img class="detail-img" alt="Test detail item" src="${sample}"></div>`;
    document.body.appendChild(fixture);
  });

  for (const selector of ['.card-img', '.dh-img', '.img-thumbnail', '.data-table .thumb', '.detail-img']) {
    await expect(page.locator(`#image-fit-fixture ${selector}`)).toHaveCSS('object-fit', 'contain');
  }

  await page.locator('#image-fit-fixture .card').hover();
  await expect(page.locator('#image-fit-fixture .card-img')).toHaveCSS('transform', 'none');

  await page.goto('/share.html');
  await page.evaluate(sample => {
    const image = document.createElement('img');
    image.className = 'sv-img';
    image.alt = 'Test shared item';
    image.src = sample;
    document.body.appendChild(image);
  }, 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%22800%22 height=%22200%22/%3E');
  await expect(page.locator('.sv-img')).toHaveCSS('object-fit', 'contain');

  if (process.env.TEST_SITE_DIR !== 'dist') {
    await page.goto('/local-edition/index.html');
    await page.evaluate(() => {
      const fixture = document.createElement('div');
      fixture.id = 'local-image-fit-fixture';
      fixture.innerHTML = '<div class="card"><img class="card-img" alt="Test local item"></div><img class="dh-img" alt=""><table class="data-table"><tbody><tr><td><img class="thumb" alt=""></td></tr></tbody></table>';
      document.body.appendChild(fixture);
    });
    for (const selector of ['.card-img', '.dh-img', '.data-table .thumb']) {
      await expect(page.locator(`#local-image-fit-fixture ${selector}`)).toHaveCSS('object-fit', 'contain');
    }
  }
});

test('pending status badges are large and high contrast', async ({ page }) => {
  await mockSignedOutSupabase(page);
  await page.goto('/index.html');
  await revealEmptyApp(page);
  const metrics = await page.evaluate(() => {
    const host = document.createElement('div');
    host.style.position = 'relative';
    host.style.height = '80px';
    host.innerHTML = '<div class="stamp-badge stamp-pending"><span class="si" aria-hidden="true">◷</span>Pending</div><span class="stamp-tag pending"><span class="si" aria-hidden="true">◷</span>Pending</span>';
    document.body.appendChild(host);

    const rgb = value => (value.match(/\d+(?:\.\d+)?/g) || []).slice(0, 3).map(Number);
    const luminance = color => {
      const channels = rgb(color).map(value => value / 255).map(value => value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
      return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
    };
    const inspect = selector => {
      const style = getComputedStyle(host.querySelector(selector));
      const light = luminance(style.backgroundColor);
      const dark = luminance(style.color);
      return {
        fontSize: Number.parseFloat(style.fontSize),
        height: Number.parseFloat(style.height),
        contrast: (Math.max(light, dark) + 0.05) / (Math.min(light, dark) + 0.05)
      };
    };
    return { badge: inspect('.stamp-badge'), tag: inspect('.stamp-tag') };
  });

  expect(metrics.badge.fontSize).toBeGreaterThanOrEqual(12);
  expect(metrics.badge.height).toBeGreaterThanOrEqual(26);
  expect(metrics.badge.contrast).toBeGreaterThanOrEqual(4.5);
  expect(metrics.tag.fontSize).toBeGreaterThanOrEqual(12);
  expect(metrics.tag.contrast).toBeGreaterThanOrEqual(4.5);
});
