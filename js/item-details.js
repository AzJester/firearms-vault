// Purchase availability and insurance valuation are independent of disposition
// and historical approval records. Existing records are read without migration.
(function () {
  'use strict';
  const STAGES = ['Ordered', 'Awaiting pickup', 'In possession', 'At gunsmith'];
  const FIELDS = {
    acquisitionStage: 'fAcquisitionStage', orderDate: 'fOrderDate',
    expectedArrival: 'fExpectedArrival', orderReference: 'fOrderReference',
    trackingUrl: 'fTrackingUrl', serviceNotes: 'fServiceNotes',
    replacementValue: 'fReplacementValue', valuationDate: 'fValuationDate',
    valuationSource: 'fValuationSource'
  };
  const control = id => document.getElementById(id);
  const escape = value => typeof esc === 'function' ? esc(String(value == null ? '' : value)).replace(/"/g, '&quot;').replace(/'/g, '&#39;') : String(value == null ? '' : value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const stage = record => STAGES.includes(record && record.acquisitionStage) ? record.acquisitionStage : 'In possession';
  let duplicateDialog;
  let duplicateSourceId = null;
  let duplicateBusy = false;

  function safeTrackingUrl(value) {
    const input = String(value || '').trim();
    if (!input) return '';
    try {
      const url = new URL(input);
      return /^(https?:)$/.test(url.protocol) && !url.username && !url.password ? url.href : '';
    } catch (_) { return ''; }
  }

  function validDate(value) {
    if (!value) return true;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(value + 'T00:00:00Z');
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
  }

  function init() {
    const grid = document.querySelector('#formModal .modal-body > .form-grid');
    if (!grid || control(FIELDS.acquisitionStage)) return;
    const availability = document.createElement('div');
    availability.className = 'form-group';
    availability.innerHTML = '<label for="fAcquisitionStage">Purchase / availability</label><select id="fAcquisitionStage">' + STAGES.map(value => '<option>' + escape(value) + '</option>').join('') + '</select>';
    const statusGroup = control('fStatus') && control('fStatus').closest('.form-group');
    if (statusGroup) statusGroup.insertAdjacentElement('afterend', availability);
    else grid.appendChild(availability);

    const purchase = document.createElement('details');
    purchase.id = 'firearmPurchaseDisclosure';
    purchase.className = 'form-disclosure full item-details-disclosure';
    purchase.innerHTML = '<summary>Order and service details</summary><div class="form-grid disclosure-grid">' +
      '<div class="form-group"><label for="fOrderDate">Order date</label><input type="date" id="fOrderDate"></div>' +
      '<div class="form-group"><label for="fExpectedArrival">Expected arrival / pickup</label><input type="date" id="fExpectedArrival"></div>' +
      '<div class="form-group"><label for="fOrderReference">Order reference</label><input id="fOrderReference" type="text" maxlength="250" placeholder="Order or invoice number"></div>' +
      '<div class="form-group"><label for="fTrackingUrl">Tracking link</label><input id="fTrackingUrl" type="url" maxlength="2000" placeholder="https://..." aria-describedby="trackingLinkHelp"><small id="trackingLinkHelp" class="item-field-help">Use a full http:// or https:// link.</small></div>' +
      '<div class="form-group full"><label for="fServiceNotes">Order / service notes</label><textarea id="fServiceNotes" rows="3" maxlength="10000" placeholder="Pickup details or work being performed"></textarea></div></div>';
    availability.insertAdjacentElement('afterend', purchase);

    const valuation = document.createElement('details');
    valuation.id = 'firearmValuationDisclosure';
    valuation.className = 'form-disclosure full item-details-disclosure';
    valuation.innerHTML = '<summary>Replacement value and insurance</summary><div class="form-grid disclosure-grid">' +
      '<p class="item-field-help full">Purchase price records what you paid. Replacement value records the amount needed to replace this item. Leave it blank if unknown.</p>' +
      '<div class="form-group"><label for="fReplacementValue">Replacement / appraised value ($)</label><input type="number" id="fReplacementValue" min="0" step="0.01" placeholder="Not recorded"></div>' +
      '<div class="form-group"><label for="fValuationDate">Valuation date</label><input type="date" id="fValuationDate"></div>' +
      '<div class="form-group full"><label for="fValuationSource">Valuation source</label><input type="text" id="fValuationSource" maxlength="1000" placeholder="Appraiser, dealer, or comparable listing"></div>' +
      '<p class="item-field-help full">Add an appraisal PDF, screenshot, or other valuation evidence under Notes and documents.</p></div>';
    purchase.insertAdjacentElement('afterend', valuation);
    clear();
  }

  function clear() {
    Object.values(FIELDS).forEach(id => { if (control(id)) control(id).value = ''; });
    if (control(FIELDS.acquisitionStage)) control(FIELDS.acquisitionStage).value = 'In possession';
    ['firearmPurchaseDisclosure', 'firearmValuationDisclosure'].forEach(id => { if (control(id)) control(id).open = false; });
  }

  function populate(record) {
    const value = record || {};
    Object.entries(FIELDS).forEach(([key, id]) => {
      if (control(id)) control(id).value = value[key] == null ? '' : String(value[key]);
    });
    if (control(FIELDS.acquisitionStage)) control(FIELDS.acquisitionStage).value = stage(value);
    const purchase = control('firearmPurchaseDisclosure');
    if (purchase) purchase.open = !!(value.orderDate || value.expectedArrival || value.orderReference || value.trackingUrl || value.serviceNotes);
    const valuation = control('firearmValuationDisclosure');
    if (valuation) valuation.open = !!(value.replacementValue !== undefined && value.replacementValue !== null && value.replacementValue !== '' || value.valuationDate || value.valuationSource);
  }

  function collect() {
    const result = {};
    Object.entries(FIELDS).forEach(([key, id]) => {
      result[key] = control(id) ? control(id).value.trim() : '';
    });
    result.acquisitionStage = STAGES.includes(result.acquisitionStage) ? result.acquisitionStage : 'In possession';
    if (result.trackingUrl && safeTrackingUrl(result.trackingUrl)) result.trackingUrl = safeTrackingUrl(result.trackingUrl);
    return result;
  }

  function validate() {
    const values = collect();
    const errors = [];
    if (control(FIELDS.replacementValue)?.validity.badInput || values.replacementValue !== '' && (!Number.isFinite(Number(values.replacementValue)) || Number(values.replacementValue) < 0)) errors.push(['fReplacementValue', 'Enter a replacement value of zero or more, or leave it blank.']);
    if (values.trackingUrl && !safeTrackingUrl(values.trackingUrl)) errors.push(['fTrackingUrl', 'Enter a full http:// or https:// tracking link without a username or password.']);
    [['orderDate', 'Order date'], ['expectedArrival', 'Expected arrival'], ['valuationDate', 'Valuation date']].forEach(([key, label]) => {
      if (!validDate(values[key]) || control(FIELDS[key])?.validity.badInput) errors.push([FIELDS[key], label + ' must be a valid date.']);
    });
    if (!errors.length) return '';
    const [id, message] = errors[0];
    const element = control(id);
    if (element) {
      const disclosure = element.closest('details');
      if (disclosure) disclosure.open = true;
      if (typeof showFieldError === 'function') showFieldError(element, message);
      else element.focus();
    }
    return message;
  }

  function detailHTML(record) {
    const value = record || {};
    const field = (label, text) => '<div class="detail-field"><label>' + escape(label) + '</label><span>' + escape(text) + '</span></div>';
    const money = amount => amount !== '' && amount != null && Number.isFinite(Number(amount)) && Number(amount) >= 0 ? Number(amount).toLocaleString(undefined, { style: 'currency', currency: 'USD' }) : 'Not recorded';
    let html = '<div class="detail-section item-purchase-details"><h3>Purchase and availability</h3><div class="detail-grid">' + field('Purchase / availability', stage(value)) + field('Purchase cost', money(value.price));
    [['orderDate', 'Order date'], ['expectedArrival', 'Expected arrival / pickup'], ['orderReference', 'Order reference']].forEach(([key, label]) => { if (value[key]) html += field(label, value[key]); });
    const tracking = safeTrackingUrl(value.trackingUrl);
    if (tracking) html += '<div class="detail-field"><label>Tracking</label><span><a href="' + escape(tracking) + '" target="_blank" rel="noopener noreferrer">Open tracking link</a></span></div>';
    html += '</div>';
    if (value.serviceNotes) html += '<p class="item-service-notes">' + escape(value.serviceNotes) + '</p>';
    html += '</div><div class="detail-section item-valuation-details"><h3>Replacement value and insurance</h3><div class="detail-grid">' + field('Replacement / appraised value', money(value.replacementValue));
    if (value.valuationDate) html += field('Valuation date', value.valuationDate);
    if (value.valuationSource) html += field('Valuation source', value.valuationSource);
    return html + '</div></div>';
  }

  function createDuplicateRecord(source, options) {
    // A whitelist prevents future item-specific fields from silently becoming
    // inherited history. The database record is never edited by this operation.
    const copy = {};
    ['make', 'model', 'caliber', 'type', 'barrel', 'condition', 'isNFA', 'nfaType'].forEach(key => { if (source[key] !== undefined) copy[key] = source[key]; });
    Object.assign(copy, {
      serial: '', dateAcquired: '', price: '', status: 'Active',
      formType: '', dateSubmitted: '', dateApproved: '', stampStatus: '', regType: '',
      stampPdf: null, stampPdfName: null, dispDate: '', dispBuyer: '', dispPrice: '',
      dispFFL: '', dispNotes: '', maintenanceLog: [], roundCount: 0, warrantyExp: '',
      acquisitionStage: 'In possession', orderDate: '', expectedArrival: '',
      orderReference: '', trackingUrl: '', serviceNotes: '', replacementValue: '',
      valuationDate: '', valuationSource: '', images: [], tags: [], notes: '',
      receipt: null, receiptName: null, documents: [], customFields: [],
      hostFirearmIds: [], rangeSessions: []
    });
    if (options.photos) copy.images = Array.isArray(source.images) ? [...source.images] : [];
    if (options.notes) {
      copy.notes = typeof sanitizeRichText === 'function' ? sanitizeRichText(source.notes || '') : source.notes || '';
      copy.tags = Array.isArray(source.tags) ? [...source.tags] : [];
    }
    if (options.documents) {
      copy.receipt = source.receipt || null;
      copy.receiptName = source.receiptName || null;
      copy.documents = Array.isArray(source.documents) ? source.documents.map(doc => ({ id: doc.id, name: doc.name, type: doc.type, data: doc.data })) : [];
    }
    if (options.approvals && source.isNFA) {
      ['formType', 'dateSubmitted', 'dateApproved', 'stampStatus', 'regType', 'stampPdf', 'stampPdfName'].forEach(key => { copy[key] = source[key] == null ? (key.startsWith('stampPdf') ? null : '') : source[key]; });
    }
    return copy;
  }

  function closeDuplicate(force) {
    if (duplicateBusy && !force) return;
    if (duplicateDialog) duplicateDialog.classList.remove('open');
    duplicateSourceId = null;
  }

  function ensureDuplicateDialog() {
    if (duplicateDialog) return;
    duplicateDialog = document.createElement('div');
    duplicateDialog.id = 'duplicateOptionsModal';
    // The app's shared modal manager supplies focus trapping. app-dialog lets
    // this lightweight choice dialog own cancellation without unsaved-form logic.
    duplicateDialog.className = 'modal-overlay app-dialog';
    duplicateDialog.setAttribute('role', 'dialog');
    duplicateDialog.setAttribute('aria-modal', 'true');
    duplicateDialog.setAttribute('aria-labelledby', 'duplicateOptionsTitle');
    duplicateDialog.innerHTML = '<div class="modal item-copy-modal"><div class="modal-header"><h2 id="duplicateOptionsTitle">Duplicate as a new draft</h2><button type="button" class="modal-close" data-copy-action="cancel" aria-label="Close">&times;</button></div><div class="modal-body">' +
      '<p id="duplicateSourceName" class="item-copy-source"></p><p>Manufacturer, model, caliber, type, barrel, and condition are copied. The new item starts without a serial number, purchase history, valuation, or usage history.</p>' +
      '<fieldset class="item-copy-options"><legend>Choose anything else to copy</legend>' +
      '<label><input type="checkbox" id="duplicatePhotos" data-no-dirty> Photos</label>' +
      '<label><input type="checkbox" id="duplicateNotes" data-no-dirty> Notes and tags</label>' +
      '<label><input type="checkbox" id="duplicateDocuments" data-no-dirty> Receipt and documents <small>These may contain the original item\'s serial number or purchase details.</small></label>' +
      '<label><input type="checkbox" id="duplicateApprovals" data-no-dirty> Historical approval records and stamp <small>Copies the original approval dates and status. Confirm they belong with this new item before saving.</small></label></fieldset>' +
      '<p class="item-field-help">Your collection changes only when you select Save Firearm. Any existing Add Firearm draft is kept separately on this device.</p><p id="duplicateOptionsError" role="alert" hidden></p></div><div class="modal-footer"><button type="button" class="btn btn-outline" data-copy-action="cancel">Cancel</button><button type="button" class="btn btn-primary" data-copy-action="create">Open new draft</button></div></div>';
    document.body.appendChild(duplicateDialog);
    duplicateDialog.addEventListener('click', event => {
      if (event.target === duplicateDialog || event.target.closest('[data-copy-action="cancel"]')) closeDuplicate();
      if (event.target.closest('[data-copy-action="create"]')) void confirmDuplicate();
    });
    duplicateDialog.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeDuplicate(); }
    });
  }

  async function confirmDuplicate() {
    const source = db.firearms.find(record => record.id === duplicateSourceId);
    if (!source) { closeDuplicate(); return; }
    const button = duplicateDialog.querySelector('[data-copy-action="create"]');
    if (button.disabled) return;
    duplicateBusy = true;
    button.disabled = true;
    duplicateDialog.querySelectorAll('[data-copy-action="cancel"]').forEach(control => { control.disabled = true; });
    const owner = window.CloudSync && CloudSync.uid;
    const copy = createDuplicateRecord(source, {
      photos: control('duplicatePhotos').checked, notes: control('duplicateNotes').checked,
      documents: control('duplicateDocuments').checked, approvals: control('duplicateApprovals').checked
    });
    try {
      // The host rotates the draft and open-form recovery keys together after
      // flushing any active form. Do not clear another draft as part of copying.
      if (typeof window.prepareFirearmDuplicateDraft !== 'function') throw new Error('Draft protection is not ready. Reload the page and try again.');
      if (await openAddModal({ freshDraft: true }) === false) throw new Error('Your current draft could not be protected. Keep this page open and try again.');
      if ((window.CloudSync && CloudSync.uid) !== owner) throw new Error('The signed-in account changed. Reopen the item before duplicating.');
      clearForm();
      populateForm(copy);
      editingId = null;
      if (typeof endRecordEdit === 'function') endRecordEdit('firearms');
      if (typeof syncFirearmDisclosure === 'function') syncFirearmDisclosure(copy);
      if (typeof closeDetail === 'function') closeDetail();
      control('modalTitle').textContent = 'Duplicate Firearm';
      control('saveBtn').textContent = 'Save Firearm';
      closeDuplicate(true);
      if (typeof saveFirearmDraftSoon === 'function') saveFirearmDraftSoon();
      setTimeout(() => control('fSerial')?.focus(), 30);
    } catch (error) {
      const message = control('duplicateOptionsError');
      message.textContent = error && error.message || 'The new draft could not be opened. Please try again.';
      message.hidden = false;
    } finally {
      duplicateBusy = false;
      button.disabled = false;
      duplicateDialog.querySelectorAll('[data-copy-action="cancel"]').forEach(control => { control.disabled = false; });
    }
  }

  function openDuplicate(id) {
    if (duplicateBusy) return false;
    const source = db.firearms.find(record => record.id === id);
    if (!source) return false;
    ensureDuplicateDialog();
    duplicateSourceId = id;
    ['duplicatePhotos', 'duplicateNotes', 'duplicateDocuments', 'duplicateApprovals'].forEach(id => { control(id).checked = false; });
    control('duplicateApprovals').disabled = !source.isNFA;
    control('duplicateSourceName').textContent = ((source.make || '') + ' ' + (source.model || '')).trim();
    control('duplicateOptionsError').hidden = true;
    duplicateDialog.classList.add('open');
    setTimeout(() => duplicateDialog.querySelector('[data-copy-action="create"]')?.focus(), 30);
    return true;
  }

  window.VaultItemDetails = Object.freeze({ init, clear, populate, collect, validate, detailHTML, openDuplicate, closeDuplicate });
})();
