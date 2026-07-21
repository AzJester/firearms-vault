import { test, expect } from '@playwright/test';

// Network mocks must remain authoritative across reloads; an installed app
// worker from another local run must not substitute cached production assets.
test.use({ serviceWorkers: 'block' });

const WIDE_IMAGE = 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%221200%22 height=%22300%22 viewBox=%220 0 1200 300%22%3E%3Crect width=%221200%22 height=%22300%22 fill=%22%23e6e0d4%22/%3E%3Cpath d=%22M70 150h1060%22 stroke=%22%23182430%22 stroke-width=%2260%22 stroke-linecap=%22round%22/%3E%3Ccircle cx=%22220%22 cy=%22150%22 r=%2245%22 fill=%22%23ad8a3b%22/%3E%3C/svg%3E';

const firearm = (overrides = {}) => ({
  id: 'firearm-fixture',
  make: 'Example Armory',
  model: 'Long Profile',
  serial: 'UX-1001',
  caliber: '5.56',
  type: 'Rifle',
  barrel: '16 in',
  condition: 'Excellent',
  price: '1299',
  dateAcquired: '2026-01-15',
  status: 'Active',
  images: ['wide-fixture'],
  tags: ['Training'],
  maintenanceLog: [],
  customFields: [],
  documents: [],
  ...overrides
});

async function mockSignedOutSupabase(page) {
  await page.route('**/vendor/supabase.js', route => route.fulfill({
    contentType: 'application/javascript',
    body: `window.supabase={createClient:function(){return {auth:{getSession:async function(){return {data:{session:null},error:null}},onAuthStateChange:function(){return {data:{subscription:{unsubscribe:function(){}}}}}}}}};`
  }));
}

async function mockSignedInEmptySupabase(page) {
  await page.route('**/vendor/supabase.js', route => route.fulfill({
    contentType: 'application/javascript',
    body: `
      (function () {
        var session = { access_token: 'test-token', user: { id: 'visual-refresh-user', email: 'visual@example.test' } };
        function emptyQuery() {
          var query = {
            select: function () { return query; },
            eq: function () { return query; },
            maybeSingle: async function () { return { data: null, error: null }; },
            single: async function () { return { data: null, error: null }; },
            update: function () { return query; },
            insert: async function () { return { data: null, error: null }; },
            upsert: async function () { return { data: null, error: null }; },
            delete: function () { return query; }
          };
          return query;
        }
        var auth = {
          getSession: async function () { return { data: { session: session }, error: null }; },
          onAuthStateChange: function () { return { data: { subscription: { unsubscribe: function () {} } } }; },
          signOut: async function () { return { error: null }; },
          updateUser: async function () { return { data: {}, error: null }; },
          resetPasswordForEmail: async function () { return { data: {}, error: null }; },
          mfa: {
            getAuthenticatorAssuranceLevel: async function () { return { data: { currentLevel: 'aal1', nextLevel: 'aal1' }, error: null }; },
            listFactors: async function () { return { data: { all: [], totp: [], phone: [] }, error: null }; }
          }
        };
        window.supabase = {
          createClient: function () {
            return {
              auth: auth,
              from: function () { return emptyQuery(); },
              rpc: async function () { return { data: null, error: null }; },
              storage: {
                from: function () {
                  return {
                    download: async function () { return { data: null, error: { message: 'not found' } }; },
                    upload: async function () { return { data: {}, error: null }; },
                    list: async function () { return { data: [], error: null }; },
                    remove: async function () { return { data: [], error: null }; }
                  };
                }
              }
            };
          }
        };
      })();`
  }));
}

async function openApp(page) {
  await mockSignedOutSupabase(page);
  await page.goto('/index.html');
  await expect.poll(() => page.evaluate(() => typeof window.render)).toBe('function');
  await page.evaluate(() => {
    document.getElementById('authOverlay').style.display = 'none';
    document.getElementById('firstRunPanel').style.display = 'none';
    document.getElementById('appRoot').style.display = '';
    window.render();
    if (typeof window.enhanceInteractiveContent === 'function') window.enhanceInteractiveContent(document);
  });
  await expect(page.locator('#appRoot')).toBeVisible();
}

async function seedVault(page, options = {}) {
  const payload = {
    firearms: options.firearms || [firearm()],
    ammo: options.ammo || [],
    accessories: options.accessories || [],
    wishlist: options.wishlist || [],
    dealers: options.dealers || []
  };
  await page.evaluate(({ payload, image }) => {
    db.firearms = payload.firearms;
    db.ammo = payload.ammo;
    db.accessories = payload.accessories;
    db.wishlist = payload.wishlist;
    db.dealers = payload.dealers;
    imagesDb['wide-fixture'] = image;
    if (typeof thumbCache !== 'undefined') thumbCache['wide-fixture'] = image;
    if (typeof bulkSelected !== 'undefined') bulkSelected.clear();
    currentTab = 'all';
    currentView = 'cards';
    render();
    if (typeof window.enhanceInteractiveContent === 'function') window.enhanceInteractiveContent(document);
  }, { payload, image: WIDE_IMAGE });
}

async function selectTab(page, tab) {
  const control = page.locator(`.tab[data-tab="${tab}"]`);
  if (await control.isVisible()) await control.click();
  else {
    // The desktop rail is intentionally hidden at mobile widths. Exercise the
    // same tab activation handler without forcing a click on a hidden element.
    await control.evaluate(element => element.click());
  }
  await expect(control).toHaveAttribute('aria-selected', 'true');
}

function visibleResults(page) {
  return page.locator('#cardGrid:visible, #tableContainer:visible').first();
}

test('Firearms Vault branding is consistent across private and shared entry points', async ({ page }) => {
  await mockSignedOutSupabase(page);
  await page.goto('/index.html');

  await expect(page).toHaveTitle(/Firearms Vault/i);
  await expect(page.locator('.auth-card h1')).toContainText(/Firearms Vault/i);
  await page.evaluate(() => {
    document.getElementById('authOverlay').style.display = 'none';
    document.getElementById('appRoot').style.display = '';
  });
  await expect(page.locator('.header h1')).toContainText(/Firearms Vault/i);
  await expect(page.locator('#firstRunPanel h2')).toContainText(/Firearms Vault/i);

  const manifest = await page.request.get('/manifest.webmanifest');
  expect(manifest.ok()).toBeTruthy();
  expect((await manifest.json()).name).toMatch(/Firearms Vault/i);

  await page.goto('/share.html');
  await expect(page).toHaveTitle(/Firearms Vault/i);
  await expect(page.locator('.sv-brand-name')).toContainText(/Firearms Vault/i);
});

test('desktop uses a nav rail, main workspace, and contextual page heading', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await openApp(page);

  await expect(page.locator('.vault-layout')).toBeVisible();
  await expect(page.locator('.vault-sidebar')).toBeVisible();
  await expect(page.locator('.vault-main')).toBeVisible();
  await expect(page.locator('.page-heading')).toBeVisible();
  await expect(page.locator('#pageTitle')).not.toBeEmpty();
  await expect(page.locator('#pageDescription')).not.toBeEmpty();
  await expect(page.locator('#pageRecordCount')).toContainText(/\d/);

  const layout = await page.evaluate(() => {
    const shell = document.querySelector('.vault-layout').getBoundingClientRect();
    const rail = document.querySelector('.vault-sidebar').getBoundingClientRect();
    const main = document.querySelector('.vault-main').getBoundingClientRect();
    const heading = document.querySelector('.page-heading').getBoundingClientRect();
    return { shell, rail, main, heading, tabs: document.querySelectorAll('.vault-sidebar .tab').length };
  });
  expect(layout.tabs).toBeGreaterThanOrEqual(8);
  expect(layout.rail.width).toBeGreaterThanOrEqual(180);
  expect(Math.abs(layout.rail.right - layout.main.left)).toBeLessThanOrEqual(2);
  expect(layout.heading.left).toBeGreaterThanOrEqual(layout.main.left - 1);
  expect(layout.heading.right).toBeLessThanOrEqual(layout.main.right + 1);
  expect(layout.shell.width).toBeLessThanOrEqual(1440);
});

test('every section presents only relevant search and primary add controls', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await openApp(page);

  const cases = [
    { tab: 'dashboard', title: /overview|dashboard/i, toolbar: false },
    { tab: 'all', title: /firearm|collection/i, action: /add.*firearm/i, search: /firearm|make|model|serial|caliber/i },
    { tab: 'nfa', title: /nfa/i, action: /add.*(nfa|firearm)/i, search: /nfa|firearm|make|model|serial/i },
    { tab: 'disposed', title: /sold|transferred|disposed/i, action: null, search: /sold|transferred|disposed|firearm|make|model|serial/i },
    { tab: 'ammo', title: /ammo|ammunition/i, action: /add.*(ammo|ammunition)/i, search: /ammo|ammunition|brand|caliber/i, nonFirearm: true },
    { tab: 'accessories', title: /accessor|part/i, action: /add.*accessor/i, search: /accessor|part|brand|name/i, nonFirearm: true },
    { tab: 'wishlist', title: /wish/i, action: /add.*wish/i, search: /wish|make|model/i, nonFirearm: true },
    { tab: 'dealers', title: /dealer|ffl/i, action: /add.*dealer/i, search: /dealer|ffl|name/i, nonFirearm: true }
  ];

  for (const item of cases) {
    await selectTab(page, item.tab);
    await expect(page.locator('#pageTitle')).toContainText(item.title);
    const visibleActions = page.locator('#pageAddBtn:visible, #addBtn:visible');

    if (item.toolbar === false) {
      await expect(page.locator('#mainToolbar')).toBeHidden();
      expect(await visibleActions.count(), `${item.tab} should not expose an add action`).toBe(0);
      continue;
    }

    await expect(page.locator('#mainToolbar')).toBeVisible();
    const search = page.locator('#searchBox');
    await expect(search).toBeVisible();
    const searchDescription = await search.evaluate(element => `${element.getAttribute('aria-label') || ''} ${element.getAttribute('placeholder') || ''}`);
    expect(searchDescription, `${item.tab} search should describe the active collection`).toMatch(item.search);

    if (item.action) {
      expect(await visibleActions.count(), `${item.tab} should have one primary add action`).toBe(1);
      await expect(visibleActions.first()).toContainText(item.action);
    } else {
      expect(await visibleActions.count(), `${item.tab} should not offer an invalid add action`).toBe(0);
    }

    if (item.nonFirearm) {
      for (const selector of ['#filterType', '#filterTag', '#filterCondition', '.view-toggle']) {
        await expect(page.locator(selector), `${selector} is a firearm-only control on ${item.tab}`).toBeHidden();
      }
    }
  }
});

test('contextual search filters ammunition, accessories, wishlist, and dealers', async ({ page }) => {
  await openApp(page);
  await seedVault(page, {
    ammo: [
      { id: 'ammo-target', brand: 'Needle Ammo', caliber: '9mm', quantity: 50, pricePerRound: 0.4, location: 'Safe' },
      { id: 'ammo-other', brand: 'Haystack Ammo', caliber: '45 ACP', quantity: 20, pricePerRound: 0.7, location: 'Cabinet' }
    ],
    accessories: [
      { id: 'accessory-target', name: 'Needle Optic', category: 'Optic', brand: 'Example', model: 'One', price: 300 },
      { id: 'accessory-other', name: 'Haystack Sling', category: 'Sling', brand: 'Example', model: 'Two', price: 60 }
    ],
    wishlist: [
      { id: 'wish-target', make: 'Needle Works', model: 'Desired', type: 'Pistol', priority: 'high', price: 900 },
      { id: 'wish-other', make: 'Haystack Works', model: 'Later', type: 'Rifle', priority: 'low', price: 1100 }
    ],
    dealers: [
      { id: 'dealer-target', name: 'Needle Arms', ffl: '9-99-999-99-9A-99999', city: 'Phoenix', state: 'AZ' },
      { id: 'dealer-other', name: 'Haystack Arms', ffl: '8-88-888-88-8B-88888', city: 'Mesa', state: 'AZ' }
    ]
  });

  for (const item of [
    { tab: 'ammo', query: 'Needle Ammo', wanted: 'Needle Ammo', unwanted: 'Haystack Ammo' },
    { tab: 'accessories', query: 'Needle Optic', wanted: 'Needle Optic', unwanted: 'Haystack Sling' },
    { tab: 'wishlist', query: 'Needle Works', wanted: 'Needle Works', unwanted: 'Haystack Works' },
    { tab: 'dealers', query: 'Needle Arms', wanted: 'Needle Arms', unwanted: 'Haystack Arms' }
  ]) {
    await selectTab(page, item.tab);
    await page.locator('#searchBox').fill(item.query);
    const results = visibleResults(page);
    await expect(results).toContainText(item.wanted);
    await expect(results).not.toContainText(item.unwanted);
  }
});

test('NFA add starts as NFA while sold or transferred has no add path', async ({ page }) => {
  await openApp(page);

  await selectTab(page, 'nfa');
  const nfaAction = page.locator('#pageAddBtn:visible, #addBtn:visible').first();
  await nfaAction.click();
  await expect(page.locator('#formModal')).toHaveClass(/open/);
  await expect(page.locator('#fIsNFA')).toBeChecked();
  await expect(page.locator('#nfaFields')).toBeVisible();
  await expect(page.locator('#fStatus')).toHaveValue(/Active/i);
  await page.evaluate(() => closeModal());

  await selectTab(page, 'disposed');
  expect(await page.locator('#pageAddBtn:visible, #addBtn:visible').count()).toBe(0);
  await expect(page.locator('#bnFab')).toBeHidden();
});

test('inventory card open target is separate from its selection checkbox', async ({ page }) => {
  await openApp(page);
  await seedVault(page);

  const card = page.locator('.card').first();
  const checkbox = card.locator('input[type="checkbox"]');
  const openTarget = card.locator('button.card-hitarea, a.card-hitarea, [data-card-action="open"]');
  await expect(card).toBeVisible();
  await expect(checkbox).toBeVisible();
  expect(await openTarget.count()).toBe(1);
  await expect(openTarget).toHaveAttribute('aria-label', /open|view|detail|Example Armory|Long Profile/i);

  const separation = await card.evaluate(element => {
    const selection = element.querySelector('input[type="checkbox"]');
    const target = element.querySelector('button.card-hitarea, a.card-hitarea, [data-card-action="open"]');
    return {
      cardHasClickAttribute: element.hasAttribute('onclick'),
      selectionInsideOpenTarget: Boolean(target && selection && target.contains(selection))
    };
  });
  expect(separation.cardHasClickAttribute).toBe(false);
  expect(separation.selectionInsideOpenTarget).toBe(false);

  await checkbox.click();
  await expect(checkbox).toBeChecked();
  await expect(page.locator('#detailView')).not.toHaveClass(/open/);
  await openTarget.click();
  await expect(page.locator('#detailView')).toHaveClass(/open/);
});

test('visible application text never renders below 12 pixels', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await openApp(page);
  await seedVault(page);

  const violations = await page.evaluate(() => {
    const root = document.getElementById('appRoot');
    const visible = element => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0 && rect.width > 0 && rect.height > 0;
    };
    const describe = element => {
      const id = element.id ? `#${element.id}` : '';
      const classes = [...element.classList].slice(0, 2).map(value => `.${value}`).join('');
      return `${element.tagName.toLowerCase()}${id}${classes}`;
    };
    const failures = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const text = walker.currentNode.textContent.replace(/\s+/g, ' ').trim();
      const element = walker.currentNode.parentElement;
      if (!text || !element || element.closest('script,style,svg,[hidden],[aria-hidden="true"],.sr-only') || !visible(element)) continue;
      const size = Number.parseFloat(getComputedStyle(element).fontSize);
      if (size < 11.9) failures.push({ selector: describe(element), size, text: text.slice(0, 45) });
    }
    root.querySelectorAll('input:not([type="hidden"]), select, textarea').forEach(element => {
      if (!visible(element)) return;
      const size = Number.parseFloat(getComputedStyle(element).fontSize);
      if (size < 11.9) failures.push({ selector: describe(element), size, text: element.getAttribute('placeholder') || element.getAttribute('aria-label') || '' });
    });
    return failures.slice(0, 30);
  });

  expect(violations, `Undersized visible text:\n${JSON.stringify(violations, null, 2)}`).toEqual([]);
});

test('persistent mobile controls provide at least 44 by 44 pixel touch targets', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openApp(page);
  await seedVault(page);

  const undersized = await page.evaluate(() => {
    const selectors = [
      '.header button',
      '.file-status-bar button',
      '.sticky-top button',
      '.sticky-top input:not([type="hidden"])',
      '.sticky-top select',
      '.bottom-nav button'
    ].join(',');
    return [...document.querySelectorAll(selectors)].flatMap(element => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      if (style.display === 'none' || style.visibility === 'hidden' || rect.width === 0 || rect.height === 0 || element.disabled) return [];
      if (rect.width >= 43.5 && rect.height >= 43.5) return [];
      return [{
        control: element.id ? `#${element.id}` : `${element.tagName.toLowerCase()}.${[...element.classList].join('.')}`,
        width: Math.round(rect.width * 10) / 10,
        height: Math.round(rect.height * 10) / 10,
        label: element.getAttribute('aria-label') || element.textContent.trim().slice(0, 35)
      }];
    });
  });

  expect(undersized, `Undersized touch targets:\n${JSON.stringify(undersized, null, 2)}`).toEqual([]);
});

test('mobile forms and details hide bottom navigation while open', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openApp(page);
  await seedVault(page);
  const bottomNav = page.locator('#bottomNav');
  await expect(bottomNav).toBeVisible();

  await page.evaluate(() => openAddModal());
  await expect(page.locator('#formModal')).toHaveClass(/open/);
  await expect(bottomNav).toBeHidden();
  await page.evaluate(() => closeModal());
  await expect(bottomNav).toBeVisible();

  await page.evaluate(() => openDetail('firearm-fixture'));
  await expect(page.locator('#detailView')).toHaveClass(/open/);
  await expect(bottomNav).toBeHidden();
  await page.evaluate(() => closeDetail());
  await expect(bottomNav).toBeVisible();
});

test('firearm details use two desktop columns and a full-screen mobile surface', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openApp(page);
  await seedVault(page);
  await page.evaluate(() => openDetail('firearm-fixture'));

  const desktop = await page.evaluate(() => {
    const panel = document.querySelector('.detail-panel').getBoundingClientRect();
    const image = document.querySelector('.detail-img-container').getBoundingClientRect();
    const body = document.querySelector('.detail-body').getBoundingClientRect();
    return { panel, image, body, display: getComputedStyle(document.querySelector('.detail-panel')).display };
  });
  expect(desktop.display).toBe('grid');
  expect(desktop.image.width).toBeGreaterThan(280);
  expect(desktop.body.width).toBeGreaterThan(380);
  expect(Math.abs(desktop.image.right - desktop.body.left)).toBeLessThanOrEqual(3);
  expect(Math.abs(desktop.image.top - desktop.body.top)).toBeLessThanOrEqual(3);

  await page.evaluate(() => closeDetail());
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => openDetail('firearm-fixture'));
  const mobile = await page.evaluate(() => {
    const panel = document.querySelector('.detail-panel').getBoundingClientRect();
    const image = document.querySelector('.detail-img-container').getBoundingClientRect();
    const body = document.querySelector('.detail-body').getBoundingClientRect();
    return { panel, image, body, viewport: { width: innerWidth, height: innerHeight } };
  });
  expect(mobile.panel.width).toBeGreaterThanOrEqual(mobile.viewport.width - 2);
  expect(mobile.panel.height).toBeGreaterThanOrEqual(mobile.viewport.height - 2);
  expect(mobile.panel.x).toBeLessThanOrEqual(1);
  expect(mobile.panel.y).toBeLessThanOrEqual(1);
  expect(mobile.body.top).toBeGreaterThanOrEqual(mobile.image.bottom - 2);
});

test('settings are divided into navigable task-focused categories', async ({ page }) => {
  await openApp(page);
  await page.evaluate(() => openSettingsModal());
  await expect(page.locator('#settingsModal')).toHaveClass(/open/);

  const buttons = page.locator('.settings-nav button');
  const labels = (await buttons.allTextContents()).map(value => value.replace(/\s+/g, ' ').trim());
  // Category names may be combined (for example, diagnostics can live under
  // Data & recovery), but each core task needs a discoverable destination.
  const categories = [/account|security/i, /preferences/i, /data|recovery/i, /sharing/i, /activity/i];
  expect(labels.length).toBeGreaterThanOrEqual(categories.length);
  for (const category of categories) {
    expect(labels.some(label => category.test(label)), `Missing settings category ${category}`).toBe(true);
  }

  for (let index = 0; index < await buttons.count(); index += 1) {
    const button = buttons.nth(index);
    await button.click();
    const selected = await button.evaluate(element => element.classList.contains('active') || element.getAttribute('aria-selected') === 'true' || element.getAttribute('aria-current') === 'page');
    expect(selected, `Settings control "${(await button.textContent()).trim()}" should expose its selected state`).toBe(true);
    const visiblePanels = page.locator('.settings-panel:visible');
    expect(await visiblePanels.count()).toBe(1);
    await expect(visiblePanels.first().locator('h2, h3').first()).not.toBeEmpty();
  }
});

test('actual card, table, detail, and shared images use contain fitting', async ({ page }) => {
  await openApp(page);
  await seedVault(page);

  await expect(page.locator('.card-img').first()).toHaveCSS('object-fit', 'contain');
  await page.evaluate(() => setView('table'));
  await expect(page.locator('.data-table .thumb').first()).toHaveCSS('object-fit', 'contain');
  await page.evaluate(() => openDetail('firearm-fixture'));
  await expect(page.locator('.detail-img').first()).toHaveCSS('object-fit', 'contain');

  await page.goto('/share.html');
  await page.evaluate(image => {
    const fixture = document.createElement('img');
    fixture.className = 'sv-img';
    fixture.alt = 'Wide shared firearm fixture';
    fixture.src = image;
    document.body.appendChild(fixture);
  }, WIDE_IMAGE);
  await expect(page.locator('.sv-img')).toHaveCSS('object-fit', 'contain');
});

test('mobile cards stay in the viewport and wide tables scroll only inside their region', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openApp(page);
  await seedVault(page, {
    firearms: [
      firearm(),
      firearm({ id: 'firearm-second', make: 'Second Armory', model: 'Compact', serial: 'UX-1002', images: [] })
    ],
    ammo: [
      { id: 'ammo-one', brand: 'Example', caliber: '9mm', quantity: 100, pricePerRound: 0.3, location: 'Safe' },
      { id: 'ammo-two', brand: 'Another', caliber: '5.56', quantity: 200, pricePerRound: 0.5, location: 'Cabinet' }
    ]
  });

  const cards = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    pageWidth: document.documentElement.scrollWidth,
    boxes: [...document.querySelectorAll('.card')].map(element => {
      const rect = element.getBoundingClientRect();
      return { left: rect.left, right: rect.right, width: rect.width };
    })
  }));
  expect(cards.pageWidth).toBeLessThanOrEqual(cards.viewport + 1);
  expect(cards.boxes.length).toBeGreaterThan(0);
  for (const box of cards.boxes) {
    expect(box.left).toBeGreaterThanOrEqual(-1);
    expect(box.right).toBeLessThanOrEqual(cards.viewport + 1);
  }

  await page.evaluate(() => setView('table'));
  await expect(page.locator('.table-container')).toHaveAttribute('role', 'region');
  const firearmTable = await page.evaluate(() => {
    const table = document.querySelector('.table-container');
    return {
      viewport: document.documentElement.clientWidth,
      pageWidth: document.documentElement.scrollWidth,
      client: table.clientWidth,
      scroll: table.scrollWidth,
      tabIndex: table.tabIndex
    };
  });
  expect(firearmTable.pageWidth).toBeLessThanOrEqual(firearmTable.viewport + 1);
  expect(firearmTable.scroll).toBeGreaterThan(firearmTable.client);
  expect(firearmTable.tabIndex).toBe(0);

  await selectTab(page, 'ammo');
  const ammoTable = await page.evaluate(() => {
    const table = document.querySelector('.table-container');
    return {
      viewport: document.documentElement.clientWidth,
      pageWidth: document.documentElement.scrollWidth,
      client: table.clientWidth,
      scroll: table.scrollWidth
    };
  });
  expect(ammoTable.pageWidth).toBeLessThanOrEqual(ammoTable.viewport + 1);
  expect(ammoTable.scroll).toBeGreaterThan(ammoTable.client);
});

test('skipping first-run setup persists for the signed-in account after reload', async ({ page }) => {
  await mockSignedInEmptySupabase(page);
  await page.goto('/index.html');
  await expect(page.locator('#appRoot')).toBeVisible({ timeout: 20000 });
  await expect(page.locator('#firstRunPanel')).toBeVisible({ timeout: 20000 });

  await page.locator('#firstRunSkip').click();
  await expect(page.locator('#firstRunPanel')).toBeHidden();
  await page.reload();

  await expect(page.locator('#appRoot')).toBeVisible({ timeout: 20000 });
  await expect(page.locator('#firstRunPanel')).toBeHidden();
});

test('new-firearm form keeps a quiet device draft until the record is saved', async ({ page }) => {
  await openApp(page);
  await page.evaluate(() => openAddModal());
  await page.locator('#fMake').fill('Draft Armory');
  await page.locator('#fModel').fill('Work in progress');
  await expect(page.locator('#formDraftStatus')).toContainText(/draft saved/i, { timeout: 3000 });

  await page.evaluate(() => closeModal());
  await page.evaluate(() => openAddModal());
  await expect(page.locator('#fMake')).toHaveValue('Draft Armory');
  await expect(page.locator('#fModel')).toHaveValue('Work in progress');
  await expect(page.locator('#formDraftStatus')).toContainText(/restored/i);
});

test('recovery read failures are not mislabeled as an empty backup history', async ({ page }) => {
  await openApp(page);
  await page.evaluate(async () => {
    CloudSync.uid = 'recovery-error-user';
    window.VaultDataSafety = {
      ...window.VaultDataSafety,
      listBackups: async () => { throw new Error('simulated storage read failure'); }
    };
    await openBackupModal();
  });
  await expect(page.locator('#backupList')).toContainText(/could not be read/i);
  await expect(page.locator('#backupList')).not.toContainText(/no recovery points yet/i);
  await expect(page.locator('#backupList button')).toContainText(/retry/i);
});
