// Conservative data-quality analysis and safe normalization. This never
// deletes or merges records automatically.
(function initVaultDataQuality(global) {
  'use strict';

  const COLLECTIONS = ['firearms', 'ammo', 'accessories', 'wishlist', 'dealers'];
  const DISPLAY_FIELDS = ['make', 'model', 'caliber', 'brand', 'type', 'condition', 'category', 'location'];

  const cleanText = (value) => typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : value;
  const keyFor = (value) => String(value || '').trim().replace(/\s+/g, ' ').toLocaleLowerCase();

  function preferredValues(database) {
    const frequencies = new Map();
    COLLECTIONS.forEach(collection => (database[collection] || []).forEach(record => {
      DISPLAY_FIELDS.forEach(field => {
        const value = cleanText(record[field]);
        const key = keyFor(value);
        if (!key) return;
        const mapKey = field + '\u0000' + key;
        const current = frequencies.get(mapKey) || new Map();
        current.set(value, (current.get(value) || 0) + 1);
        frequencies.set(mapKey, current);
      });
    }));
    const preferred = new Map();
    frequencies.forEach((variants, mapKey) => {
      const sorted = [...variants.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
      preferred.set(mapKey, sorted[0][0]);
    });
    return preferred;
  }

  function analyze(database) {
    const findings = [];
    let safeFixes = 0;
    const serials = new Map();
    const preferred = preferredValues(database);

    COLLECTIONS.forEach(collection => (database[collection] || []).forEach((record, index) => {
      if (!record || typeof record !== 'object') {
        findings.push({ severity: 'error', collection, index, message: 'Invalid record value.' });
        return;
      }
      if (!record.id) findings.push({ severity: 'error', collection, index, message: 'Missing internal record ID.' });
      DISPLAY_FIELDS.forEach(field => {
        if (typeof record[field] !== 'string' || !record[field]) return;
        const cleaned = cleanText(record[field]);
        const canonical = preferred.get(field + '\u0000' + keyFor(cleaned));
        if (record[field] !== cleaned || (canonical && record[field] !== canonical)) safeFixes++;
      });
      if (Array.isArray(record.tags)) {
        const normalized = [...new Map(record.tags.map(tag => [keyFor(tag), cleanText(tag)]).filter(([key]) => key)).values()];
        if (JSON.stringify(normalized) !== JSON.stringify(record.tags)) safeFixes++;
      }
      if (collection === 'firearms' && record.serial) {
        const serialKey = keyFor(record.serial);
        if (serials.has(serialKey)) {
          findings.push({ severity: 'warning', collection, index, message: 'Possible duplicate serial number; review both records manually.' });
        } else serials.set(serialKey, record.id);
      }
      ['dateAcquired', 'dateSubmitted', 'dateApproved', 'warrantyExpiry'].forEach(field => {
        if (record[field] && Number.isNaN(new Date(record[field]).getTime())) {
          findings.push({ severity: 'warning', collection, index, message: field + ' is not a valid date.' });
        }
      });
    }));

    return { findings, safeFixes, duplicateSerials: findings.filter(item => /duplicate serial/i.test(item.message)).length };
  }

  function applySafeFixes(database) {
    const preferred = preferredValues(database);
    let changed = 0;
    COLLECTIONS.forEach(collection => (database[collection] || []).forEach(record => {
      if (!record || typeof record !== 'object') return;
      DISPLAY_FIELDS.forEach(field => {
        if (typeof record[field] !== 'string') return;
        const cleaned = cleanText(record[field]);
        const canonical = preferred.get(field + '\u0000' + keyFor(cleaned)) || cleaned;
        if (record[field] !== canonical) { record[field] = canonical; changed++; }
      });
      if (Array.isArray(record.tags)) {
        const seen = new Map();
        record.tags.forEach(tag => {
          const cleaned = cleanText(tag);
          const key = keyFor(cleaned);
          if (key && !seen.has(key)) seen.set(key, cleaned);
        });
        const normalized = [...seen.values()];
        if (JSON.stringify(normalized) !== JSON.stringify(record.tags)) { record.tags = normalized; changed++; }
      }
    }));
    return { changed, report: analyze(database) };
  }

  global.VaultDataQuality = Object.freeze({ analyze, applySafeFixes });
})(window);
