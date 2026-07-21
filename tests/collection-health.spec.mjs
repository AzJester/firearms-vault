import { test, expect } from '@playwright/test';

test.use({ serviceWorkers: 'block' });

test.beforeEach(async ({ page }) => {
  await page.goto('/index.html');
  await expect.poll(() => page.evaluate(() => typeof window.VaultDataQuality?.analyzeCollectionHealth)).toBe('function');
  await page.evaluate(() => {
    document.getElementById('authOverlay').style.display = 'none';
    document.getElementById('firstRunPanel').style.display = 'none';
    document.getElementById('appRoot').style.display = '';
  });
});
test('health report is deterministic, non-mutating, and finds collection inconsistencies', async ({ page }) => {
  const result = await page.evaluate(() => {
    const source = {
      firearms: [
        {
          id: 'one', make: '  Colt ', model: ' M4  ', caliber: ' 5.56 ', barrel: '16 in',
          serial: ' ABC 123 ', tags: ['Duty', ' duty '], images: ['photo-one'],
          documents: [{ id: 'document-one', name: 'Form.pdf' }]
        },
        {
          id: 'two', make: 'colt', model: 'M4', caliber: '5.56', barrel: '16"',
          serial: 'abc 123', tags: ['DUTY'], images: [], documents: []
        },
        {
          id: 'three', make: '', model: '', caliber: '', barrel: 'unknown', serial: '', tags: [],
          images: ['photo-three', 'photo-three'], documents: [{ id: 'same' }, { id: 'same' }]
        }
      ],
      ammo: [], accessories: [], wishlist: [], dealers: []
    };
    const before = JSON.stringify(source);
    const report = VaultDataQuality.analyzeCollectionHealth(source);
    const unchanged = before === JSON.stringify(source);
    const outcome = VaultDataQuality.applySafeFixes(source);
    return {
      unchanged,
      report,
      changed: outcome.changed,
      after: source,
      remaining: VaultDataQuality.analyzeCollectionHealth(source).totals.safeFixes
    };
  });

  expect(result.unchanged).toBe(true);
  expect(result.report.facets.manufacturers.unique).toBe(1);
  expect(result.report.facets.manufacturers.missing).toBe(1);
  expect(result.report.facets.calibers.unique).toBe(1);
  expect(result.report.facets.barrels.values.find(value => value.label === '16"')?.count).toBe(2);
  expect(result.report.facets.tags.unique).toBe(1);
  expect(result.report.totals.duplicateGroups).toBe(1);
  expect(result.report.coverage.photos).toMatchObject({ complete: 2, total: 3, percent: 67 });
  expect(result.report.coverage.documents).toMatchObject({ complete: 2, total: 3, percent: 67 });
  expect(result.report.issues.map(issue => issue.title)).toEqual(expect.arrayContaining([
    'Possible duplicate serial number', 'Duplicate photo reference', 'Document identity needs repair',
    'Manufacturer is missing', 'Model is missing', 'Caliber or gauge is missing', 'Review barrel formatting'
  ]));
  expect(result.changed).toBeGreaterThan(0);
  expect(result.after.firearms[0].barrel).toBe('16"');
  expect(result.after.firearms[0].tags).toHaveLength(1);
  expect(result.after.firearms[0].serial).toBe(' ABC 123 ');
  expect(result.remaining).toBe(0);
});

test('known typos are guided fixes while uncertain aliases stay review-only', async ({ page }) => {
  const result = await page.evaluate(() => {
    const source = {
      firearms: [
        { id: 'known', make: 'Sprinfield', model: 'Example', caliber: '9mm', barrel: '4', tags: ['Supressor'], images: [] },
        { id: 'review', make: 'H&K', model: 'Example', caliber: '9mm', barrel: '5"', tags: ['can'], images: [] }
      ],
      ammo: [], accessories: [], wishlist: [], dealers: []
    };
    const report = VaultDataQuality.analyzeCollectionHealth(source);
    const safe = report.safeFixes.map(fix => ({ recordId: fix.recordId, field: fix.field, from: fix.from, to: fix.to, reason: fix.reason }));
    const suggestions = report.issues.filter(issue => Array.isArray(issue.suggestions));
    VaultDataQuality.applySafeFixes(source);
    return { safe, suggestions, after: source };
  });

  expect(result.safe).toEqual(expect.arrayContaining([
    expect.objectContaining({ recordId: 'known', field: 'make', to: 'Springfield Armory', reason: 'dictionary' }),
    expect.objectContaining({ recordId: 'known', field: 'tags', to: ['Suppressor'], reason: 'dictionary' })
  ]));
  expect(result.suggestions).toEqual(expect.arrayContaining([
    expect.objectContaining({ recordId: 'review', field: 'make', suggestions: ['Heckler & Koch'] }),
    expect.objectContaining({ recordId: 'review', field: 'tags', suggestions: ['Suppressor'] })
  ]));
  expect(result.after.firearms[0]).toMatchObject({ make: 'Springfield Armory', tags: ['Suppressor'], barrel: '4"' });
  expect(result.after.firearms[1]).toMatchObject({ make: 'H&K', tags: ['can'] });
});

test('only explicit sync failures are reported as unavailable attachments', async ({ page }) => {
  const result = await page.evaluate(() => {
    const source = {
      firearms: [{
        id: 'media-record', make: 'Example', model: 'Media', caliber: '9mm', barrel: '4"',
        images: ['remote-photo'], documents: [{ id: 'license', name: 'License.pdf' }],
        receipt: '@media:receipt:firearm:media-record', stampPdf: '@media:stamp:firearm:media-record'
      }],
      ammo: [], accessories: [], wishlist: [], dealers: []
    };
    const withoutFailures = VaultDataQuality.analyzeCollectionHealth(source);
    const withFailures = VaultDataQuality.analyzeCollectionHealth(source, { missingMedia: [
      { key: 'remote-photo' }, { key: 'doc:media-record:license' },
      { key: 'receipt:firearm:media-record' }, { key: 'not-referenced-anymore' }
    ] });
    return {
      without: withoutFailures.totals.missingAttachments,
      integrityWithout: withoutFailures.coverage.attachmentIntegrity.percent,
      with: withFailures.totals.missingAttachments,
      mediaKeys: withFailures.issues.filter(issue => issue.mediaKey).map(issue => issue.mediaKey).sort()
    };
  });

  expect(result.without).toBe(0);
  expect(result.integrityWithout).toBe(100);
  expect(result.with).toBe(3);
  expect(result.mediaKeys).toEqual(['doc:media-record:license', 'receipt:firearm:media-record', 'remote-photo']);
});

test('controller renders untrusted values as text and auto-saves safe cleanup', async ({ page }) => {
  await page.evaluate(() => {
    const fixture = document.createElement('section');
    fixture.id = 'healthModal';
    fixture.innerHTML = `
      <button type="button" data-health-close>Close</button>
      <output id="healthScore"></output><p id="healthSummary"></p><time id="healthUpdatedAt"></time>
      <select id="healthFilter"><option value="all">All</option><option value="warnings">Warnings</option></select>
      <div id="healthMetrics"></div><div id="healthIssues"></div><button id="healthApplyBtn" type="button"></button>`;
    document.body.append(fixture);
    db = {
      version: 3, encrypted: false, backups: [], settings: {}, auditTrail: [], valueHistory: [],
      firearms: [{
        id: 'unsafe-record', make: '  <img src=x onerror="window.__healthXss=1">  ', model: '<script>window.__healthXss=2</script>',
        caliber: '', barrel: '', tags: ['Supressor'], images: [], documents: []
      }],
      ammo: [], accessories: [], wishlist: [], dealers: []
    };
  });
  await page.addScriptTag({ url: '/js/collection-health.js' });

  const renderResult = await page.evaluate(() => {
    openCollectionHealth();
    return {
      open: document.getElementById('healthModal').classList.contains('open'),
      issueText: document.getElementById('healthIssues').textContent,
      injectedImages: document.querySelectorAll('#healthIssues img').length,
      injectedScripts: document.querySelectorAll('#healthIssues script').length,
      metrics: document.querySelectorAll('#healthMetrics .health-metric').length,
      button: document.getElementById('healthApplyBtn').textContent
    };
  });

  expect(renderResult.open).toBe(true);
  expect(renderResult.issueText).toContain('<img src=x');
  expect(renderResult.injectedImages).toBe(0);
  expect(renderResult.injectedScripts).toBe(0);
  expect(renderResult.metrics).toBe(9);
  expect(renderResult.button).toMatch(/Apply \d+ safe fix/);

  const applyResult = await page.evaluate(async () => {
    window.__healthCalls = { backup: 0, save: 0, audit: 0, render: 0, toasts: [] };
    CloudSync.uid = 'health-owner';
    window.VaultDataSafety = { createBackup: async () => { window.__healthCalls.backup++; } };
    window.saveData = async () => { window.__healthCalls.save++; return true; };
    window.addAuditEntry = () => { window.__healthCalls.audit++; };
    window.render = () => { window.__healthCalls.render++; };
    window.toast = (message, type) => window.__healthCalls.toasts.push({ message, type });
    const outcome = await applyCollectionHealthFixes();
    return { outcome, calls: window.__healthCalls, firearm: db.firearms[0] };
  });

  expect(applyResult.outcome).toMatchObject({ ok: true, status: 'saved' });
  expect(applyResult.calls).toMatchObject({ backup: 1, save: 1, audit: 1, render: 1 });
  expect(applyResult.calls.toasts.at(-1)).toMatchObject({ type: 'success' });
  expect(applyResult.firearm.tags).toEqual(['Suppressor']);
  expect(applyResult.firearm.make).toBe('<img src=x onerror="window.__healthXss=1">');
});
