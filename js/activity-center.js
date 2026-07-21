// Searchable, restorable activity history. New audit entries keep compact
// structural snapshots and field-level diffs; binary attachment bytes remain
// in the scoped media store rather than being duplicated into the log.
(function initVaultActivity(global) {
  'use strict';

  const PAGE_SIZE = 20;
  const COLLECTIONS = {
    firearm: 'firearms', ammo: 'ammo', accessory: 'accessories',
    wishlist: 'wishlist', dealer: 'dealers'
  };
  const INTERNAL_FIELDS = new Set(['id']);
  const MEDIA_FIELDS = new Set(['receipt', 'stampPdf', 'data']);
  let currentPage = 1;
  let expandedId = null;

  const clone = value => value == null ? value : structuredClone(value);
  const escapeHTML = value => global.VaultSecurity
    ? global.VaultSecurity.escapeHTML(value)
    : String(value == null ? '' : value).replace(/[&<>"']/g, character => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
      })[character]);

  function stripInlineMedia(value, key) {
    if (value == null || typeof value !== 'object') {
      if (MEDIA_FIELDS.has(key) && typeof value === 'string' && value.startsWith('data:')) return null;
      return value;
    }
    if (Array.isArray(value)) return value.map(item => stripInlineMedia(item, key));
    const result = {};
    Object.entries(value).forEach(([childKey, childValue]) => {
      if (childKey === 'data' && typeof childValue === 'string' && childValue.startsWith('data:')) return;
      if ((childKey === 'receipt' || childKey === 'stampPdf') && typeof childValue === 'string' && childValue.startsWith('data:')) {
        result[childKey] = null;
        return;
      }
      result[childKey] = stripInlineMedia(childValue, childKey);
    });
    return result;
  }

  function snapshotRecord(record, collection) {
    if (!record || typeof record !== 'object') return null;
    const snapshot = stripInlineMedia(clone(record), '');
    if (collection === 'firearms' && record.id) {
      if (record.receipt) snapshot.receipt = '@media:receipt:firearm:' + record.id;
      if (record.stampPdf) snapshot.stampPdf = '@media:stamp:firearm:' + record.id;
    } else if (collection === 'ammo' && record.receipt && record.id) {
      snapshot.receipt = '@media:receipt:ammo:' + record.id;
    } else if (collection === 'accessories' && record.receipt && record.id) {
      snapshot.receipt = '@media:receipt:accessory:' + record.id;
    }
    return snapshot;
  }

  function fieldLabel(field) {
    const labels = {
      make: 'Manufacturer', model: 'Model', serial: 'Serial number', caliber: 'Caliber',
      barrel: 'Barrel length', dateAcquired: 'Date acquired', price: 'Purchase price',
      condition: 'Condition', images: 'Photos', documents: 'Documents', receipt: 'Receipt',
      stampPdf: 'Tax stamp', stampStatus: 'Tax stamp status', tags: 'Tags', roundCount: 'Round count',
      maintenanceLog: 'Maintenance history', firearmId: 'Assigned firearm'
    };
    return labels[field] || String(field || '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, value => value.toUpperCase());
  }

  function comparable(value) {
    if (value == null || value === '') return '';
    if (typeof value === 'string') return value.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    return JSON.stringify(value);
  }

  function displayValue(value) {
    if (value == null || value === '') return 'Not set';
    if (value && typeof value === 'object' && value.__activitySummary) return String(value.__activitySummary);
    if (Array.isArray(value)) {
      if (!value.length) return 'None';
      if (value.every(item => typeof item === 'string')) return value.join(', ');
      return value.length + ' item' + (value.length === 1 ? '' : 's');
    }
    if (typeof value === 'object') return 'Updated details';
    const text = String(value).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    return text.length > 180 ? text.slice(0, 177) + '…' : text || 'Not set';
  }

  function comparisonValue(value) {
    if (typeof value === 'string') {
      const text = value.startsWith('data:') ? 'Attached file' : value;
      return text.length > 500 ? text.slice(0, 497) + '…' : text;
    }
    if (Array.isArray(value)) {
      if (value.every(item => item == null || ['string', 'number', 'boolean'].includes(typeof item))) {
        return value.length > 40 ? [...value.slice(0, 40), '… ' + (value.length - 40) + ' more'] : clone(value);
      }
      return { __activitySummary: value.length + ' item' + (value.length === 1 ? '' : 's') };
    }
    if (value && typeof value === 'object') return { __activitySummary: 'Updated details' };
    return value;
  }

  function diffRecords(before, after) {
    const left = before || {};
    const right = after || {};
    const fields = [...new Set([...Object.keys(left), ...Object.keys(right)])]
      .filter(field => !INTERNAL_FIELDS.has(field));
    return fields.flatMap(field => comparable(left[field]) === comparable(right[field]) ? [] : [{
      field, label: fieldLabel(field), before: comparisonValue(left[field]), after: comparisonValue(right[field])
    }]).slice(0, 80);
  }

  function identitySnapshot(record) {
    if (!record) return null;
    const result = {};
    ['id', 'make', 'model', 'name', 'brand', 'caliber', 'type'].forEach(field => {
      if (record[field] != null && record[field] !== '') result[field] = clone(record[field]);
    });
    return result;
  }

  function recordMediaKeys(collection, record) {
    if (!record || !record.id) return [];
    const keys = [];
    if (collection === 'firearms') {
      (record.images || []).forEach(id => keys.push(String(id)));
      if (record.receipt) keys.push('receipt:firearm:' + record.id);
      if (record.stampPdf) keys.push('stamp:firearm:' + record.id);
      (record.documents || []).forEach(document => keys.push('doc:' + record.id + ':' + document.id));
    } else if (collection === 'ammo' && record.receipt) keys.push('receipt:ammo:' + record.id);
    else if (collection === 'accessories' && record.receipt) keys.push('receipt:accessory:' + record.id);
    return [...new Set(keys)];
  }

  function mediaManifestFor(collection, record) {
    const manifest = {};
    const source = global.CloudSync && CloudSync.serverMediaManifest || {};
    recordMediaKeys(collection, record).forEach(key => { if (source[key]) manifest[key] = clone(source[key]); });
    return manifest;
  }

  function createEntry(action, itemType, itemName, details, metadata) {
    const meta = metadata || {};
    const collection = meta.collection || COLLECTIONS[itemType] || null;
    const beforeSnapshot = snapshotRecord(meta.before, collection);
    const afterSnapshot = snapshotRecord(meta.after, collection);
    const changes = Array.isArray(meta.changes)
      ? clone(meta.changes)
      : (beforeSnapshot && afterSnapshot ? diffRecords(beforeSnapshot, afterSnapshot) : []);
    const before = beforeSnapshot;
    const after = beforeSnapshot ? null : identitySnapshot(afterSnapshot);
    const record = beforeSnapshot || afterSnapshot;
    const sourceRecord = meta.before || meta.after || record;
    return {
      id: meta.id || (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2)),
      timestamp: meta.timestamp || new Date().toISOString(),
      action: String(action || 'edit'),
      itemType: String(itemType || 'system'),
      itemName: String(itemName || 'Untitled'),
      details: String(details || ''),
      collection,
      recordId: meta.recordId || record && record.id || null,
      before,
      after,
      changes,
      mediaManifest: clone(meta.mediaManifest || mediaManifestFor(collection, sourceRecord))
    };
  }

  function contentId(entry) {
    const source = [entry.timestamp, entry.action, entry.itemType, entry.itemName, entry.details, entry.recordId]
      .map(value => String(value || '')).join('\u001f');
    let hash = 2166136261;
    for (let index = 0; index < source.length; index++) {
      hash ^= source.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return 'legacy-' + (hash >>> 0).toString(36);
  }

  function entries() {
    const trail = Array.isArray(db.auditTrail) ? db.auditTrail : [];
    trail.forEach(entry => { if (!entry.id) entry.id = contentId(entry); });
    return trail;
  }

  function filters() {
    return {
      query: String(document.getElementById('activitySearch')?.value || '').trim().toLowerCase(),
      action: String(document.getElementById('activityActionFilter')?.value || ''),
      type: String(document.getElementById('activityTypeFilter')?.value || ''),
      date: String(document.getElementById('activityDateFilter')?.value || '')
    };
  }

  function filteredEntries() {
    const active = filters();
    return entries().slice().reverse().filter(entry => {
      if (active.action && entry.action !== active.action) return false;
      if (active.type && entry.itemType !== active.type) return false;
      if (active.date && String(entry.timestamp || '').slice(0, 10) !== active.date) return false;
      if (!active.query) return true;
      const changeText = (entry.changes || []).map(change => [change.label, displayValue(change.before), displayValue(change.after)].join(' ')).join(' ');
      return [entry.itemName, entry.itemType, entry.action, entry.details, changeText]
        .join(' ').toLowerCase().includes(active.query);
    });
  }

  function canRestore(entry) {
    return !!(entry && entry.before && entry.recordId && entry.collection && Array.isArray(db[entry.collection]));
  }

  function renderChanges(entry) {
    const changes = Array.isArray(entry.changes) && entry.changes.length
      ? entry.changes
      : (entry.before || entry.after ? diffRecords(entry.before, entry.after) : []);
    if (!changes.length) return '<p class="activity-no-diff">A field-by-field comparison was not captured for this older entry.</p>';
    return '<div class="activity-diff">' + changes.map(change => {
      const sensitive = /serial|price|value|email|ffl/i.test(String(change.field || '')) ? ' data-sensitive' : '';
      return '<div class="activity-diff-row"><strong>' + escapeHTML(change.label || fieldLabel(change.field)) + '</strong>' +
        '<span class="activity-before"' + sensitive + '>' + escapeHTML(displayValue(change.before)) + '</span>' +
        '<span class="activity-arrow" aria-hidden="true">→</span>' +
        '<span class="activity-after"' + sensitive + '>' + escapeHTML(displayValue(change.after)) + '</span></div>';
    }).join('') + '</div>';
  }

  function renderActivityCenter() {
    const list = document.getElementById('activityList');
    if (!list) return;
    const all = filteredEntries();
    const pages = Math.max(1, Math.ceil(all.length / PAGE_SIZE));
    currentPage = Math.min(Math.max(1, currentPage), pages);
    const start = (currentPage - 1) * PAGE_SIZE;
    const pageEntries = all.slice(start, start + PAGE_SIZE);
    const count = document.getElementById('activityResultCount');
    if (count) count.textContent = all.length + ' matching entr' + (all.length === 1 ? 'y' : 'ies');
    const pageLabel = document.getElementById('activityPageLabel');
    if (pageLabel) pageLabel.textContent = 'Page ' + currentPage + ' of ' + pages;
    const previous = document.getElementById('activityPrev');
    const next = document.getElementById('activityNext');
    if (previous) previous.disabled = currentPage <= 1;
    if (next) next.disabled = currentPage >= pages;

    if (!pageEntries.length) {
      list.innerHTML = '<div class="activity-empty">No activity matches these filters.</div>';
      return;
    }
    list.innerHTML = pageEntries.map(entry => {
      const date = new Date(entry.timestamp);
      const expanded = expandedId === entry.id;
      const sensitiveDetails = entry.details && (/serial|price|value|email|ffl|duplicated from/i.test(entry.details) || /\$[\d,.]+/.test(entry.details));
      return '<article class="activity-entry" data-entry-id="' + escapeHTML(entry.id || '') + '">' +
        '<button type="button" class="activity-summary" data-activity-toggle="' + escapeHTML(entry.id || '') + '" aria-expanded="' + expanded + '">' +
        '<span class="audit-action ' + escapeHTML(entry.action || 'edit') + '">' + escapeHTML(entry.action || 'edit') + '</span>' +
        '<span class="activity-main"><strong>' + escapeHTML(entry.itemName || 'Untitled') + '</strong><small>' +
        escapeHTML(entry.itemType || 'system') + (entry.details ? ' · <span' + (sensitiveDetails ? ' data-sensitive' : '') + '>' + escapeHTML(entry.details) + '</span>' : '') + '</small></span>' +
        '<time>' + escapeHTML(Number.isNaN(date.getTime()) ? '--' : date.toLocaleString()) + '</time></button>' +
        (expanded ? '<div class="activity-expanded">' + renderChanges(entry) +
          (canRestore(entry) ? '<p class="activity-restore-note">Record fields can be restored independently. Older attachment files are checked first because their bytes may no longer be retained.</p><button type="button" class="btn btn-outline btn-small" data-activity-restore="' + escapeHTML(entry.id) + '">Restore this record to the earlier state</button>' : '') +
          '</div>' : '') + '</article>';
    }).join('');
    if (typeof refreshSensitiveElements === 'function') refreshSensitiveElements(list);
  }

  function resetPageAndRender() { currentPage = 1; renderActivityCenter(); }

  function openActivityCenter() {
    currentPage = 1;
    expandedId = null;
    document.getElementById('activityCenterModal')?.classList.add('open');
    renderActivityCenter();
  }

  function closeActivityCenter() {
    document.getElementById('activityCenterModal')?.classList.remove('open');
  }

  async function restoreActivityRecord(entryId) {
    const entry = entries().find(item => String(item.id) === String(entryId));
    if (!canRestore(entry)) {
      global.toast && toast('This older activity entry does not contain a restorable record snapshot.', 'error');
      return { ok: false, status: 'snapshot-unavailable' };
    }
    const approved = await confirmDialog('Restore only "' + entry.itemName + '" to its state before this activity? The rest of the collection will not change.', {
      title: 'Restore one record', okText: 'Restore record', danger: true
    });
    if (!approved) return { ok: false, status: 'cancelled' };

    const collection = entry.collection;
    const currentIndex = db[collection].findIndex(record => String(record.id) === String(entry.recordId));
    const current = currentIndex >= 0 ? clone(db[collection][currentIndex]) : null;
    const restored = clone(entry.before);
    let auditLength = null;
    const rollbackRecord = () => {
      const index = db[collection].findIndex(record => String(record.id) === String(entry.recordId));
      if (current) {
        if (index >= 0) db[collection][index] = clone(current); else db[collection].push(clone(current));
      } else if (index >= 0) db[collection].splice(index, 1);
      if (global.CloudSync && typeof CloudSync.reconcileMissingMedia === 'function') CloudSync.reconcileMissingMedia([]);
    };

    try {
      if (global.VaultDataSafety && global.CloudSync && CloudSync.uid) {
        await VaultDataSafety.createBackup(CloudSync.uid, db, 'before-single-record-restore', {
          activityEntryId: entry.id, recordId: entry.recordId, collection
        });
      }
      if (currentIndex >= 0) db[collection][currentIndex] = restored;
      else db[collection].push(restored);

      const mediaKeys = recordMediaKeys(collection, restored);
      let mediaResult = { ok: true, failures: [] };
      if (mediaKeys.length && global.CloudSync && CloudSync.downloadMedia) {
        mediaResult = await CloudSync.downloadMedia(entry.mediaManifest || {}, {
          context: CloudSync.accountContext(), keys: mediaKeys
        }).catch(error => ({ ok: false, failures: [{ error }] }));
      }
      const unavailable = mediaKeys.filter(key => {
        let value = null;
        if (global.CloudSync && typeof CloudSync.residentMedia === 'function') value = CloudSync.residentMedia(key);
        else if (!String(key).includes(':') && typeof imagesDb !== 'undefined') value = imagesDb[key];
        return !(typeof value === 'string' && value.startsWith('data:'));
      });
      const failedKeys = (mediaResult.failures || []).map(item => String(item && item.key || '')).filter(Boolean);
      const unverified = [...new Set([...unavailable, ...failedKeys])];
      if (!mediaResult.ok && !unverified.length) unverified.push(...mediaKeys);
      if (unverified.length) {
        rollbackRecord();
        render();
        const continueWithoutFiles = await confirmDialog(
          'The earlier record references ' + unverified.length + ' attachment' + (unverified.length === 1 ? '' : 's') + ' whose original bytes could not be verified. Restore its fields anyway and mark those files unavailable?',
          { title: 'Older attachments unavailable', okText: 'Restore fields only', danger: true }
        );
        if (!continueWithoutFiles) {
          renderActivityCenter();
          return { ok: false, status: 'attachment-unavailable', missingMedia: unverified };
        }
        const refreshedIndex = db[collection].findIndex(record => String(record.id) === String(entry.recordId));
        if (refreshedIndex >= 0) db[collection][refreshedIndex] = restored; else db[collection].push(restored);
        if (global.CloudSync) {
          const existing = Array.isArray(CloudSync.missingMedia) ? CloudSync.missingMedia : [];
          const byKey = new Map(existing.map(item => [String(item && item.key || ''), item]));
          unverified.forEach(key => {
            const detail = typeof CloudSync.describeMediaKey === 'function' ? CloudSync.describeMediaKey(key) : { key };
            byKey.set(String(key), Object.assign({}, detail, {
              key: String(key), detectedAt: new Date().toISOString(),
              error: { message: 'The attachment referenced by this activity snapshot is no longer available.' }
            }));
          });
          CloudSync.missingMedia = [...byKey.values()].filter(item => item && item.key);
        }
      }

      auditLength = db.auditTrail.length;
      addAuditEntry('restore', entry.itemType, entry.itemName, 'Restored one record from activity history', {
        collection, recordId: entry.recordId, before: current, after: restored
      });
      const saved = await saveData();
      if (!saved) {
        rollbackRecord();
        db.auditTrail.splice(auditLength);
        render();
        renderActivityCenter();
        toast('The restore was rolled back because it could not be saved safely. No other record was changed.', 'error', 9000);
        return { ok: false, status: 'save-failed' };
      }
      render();
      renderActivityCenter();
      if (unverified.length) {
        toast('Record fields restored. ' + unverified.length + ' older attachment' + (unverified.length === 1 ? ' is' : 's are') + ' marked unavailable.', 'warning', 9000);
        return { ok: true, status: 'restored-with-missing-media', recordId: entry.recordId, missingMedia: unverified };
      }
      toast('Record restored without changing the rest of the collection.', 'success');
      return { ok: true, status: 'restored', recordId: entry.recordId };
    } catch (error) {
      rollbackRecord();
      if (auditLength != null) db.auditTrail.splice(auditLength);
      render();
      renderActivityCenter();
      toast('The record was not restored: ' + (error.message || error), 'error', 9000);
      return { ok: false, status: 'failed', error };
    }
  }

  function init() {
    const search = document.getElementById('activitySearch');
    ['activitySearch', 'activityActionFilter', 'activityTypeFilter', 'activityDateFilter'].forEach(id => {
      document.getElementById(id)?.addEventListener(id === 'activitySearch' ? 'input' : 'change', resetPageAndRender);
    });
    document.getElementById('activityClearFilters')?.addEventListener('click', () => {
      if (search) search.value = '';
      ['activityActionFilter', 'activityTypeFilter', 'activityDateFilter'].forEach(id => { const element = document.getElementById(id); if (element) element.value = ''; });
      resetPageAndRender();
    });
    document.getElementById('activityPrev')?.addEventListener('click', () => { currentPage--; renderActivityCenter(); });
    document.getElementById('activityNext')?.addEventListener('click', () => { currentPage++; renderActivityCenter(); });
    document.getElementById('activityList')?.addEventListener('click', event => {
      const restore = event.target.closest('[data-activity-restore]');
      if (restore) { restoreActivityRecord(restore.dataset.activityRestore); return; }
      const toggle = event.target.closest('[data-activity-toggle]');
      if (toggle) {
        expandedId = expandedId === toggle.dataset.activityToggle ? null : toggle.dataset.activityToggle;
        renderActivityCenter();
      }
    });
  }

  global.VaultActivity = Object.freeze({
    createEntry, snapshotRecord, diffRecords, recordMediaKeys,
    open: openActivityCenter, close: closeActivityCenter, render: renderActivityCenter,
    restore: restoreActivityRecord
  });
  global.openActivityCenter = openActivityCenter;
  global.closeActivityCenter = closeActivityCenter;
  global.renderActivityCenter = renderActivityCenter;
  global.restoreActivityRecord = restoreActivityRecord;
  init();
})(window);
