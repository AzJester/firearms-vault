(function initRangeSessions(global) {
  'use strict';

  let initialized = false;
  let saving = false;
  let returnFocus = null;
  const $ = id => document.getElementById(id);
  const clone = value => structuredClone(value);
  const escape = value => String(value == null ? '' : value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const data = () => typeof db !== 'undefined' ? db : { firearms: [], ammo: [] };
  const notify = (message, kind) => { if (typeof global.toast === 'function') global.toast(message, kind); };
  const firearmName = firearm => [firearm.make, firearm.model].filter(Boolean).join(' ') || 'Firearm';
  const ammoName = ammo => [ammo.caliber, ammo.brand, ammo.location ? '(' + ammo.location + ')' : ''].filter(Boolean).join(' ') || 'Ammunition';

  function today() {
    const now = new Date();
    return now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
  }

  function dayNumber(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return null;
    const [year, month, day] = value.split('-').map(Number);
    const parsed = new Date(Date.UTC(year, month - 1, day));
    if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) return null;
    return parsed.getTime() / 86400000;
  }

  function wholeNumber(value, allowZero) {
    if (value === null || value === undefined || String(value).trim() === '') return null;
    const result = Number(value);
    return Number.isSafeInteger(result) && result >= (allowZero ? 0 : 1) ? result : null;
  }

  function status(message, invalidId) {
    const element = $('rangeSessionStatus');
    if (element) { element.textContent = message || ''; element.hidden = !message; }
    if (invalidId && $(invalidId)) $(invalidId).focus();
    return false;
  }

  function setBusy(value) {
    saving = value;
    const modal = $('rangeSessionModal');
    if (!modal) return;
    modal.dataset.saving = String(value);
    modal.setAttribute('aria-busy', String(value));
    modal.querySelectorAll('input, select, textarea, button').forEach(element => { element.disabled = value; });
    $('rangeSessionSaveBtn').textContent = value ? 'Saving...' : 'Save range session';
  }

  function init() {
    if (initialized) return;
    initialized = true;
    const modal = document.createElement('div');
    modal.id = 'rangeSessionModal';
    modal.className = 'modal-overlay range-session-overlay';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-labelledby', 'rangeSessionTitle');
    modal.innerHTML = '<div class="modal range-session-modal"><div class="modal-header"><h2 id="rangeSessionTitle">Log range session</h2><button type="button" class="modal-close" data-range-close aria-label="Close range session">&times;</button></div>' +
      '<form id="rangeSessionForm"><div class="modal-body"><p class="range-session-help">Record rounds fired once to update this firearm\'s lifetime count and ammunition on hand.</p>' +
      '<div class="form-grid"><div class="form-group"><label for="rsDate">Date</label><input id="rsDate" type="date" required></div><div class="form-group"><label for="rsRounds">Rounds fired</label><input id="rsRounds" type="number" min="1" step="1" inputmode="numeric" required></div>' +
      '<div class="form-group range-session-wide"><label for="rsFirearm">Firearm</label><select id="rsFirearm" required></select></div>' +
      '<div class="form-group range-session-wide"><label for="rsAmmo">Ammunition lot</label><select id="rsAmmo" required aria-describedby="rsAmmoHelp"></select><p id="rsAmmoHelp" class="range-session-help">All saved lots are listed. Check the lot yourself before selecting it. This list does not assess compatibility.</p></div>' +
      '<div class="form-group range-session-wide"><label for="rsNotes">Session notes</label><textarea id="rsNotes" rows="3" maxlength="4000" placeholder="Optional plain-text notes"></textarea></div></div><p id="rangeSessionStatus" class="range-session-error" role="alert" hidden></p></div>' +
      '<div class="modal-footer"><button type="button" class="btn btn-outline" data-range-close>Cancel</button><button id="rangeSessionSaveBtn" type="submit" class="btn btn-primary">Save range session</button></div></form></div>';
    document.body.appendChild(modal);
    $('rangeSessionForm').addEventListener('submit', event => { event.preventDefault(); void save(); });
    modal.addEventListener('click', event => { if (event.target === modal || event.target.closest('[data-range-close]')) close(); });
    modal.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); } });
    document.addEventListener('click', event => {
      const opener = event.target.closest('[data-range-open]');
      if (opener) { event.preventDefault(); open(opener.dataset.rangeOpen || undefined); return; }
      const undoer = event.target.closest('[data-range-undo]');
      if (undoer) { event.preventDefault(); void undo(undoer.dataset.rangeFirearm, undoer.dataset.rangeUndo, undoer); }
    });
  }

  function open(firearmId) {
    init();
    if (saving) return false;
    const current = data();
    const firearms = Array.isArray(current.firearms) ? current.firearms : [];
    if (!firearms.length) { notify('Add a firearm before logging a range session.', 'info'); return false; }
    returnFocus = document.activeElement;
    $('rsFirearm').innerHTML = '<option value="">Select a firearm</option>' + firearms.map(firearm => '<option value="' + escape(firearm.id) + '">' + escape(firearmName(firearm) + (firearm.serial ? ' · ' + firearm.serial : '')) + '</option>').join('');
    $('rsFirearm').value = firearmId || '';
    $('rsAmmo').innerHTML = '<option value="">Select an ammunition lot</option>' + (current.ammo || []).map(ammo => '<option value="' + escape(ammo.id) + '">' + escape(ammoName(ammo) + ' · ' + String(ammo.quantity || 0) + ' rounds on hand · lot ' + String(ammo.lot || ammo.lotNumber || ammo.id)) + '</option>').join('');
    $('rsDate').value = today();
    $('rsDate').max = today();
    $('rsRounds').value = '';
    $('rsNotes').value = '';
    status('');
    $('rangeSessionModal').classList.add('open');
    return true;
  }

  function close() {
    if (saving) return false;
    const modal = $('rangeSessionModal');
    if (modal) modal.classList.remove('open');
    if (returnFocus && returnFocus.isConnected) returnFocus.focus();
    return true;
  }

  async function save() {
    if (saving) return false;
    const current = data();
    const firearm = (current.firearms || []).find(item => item.id === $('rsFirearm').value);
    const ammo = (current.ammo || []).find(item => item.id === $('rsAmmo').value);
    const rounds = wholeNumber($('rsRounds').value, false);
    const date = $('rsDate').value;
    if (!firearm) return status('Select an existing firearm.', 'rsFirearm');
    if (!ammo) return status('Select an existing ammunition lot.', 'rsAmmo');
    if (dayNumber(date) === null || dayNumber(date) > dayNumber(today())) return status('Enter a valid session date on or before today.', 'rsDate');
    if (rounds === null) return status('Rounds fired must be a positive whole number.', 'rsRounds');
    const stock = wholeNumber(ammo.quantity, true);
    if (stock === null) return status('This lot has an invalid quantity. Correct the ammunition record first.', 'rsAmmo');
    if (rounds > stock) return status('This lot has only ' + stock + ' rounds available.', 'rsRounds');
    if (firearm.rangeSessions != null && (!Array.isArray(firearm.rangeSessions) || firearm.rangeSessions.some(session => !session || typeof session !== 'object'))) return status('This firearm has invalid session history. Review its record before adding another session.', 'rsFirearm');
    const lifetime = firearm.roundCount == null || firearm.roundCount === '' ? 0 : wholeNumber(firearm.roundCount, true);
    if (lifetime === null || !Number.isSafeInteger(lifetime + rounds)) return status('Correct the firearm lifetime round count before logging this session.', 'rsFirearm');
    if (!global.VaultCollection || typeof global.VaultCollection.commitChanges !== 'function') return status('Saving is unavailable. Reload the app and try again.');
    const beforeFirearm = clone(firearm);
    const beforeAmmo = clone(ammo);
    const afterFirearm = clone(firearm);
    const afterAmmo = clone(ammo);
    const session = {
      id: typeof global.generateId === 'function' ? global.generateId() : global.crypto.randomUUID(),
      date, ammoId: ammo.id, ammoLabel: ammoName(ammo), rounds,
      notes: $('rsNotes').value.trim().slice(0, 4000),
      roundCountBefore: lifetime, roundCountAfter: lifetime + rounds, createdAt: new Date().toISOString()
    };
    afterFirearm.rangeSessions = Array.isArray(afterFirearm.rangeSessions) ? afterFirearm.rangeSessions : [];
    afterFirearm.rangeSessions.push(session);
    afterFirearm.roundCount = lifetime + rounds;
    afterAmmo.quantity = typeof ammo.quantity === 'string' ? String(stock - rounds) : stock - rounds;
    setBusy(true);
    status('');
    let committed = false;
    try {
      committed = await global.VaultCollection.commitChanges('Range session: ' + firearmName(firearm) + ', ' + rounds + ' rounds', [
        { collection: 'firearms', id: firearm.id, before: beforeFirearm, after: afterFirearm },
        { collection: 'ammo', id: ammo.id, before: beforeAmmo, after: afterAmmo }
      ]);
      if (!committed) { status('The session was not saved. Your entries are still here. Review any sync warning, then retry.'); return false; }
    } catch (error) {
      console.error('Range session save failed', error);
      status('The session was not saved. Your entries are still here. Try again.');
      return false;
    } finally { setBusy(false); }
    close();
    if (typeof global.openDetail === 'function') global.openDetail(firearm.id);
    notify('Range session saved. Ammunition and lifetime rounds updated.', 'success');
    return true;
  }

  async function undo(firearmId, sessionId, button) {
    if (saving) return false;
    const current = data();
    const firearm = (current.firearms || []).find(item => item.id === firearmId);
    const sessions = firearm && Array.isArray(firearm.rangeSessions) ? firearm.rangeSessions.filter(session => session && typeof session === 'object') : [];
    const latest = sessions.filter(session => !session.undoneAt).at(-1);
    if (!firearm || !latest || latest.id !== sessionId) { notify('Only the latest active session can be undone. Reopen the firearm to see its current history.', 'error'); return false; }
    const ammo = (current.ammo || []).find(item => item.id === latest.ammoId);
    if (!ammo) { notify('The ammunition lot was removed. Restore that lot before undoing this session.', 'error'); return false; }
    const rounds = wholeNumber(latest.rounds, false);
    const beforeCount = wholeNumber(latest.roundCountBefore, true);
    const afterCount = wholeNumber(latest.roundCountAfter, true);
    const stock = wholeNumber(ammo.quantity, true);
    if (rounds === null || beforeCount === null || afterCount === null || afterCount !== beforeCount + rounds || Number(firearm.roundCount) !== afterCount || stock === null || !Number.isSafeInteger(stock + rounds)) {
      notify('This session cannot be undone safely because its recorded counts changed. Review the firearm and ammunition records.', 'error');
      return false;
    }
    if (!global.VaultCollection || typeof global.VaultCollection.commitChanges !== 'function') { notify('Saving is unavailable. Reload the app and try again.', 'error'); return false; }
    const afterFirearm = clone(firearm);
    const afterAmmo = clone(ammo);
    afterFirearm.rangeSessions.find(session => session && session.id === sessionId).undoneAt = new Date().toISOString();
    afterFirearm.roundCount = beforeCount;
    afterAmmo.quantity = typeof ammo.quantity === 'string' ? String(stock + rounds) : stock + rounds;
    saving = true;
    if (button) button.disabled = true;
    try {
      const committed = await global.VaultCollection.commitChanges('Undo range session: ' + firearmName(firearm) + ', ' + rounds + ' rounds', [
        { collection: 'firearms', id: firearm.id, before: clone(firearm), after: afterFirearm },
        { collection: 'ammo', id: ammo.id, before: clone(ammo), after: afterAmmo }
      ]);
      if (!committed) { notify('The undo was not saved. Review the sync warning before retrying.', 'error'); return false; }
      if (typeof global.openDetail === 'function') global.openDetail(firearm.id);
      notify('Session undone. Ammunition and lifetime rounds restored.', 'success');
      return true;
    } catch (error) { console.error('Range session undo failed', error); notify('The undo was not saved. Try again.', 'error'); return false; }
    finally { saving = false; if (button && button.isConnected) button.disabled = false; }
  }

  function detailHTML(firearm) {
    const sessions = Array.isArray(firearm.rangeSessions) ? firearm.rangeSessions.filter(session => session && typeof session === 'object') : [];
    const latest = sessions.filter(session => !session.undoneAt).at(-1);
    const remindersForFirearm = reminders({ firearms: [firearm] });
    const intervals = [wholeNumber(firearm.maintenanceIntervalRounds, false) ? Number(firearm.maintenanceIntervalRounds).toLocaleString() + ' rounds' : '', wholeNumber(firearm.maintenanceIntervalDays, false) ? Number(firearm.maintenanceIntervalDays).toLocaleString() + ' days' : ''].filter(Boolean);
    let html = '<section class="detail-section range-session-detail"><div class="range-session-heading"><h3>Range sessions</h3><button class="btn btn-small btn-primary" type="button" data-range-open="' + escape(firearm.id) + '">Log range session</button></div>';
    if (intervals.length) html += '<p class="range-session-help">Maintenance interval: ' + escape(intervals.join(' or ')) + '. Uses lifetime rounds at the latest cleaning or maintenance entry, or the baseline in this firearm\'s form.</p>';
    html += remindersForFirearm.map(reminder => '<p class="range-session-due">' + escape(reminder.text) + '</p>').join('');
    if (!sessions.length) html += '<p class="range-session-help">No range sessions recorded yet.</p>';
    else html += '<p class="range-session-help">To correct an entry, undo the latest active session, then log it again. Undo restores rounds to the original lot.</p>' + '<div class="range-session-history">' + sessions.slice().reverse().map(session => '<article class="range-session-entry' + (session.undoneAt ? ' is-undone' : '') + '"><div class="range-session-heading"><strong>' + escape(session.date) + ' · ' + escape(session.rounds) + ' rounds' + (session.undoneAt ? ' · Undone' : '') + '</strong>' + (!session.undoneAt && latest && session.id === latest.id ? '<button class="btn btn-small btn-outline" type="button" data-range-firearm="' + escape(firearm.id) + '" data-range-undo="' + escape(session.id) + '">Undo session</button>' : '') + '</div><p>' + escape(session.ammoLabel || 'Ammunition lot') + '</p>' + (session.notes ? '<p class="range-session-notes">' + escape(session.notes) + '</p>' : '') + '</article>').join('') + '</div>';
    return html + '</section>';
  }

  function reminders(currentData) {
    const result = [];
    const currentDay = dayNumber(today());
    ((currentData || data()).firearms || []).forEach(firearm => {
      if (firearm.status && firearm.status !== 'Active') return;
      const intervalRounds = wholeNumber(firearm.maintenanceIntervalRounds, false);
      const intervalDays = wholeNumber(firearm.maintenanceIntervalDays, false);
      if (!intervalRounds && !intervalDays) return;
      const lifetime = wholeNumber(firearm.roundCount, true) || 0;
      const entries = (Array.isArray(firearm.maintenanceLog) ? firearm.maintenanceLog : []).filter(entry => entry && /^(cleaning|maintenance)$/i.test(String(entry.type || '')) && dayNumber(entry.date) !== null && dayNumber(entry.date) <= currentDay);
      const last = entries.reduce((previous, entry) => !previous || dayNumber(entry.date) >= dayNumber(previous.date) ? entry : previous, null);
      const documentedReading = last ? wholeNumber(last.roundCount, true) : null;
      const baselineRounds = documentedReading !== null ? documentedReading : (wholeNumber(firearm.maintenanceBaselineRounds, true) || 0);
      const baselineDate = last ? last.date : firearm.dateAcquired;
      const days = dayNumber(baselineDate) === null ? null : currentDay - dayNumber(baselineDate);
      const reasons = [];
      if (intervalRounds && lifetime >= baselineRounds && lifetime - baselineRounds >= intervalRounds) reasons.push((lifetime - baselineRounds).toLocaleString() + ' rounds since service baseline');
      if (intervalDays && days !== null && days >= intervalDays) reasons.push(days.toLocaleString() + ' days since ' + (last ? 'service' : 'acquisition'));
      if (reasons.length) result.push({ sev: 'med', icon: '&#128295;', itemType: 'firearm', itemId: firearm.id, text: firearmName(firearm) + ': maintenance due (' + reasons.join('; ') + ')' });
    });
    return result;
  }

  function formClear() {
    ['fMaintenanceIntervalRounds', 'fMaintenanceIntervalDays', 'fMaintenanceBaselineRounds'].forEach(id => { if ($(id)) $(id).value = ''; });
  }

  function formPopulate(firearm) {
    const fields = { fMaintenanceIntervalRounds: 'maintenanceIntervalRounds', fMaintenanceIntervalDays: 'maintenanceIntervalDays', fMaintenanceBaselineRounds: 'maintenanceBaselineRounds' };
    Object.entries(fields).forEach(([id, key]) => { if ($(id)) $(id).value = firearm[key] == null ? '' : firearm[key]; });
  }

  function formCollect() {
    const values = {};
    const fields = { fMaintenanceIntervalRounds: 'maintenanceIntervalRounds', fMaintenanceIntervalDays: 'maintenanceIntervalDays', fMaintenanceBaselineRounds: 'maintenanceBaselineRounds' };
    for (const [id, key] of Object.entries(fields)) {
      const element = $(id);
      if (!element) continue;
      if (!element.value.trim()) { values[key] = null; continue; }
      const value = wholeNumber(element.value, key === 'maintenanceBaselineRounds');
      if (value === null) { notify(key === 'maintenanceBaselineRounds' ? 'Maintenance baseline must be a whole number of zero or more.' : 'Maintenance intervals must be positive whole numbers, or blank to disable.', 'error'); element.focus(); return false; }
      values[key] = value;
    }
    return values;
  }

  global.VaultRange = Object.freeze({ init, open, close, detailHTML, reminders, formClear, formPopulate, formCollect });
})(window);
