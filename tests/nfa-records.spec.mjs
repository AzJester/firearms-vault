import { test, expect } from '@playwright/test';

test.use({ serviceWorkers: 'block' });

const storageKey = 'nfa-records-test-database';
const pdf = 'data:application/pdf;base64,JVBERi0xLjQKJSByZWdyZXNzaW9uIHRlc3QK';
const legacyApproval = {
  id: 'legacy-sbr', make: 'Legacy Arms', model: 'Historical SBR', serial: 'HISTORICAL-1',
  type: 'Rifle', caliber: '5.56', condition: 'Good', status: 'Active', isNFA: true,
  nfaType: 'SBR', formType: 'Form 4', stampStatus: 'Approved', regType: 'Trust',
  dateSubmitted: '2024-01-12', dateApproved: '2024-04-03',
  stampPdf: pdf, stampPdfName: 'historical-approved-stamp.pdf',
  documents: [{ id: 'legacy-document', name: 'original-form-4.pdf', type: 'application/pdf', data: pdf }],
  images: [], tags: ['Historical'], customFields: [], maintenanceLog: [], notes: ''
};

async function initializeTestApp(page, restore = false) {
  await expect.poll(() => page.evaluate(() => typeof window.openAddModal)).toBe('function');
  await page.evaluate(async ({ storageKey, restore }) => {
    await openImageDB();
    await openStateDB();
    document.getElementById('authOverlay').style.display = 'none';
    document.getElementById('firstRunPanel').style.display = 'none';
    document.getElementById('appRoot').style.display = '';
    const saved = restore ? sessionStorage.getItem(storageKey) : null;
    db = saved ? JSON.parse(saved) : {
      version: 3, encrypted: false, firearms: [], ammo: [], accessories: [], wishlist: [], dealers: [],
      backups: [], settings: {}, auditTrail: [], valueHistory: []
    };
    // Exercise the actual form save and edit logic with test-only local persistence.
    window.saveData = async () => {
      sessionStorage.setItem(storageKey, JSON.stringify(db));
      return true;
    };
    currentTab = 'all';
    currentView = 'cards';
    render();
  }, { storageKey, restore });
}

async function expectBlankApprovals(page) {
  for (const selector of ['#fFormType', '#fStampStatus', '#fRegType', '#fDateSubmitted', '#fDateApproved']) {
    await expect(page.locator(selector)).toHaveValue('');
  }
}

async function expectHistoricalApprovals(page) {
  await expect(page.locator('#fFormType')).toHaveValue('Form 4');
  await expect(page.locator('#fStampStatus')).toHaveValue('Approved');
  await expect(page.locator('#fRegType')).toHaveValue('Trust');
  await expect(page.locator('#fDateSubmitted')).toHaveValue('2024-01-12');
  await expect(page.locator('#fDateApproved')).toHaveValue('2024-04-03');
}

test.beforeEach(async ({ page }) => {
  // Never contact production services, even if application startup changes.
  await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1'
    ? route.continue() : route.abort());
  await page.goto('/index.html');
  await initializeTestApp(page);
});

test('firearm, collection filter, and wishlist selectors offer SBR, SBS, and the compatible suppressor value', async ({ page }) => {
  for (const selector of ['#fType', '#filterType', '#wType']) {
    await expect(page.locator(`${selector} option[value="SBR"]`)).toHaveText(/SBR/);
    await expect(page.locator(`${selector} option[value="SBS"]`)).toHaveText(/SBS/);
    await expect(page.locator(`${selector} option[value="Silencer"]`)).toHaveText('Suppressor / Silencer');
  }

  await page.evaluate(() => openAddModal());
  await expectBlankApprovals(page);
  await page.locator('#fType').selectOption('SBR');
  await expect(page.locator('#nfaGuidance')).toBeVisible();
  await expect(page.locator('#nfaGuidance')).toContainText(/state.*local/i);
  await expect(page.locator('#nfaGuidance')).toContainText(/Form\s*(?:5320\.)?20/i);
  await expect(page.locator('#nfaGuidance a[href*="atf.gov"]').first()).toHaveAttribute('href', /^https:\/\/(?:www\.)?atf\.gov\//);
});

for (const [type, nfaType] of [['SBR', 'SBR'], ['SBS', 'SBS'], ['Silencer', 'Suppressor']]) {
  test(`${type} saves and reopens with its category and without an invented approval status`, async ({ page }) => {
    await page.evaluate(() => openAddModal());
    await page.locator('#fMake').fill('Test Arms');
    await page.locator('#fModel').fill(`${type} Record`);
    await page.locator('#fType').selectOption(type);

    await expect(page.locator('#fIsNFA')).toBeChecked();
    await expect(page.locator('#nfaFields')).toBeVisible();
    await expect(page.locator('#fNFAType')).toHaveValue(nfaType);
    await expectBlankApprovals(page);
    await page.locator('#saveBtn').click();
    await expect(page.locator('#formModal')).not.toHaveClass(/\bopen\b/);

    const saved = await page.evaluate(() => structuredClone(db.firearms[0]));
    expect(saved).toMatchObject({
      type, isNFA: true, nfaType, formType: '', stampStatus: '', regType: '',
      dateSubmitted: '', dateApproved: '', stampPdf: null, documents: []
    });

    await page.reload();
    await initializeTestApp(page, true);
    await page.evaluate(id => openEditModal(id), saved.id);
    await expect(page.locator('#fType')).toHaveValue(type);
    await expect(page.locator('#fNFAType')).toHaveValue(nfaType);
    await expect(page.locator('#fIsNFA')).toBeChecked();
    await expectBlankApprovals(page);

    await page.locator('#fModel').fill(`${type} Record Updated`);
    await page.locator('#saveBtn').click();
    await expect(page.locator('#formModal')).not.toHaveClass(/\bopen\b/);
    expect(await page.evaluate(() => db.firearms[0])).toMatchObject({
      id: saved.id, type, nfaType, formType: '', stampStatus: '', regType: '',
      model: `${type} Record Updated`
    });
    await expect(page.locator('#cardGrid .stamp-badge')).toHaveCount(0);
  });
}

test('category filters find new and historical SBR/SBS records without changing stored types', async ({ page }) => {
  await page.evaluate(() => {
    db.firearms = [
      { id: 'new-sbr', type: 'SBR', isNFA: true, nfaType: 'SBR' },
      { id: 'old-sbr', type: 'Rifle', isNFA: true, nfaType: 'SBR' },
      { id: 'new-sbs', type: 'SBS', isNFA: true, nfaType: 'SBS' },
      { id: 'old-sbs', type: 'Shotgun', isNFA: true, nfaType: 'SBS' },
      { id: 'suppressor', type: 'Silencer', isNFA: true, nfaType: 'Suppressor' },
      { id: 'ordinary-rifle', type: 'Rifle', isNFA: false, nfaType: null },
      { id: 'stale-subtype', type: 'Rifle', isNFA: false, nfaType: 'SBR' }
    ].map(item => ({ ...item, make: 'Test Arms', model: item.id, status: 'Active', images: [], tags: [] }));
    render();
  });

  if (!await page.locator('#filterType').isVisible()) await page.locator('#filterBtn').click();
  for (const [type, ids] of [
    ['SBR', ['new-sbr', 'old-sbr']],
    ['SBS', ['new-sbs', 'old-sbs']],
    ['Silencer', ['suppressor']]
  ]) {
    await page.locator('#filterType').selectOption(type);
    await expect.poll(() => page.locator('#cardGrid [data-card-id]').evaluateAll(nodes => nodes.map(node => node.dataset.cardId).sort())).toEqual(ids);
  }
  expect(await page.evaluate(() => db.firearms.find(item => item.id === 'old-sbr').type)).toBe('Rifle');
  expect(await page.evaluate(() => db.firearms.find(item => item.id === 'old-sbs').type)).toBe('Shotgun');
});

test('editing a historical approval retains its original type, dates, stamp, and documents', async ({ page }) => {
  await page.evaluate(record => { db.firearms = [record]; openEditModal(record.id); }, legacyApproval);
  await expect(page.locator('#fType')).toHaveValue('Rifle');
  await expect(page.locator('#fNFAType')).toHaveValue('SBR');
  await expectHistoricalApprovals(page);
  await page.locator('#fModel').fill('Historical SBR Updated');
  await page.locator('#saveBtn').click();
  await expect(page.locator('#formModal')).not.toHaveClass(/\bopen\b/);

  const saved = await page.evaluate(() => structuredClone(db.firearms[0]));
  expect(saved).toMatchObject({ ...legacyApproval, model: 'Historical SBR Updated' });
  await page.reload();
  await initializeTestApp(page, true);
  await page.evaluate(id => openEditModal(id), legacyApproval.id);
  await expect(page.locator('#fType')).toHaveValue('Rifle');
  await expectHistoricalApprovals(page);
  expect(await page.evaluate(() => ({ stamp: tempStampPdf, name: tempStampPdfName, documents: tempDocs }))).toEqual({
    stamp: legacyApproval.stampPdf, name: legacyApproval.stampPdfName, documents: legacyApproval.documents
  });
});

test('an explicit subtype change synchronizes firearm type and preserves historical approval attachments', async ({ page }) => {
  await page.evaluate(record => { db.firearms = [record]; openEditModal(record.id); }, legacyApproval);

  for (const [nfaType, type] of [['SBS', 'SBS'], ['Suppressor', 'Silencer'], ['SBR', 'SBR']]) {
    await page.locator('#fNFAType').selectOption(nfaType);
    await expect(page.locator('#fType')).toHaveValue(type);
    await expectHistoricalApprovals(page);
  }
  await page.locator('#saveBtn').click();
  await expect(page.locator('#formModal')).not.toHaveClass(/\bopen\b/);
  expect(await page.evaluate(() => db.firearms[0])).toMatchObject({ ...legacyApproval, type: 'SBR' });
});

test('machine gun, AOW, and destructive device subtypes replace a covered main category with Other', async ({ page }) => {
  await page.evaluate(() => openAddModal());
  await page.locator('#fMake').fill('Test Arms');
  await page.locator('#fModel').fill('Explicit Subtype');
  for (const [type, nfaType] of [['SBR', 'Machine Gun'], ['SBS', 'AOW'], ['Silencer', 'Destructive Device']]) {
    await page.locator('#fType').selectOption(type);
    await page.locator('#fNFAType').selectOption(nfaType);
    await expect(page.locator('#fType')).toHaveValue('Other');
    await expect(page.locator('#fIsNFA')).toBeChecked();
    await expectBlankApprovals(page);
  }
  await page.locator('#saveBtn').click();
  await expect(page.locator('#formModal')).not.toHaveClass(/\bopen\b/);
  expect(await page.evaluate(() => db.firearms[0])).toMatchObject({
    type: 'Other', isNFA: true, nfaType: 'Destructive Device', stampStatus: ''
  });
});

test('a submitted date with no tracked approval does not create pending reminders or waiting summaries', async ({ page }) => {
  const reminders = await page.evaluate(() => {
    db.firearms = [
      { id: 'untracked', model: 'Untracked Record', stampStatus: '' },
      { id: 'pending', model: 'Pending Record', stampStatus: 'Pending' },
      { id: 'submitted', model: 'Submitted Record', stampStatus: 'Submitted' },
      { id: 'denied', model: 'Denied Record', stampStatus: 'Denied' }
    ].map(item => ({
      ...item, make: 'Test Arms', type: 'SBR', isNFA: true, nfaType: 'SBR',
      dateSubmitted: '2020-01-01', dateApproved: '', status: 'Active', images: [], tags: []
    }));
    currentTab = 'dashboard';
    render();
    return computeReminders().map(item => item.itemId).sort();
  });
  expect(reminders).toEqual(['pending', 'submitted']);

  const nfaSummary = page.locator('#dashboardContainer .dash-card').filter({ hasText: 'NFA Items (4)' });
  await expect(nfaSummary).toContainText('Pending: 2');
  await expect(nfaSummary).toContainText('Pending Record');
  await expect(nfaSummary).toContainText('Submitted Record');
  await expect(nfaSummary).not.toContainText('Untracked Record');
  await expect(nfaSummary).not.toContainText('Denied Record');

  await page.evaluate(() => openDetail('untracked'));
  await expect(page.locator('#detailView')).not.toContainText('days so far');
});
