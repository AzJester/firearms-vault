(function initCollectionTools(global) {
  'use strict';
  const FILTERS = ['searchBox', 'filterType', 'filterCaliber', 'filterTag', 'filterCondition', 'filterMake', 'filterStage', 'filterAcquiredFrom', 'filterAcquiredTo', 'filterValueMin', 'filterValueMax', 'filterMissing'];
  const extraFilters = [
    ['filterMake', 'Manufacturer', 'text'], ['filterStage', 'Purchase / availability', 'stage'],
    ['filterAcquiredFrom', 'Acquired from', 'date'], ['filterAcquiredTo', 'Acquired through', 'date'],
    ['filterValueMin', 'Minimum purchase cost', 'number'], ['filterValueMax', 'Maximum purchase cost', 'number'],
    ['filterMissing', 'Missing records', 'missing']
  ];
  const TYPES = ['Rifle', 'Pistol', 'Shotgun', 'Revolver', 'SBR', 'SBS', 'Silencer', 'Other'];
  const CONDITIONS = ['New', 'Like New', 'Excellent', 'Good', 'Fair', 'Poor'];
  const STAGES = ['Ordered', 'Awaiting pickup', 'In possession', 'At gunsmith'];
  let initialized = false, defaultOwner = null, applying = false, reviewed = null, busy = false;
  const el = id => document.getElementById(id);
  const escape = value => VaultSecurity.escapeHTML(value);
  const input = id => el(id)?.value || '';
  function filters() { return Object.fromEntries(FILTERS.map(id => [id, input(id)])); }
  function applyFilters(items) {
    const make = input('filterMake').trim().toLowerCase(), stage = input('filterStage');
    const from = input('filterAcquiredFrom'), through = input('filterAcquiredTo');
    const min = input('filterValueMin'), max = input('filterValueMax'), missing = input('filterMissing');
    return items.filter(record => {
      const cost = VaultCollection.value(record, 'purchase');
      return (!make || String(record.make || '').toLowerCase().includes(make)) &&
        (!stage || VaultCollection.stage(record) === stage) &&
        (!from || record.dateAcquired && record.dateAcquired >= from) &&
        (!through || record.dateAcquired && record.dateAcquired <= through) &&
        (min === '' || cost !== null && cost >= Number(min)) && (max === '' || cost !== null && cost <= Number(max)) &&
        (!missing || missing === 'receipt' && !record.receipt || missing === 'photo' && !(record.images || []).length ||
          missing === 'serial' && !String(record.serial || '').trim() || missing === 'valuation' && VaultCollection.value(record, 'replacement') === null);
    });
  }
  function views() { return Array.isArray(db.settings?.savedCollectionViews) ? db.settings.savedCollectionViews : []; }
  function positionViewsPanel() {
    const menu = el('collectionViewsMenu'), bar = el('collectionViewControls');
    if (!menu?.open || !bar) return;
    const box = bar.getBoundingClientRect(), panel = bar.querySelector('.collection-view-panel');
    const width = Math.min(290, window.innerWidth - 32);
    const left = Math.max(16, Math.min(box.right - width, window.innerWidth - width - 16));
    panel.style.left = (left - box.left) + 'px'; panel.style.right = 'auto'; panel.style.width = width + 'px';
  }
  function refresh() {
    if (!initialized) return;
    const firearmView = ['all', 'nfa', 'disposed'].includes(currentTab);
    el('collectionViewControls').hidden = !firearmView;
    extraFilters.forEach(([id]) => el(id).hidden = !firearmView);
    el('bulkEditRecordsBtn').hidden = !firearmView;
    if (!firearmView) return;
    const selected = input('savedCollectionView');
    el('savedCollectionView').innerHTML = '<option value="">Saved views</option>' + views().map(view =>
      '<option value="' + escape(view.id) + '">' + escape(view.name) + (db.settings.defaultCollectionView === view.id ? ' (default)' : '') + '</option>').join('');
    el('savedCollectionView').value = selected;
    el('deleteCollectionViewBtn').disabled = !el('savedCollectionView').value;
    positionViewsPanel();
    const owner = String(global.CloudSync?.uid || 'session');
    if (!applying && defaultOwner !== owner) {
      const previousOwner = defaultOwner;
      defaultOwner = owner;
      if (previousOwner !== null) {
        FILTERS.forEach(id => { if (el(id)) el(id).value = ''; });
        el('savedCollectionView').value = '';
        el('deleteCollectionViewBtn').disabled = true;
        Object.keys(sectionSearchValues).forEach(key => delete sectionSearchValues[key]);
      }
      const preferred = views().find(view => view.id === db.settings.defaultCollectionView);
      if (preferred) applyView(preferred);
      else if (previousOwner !== null) render();
    }
  }
  function applyView(view) {
    applying = true;
    const tab = ['all', 'nfa', 'disposed'].includes(view.tab) ? view.tab : 'all';
    _gotoTab(tab);
    for (const id of FILTERS) {
      const control = el(id);
      const value = String(view.filters?.[id] || '');
      if (control instanceof HTMLSelectElement && value && !Array.from(control.options).some(option => option.value === value)) control.add(new Option(value, value));
      if (control) control.value = value;
    }
    currentView = view.view === 'table' ? 'table' : 'cards';
    el('viewCards').classList.toggle('active', currentView === 'cards');
    el('viewTable').classList.toggle('active', currentView === 'table');
    sortCol = view.sortCol || null;
    sortDir = view.sortDir === 'desc' ? 'desc' : 'asc';
    el('cardSort').value = view.cardSort || '';
    render();
    el('savedCollectionView').value = view.id;
    el('deleteCollectionViewBtn').disabled = false;
    applying = false;
  }
  async function saveView() {
    const name = await promptDialog('Name this collection view:', '', { title: 'Save view', okText: 'Save view' });
    if (!name || !name.trim()) return;
    const cleanName = name.trim().slice(0, 80);
    const before = structuredClone(db.settings || {}), after = structuredClone(before);
    const all = views().map(view => structuredClone(view));
    const existing = all.find(view => view.name.toLowerCase() === cleanName.toLowerCase());
    if (existing && !await confirmDialog('Replace the saved view "' + existing.name + '" with your current filters?', { title: 'Update view', okText: 'Replace' })) return;
    if (!existing && all.length >= 50) { toast('You can save up to 50 views. Remove an old view first.', 'warning'); return; }
    const view = { id: existing?.id || generateId(), name: cleanName, filters: filters(), tab: currentTab, view: currentView, sortCol, sortDir, cardSort: input('cardSort') };
    after.savedCollectionViews = existing ? all.map(item => item.id === existing.id ? view : item) : [...all, view];
    if (await VaultCollection.commitChanges('Saved collection view', [{ collection: 'settings', id: 'settings', before, after }])) {
      el('savedCollectionView').value = view.id;
      el('deleteCollectionViewBtn').disabled = false;
      toast('View saved.', 'success');
    }
  }
  async function removeView() {
    const id = input('savedCollectionView'), view = views().find(item => item.id === id);
    if (!view || !await confirmDialog('Remove the saved view "' + view.name + '"? Collection records are unchanged.', { title: 'Remove view', okText: 'Remove' })) return;
    const before = structuredClone(db.settings || {}), after = structuredClone(before);
    after.savedCollectionViews = views().filter(item => item.id !== id);
    if (after.defaultCollectionView === id) delete after.defaultCollectionView;
    await VaultCollection.commitChanges('Removed collection view', [{ collection: 'settings', id: 'settings', before, after }]);
  }
  async function setDefaultView() {
    const id = input('savedCollectionView');
    if (!id) { toast('Choose a saved view first.', 'info'); return; }
    const before = structuredClone(db.settings || {}), after = structuredClone(before);
    after.defaultCollectionView = before.defaultCollectionView === id ? null : id;
    if (await VaultCollection.commitChanges('Changed default collection view', [{ collection: 'settings', id: 'settings', before, after }])) toast(after.defaultCollectionView ? 'Default view saved for this account.' : 'Default view cleared.', 'success');
  }
  function openBatch() {
    const records = db.firearms.filter(record => bulkSelected.has(record.id));
    if (!records.length) { toast('Select firearms first.', 'info'); return; }
    el('batchType').value = ''; el('batchCondition').value = ''; el('batchStage').value = '';
    el('batchSummary').textContent = records.length + ' selected records. Only the fields you choose will change. Receipts and approval history are preserved.';
    el('batchPreview').textContent = '';
    reviewed = null;
    el('batchApplyBtn').disabled = true;
    el('batchEditModal').classList.add('open');
  }
  function reviewBatch() {
    const type = input('batchType'), condition = input('batchCondition'), stage = input('batchStage');
    if (!type && !condition && !stage) { toast('Choose at least one field to change.', 'info'); return; }
    reviewed = db.firearms.filter(record => bulkSelected.has(record.id)).map(record => {
      const before = structuredClone(record), after = structuredClone(record);
      if (type) {
        after.type = type;
        const nfaType = { SBR: 'SBR', SBS: 'SBS', Silencer: 'Suppressor' }[type];
        if (nfaType) { after.isNFA = true; after.nfaType = nfaType; }
      }
      if (condition) after.condition = condition;
      if (stage) after.acquisitionStage = stage;
      return { collection: 'firearms', id: record.id, before, after };
    }).filter(change => !editValuesEqual(change.before, change.after));
    el('batchPreview').innerHTML = reviewed.length ? '<p>' + reviewed.length + ' records will change:</p><ul>' + reviewed.map(change =>
      '<li>' + escape([change.before.make, change.before.model].filter(Boolean).join(' ') || 'Untitled item') + ': ' +
      ['type', 'condition', 'acquisitionStage'].filter(key => !editValuesEqual(change.before[key], change.after[key])).map(key => escape(key === 'acquisitionStage' ? 'Stage' : key) + ' ' + escape(change.before[key] || (key === 'acquisitionStage' ? 'In possession' : 'blank')) + ' → ' + escape(change.after[key])).join('; ') + '</li>').join('') + '</ul>' : '<p>These records already have the selected values.</p>';
    el('batchApplyBtn').disabled = !reviewed.length;
    el('batchApplyBtn').textContent = 'Apply ' + reviewed.length + ' updates';
  }
  async function applyBatch() {
    if (busy || !reviewed?.length) return;
    busy = true;
    const modal = el('batchEditModal'); modal.dataset.saving = 'true';
    modal.querySelectorAll('input,select,button').forEach(control => control.disabled = true);
    try {
      if (await VaultCollection.commitChanges('Batch updated collection records', reviewed)) {
        modal.dataset.dirty = 'false'; modal.classList.remove('open'); clearBulkSelection();
        toast('Selected records updated.', 'success');
      }
    } finally {
      busy = false; modal.dataset.saving = 'false';
      modal.querySelectorAll('input,select,button').forEach(control => control.disabled = false);
      reviewed = null; el('batchApplyBtn').disabled = true;
    }
  }
  function closeBatch() { if (!busy) { reviewed = null; el('batchEditModal').classList.remove('open'); } }
  function init() {
    if (initialized) return;
    initialized = true;
    const toolbar = el('mainToolbar');
    for (const [id, label, kind] of extraFilters) {
      const control = document.createElement(['stage', 'missing'].includes(kind) ? 'select' : 'input');
      control.id = id; control.className = 'filter-select collection-extra-filter';
      control.setAttribute('aria-label', label); control.title = label;
      if (kind === 'stage') control.innerHTML = '<option value="">All purchase stages</option>' + STAGES.map(stage => '<option>' + stage + '</option>').join('');
      else if (kind === 'missing') control.innerHTML = '<option value="">All records</option><option value="receipt">Missing receipts</option><option value="photo">Missing photos</option><option value="serial">Missing serials</option><option value="valuation">Missing replacement values</option>';
      else { control.type = kind; control.placeholder = label; if (kind === 'number') { control.min = '0'; control.step = '0.01'; } }
      control.addEventListener(kind === 'text' || kind === 'number' ? 'input' : 'change', render);
      toolbar.append(control);
    }
    const bar = document.createElement('div'); bar.id = 'collectionViewControls'; bar.className = 'collection-view-controls';
    bar.innerHTML = '<details id="collectionViewsMenu"><summary class="btn btn-outline">Views</summary><div class="collection-view-panel"><select id="savedCollectionView" aria-label="Saved collection views"><option value="">Saved views</option></select><button class="btn btn-outline" id="saveCollectionViewBtn" type="button">Save view</button><button class="btn btn-outline" id="defaultCollectionViewBtn" type="button">Set / clear default</button><button class="btn btn-outline" id="deleteCollectionViewBtn" type="button" disabled>Remove view</button></div></details>';
    toolbar.append(bar);
    el('collectionViewsMenu').addEventListener('toggle', positionViewsPanel);
    window.addEventListener('resize', positionViewsPanel);
    el('savedCollectionView').addEventListener('change', () => { const selected = views().find(view => view.id === input('savedCollectionView')); if (selected) applyView(selected); });
    el('saveCollectionViewBtn').addEventListener('click', saveView);
    el('defaultCollectionViewBtn').addEventListener('click', setDefaultView);
    el('deleteCollectionViewBtn').addEventListener('click', removeView);
    const batch = document.createElement('button'); batch.id = 'bulkEditRecordsBtn'; batch.type = 'button'; batch.textContent = 'Edit selected';
    batch.addEventListener('click', openBatch); el('bulkBar').insertBefore(batch, el('bulkBar').lastElementChild);
    const modal = document.createElement('div'); modal.id = 'batchEditModal'; modal.className = 'modal-overlay';
    const options = values => '<option value="">Keep existing</option>' + values.map(value => '<option value="' + escape(value) + '">' + escape(value === 'Silencer' ? 'Suppressor / Silencer' : value) + '</option>').join('');
    modal.innerHTML = '<div class="modal" role="dialog" aria-modal="true" aria-labelledby="batchEditTitle"><div class="modal-header"><h2 id="batchEditTitle">Edit selected records</h2><button type="button" class="modal-close" aria-label="Close batch edit">×</button></div><div class="modal-body"><p id="batchSummary"></p><div class="form-grid"><div class="form-group"><label for="batchType">Firearm type</label><select id="batchType">' + options(TYPES) + '</select></div><div class="form-group"><label for="batchCondition">Condition</label><select id="batchCondition">' + options(CONDITIONS) + '</select></div><div class="form-group"><label for="batchStage">Purchase / availability</label><select id="batchStage">' + options(STAGES) + '</select></div></div><p>SBR, SBS, and suppressor types also update their NFA classification. Approval records remain unchanged.</p><div id="batchPreview" aria-live="polite"></div></div><div class="modal-footer"><button class="btn btn-outline" type="button" id="batchCloseBtn">Cancel</button><button class="btn btn-outline" type="button" id="batchReviewBtn">Review changes</button><button class="btn btn-primary" type="button" id="batchApplyBtn" disabled>Apply updates</button></div></div>';
    document.body.append(modal);
    modal.querySelector('.modal-close').addEventListener('click', closeBatch);
    el('batchCloseBtn').addEventListener('click', closeBatch);
    el('batchReviewBtn').addEventListener('click', reviewBatch);
    el('batchApplyBtn').addEventListener('click', applyBatch);
    ['batchType', 'batchCondition', 'batchStage'].forEach(id => el(id).addEventListener('change', () => { reviewed = null; el('batchApplyBtn').disabled = true; el('batchPreview').textContent = ''; }));
    refresh();
  }
  global.VaultCollectionTools = Object.freeze({ init, refresh, applyFilters, openBatch, closeBatch, filterIds: FILTERS, extraFilters, applyView });
})(window);
