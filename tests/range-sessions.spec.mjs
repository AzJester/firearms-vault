import { test, expect } from '@playwright/test';

test.use({ serviceWorkers: 'block' });

async function setup(page) {
  await page.goto('/index.html');
  await page.waitForFunction(() => window.VaultRange && window.VaultCollection);
  await page.evaluate(() => {
    document.getElementById('authOverlay').style.display = 'none';
    document.getElementById('firstRunPanel').style.display = 'none';
    document.getElementById('appRoot').style.display = '';
    setPrivacyMode(false);
    db = {
      version: 3, encrypted: false,
      firearms: [{ id: 'range-f1', make: 'Test', model: 'One', serial: 'TEST-1', caliber: 'A', status: 'Active', roundCount: 100,
        maintenanceIntervalRounds: 50, maintenanceIntervalDays: null, maintenanceBaselineRounds: 100,
        images: [], tags: [], customFields: [], maintenanceLog: [{ id: 'service1', date: '2026-01-01', type: 'Inspection', roundCount: '80', description: '' }] }],
      ammo: [{ id: 'range-a1', caliber: 'B', brand: 'Lot one', quantity: '200', notes: '' }, { id: 'range-a2', caliber: 'A', brand: 'Other lot', quantity: '10', notes: '' }],
      accessories: [], wishlist: [], dealers: [], backups: [], settings: {}, auditTrail: [], valueHistory: []
    };
    window.__rangeSaveCalls = 0;
    window.saveData = async () => { window.__rangeSaveCalls += 1; localStorage.setItem('__rangeTestPersisted', JSON.stringify(db)); return true; };
    VaultRange.init();
  });
}

async function openSession(page, rounds = '30') {
  await page.evaluate(() => VaultRange.open('range-f1'));
  await page.locator('#rsAmmo').selectOption('range-a1');
  await page.locator('#rsRounds').fill(rounds);
}

test.beforeEach(async ({ page }) => { await setup(page); });

test('a range session saves both counts once, survives reload, and undo restores its original lot', async ({ page }) => {
  await openSession(page);
  await expect(page.locator('#rsAmmo option')).toHaveCount(3);
  await page.locator('#rsNotes').fill('<img src=x onerror=alert(1)> Plain notes');
  await page.locator('#rangeSessionSaveBtn').click();
  await expect(page.locator('#rangeSessionModal')).not.toHaveClass(/open/);
  let result = await page.evaluate(() => ({ firearm: structuredClone(db.firearms[0]), ammo: structuredClone(db.ammo), saves: window.__rangeSaveCalls, audit: db.auditTrail.length }));
  expect(result.firearm.roundCount).toBe(130);
  expect(result.ammo[0].quantity).toBe('170');
  expect(result.ammo[1].quantity).toBe('10');
  expect(result.firearm.rangeSessions).toHaveLength(1);
  expect(result.firearm.maintenanceLog).toEqual([{ id: 'service1', date: '2026-01-01', type: 'Inspection', roundCount: '80', description: '' }]);
  expect(result.saves).toBe(1);
  expect(result.audit).toBeGreaterThan(0);
  await expect(page.locator('.range-session-entry img')).toHaveCount(0);
  await expect(page.locator('.range-session-notes')).toContainText('<img src=x onerror=alert(1)>');

  await page.reload();
  await page.waitForFunction(() => window.VaultRange && window.VaultCollection);
  await page.evaluate(() => {
    document.getElementById('authOverlay').style.display = 'none';
    document.getElementById('firstRunPanel').style.display = 'none';
    document.getElementById('appRoot').style.display = '';
    db = JSON.parse(localStorage.getItem('__rangeTestPersisted'));
    window.saveData = async () => { localStorage.setItem('__rangeTestPersisted', JSON.stringify(db)); return true; };
    openDetail('range-f1');
  });
  await expect(page.locator('.range-session-entry')).toHaveCount(1);
  await page.getByRole('button', { name: 'Undo session', exact: true }).click();
  await expect(page.locator('.range-session-entry')).toContainText('Undone');
  result = await page.evaluate(() => ({ firearm: structuredClone(db.firearms[0]), ammo: structuredClone(db.ammo), audit: db.auditTrail.length }));
  expect(result.firearm.roundCount).toBe(100);
  expect(result.ammo[0].quantity).toBe('200');
  expect(result.ammo[1].quantity).toBe('10');
  expect(result.firearm.rangeSessions[0].undoneAt).toBeTruthy();
  expect(result.audit).toBeGreaterThan(1);
});

test('invalid and excessive rounds cannot change inventory', async ({ page }) => {
  await openSession(page, '201');
  await page.locator('#rangeSessionSaveBtn').click();
  await expect(page.locator('#rangeSessionStatus')).toContainText('only 200 rounds');
  for (const invalid of ['0', '-1', '1.5', '1e309', '']) {
    await page.locator('#rsRounds').fill(invalid);
    await page.locator('#rangeSessionForm').dispatchEvent('submit');
    await expect(page.locator('#rangeSessionStatus')).toContainText('positive whole number');
  }
  await page.locator('#rsRounds').fill('30');
  await page.evaluate(() => { document.getElementById('rsDate').value = ''; });
  await page.locator('#rangeSessionForm').dispatchEvent('submit');
  await expect(page.locator('#rangeSessionStatus')).toContainText('valid session date');
  await page.evaluate(() => {
    const date = new Date(); date.setDate(date.getDate() + 1);
    document.getElementById('rsDate').value = date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0');
  });
  await page.locator('#rangeSessionForm').dispatchEvent('submit');
  await expect(page.locator('#rangeSessionStatus')).toContainText('on or before today');
  const result = await page.evaluate(() => ({ count: db.firearms[0].roundCount, quantity: db.ammo[0].quantity, saves: window.__rangeSaveCalls }));
  expect(result).toEqual({ count: 100, quantity: '200', saves: 0 });
});

test('a failed save rolls both records back and retains the range form for retry', async ({ page }) => {
  await page.evaluate(() => {
    window.__rangeBefore = structuredClone(db);
    window.saveData = async () => false;
  });
  await openSession(page);
  await page.locator('#rsNotes').fill('Keep these notes');
  await page.locator('#rangeSessionSaveBtn').click();
  await expect(page.locator('#rangeSessionStatus')).toContainText('not saved');
  await expect(page.locator('#rangeSessionModal')).toHaveClass(/open/);
  await expect(page.locator('#rsNotes')).toHaveValue('Keep these notes');
  expect(await page.evaluate(() => ({ count: db.firearms[0].roundCount, quantity: db.ammo[0].quantity, sessions: db.firearms[0].rangeSessions || [], audits: db.auditTrail.length }))).toEqual({ count: 100, quantity: '200', sessions: [], audits: 0 });
  await page.evaluate(() => { window.saveData = async () => true; });
  await page.locator('#rangeSessionSaveBtn').click();
  await expect(page.locator('#rangeSessionModal')).not.toHaveClass(/open/);
  expect(await page.evaluate(() => db.firearms[0].rangeSessions.length)).toBe(1);
});

test('a second submit and closing the modal cannot interrupt an in-flight save', async ({ page }) => {
  await page.evaluate(() => {
    window.saveData = async () => {
      window.__rangeSaveCalls += 1;
      return new Promise(resolve => { window.__finishRangeSave = resolve; });
    };
  });
  await openSession(page);
  await page.evaluate(() => {
    document.getElementById('rangeSessionForm').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    document.getElementById('rangeSessionForm').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    VaultRange.close();
  });
  await expect(page.locator('#rangeSessionModal')).toHaveClass(/open/);
  await expect(page.locator('#rangeSessionSaveBtn')).toBeDisabled();
  expect(await page.evaluate(() => window.__rangeSaveCalls)).toBe(1);
  await page.evaluate(() => window.__finishRangeSave(true));
  await expect(page.locator('#rangeSessionModal')).not.toHaveClass(/open/);
  expect(await page.evaluate(() => ({ count: db.firearms[0].roundCount, quantity: db.ammo[0].quantity, sessions: db.firearms[0].rangeSessions.length }))).toEqual({ count: 130, quantity: '170', sessions: 1 });
});

test('undo is guarded against deleted ammunition and changed lifetime counts', async ({ page }) => {
  await openSession(page);
  await page.locator('#rangeSessionSaveBtn').click();
  await expect(page.locator('#rangeSessionModal')).not.toHaveClass(/open/);
  await page.evaluate(() => { db.firearms[0].roundCount = 200; });
  await page.getByRole('button', { name: 'Undo session', exact: true }).click();
  expect(await page.evaluate(() => ({ count: db.firearms[0].roundCount, quantity: db.ammo[0].quantity, undone: Boolean(db.firearms[0].rangeSessions[0].undoneAt) }))).toEqual({ count: 200, quantity: '170', undone: false });
  await page.evaluate(() => { db.firearms[0].roundCount = 130; db.ammo = db.ammo.filter(ammo => ammo.id !== 'range-a1'); });
  await page.getByRole('button', { name: 'Undo session', exact: true }).click();
  expect(await page.evaluate(() => ({ count: db.firearms[0].roundCount, ammo: db.ammo.length, undone: Boolean(db.firearms[0].rangeSessions[0].undoneAt) }))).toEqual({ count: 130, ammo: 1, undone: false });
  await page.evaluate(() => { db.ammo.unshift({ id: 'range-a1', caliber: 'B', brand: 'Lot one', quantity: '170', notes: '' }); });
  await openSession(page);
  await page.locator('#rangeSessionSaveBtn').click();
  await expect(page.locator('#rangeSessionModal')).not.toHaveClass(/open/);
  await page.evaluate(() => { document.querySelector('[data-range-undo]').dataset.rangeUndo = db.firearms[0].rangeSessions[0].id; });
  await page.getByRole('button', { name: 'Undo session', exact: true }).click();
  expect(await page.evaluate(() => ({ count: db.firearms[0].roundCount, quantity: db.ammo[0].quantity, sessions: db.firearms[0].rangeSessions.filter(session => !session.undoneAt).length }))).toEqual({ count: 160, quantity: '140', sessions: 2 });
});

test('maintenance reminders use exact round and date thresholds with the latest service baseline', async ({ page }) => {
  const result = await page.evaluate(() => {
    const localDate = offset => { const date = new Date(); date.setDate(date.getDate() + offset); return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0'); };
    const firearm = { id: 'reminder-one', make: 'Test', model: 'Reminder', roundCount: 149, maintenanceIntervalRounds: 50, maintenanceIntervalDays: 30,
      dateAcquired: localDate(-100), maintenanceLog: [{ type: 'Cleaning', date: localDate(-29), roundCount: '100' }] };
    const beforeThreshold = VaultRange.reminders({ firearms: [firearm] });
    firearm.roundCount = 150;
    const roundsThreshold = VaultRange.reminders({ firearms: [firearm] });
    firearm.roundCount = 149;
    firearm.maintenanceLog[0].date = localDate(-30);
    const daysThreshold = VaultRange.reminders({ firearms: [firearm] });
    firearm.maintenanceLog.push({ type: 'Maintenance', date: localDate(0), roundCount: '149' });
    const reset = VaultRange.reminders({ firearms: [firearm] });
    firearm.maintenanceLog = [];
    firearm.maintenanceIntervalDays = null;
    firearm.maintenanceBaselineRounds = 100;
    firearm.roundCount = 150;
    const explicitBaseline = VaultRange.reminders({ firearms: [firearm] });
    firearm.maintenanceIntervalDays = '';
    firearm.maintenanceIntervalRounds = '';
    const disabled = VaultRange.reminders({ firearms: [firearm] });
    return { beforeThreshold, roundsThreshold, daysThreshold, reset, explicitBaseline, disabled };
  });
  expect(result.beforeThreshold).toEqual([]);
  expect(result.roundsThreshold).toHaveLength(1);
  expect(result.roundsThreshold[0]).toMatchObject({ sev: 'med', itemType: 'firearm', itemId: 'reminder-one' });
  expect(result.roundsThreshold[0].text).toContain('50 rounds');
  expect(result.daysThreshold[0].text).toContain('30 days');
  expect(result.reset).toEqual([]);
  expect(result.explicitBaseline).toHaveLength(1);
  expect(result.disabled).toEqual([]);
});

test('maintenance interval form settings validate, clear, and populate', async ({ page }) => {
  const result = await page.evaluate(() => {
    VaultRange.formPopulate({ maintenanceIntervalRounds: 250, maintenanceIntervalDays: 30, maintenanceBaselineRounds: 0 });
    const collected = VaultRange.formCollect();
    document.getElementById('fMaintenanceIntervalRounds').value = '1.5';
    const invalid = VaultRange.formCollect();
    VaultRange.formClear();
    const cleared = VaultRange.formCollect();
    return { collected, invalid, cleared };
  });
  expect(result.collected).toEqual({ maintenanceIntervalRounds: 250, maintenanceIntervalDays: 30, maintenanceBaselineRounds: 0 });
  expect(result.invalid).toBe(false);
  expect(result.cleared).toEqual({ maintenanceIntervalRounds: null, maintenanceIntervalDays: null, maintenanceBaselineRounds: null });
});

test('activity restore blocks session or ammunition count changes before asking for confirmation', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const session = { id: 'session-existing', date: '2026-01-01', ammoId: 'range-a1', ammoLabel: 'Lot one', rounds: 30, roundCountBefore: 100, roundCountAfter: 130, notes: '' };
    db.firearms[0].rangeSessions = [session];
    db.firearms[0].roundCount = 130;
    db.ammo[0].quantity = '170';
    window.__rangeConfirmCalls = 0;
    window.confirmDialog = async () => { window.__rangeConfirmCalls += 1; return true; };
    const earlier = structuredClone(db.firearms[0]);
    earlier.rangeSessions = [];
    earlier.roundCount = 100;
    const wrongCount = structuredClone(db.firearms[0]);
    wrongCount.roundCount = 100;
    const earlierAmmo = { ...db.ammo[0], quantity: '200' };
    db.auditTrail = [
      VaultActivity.createEntry('edit', 'firearm', 'Test One', '', { collection: 'firearms', recordId: 'range-f1', before: earlier, after: db.firearms[0] }),
      VaultActivity.createEntry('edit', 'firearm', 'Test One', '', { collection: 'firearms', recordId: 'range-f1', before: wrongCount, after: db.firearms[0] }),
      VaultActivity.createEntry('edit', 'ammo', 'Lot one', '', { collection: 'ammo', recordId: 'range-a1', before: earlierAmmo, after: db.ammo[0] })
    ];
    const before = JSON.stringify(db);
    const outcomes = [];
    for (const entry of [...db.auditTrail]) outcomes.push(await VaultActivity.restore(entry.id));
    return { outcomes, unchanged: before === JSON.stringify(db), confirmations: window.__rangeConfirmCalls, saves: window.__rangeSaveCalls };
  });
  expect(result.outcomes.every(outcome => outcome.status === 'range-session-conflict')).toBe(true);
  expect(result.unchanged).toBe(true);
  expect(result.confirmations).toBe(0);
  expect(result.saves).toBe(0);
  await expect(page.locator('.toast-msg').last()).toContainText('Undo session');
});

test('activity restore permits unrelated fields when existing sessions and counts stay unchanged', async ({ page }) => {
  await openSession(page);
  await page.locator('#rangeSessionSaveBtn').click();
  await expect(page.locator('#rangeSessionModal')).not.toHaveClass(/open/);
  const result = await page.evaluate(async () => {
    const firearmBefore = structuredClone(db.firearms[0]);
    firearmBefore.model = 'Earlier model';
    const ammoBefore = structuredClone(db.ammo[0]);
    ammoBefore.brand = 'Earlier lot name';
    const firearmEntry = VaultActivity.createEntry('edit', 'firearm', 'Test One', '', { collection: 'firearms', recordId: 'range-f1', before: firearmBefore, after: db.firearms[0] });
    const ammoEntry = VaultActivity.createEntry('edit', 'ammo', 'Lot one', '', { collection: 'ammo', recordId: 'range-a1', before: ammoBefore, after: db.ammo[0] });
    db.auditTrail.push(firearmEntry, ammoEntry);
    window.confirmDialog = async () => true;
    const firearmRestore = await VaultActivity.restore(firearmEntry.id);
    const ammoRestore = await VaultActivity.restore(ammoEntry.id);
    return { firearmRestore, ammoRestore, firearm: structuredClone(db.firearms[0]), ammo: structuredClone(db.ammo[0]) };
  });
  expect(result.firearmRestore.status).toBe('restored');
  expect(result.ammoRestore.status).toBe('restored');
  expect(result.firearm.model).toBe('Earlier model');
  expect(result.firearm.roundCount).toBe(130);
  expect(result.firearm.rangeSessions).toHaveLength(1);
  expect(result.ammo.brand).toBe('Earlier lot name');
  expect(result.ammo.quantity).toBe('170');
});

test('activity restore rechecks range history after its confirmation yields', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const before = { ...structuredClone(db.firearms[0]), model: 'Earlier model' };
    const entry = VaultActivity.createEntry('edit', 'firearm', 'Test One', '', { collection: 'firearms', recordId: 'range-f1', before, after: db.firearms[0] });
    db.auditTrail.push(entry);
    window.confirmDialog = async () => {
      db.firearms[0].rangeSessions = [{ id: 'arrived-session', date: '2026-01-01', ammoId: 'range-a1', rounds: 30, roundCountBefore: 100, roundCountAfter: 130 }];
      db.firearms[0].roundCount = 130;
      db.ammo[0].quantity = '170';
      return true;
    };
    const outcome = await VaultActivity.restore(entry.id);
    return { outcome, firearm: structuredClone(db.firearms[0]), quantity: db.ammo[0].quantity, saves: window.__rangeSaveCalls };
  });
  expect(result.outcome.status).toBe('range-session-conflict');
  expect(result.firearm.model).toBe('One');
  expect(result.firearm.roundCount).toBe(130);
  expect(result.firearm.rangeSessions[0].id).toBe('arrived-session');
  expect(result.quantity).toBe('170');
  expect(result.saves).toBe(0);
});

test('activity restore verifies live range history after attachment preflight without applying old fields', async ({ page }) => {
  const result = await page.evaluate(async () => {
    db.firearms[0].images = ['existing-photo'];
    imagesDb['existing-photo'] = 'data:image/png;base64,aGVsbG8=';
    const before = { ...structuredClone(db.firearms[0]), model: 'Earlier model' };
    const entry = VaultActivity.createEntry('edit', 'firearm', 'Test One', '', { collection: 'firearms', recordId: 'range-f1', before, after: db.firearms[0] });
    db.auditTrail.push(entry);
    window.confirmDialog = async () => true;
    CloudSync.residentMedia = () => imagesDb['existing-photo'];
    CloudSync.downloadMedia = async () => {
      db.firearms[0].rangeSessions = [{ id: 'remote-session', date: '2026-01-01', ammoId: 'range-a1', rounds: 30, roundCountBefore: 100, roundCountAfter: 130 }];
      db.firearms[0].roundCount = 130;
      db.ammo[0].quantity = '170';
      return { ok: true, failures: [] };
    };
    const outcome = await VaultActivity.restore(entry.id);
    return { outcome, firearm: structuredClone(db.firearms[0]), quantity: db.ammo[0].quantity, saves: window.__rangeSaveCalls };
  });
  expect(result.outcome.status).toBe('range-session-conflict');
  expect(result.firearm.model).toBe('One');
  expect(result.firearm.roundCount).toBe(130);
  expect(result.firearm.rangeSessions[0].id).toBe('remote-session');
  expect(result.quantity).toBe('170');
  expect(result.saves).toBe(0);
});

test('a failed range session preserves all 500 earlier audit entries', async ({ page }) => {
  await page.evaluate(() => {
    db.auditTrail = Array.from({ length: 500 }, (_, index) => ({ id: 'earlier-' + index, timestamp: '2026-01-01T00:00:00.000Z', action: 'edit', itemType: 'system', itemName: 'Earlier event ' + index, details: '' }));
    window.__rangeEarlierAuditIds = db.auditTrail.map(entry => entry.id);
    window.saveData = async () => false;
  });
  await openSession(page);
  await page.locator('#rangeSessionSaveBtn').click();
  await expect(page.locator('#rangeSessionStatus')).toContainText('not saved');
  const result = await page.evaluate(() => ({ ids: db.auditTrail.map(entry => entry.id), earlierIds: window.__rangeEarlierAuditIds, rounds: db.firearms[0].roundCount, quantity: db.ammo[0].quantity }));
  expect(result.ids).toEqual(result.earlierIds);
  expect(result.rounds).toBe(100);
  expect(result.quantity).toBe('200');
});
