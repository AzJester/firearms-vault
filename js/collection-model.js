(function initCollectionModel(global) {
  'use strict';
  const DISPOSED = new Set(['Sold', 'Traded', 'Transferred', 'Lost', 'Stolen', 'Destroyed']);
  const copy = value => value === undefined ? undefined : structuredClone(value);
  function isDisposed(record) { return !!record && DISPOSED.has(record.status); }
  function stage(record) { return record && record.acquisitionStage || 'In possession'; }
  function inPossession(record) { return !!record && !isDisposed(record) && !['Ordered', 'Awaiting pickup'].includes(stage(record)); }
  function value(record, basis) {
    const raw = record && record[basis === 'replacement' ? 'replacementValue' : 'price'];
    if (raw == null || typeof raw === 'string' && raw.trim() === '') return null;
    const amount = Number(raw);
    return Number.isFinite(amount) && amount >= 0 ? amount : null;
  }
  // All records in one feature action share the existing save lock and durable
  // snapshot. Reject stale plans before touching either record of a linked edit.
  async function commitChanges(label, changes) {
    if (!Array.isArray(changes) || !changes.length) return false;
    return withFormSaveLock('collection-feature', null, async () => {
      const ids = new Set();
      for (const change of changes) {
        if (!['firearms', 'ammo', 'accessories', 'settings'].includes(change.collection)) throw new Error('Unsupported collection update.');
        const key = change.collection + ':' + change.id;
        if (ids.has(key)) throw new Error('Duplicate record in update.');
        ids.add(key);
        const current = change.collection === 'settings' ? db.settings || {} : (db[change.collection] || []).find(item => item.id === change.id);
        if (!current || !editValuesEqual(current, change.before)) {
          toast('This record changed while you were reviewing it. Reopen the form and try again.', 'warning', 7000);
          return false;
        }
        if (!change.after || (change.collection !== 'settings' && change.after.id !== change.id)) throw new Error('Invalid updated record.');
      }
      const auditSnapshot = copy(db.auditTrail || []);
      const auditsBefore = new Set(auditSnapshot.map(entry => entry.id));
      for (const change of changes) {
        if (change.collection === 'settings') db.settings = copy(change.after);
        else {
          const index = db[change.collection].findIndex(item => item.id === change.id);
          db[change.collection][index] = copy(change.after);
        }
        const itemName = change.after.name || [change.after.make, change.after.model].filter(Boolean).join(' ') || label;
        addAuditEntry('edit', change.collection === 'settings' ? 'system' : change.collection === 'ammo' ? 'ammo' : change.collection === 'accessories' ? 'accessory' : 'firearm', itemName, label,
          change.collection === 'settings' ? undefined : { collection: change.collection, recordId: change.id, before: change.before, after: change.after });
      }
      const createdAudits = new Set((db.auditTrail || []).filter(entry => !auditsBefore.has(entry.id)).map(entry => entry.id));
      let saved = false;
      try { saved = await saveData(); } catch (error) { console.warn('Collection action save failed:', error); }
      if (!saved) {
        // Roll back only fields still carrying this action's values. A cloud
        // update to another field or record must survive a failed local save.
        for (const change of changes) {
          const current = change.collection === 'settings' ? db.settings : db[change.collection].find(item => item.id === change.id);
          if (!current) continue;
          for (const key of new Set([...Object.keys(change.before), ...Object.keys(change.after)])) {
            if (key === 'id' || editValuesEqual(change.before[key], change.after[key])) continue;
            if (editValuesEqual(current[key], change.after[key])) {
              if (Object.hasOwn(change.before, key)) current[key] = copy(change.before[key]);
              else delete current[key];
            }
          }
        }
        const concurrentAudits = (db.auditTrail || []).filter(entry => !createdAudits.has(entry.id));
        const auditMap = new Map([...auditSnapshot, ...concurrentAudits].map(entry => [entry.id, entry]));
        db.auditTrail = Array.from(auditMap.values()).slice(-500);
        hasUnsavedChanges = true;
        try { const safeCopy = { ...db }; delete safeCopy.backups; await statePut('db', safeCopy); } catch (_) {}
        setSaveStatus('failed', label + ' not saved');
        toast('The change could not be saved. Your previous values were kept; keep this page open and retry.', 'error', 9000);
        render();
        return false;
      }
      render();
      return true;
    });
  }
  global.VaultCollection = Object.freeze({ isDisposed, stage, inPossession, value, commitChanges });
})(window);
