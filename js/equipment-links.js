/* One equipment record can be associated with several hosts, with one current host. */
(function () {
  'use strict';

  const MODAL_ID = 'equipmentLinksModal';
  let contextHostId = '';
  let selectedKey = '';
  let saving = false;
  let initialized = false;

  const escape = value => String(value == null ? '' : value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const clone = value => JSON.parse(JSON.stringify(value));
  const database = () => typeof db === 'object' && db ? db : { firearms: [], accessories: [] };
  const idOf = value => typeof value === 'string' ? value.trim() : '';
  const uniqueIds = values => Array.from(new Set((Array.isArray(values) ? values : []).map(idOf).filter(Boolean)));
  const linkState = record => JSON.stringify({ hostFirearmIds: record.hostFirearmIds, currentHostId: record.currentHostId, firearmId: record.firearmId });
  let linkBaseline = null;
  const currency = value => typeof money === 'function' ? money(value) : '$' + Number(value || 0).toFixed(2);
  const price = record => Math.max(0, parseFloat(record && record.price) || 0);

  function hostIds(record) {
    if (!record) return [];
    if (record.hostFirearmIds !== undefined) return uniqueIds(record.hostFirearmIds);
    if (record.currentHostId !== undefined) return uniqueIds([record.currentHostId]);
    return uniqueIds([record.firearmId]);
  }

  function currentHostId(record) {
    if (!record) return null;
    const current = record.currentHostId !== undefined ? idOf(record.currentHostId) : record.hostFirearmIds !== undefined ? '' : idOf(record.firearmId);
    return current && hostIds(record).includes(current) ? current : null;
  }

  function isDisposed(record) {
    if (window.VaultCollection && typeof window.VaultCollection.isDisposed === 'function') return window.VaultCollection.isDisposed(record);
    return !!(record && record.status && record.status !== 'Active');
  }

  function isSuppressor(record) {
    if (!record) return false;
    const type = String(record.type || '').trim().toLowerCase();
    const nfaType = String(record.nfaType || '').trim().toLowerCase();
    return ['silencer', 'suppressor'].includes(type) || !!(record.isNFA && nfaType === 'suppressor');
  }

  function eligibleHost(record) {
    return !!record && !!idOf(record.id) && !isSuppressor(record) && !isDisposed(record) &&
      (!record.acquisitionStage || ['In possession', 'At gunsmith'].includes(record.acquisitionStage));
  }

  function availableHosts(data, equipmentId) {
    return (data.firearms || []).filter(record => eligibleHost(record) && record.id !== equipmentId);
  }

  function equipmentRecords(data) {
    return [
      ...(data.firearms || []).filter(record => isSuppressor(record) && !isDisposed(record)).map(record => ({ collection: 'firearms', record })),
      ...(data.accessories || []).map(record => ({ collection: 'accessories', record }))
    ];
  }

  function equipmentForHost(data, hostId) {
    const host = (data.firearms || []).find(record => record.id === hostId);
    if (!eligibleHost(host)) return [];
    return equipmentRecords(data).filter(entry => entry.record.id !== hostId && hostIds(entry.record).includes(hostId))
      .map(entry => ({ ...entry, current: currentHostId(entry.record) === hostId }));
  }

  function buildCost(data, hostId) {
    const host = (data.firearms || []).find(record => record.id === hostId);
    if (!host) return 0;
    return price(host) + equipmentForHost(data, hostId).filter(entry => entry.current).reduce((sum, entry) => sum + price(entry.record), 0);
  }

  function label(record, collection) {
    if (collection === 'accessories') return [record.name || 'Accessory', record.brand, record.model].filter(Boolean).join(' ');
    return [record.make, record.model].filter(Boolean).join(' ') || 'Suppressor';
  }

  const hostLabel = record => [record.make, record.model].filter(Boolean).join(' ') || 'Firearm';
  const entryKey = entry => entry.collection + '|' + entry.record.id;

  function getEntry(key) {
    const split = String(key || '').indexOf('|');
    if (split < 1) return null;
    const collection = key.slice(0, split);
    if (!['firearms', 'accessories'].includes(collection)) return null;
    return equipmentRecords(database()).find(entry => entry.collection === collection && entry.record.id === key.slice(split + 1)) || null;
  }

  function actionButton(action, text, attributes, primary) {
    return '<button type="button" class="btn btn-small ' + (primary ? 'btn-primary' : 'btn-outline') + '" data-equipment-action="' + action + '"' +
      Object.entries(attributes || {}).map(([key, value]) => ' data-equipment-' + key + '="' + escape(value) + '"').join('') + '>' + escape(text) + '</button>';
  }

  function equipmentRow(entry, hostId) {
    const current = currentHostId(entry.record);
    const currentHost = (database().firearms || []).find(record => record.id === current && eligibleHost(record));
    const assignment = entry.current ? 'Currently on this firearm' : currentHost ? 'Currently on ' + hostLabel(currentHost) : 'Currently unassigned';
    return '<div class="equipment-row"><div class="equipment-row-copy"><strong>' + escape(label(entry.record, entry.collection)) + '</strong>' +
      '<span>' + escape(entry.collection === 'firearms' ? 'Suppressor' : entry.record.category || 'Accessory') + ' &middot; ' + escape(currency(price(entry.record))) + '</span>' +
      '<span class="equipment-assignment' + (entry.current ? ' is-current' : '') + '">' + escape(assignment) + '</span></div><div class="equipment-row-actions">' +
      actionButton('source', 'View record', { key: entryKey(entry) }) + actionButton('edit', 'Edit links', { key: entryKey(entry), host: hostId }) + '</div></div>';
  }

  function buildHTML(firearm) {
    if (!firearm) return '';
    const data = database();
    if (isSuppressor(firearm)) {
      const hosts = availableHosts(data, firearm.id).filter(host => hostIds(firearm).includes(host.id));
      const current = currentHostId(firearm);
      return '<section class="detail-section equipment-section"><div class="equipment-heading"><h3>Host firearm links</h3>' +
        actionButton('edit', 'Edit host links', { key: 'firearms|' + firearm.id }) + '</div><p class="equipment-help">Keep one suppressor record and associate it with several firearms. Choose one current host when it is assigned.</p>' +
        (hosts.length ? '<ul class="equipment-host-summary">' + hosts.map(host => '<li><strong>' + escape(hostLabel(host)) + '</strong><span>' + (host.id === current ? 'Current host' : 'Associated host') + '</span></li>').join('') + '</ul>' : '<p class="equipment-empty">No host firearms linked.</p>') + '</section>';
    }
    if (!eligibleHost(firearm)) return '<section class="detail-section equipment-section"><h3>Build / Loadout</h3><p class="equipment-help">Equipment can be linked when this firearm is in possession or at the gunsmith.</p></section>';
    const entries = equipmentForHost(data, firearm.id).sort((left, right) => label(left.record, left.collection).localeCompare(label(right.record, right.collection)));
    const assigned = entries.filter(entry => entry.current);
    const associated = entries.filter(entry => !entry.current);
    const assignedCost = assigned.reduce((sum, entry) => sum + price(entry.record), 0);
    return '<section class="detail-section equipment-section"><div class="equipment-heading"><h3>Build / Loadout</h3>' + actionButton('edit', 'Link existing equipment', { host: firearm.id }, true) + '</div>' +
      '<div class="build-summary"><div><div class="build-summary-label">Current build purchase cost</div><div class="build-summary-value">' + escape(currency(price(firearm) + assignedCost)) + '</div></div>' +
      '<div class="build-summary-meta">Firearm ' + escape(currency(price(firearm))) + ' + current equipment ' + escape(currency(assignedCost)) + '</div></div>' +
      '<p class="equipment-help">Equipment has one source record. Only equipment currently assigned here contributes to this build cost. Associated equipment stays linked for reference.</p>' +
      (assigned.length ? '<h4 class="equipment-subheading">Currently assigned (' + assigned.length + ')</h4>' + assigned.map(entry => equipmentRow(entry, firearm.id)).join('') : '<p class="equipment-empty">No equipment currently assigned.</p>') +
      (associated.length ? '<h4 class="equipment-subheading">Also associated (' + associated.length + ')</h4>' + associated.map(entry => equipmentRow(entry, firearm.id)).join('') : '') + '</section>';
  }

  function setError(message) {
    const error = document.getElementById('equipmentLinksError');
    if (error) { error.textContent = message || ''; error.hidden = !message; }
  }

  function selectedHosts() {
    return uniqueIds(Array.from(document.querySelectorAll('#equipmentHostList input:checked')).map(input => input.value));
  }

  function refreshCurrentOptions(preferred) {
    const select = document.getElementById('equipmentCurrentHost');
    if (!select) return;
    const current = preferred === undefined ? select.value : preferred;
    const ids = selectedHosts();
    const hosts = availableHosts(database(), getEntry(selectedKey)?.record.id);
    select.innerHTML = '<option value="">Unassigned / in storage</option>' + hosts.filter(host => ids.includes(host.id)).map(host => '<option value="' + escape(host.id) + '">' + escape(hostLabel(host)) + '</option>').join('');
    select.value = ids.includes(current) ? current : '';
  }

  function populateLinks() {
    const entry = getEntry(selectedKey);
    linkBaseline = entry ? { key: selectedKey, state: linkState(entry.record) } : null;
    const fields = document.getElementById('equipmentLinkFields');
    const save = document.getElementById('saveEquipmentLinksBtn');
    const view = document.getElementById('equipmentViewSourceBtn');
    const unlink = document.getElementById('equipmentUnlinkBtn');
    fields.hidden = !entry;
    save.disabled = !entry;
    view.hidden = !entry;
    unlink.hidden = !entry || !contextHostId || !hostIds(entry.record).includes(contextHostId);
    setError('');
    if (!entry) return;
    const hosts = availableHosts(database(), entry.record.id);
    const ids = hostIds(entry.record);
    const selected = uniqueIds([...ids, contextHostId]).filter(id => hosts.some(host => host.id === id));
    document.getElementById('equipmentHostList').innerHTML = hosts.length ? hosts.map((host, index) => '<label class="equipment-host-option" for="equipmentHostOption' + index + '"><input type="checkbox" id="equipmentHostOption' + index + '" value="' + escape(host.id) + '"' + (selected.includes(host.id) ? ' checked' : '') + '><span>' + escape(hostLabel(host)) + '</span></label>').join('') : '<p class="equipment-empty">No host firearms are currently available.</p>';
    document.getElementById('equipmentUnavailableNote').hidden = !ids.some(id => !hosts.some(host => host.id === id));
    refreshCurrentOptions(currentHostId(entry.record));
  }

  function open(hostId, collection, recordId) {
    init();
    if (saving) return false;
    contextHostId = idOf(hostId);
    const all = equipmentRecords(database()).filter(entry => entry.record.id !== contextHostId);
    selectedKey = collection && recordId ? collection + '|' + recordId : '';
    const selector = document.getElementById('equipmentSource');
    selector.innerHTML = '<option value="">Choose an existing item</option>' + all.sort((left, right) => label(left.record, left.collection).localeCompare(label(right.record, right.collection))).map(entry => '<option value="' + escape(entryKey(entry)) + '">' + escape(label(entry.record, entry.collection)) + ' (' + (entry.collection === 'firearms' ? 'Suppressor' : 'Accessory') + ')</option>').join('');
    selector.value = selectedKey;
    selectedKey = selector.value;
    document.getElementById('equipmentNoItems').hidden = !!all.length;
    populateLinks();
    const modal = document.getElementById(MODAL_ID);
    modal.dataset.dirty = 'false';
    modal.classList.add('open');
    setTimeout(() => selector.focus(), 0);
    return true;
  }

  async function close() {
    const modal = document.getElementById(MODAL_ID);
    if (!modal || saving || modal.dataset.saving === 'true') return false;
    if (modal.dataset.dirty === 'true' && typeof confirmDialog === 'function' && !await confirmDialog('Discard these equipment link changes?', { title: 'Unsaved equipment links', okText: 'Discard changes' })) return false;
    modal.classList.remove('open');
    modal.dataset.dirty = 'false';
    return true;
  }

  async function saveLinks() {
    if (saving) return false;
    const entry = getEntry(selectedKey);
    if (!entry) { setError('Choose an existing equipment record.'); return false; }
    if (!linkBaseline || linkBaseline.key !== selectedKey || linkBaseline.state !== linkState(entry.record)) {
      setError('These equipment links changed while this form was open. Reopen the links to review the current assignments before saving.');
      return false;
    }
    const hosts = selectedHosts();
    const current = idOf(document.getElementById('equipmentCurrentHost').value) || null;
    const available = new Set(availableHosts(database(), entry.record.id).map(host => host.id));
    if (hosts.some(id => !available.has(id) || id === entry.record.id)) { setError('One of the selected hosts is no longer available. Reopen the links and try again.'); return false; }
    if (current && !hosts.includes(current)) { setError('The current host must also be selected in associated hosts.'); return false; }
    const mutation = window.VaultCollection && window.VaultCollection.commitChanges;
    if (typeof mutation !== 'function') { setError('Equipment links could not be saved. Reload the application and try again.'); return false; }
    const before = clone(entry.record);
    const after = { ...clone(entry.record), hostFirearmIds: hosts, currentHostId: current };
    if (entry.collection === 'accessories') after.firearmId = current || '';
    const modal = document.getElementById(MODAL_ID);
    const button = document.getElementById('saveEquipmentLinksBtn');
    const controls = Array.from(modal.querySelectorAll('input, select, button'));
    const previousDisabled = controls.map(control => control.disabled);
    saving = true;
    modal.dataset.saving = 'true';
    controls.forEach(control => { control.disabled = true; });
    button.textContent = 'Saving...';
    setError('');
    let success = false;
    try {
      success = await mutation('Equipment links', [{ collection: entry.collection, id: entry.record.id, before, after }]);
      if (!success) { setError('Equipment links were not saved. Your choices are still here so you can retry.'); modal.dataset.dirty = 'true'; return false; }
      modal.dataset.dirty = 'false';
      modal.classList.remove('open');
      if (typeof render === 'function') render();
      if (contextHostId && typeof openDetail === 'function') openDetail(contextHostId);
      else if (entry.collection === 'firearms' && typeof openDetail === 'function') openDetail(entry.record.id);
      if (typeof toast === 'function') toast('Equipment links saved.', 'success');
      return true;
    } catch (error) {
      console.warn('Equipment links could not be saved:', error);
      setError('Equipment links were not saved. Keep this form open and retry.');
      modal.dataset.dirty = 'true';
      return false;
    } finally {
      saving = false;
      modal.dataset.saving = 'false';
      controls.forEach((control, index) => { control.disabled = previousDisabled[index]; });
      button.textContent = 'Save links';
    }
  }

  async function viewSource(key) {
    const entry = getEntry(key);
    if (!entry) return;
    const modal = document.getElementById(MODAL_ID);
    if (modal?.classList.contains('open') && !await close()) return;
    if (entry.collection === 'firearms' && typeof openDetail === 'function') openDetail(entry.record.id);
    else if (typeof openAccessoryModal === 'function') {
      if (typeof closeDetail === 'function') closeDetail();
      openAccessoryModal(entry.record.id);
    }
  }

  function init() {
    if (initialized) return;
    initialized = true;
    const modal = document.createElement('div');
    modal.id = MODAL_ID;
    modal.className = 'modal-overlay equipment-links-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-labelledby', 'equipmentLinksTitle');
    modal.innerHTML = '<div class="modal"><div class="modal-header"><h2 id="equipmentLinksTitle">Equipment and host links</h2><button type="button" class="modal-close" data-equipment-action="close" aria-label="Close equipment links">&times;</button></div>' +
      '<form id="equipmentLinksForm"><div class="modal-body"><p class="equipment-help">Link an existing suppressor or accessory to your firearms. Its photos, serial number, documents, and purchase cost stay in one record.</p>' +
      '<div class="form-group"><label for="equipmentSource">Existing equipment</label><select id="equipmentSource" required></select></div>' +
      '<p id="equipmentNoItems" class="equipment-help" hidden>Add a suppressor or accessory to the vault first, then link it here.</p>' +
      '<div id="equipmentLinkFields" hidden><fieldset class="equipment-host-fieldset"><legend>Associated hosts</legend><p class="equipment-help">Select every firearm you want linked to this equipment.</p><div id="equipmentHostList" class="equipment-host-list"></div></fieldset>' +
      '<p id="equipmentUnavailableNote" class="equipment-help" hidden>Some previous hosts are unavailable. Saving will remove those unavailable links.</p>' +
      '<div class="form-group"><label for="equipmentCurrentHost">Current host</label><select id="equipmentCurrentHost"><option value="">Unassigned / in storage</option></select><p class="equipment-help">Choose where the equipment is currently assigned. Its cost is included only in that firearm\'s current build.</p></div>' +
      '<div class="equipment-secondary-actions"><button type="button" id="equipmentViewSourceBtn" class="btn btn-small btn-outline" data-equipment-action="modal-source">View equipment record</button><button type="button" id="equipmentUnlinkBtn" class="btn btn-small btn-outline" data-equipment-action="unlink" hidden>Unlink from this firearm</button></div></div>' +
      '<p id="equipmentLinksError" class="equipment-error" role="alert" hidden></p></div><div class="modal-footer"><button type="button" class="btn btn-outline" data-equipment-action="close">Cancel</button><button type="submit" id="saveEquipmentLinksBtn" class="btn btn-primary">Save links</button></div></form></div>';
    document.body.appendChild(modal);
    modal.addEventListener('click', event => { if (event.target === modal) close(); });
    modal.addEventListener('change', event => {
      modal.dataset.dirty = 'true';
      setError('');
      if (event.target.id === 'equipmentSource') { selectedKey = event.target.value; populateLinks(); }
      else if (event.target.matches('#equipmentHostList input')) refreshCurrentOptions();
    });
    modal.querySelector('form').addEventListener('submit', event => { event.preventDefault(); saveLinks(); });
    document.addEventListener('click', async event => {
      const button = event.target.closest('[data-equipment-action]');
      if (!button) return;
      event.preventDefault();
      event.stopPropagation();
      const action = button.dataset.equipmentAction;
      if (action === 'close') await close();
      else if (action === 'source') await viewSource(button.dataset.equipmentKey);
      else if (action === 'modal-source') await viewSource(selectedKey);
      else if (action === 'edit') {
        const key = button.dataset.equipmentKey || '';
        const separator = key.indexOf('|');
        open(button.dataset.equipmentHost || '', separator > 0 ? key.slice(0, separator) : '', separator > 0 ? key.slice(separator + 1) : '');
      } else if (action === 'unlink' && contextHostId && !saving) {
        modal.querySelectorAll('#equipmentHostList input').forEach(input => { if (input.value === contextHostId) input.checked = false; });
        refreshCurrentOptions();
        modal.dataset.dirty = 'true';
        await saveLinks();
      }
    });
  }

  window.VaultEquipment = { init, open, close, buildHTML, buildCost, equipmentForHost, hostIds, currentHostId, eligibleHost };
})();
