import { test, expect } from '@playwright/test';

test.use({ serviceWorkers: 'block' });

async function loadFeatureModules(page) {
  await page.goto('/index.html');
  if (await page.evaluate(() => typeof window.QuickCapture === 'undefined')) {
    await page.addScriptTag({ url: '/js/quick-capture.js' });
  }
  if (await page.evaluate(() => typeof window.ReportPackages === 'undefined')) {
    await page.addScriptTag({ url: '/js/report-packages.js' });
  }
}

test.beforeEach(async ({ page }) => {
  await loadFeatureModules(page);
});

test('Quick Capture extracts conservative local suggestions and reports exact duplicates', async ({ page }) => {
  const result = await page.evaluate(() => QuickCapture.analyzeText(`
    SIG SAUER
    MODEL P365 X
    SERIAL NO 66E848193
    PISTOL 9MM
  `, [
    { id: 'existing', make: 'Sig Sauer', model: 'P365 X', serial: '66E848193' }
  ]));

  expect(result).toMatchObject({
    make: 'Sig Sauer',
    model: 'P365 X',
    serial: '66E848193',
    caliber: '9MM',
    type: 'Pistol',
    duplicate: { id: 'existing' }
  });
  expect(result.serialCandidates[0].labeled).toBe(true);
});

test('Quick Capture keeps the file fallback open when camera permission is denied', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const denied = new DOMException('Permission denied', 'NotAllowedError');
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: async () => { throw denied; } }
    });
    const opened = await QuickCapture.open();
    const state = {
      opened,
      modalOpen: document.getElementById('quickCaptureModal').classList.contains('open'),
      status: document.getElementById('quickCaptureStatus').textContent
    };
    QuickCapture.close();
    return state;
  });

  expect(result.opened.camera).toBe(false);
  expect(result.modalOpen).toBe(true);
  expect(result.status).toMatch(/permission|choose an existing photo/i);
});

test('Quick Capture approval only opens and prefills the existing review form', async ({ page }) => {
  const result = await page.evaluate(async () => {
    db.firearms = [];
    const modal = document.getElementById('quickCaptureModal') || document.createElement('div');
    if (!modal.id) modal.id = 'quickCaptureModal';
    modal.className = 'open';
    if (!modal.isConnected) document.body.appendChild(modal);
    for (const [id, value, type] of [
      ['quickCaptureSerial', 'TEST-12345', 'text'],
      ['quickCaptureMake', 'Example Arms', 'text'],
      ['quickCaptureModel', 'Review Only', 'text'],
      ['quickCaptureCaliber', '9MM', 'text'],
      ['quickCaptureType', 'Pistol', 'text'],
      ['quickCaptureAttachPhoto', '', 'checkbox']
    ]) {
      const input = document.getElementById(id) || document.createElement('input');
      if (!input.id) input.id = id;
      if (!input.isConnected) { input.type = type; modal.appendChild(input); }
      input.value = value;
      if (type === 'checkbox') input.checked = false;
    }
    window.__reviewOpened = 0;
    window.__saveCalls = 0;
    window.openAddModal = async () => {
      window.__reviewOpened += 1;
      clearForm();
      document.getElementById('formModal').classList.add('open');
    };
    window.saveData = async () => { window.__saveCalls += 1; return true; };
    const approval = await QuickCapture.approveToReview();
    return {
      approval,
      reviewOpened: window.__reviewOpened,
      saveCalls: window.__saveCalls,
      firearmCount: db.firearms.length,
      form: {
        make: document.getElementById('fMake').value,
        model: document.getElementById('fModel').value,
        serial: document.getElementById('fSerial').value,
        caliber: document.getElementById('fCaliber').value,
        type: document.getElementById('fType').value
      }
    };
  });

  expect(result.approval.ok).toBe(true);
  expect(result.reviewOpened).toBe(1);
  expect(result.saveCalls).toBe(0);
  expect(result.firearmCount).toBe(0);
  expect(result.form).toEqual({
    make: 'Example Arms', model: 'Review Only', serial: 'TEST-12345', caliber: '9MM', type: 'Pistol'
  });
});

test('Quick Capture preserves receipt and tax-stamp categories in the review handoff', async ({ page }) => {
  const result = await page.evaluate(async () => {
    db.firearms = [];
    const modal = document.getElementById('quickCaptureModal') || document.createElement('div');
    if (!modal.id) modal.id = 'quickCaptureModal';
    modal.className = 'open';
    if (!modal.isConnected) document.body.appendChild(modal);
    const attach = document.getElementById('quickCaptureAttachPhoto') || document.createElement('input');
    if (!attach.id) attach.id = 'quickCaptureAttachPhoto';
    if (!attach.isConnected) { attach.type = 'checkbox'; modal.appendChild(attach); }
    attach.checked = true;
    window.openAddModal = async () => {
      clearForm();
      document.getElementById('formModal').classList.add('open');
    };
    const receipt = new File([new Uint8Array([37, 80, 68, 70, 45])], 'receipt.pdf', { type: 'application/pdf' });
    const stampBinary = atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=');
    const stampBytes = Uint8Array.from(stampBinary, character => character.charCodeAt(0));
    const stamp = new File([stampBytes], 'tax-stamp.png', { type: 'image/png' });
    await QuickCapture.handleFile(receipt, 'receipt');
    await QuickCapture.handleFile(stamp, 'tax-stamp');
    const approval = await QuickCapture.approveToReview();
    return {
      ok: approval.ok,
      receipt: tempReceipts.f,
      receiptName: tempReceipts.fName,
      stamp: tempStampPdf,
      stampName: tempStampPdfName,
      nfa: document.getElementById('fIsNFA').checked,
      firearmCount: db.firearms.length,
      artifacts: approval.artifacts
    };
  });

  expect(result.ok).toBe(true);
  expect(result.receipt).toMatch(/^data:application\/pdf;base64,/);
  expect(result.receiptName).toBe('receipt.pdf');
  expect(result.stamp).toMatch(/^data:application\/pdf;base64,/);
  expect(result.stampName).toBe('tax-stamp.pdf');
  expect(result.nfa).toBe(true);
  expect(result.firearmCount).toBe(0);
  expect(result.artifacts).toMatchObject({ receipt: true, taxStamp: true, failures: [] });
});

test('redacted report snapshots use an allowlist and never inherit private record fields', async ({ page }) => {
  const snapshot = await page.evaluate(() => ReportPackages.buildSnapshot([
    {
      id: 'one', make: 'Example', model: 'Carbine', serial: 'ABC1234567', caliber: '5.56',
      type: 'Rifle', price: '1250', dateAcquired: '2024-05-06', condition: 'Good',
      status: 'Active', notes: '<b>private note</b>', dispBuyer: 'Private buyer',
      receipt: 'data:application/pdf;base64,AAAA', secretFutureField: 'must not leak'
    }
  ], {
    purpose: 'insurance', mode: 'redacted', serialMode: 'last4', includeValues: true,
    includeExactDates: false, includePhotos: false, includeAccessories: false
  }, { firearms: [], accessories: [] }));

  expect(snapshot.items).toHaveLength(1);
  expect(snapshot.items[0].serial).toBe('Ending 4567');
  expect(snapshot.items[0].acquired).toBe('2024');
  expect(snapshot.items[0].documentedValue).toBe(1250);
  expect(snapshot.items[0]).not.toHaveProperty('notes');
  expect(snapshot.items[0]).not.toHaveProperty('dispBuyer');
  expect(snapshot.items[0]).not.toHaveProperty('receipt');
  expect(snapshot.items[0]).not.toHaveProperty('secretFutureField');
});

test('report profile presets keep redacted documents off and theft reports fully encrypted', async ({ page }) => {
  const result = await page.evaluate(() => {
    const purpose = document.getElementById('reportPackagePurpose');
    const mode = document.getElementById('reportPackageMode');
    purpose.value = 'insurance';
    mode.value = 'redacted';
    ReportPackages.applyModePreset();
    const redacted = {
      serial: document.getElementById('reportPackageSerialMode').value,
      encrypted: document.getElementById('reportPackageEncrypt').checked,
      receipts: document.getElementById('reportPackageIncludeReceipts').checked,
      receiptsDisabled: document.getElementById('reportPackageIncludeReceipts').disabled,
      documents: document.getElementById('reportPackageIncludeDocuments').checked,
      stamps: document.getElementById('reportPackageIncludeTaxStamps').checked
    };
    mode.value = 'full';
    ReportPackages.applyModePreset();
    const full = {
      serial: document.getElementById('reportPackageSerialMode').value,
      encrypted: document.getElementById('reportPackageEncrypt').checked,
      receipts: document.getElementById('reportPackageIncludeReceipts').checked,
      documents: document.getElementById('reportPackageIncludeDocuments').checked,
      stamps: document.getElementById('reportPackageIncludeTaxStamps').checked,
      photos: document.getElementById('reportPackageIncludePhotos').checked
    };
    purpose.value = 'theft';
    ReportPackages.applyPurposePreset();
    const theft = {
      mode: mode.value,
      modeDisabled: mode.disabled,
      encrypted: document.getElementById('reportPackageEncrypt').checked,
      encryptionDisabled: document.getElementById('reportPackageEncrypt').disabled
    };
    return { redacted, full, theft };
  });

  expect(result.redacted).toEqual({
    serial: 'omit', encrypted: false, receipts: false, receiptsDisabled: true, documents: false, stamps: false
  });
  expect(result.full).toEqual({
    serial: 'full', encrypted: true, receipts: true, documents: true, stamps: true, photos: true
  });
  expect(result.theft).toEqual({ mode: 'full', modeDisabled: true, encrypted: true, encryptionDisabled: true });
});

test('secure report envelope round-trips and rejects the wrong password or tampering', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const original = new TextEncoder().encode('private report bytes');
    const envelope = await ReportPackages.encryptBytes(original, 'correct horse battery staple');
    const restored = await ReportPackages.decryptEnvelope(envelope, 'correct horse battery staple');
    let wrongPassword = '';
    try { await ReportPackages.decryptEnvelope(envelope, 'this password is wrong'); }
    catch (error) { wrongPassword = error.message; }
    const damaged = structuredClone(envelope);
    damaged.ciphertext = damaged.ciphertext.slice(0, -4) + 'AAAA';
    let tampered = '';
    try { await ReportPackages.decryptEnvelope(damaged, 'correct horse battery staple'); }
    catch (error) { tampered = error.message; }
    return {
      format: envelope.format,
      plaintext: new TextDecoder().decode(restored),
      wrongPassword,
      tampered
    };
  });

  expect(result.format).toBe('firearms-vault-report-package');
  expect(result.plaintext).toBe('private report bytes');
  expect(result.wrongPassword).toMatch(/incorrect|changed/i);
  expect(result.tampered).toMatch(/incorrect|changed|damaged/i);
});

test('redacted ZIP generation honors the bulk selection and omits serials', async ({ page }) => {
  const result = await page.evaluate(async () => {
    db.firearms = [
      { id: 'selected', make: 'Selected', model: 'Item', serial: 'SECRET-ONE', caliber: '9mm', type: 'Pistol', condition: 'New', status: 'Active', images: [] },
      { id: 'not-selected', make: 'Other', model: 'Item', serial: 'SECRET-TWO', caliber: '5.56', type: 'Rifle', condition: 'Good', status: 'Active', images: [] }
    ];
    db.accessories = [];
    bulkSelected.clear();
    bulkSelected.add('selected');
    const built = await ReportPackages.generateRedactedZip({
      download: false,
      scope: 'selected',
      serialMode: 'omit',
      includePhotos: false,
      includeAccessories: false
    });
    const zip = await JSZip.loadAsync(built.bytes);
    const verified = await ReportPackages.inspectZip(built.bytes);
    const inventory = JSON.parse(await zip.file('inventory.json').async('string'));
    const manifest = JSON.parse(await zip.file('manifest.json').async('string'));
    return {
      encrypted: built.encrypted,
      itemCount: inventory.items.length,
      make: inventory.items[0].make,
      hasSerial: Object.prototype.hasOwnProperty.call(inventory.items[0], 'serial'),
      manifestItems: manifest.itemCount,
      verifiedItems: verified.itemCount,
      hasPdf: Boolean(zip.file('report.pdf'))
    };
  });

  expect(result).toEqual({
    encrypted: false,
    itemCount: 1,
    make: 'Selected',
    hasSerial: false,
    manifestItems: 1,
    verifiedItems: 1,
    hasPdf: true
  });
});
