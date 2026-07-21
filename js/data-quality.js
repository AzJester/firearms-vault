// Conservative data-quality analysis and collection-health reporting. Safe
// cleanup never deletes, merges, or invents inventory records.
(function initVaultDataQuality(global) {
  'use strict';

  const COLLECTIONS = ['firearms', 'ammo', 'accessories', 'wishlist', 'dealers'];
  const DISPLAY_FIELDS = ['make', 'model', 'caliber', 'brand', 'type', 'condition', 'category', 'location', 'barrel'];
  const SEVERITY_ORDER = { error: 0, warning: 1, info: 2 };

  const cleanText = (value) => typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : value;
  const keyFor = (value) => String(value || '').trim().replace(/\s+/g, ' ').toLocaleLowerCase();
  const clone = (value) => typeof structuredClone === 'function'
    ? structuredClone(value)
    : JSON.parse(JSON.stringify(value));
  const recordsOf = (database, collection) => Array.isArray(database && database[collection])
    ? database[collection]
    : [];

  const MANUFACTURERS = [
    'Aero Precision', 'Anderson Manufacturing', 'Barrett', 'Beretta', 'Bersa', 'Browning',
    'Bushmaster', 'Century Arms', 'Christensen Arms', 'Colt', 'CZ', 'Daniel Defense',
    'FN America', 'Glock', 'Heckler & Koch', 'Henry', 'Heritage', 'Hi-Point', 'HUXWRX',
    'IWI', 'KelTec', 'Kimber', 'Marlin', 'Maxim Defense', 'Mossberg',
    'Palmetto State Armory', 'Q LLC', 'Remington', 'Ruger', 'Savage Arms', 'SIG Sauer',
    'Smith & Wesson', 'Springfield Armory', 'Staccato', 'Taurus', 'Tikka', 'Walther', 'Winchester'
  ];
  const TAGS = ['Approved', 'Pending', 'SBR', 'SBS', 'AOW', 'Suppressor', 'Silencer', 'NFA', 'Rifle', 'Pistol', 'Revolver', 'Shotgun'];
  const MAKE_CORRECTIONS = new Map(MANUFACTURERS.map(value => [keyFor(value), value]));
  [
    ['sprinfield', 'Springfield Armory'], ['springfeild', 'Springfield Armory'],
    ['sprinfield armory', 'Springfield Armory'], ['springfeild armory', 'Springfield Armory'],
    ['springfield armoury', 'Springfield Armory'], ['sig sauer inc', 'SIG Sauer'],
    ['smith and wesson', 'Smith & Wesson'], ['heckler and koch', 'Heckler & Koch'],
    ['palmetto state armoury', 'Palmetto State Armory']
  ].forEach(([variant, canonical]) => MAKE_CORRECTIONS.set(keyFor(variant), canonical));
  const TAG_CORRECTIONS = new Map(TAGS.map(value => [keyFor(value), value]));
  [
    ['supressor', 'Suppressor'], ['supresser', 'Suppressor'], ['suppressser', 'Suppressor'],
    ['silincer', 'Silencer'], ['silensor', 'Silencer'], ['revoler', 'Revolver'],
    ['shotgn', 'Shotgun']
  ].forEach(([variant, canonical]) => TAG_CORRECTIONS.set(keyFor(variant), canonical));
  const MAKE_ALIASES = new Map([
    ['springfield', ['Springfield Armory']], ['sig', ['SIG Sauer']], ['s&w', ['Smith & Wesson']],
    ['h&k', ['Heckler & Koch']], ['hk', ['Heckler & Koch']], ['fn', ['FN America']],
    ['psa', ['Palmetto State Armory']], ['dd', ['Daniel Defense']]
  ]);
  const TAG_ALIASES = new Map([
    ['can', ['Suppressor']], ['short barrel rifle', ['SBR']], ['short-barreled rifle', ['SBR']],
    ['short barrel shotgun', ['SBS']], ['short-barreled shotgun', ['SBS']], ['class 3', ['NFA']]
  ]);

  function preferredVariant(variants) {
    return [...variants.entries()].sort((left, right) =>
      right[1] - left[1] || left[0].localeCompare(right[0]))[0]?.[0] || '';
  }

  function preferredValues(database) {
    const frequencies = new Map();
    COLLECTIONS.forEach(collection => recordsOf(database, collection).forEach(record => {
      DISPLAY_FIELDS.forEach(field => {
        const value = cleanText(record && record[field]);
        const key = keyFor(value);
        if (!key) return;
        const mapKey = field + '\u0000' + key;
        const current = frequencies.get(mapKey) || new Map();
        current.set(value, (current.get(value) || 0) + 1);
        frequencies.set(mapKey, current);
      });
    }));
    const preferred = new Map();
    frequencies.forEach((variants, mapKey) => preferred.set(mapKey, preferredVariant(variants)));
    return preferred;
  }

  function preferredTagValues(database) {
    const frequencies = new Map();
    recordsOf(database, 'firearms').forEach(record => (record && Array.isArray(record.tags) ? record.tags : []).forEach(tag => {
      const value = cleanText(tag);
      const key = keyFor(value);
      if (!key) return;
      const variants = frequencies.get(key) || new Map();
      variants.set(value, (variants.get(value) || 0) + 1);
      frequencies.set(key, variants);
    }));
    const preferred = new Map();
    frequencies.forEach((variants, key) => preferred.set(key, preferredVariant(variants)));
    return preferred;
  }

  function normalizedTags(tags, preferredTags) {
    const seen = new Set();
    const normalized = [];
    (Array.isArray(tags) ? tags : []).forEach(tag => {
      const cleaned = cleanText(tag);
      const key = keyFor(cleaned);
      if (!key) return;
      const canonical = TAG_CORRECTIONS.get(key) || (preferredTags && preferredTags.get(key)) || cleaned;
      const canonicalKey = keyFor(canonical);
      if (!canonicalKey || seen.has(canonicalKey)) return;
      seen.add(canonicalKey);
      normalized.push(canonical);
    });
    return normalized;
  }

  function cleanupPlan(database) {
    const preferred = preferredValues(database);
    const preferredTags = preferredTagValues(database);
    const fixes = [];
    COLLECTIONS.forEach(collection => recordsOf(database, collection).forEach((record, index) => {
      if (!record || typeof record !== 'object') return;
      DISPLAY_FIELDS.forEach(field => {
        if (typeof record[field] !== 'string') return;
        const cleaned = cleanText(record[field]);
        const parsedBarrel = field === 'barrel' ? parseBarrel(cleaned) : null;
        const dictionaryValue = field === 'make' ? MAKE_CORRECTIONS.get(keyFor(cleaned)) : null;
        const canonical = dictionaryValue || (parsedBarrel && parsedBarrel.recognized
          ? parsedBarrel.canonical
          : preferred.get(field + '\u0000' + keyFor(cleaned)) || cleaned);
        if (record[field] !== canonical) {
          fixes.push({
            id: 'text:' + collection + ':' + String(record.id || index) + ':' + field,
            type: 'text', collection, index, recordId: record.id || null, field,
            from: record[field], to: canonical,
            reason: dictionaryValue ? 'dictionary' : parsedBarrel && parsedBarrel.recognized ? 'standard-format' : 'formatting'
          });
        }
      });
      if (Array.isArray(record.tags)) {
        const normalized = normalizedTags(record.tags, preferredTags);
        if (JSON.stringify(normalized) !== JSON.stringify(record.tags)) {
          fixes.push({
            id: 'tags:' + collection + ':' + String(record.id || index),
            type: 'tags', collection, index, recordId: record.id || null, field: 'tags',
            from: clone(record.tags), to: normalized,
            reason: record.tags.some(tag => {
              const canonical = TAG_CORRECTIONS.get(keyFor(cleanText(tag)));
              return canonical && canonical !== cleanText(tag);
            }) ? 'dictionary' : 'formatting'
          });
        }
      }
    }));
    return fixes;
  }

  function analyze(database) {
    const source = database && typeof database === 'object' ? database : {};
    const findings = [];
    const serials = new Map();

    COLLECTIONS.forEach(collection => recordsOf(source, collection).forEach((record, index) => {
      if (!record || typeof record !== 'object') {
        findings.push({ severity: 'error', collection, index, message: 'Invalid record value.' });
        return;
      }
      if (!record.id) findings.push({ severity: 'error', collection, index, message: 'Missing internal record ID.' });
      if (collection === 'firearms' && record.serial) {
        const serialKey = keyFor(record.serial);
        if (serialKey && serials.has(serialKey)) {
          findings.push({ severity: 'warning', collection, index, message: 'Possible duplicate serial number; review both records manually.' });
        } else if (serialKey) serials.set(serialKey, record.id);
      }
      ['dateAcquired', 'dateSubmitted', 'dateApproved', 'warrantyExp', 'warrantyExpiry'].forEach(field => {
        if (record[field] && Number.isNaN(new Date(record[field]).getTime())) {
          findings.push({ severity: 'warning', collection, index, message: field + ' is not a valid date.' });
        }
      });
    }));

    const fixes = cleanupPlan(source);
    return {
      findings,
      safeFixes: fixes.length,
      duplicateSerials: findings.filter(item => /duplicate serial/i.test(item.message)).length
    };
  }

  function applySafeFixes(database) {
    const fixes = cleanupPlan(database || {});
    let changed = 0;
    fixes.forEach(fix => {
      const records = recordsOf(database, fix.collection);
      const indexed = records[fix.index];
      const record = indexed && (fix.recordId == null || String(indexed.id) === String(fix.recordId))
        ? indexed
        : records.find(item => item && String(item.id) === String(fix.recordId));
      if (!record) return;
      const next = clone(fix.to);
      if (JSON.stringify(record[fix.field]) === JSON.stringify(next)) return;
      record[fix.field] = next;
      changed++;
    });
    return { changed, report: analyze(database) };
  }

  function parseBarrel(value) {
    const text = cleanText(value);
    if (!text) return null;
    const match = /^(\d+(?:\.\d+)?)\s*(?:["”]|in(?:ch(?:es)?)?\.?)?$/i.exec(text);
    if (!match) return { recognized: false, key: 'text:' + keyFor(text), display: text, canonical: text };
    const inches = Number(match[1]);
    if (!Number.isFinite(inches) || inches <= 0 || inches > 100) {
      return { recognized: false, key: 'text:' + keyFor(text), display: text, canonical: text };
    }
    const number = String(inches).replace(/\.0+$/, '');
    return { recognized: true, inches, key: 'inches:' + number, display: text, canonical: number + '"' };
  }

  function groupFacet(records, field, options) {
    const opts = options || {};
    const groups = new Map();
    const missingRecordIds = [];
    (records || []).forEach((record, index) => {
      if (!record || typeof record !== 'object') return;
      const raw = cleanText(record[field]);
      if (!raw) {
        missingRecordIds.push(record.id || String(index));
        return;
      }
      const parsed = opts.parse ? opts.parse(raw) : null;
      const key = parsed ? parsed.key : keyFor(raw);
      const group = groups.get(key) || {
        key, count: 0, recordIds: [], variants: new Map(), recognized: parsed ? parsed.recognized : true,
        canonical: parsed && parsed.recognized ? parsed.canonical : null
      };
      group.count++;
      group.recordIds.push(record.id || String(index));
      group.variants.set(raw, (group.variants.get(raw) || 0) + 1);
      if (parsed && !parsed.recognized) group.recognized = false;
      groups.set(key, group);
    });
    const values = [...groups.values()].map(group => {
      const variants = [...group.variants.entries()]
        .map(([value, count]) => ({ value, count }))
        .sort((left, right) => right.count - left.count || left.value.localeCompare(right.value));
      return {
        key: group.key,
        label: group.canonical || (variants[0] && variants[0].value) || '',
        count: group.count,
        recordIds: group.recordIds,
        variants,
        inconsistent: variants.length > 1,
        recognized: group.recognized
      };
    }).sort((left, right) => right.count - left.count || left.label.localeCompare(right.label));
    return { values, unique: values.length, missing: missingRecordIds.length, missingRecordIds };
  }

  function groupTags(records) {
    const groups = new Map();
    let assignments = 0;
    let recordsWithTags = 0;
    (records || []).forEach((record, index) => {
      if (!record || !Array.isArray(record.tags) || !record.tags.length) return;
      const recordKeys = new Set();
      record.tags.forEach(tag => {
        const value = cleanText(tag);
        const key = keyFor(value);
        if (!key) return;
        assignments++;
        const group = groups.get(key) || { key, count: 0, recordIds: [], variants: new Map() };
        group.count++;
        if (!recordKeys.has(key)) group.recordIds.push(record.id || String(index));
        group.variants.set(value, (group.variants.get(value) || 0) + 1);
        recordKeys.add(key);
        groups.set(key, group);
      });
      if (recordKeys.size) recordsWithTags++;
    });
    const values = [...groups.values()].map(group => {
      const variants = [...group.variants.entries()]
        .map(([value, count]) => ({ value, count }))
        .sort((left, right) => right.count - left.count || left.value.localeCompare(right.value));
      return {
        key: group.key, label: (variants[0] && variants[0].value) || '', count: group.count,
        recordIds: group.recordIds, variants, inconsistent: variants.length > 1
      };
    }).sort((left, right) => right.count - left.count || left.label.localeCompare(right.label));
    return { values, unique: values.length, assignments, recordsWithTags };
  }

  function recordLabel(record) {
    const label = [cleanText(record && record.make), cleanText(record && record.model)].filter(Boolean).join(' ');
    return label || cleanText(record && record.name) || 'Untitled firearm';
  }

  function percent(complete, total) {
    return total ? Math.round((complete / total) * 100) : 100;
  }

  function missingMediaKeys(options) {
    const source = options && (options.missingMedia || options.missingKeys) || [];
    return new Set((Array.isArray(source) ? source : []).map(item =>
      String(item && typeof item === 'object' ? item.key || '' : item || '')).filter(Boolean));
  }

  function issueId(parts) {
    return parts.map(part => String(part == null ? '' : part).replace(/[^A-Za-z0-9_.:-]+/g, '-')).join(':');
  }

  function comparableSpelling(value) {
    return keyFor(value).normalize('NFKD').replace(/[^a-z0-9]/g, '');
  }

  function editDistance(left, right) {
    const a = comparableSpelling(left);
    const b = comparableSpelling(right);
    if (!a) return b.length;
    if (!b) return a.length;
    const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
    for (let row = 1; row <= a.length; row++) {
      let diagonal = previous[0];
      previous[0] = row;
      for (let column = 1; column <= b.length; column++) {
        const above = previous[column];
        previous[column] = Math.min(
          previous[column] + 1,
          previous[column - 1] + 1,
          diagonal + (a[row - 1] === b[column - 1] ? 0 : 1)
        );
        diagonal = above;
      }
    }
    return previous[b.length];
  }

  function reviewSuggestions(value, kind) {
    const cleaned = cleanText(value);
    const key = keyFor(cleaned);
    if (!key) return [];
    const corrections = kind === 'manufacturer' ? MAKE_CORRECTIONS : TAG_CORRECTIONS;
    if (corrections.has(key)) return [];
    const aliases = kind === 'manufacturer' ? MAKE_ALIASES : TAG_ALIASES;
    if (aliases.has(key)) return aliases.get(key).slice();
    const candidates = kind === 'manufacturer' ? MANUFACTURERS : TAGS;
    const input = comparableSpelling(cleaned);
    if (input.length < 5) return [];
    const ranked = candidates.map(candidate => ({ candidate, distance: editDistance(cleaned, candidate) }))
      .sort((left, right) => left.distance - right.distance || left.candidate.localeCompare(right.candidate));
    const best = ranked[0] && ranked[0].distance;
    const threshold = input.length >= 10 ? 2 : 1;
    if (best == null || best > threshold) return [];
    return ranked.filter(item => item.distance === best).map(item => item.candidate).slice(0, 3);
  }

  function analyzeCollectionHealth(database, options) {
    const source = database && typeof database === 'object' ? database : {};
    const firearms = Array.isArray(source.firearms) ? source.firearms.filter(item => item && typeof item === 'object') : [];
    const explicitMissing = missingMediaKeys(options);
    const fixes = cleanupPlan(source);
    const issues = [];
    const addIssue = issue => issues.push(Object.assign({ severity: 'info', collection: 'firearms' }, issue));
    const manufacturers = groupFacet(firearms, 'make');
    const calibers = groupFacet(firearms, 'caliber');
    const barrels = groupFacet(firearms, 'barrel', { parse: parseBarrel });
    const tags = groupTags(firearms);
    const serialGroups = new Map();
    let withIdentity = 0;
    let withPhotos = 0;
    let withDocuments = 0;
    let photoReferences = 0;
    let documentReferences = 0;
    const referencedMedia = new Set();

    firearms.forEach((record, index) => {
      const recordId = record.id || String(index);
      const label = recordLabel(record);
      const make = cleanText(record.make);
      const model = cleanText(record.model);
      if (make && model) withIdentity++;
      if (!make) addIssue({
        id: issueId(['manufacturer', recordId]), category: 'manufacturers', severity: 'warning',
        recordId, field: 'make', title: 'Manufacturer is missing', message: label + ' has no manufacturer.'
      });
      if (!model) addIssue({
        id: issueId(['model', recordId]), category: 'formatting', severity: 'warning',
        recordId, field: 'model', title: 'Model is missing', message: label + ' has no model name.'
      });
      if (!cleanText(record.caliber)) addIssue({
        id: issueId(['caliber', recordId]), category: 'calibers', severity: 'warning',
        recordId, field: 'caliber', title: 'Caliber or gauge is missing', message: label + ' has no caliber or gauge.'
      });
      const barrel = parseBarrel(record.barrel);
      if (!barrel) addIssue({
        id: issueId(['barrel-missing', recordId]), category: 'barrels',
        recordId, field: 'barrel', title: 'Barrel value is missing', message: label + ' has no barrel value.'
      });
      else if (!barrel.recognized) addIssue({
        id: issueId(['barrel-review', recordId]), category: 'barrels',
        recordId, field: 'barrel', title: 'Review barrel formatting',
        message: label + ' uses "' + barrel.display + '", which could not be compared with inch values.'
      });

      const imageIds = Array.isArray(record.images)
        ? record.images.map(value => String(value == null ? '' : value).trim()).filter(Boolean)
        : [];
      photoReferences += imageIds.length;
      if (imageIds.length) withPhotos++;
      imageIds.forEach(key => referencedMedia.add(key));
      if (!imageIds.length) addIssue({
        id: issueId(['photo', recordId]), category: 'attachments',
        recordId, field: 'images', title: 'No photo added', message: label + ' has no photo.'
      });
      if (new Set(imageIds).size !== imageIds.length) addIssue({
        id: issueId(['photo-duplicate', recordId]), category: 'attachments', severity: 'warning',
        recordId, field: 'images', title: 'Duplicate photo reference', message: label + ' references the same photo more than once.'
      });

      const documents = Array.isArray(record.documents) ? record.documents.filter(item => item && typeof item === 'object') : [];
      documentReferences += documents.length;
      if (documents.length) withDocuments++;
      const documentIds = new Set();
      documents.forEach((documentRecord, documentIndex) => {
        const documentId = String(documentRecord.id || '');
        const key = 'doc:' + recordId + ':' + documentId;
        if (documentId) referencedMedia.add(key);
        if (!documentId || documentIds.has(documentId)) addIssue({
          id: issueId(['document-id', recordId, documentId || documentIndex]), category: 'attachments', severity: 'error',
          recordId, field: 'documents', title: 'Document identity needs repair',
          message: label + ' has a document with a missing or duplicate internal ID.'
        });
        documentIds.add(documentId);
      });

      [record.receipt, record.stampPdf].forEach(value => {
        if (typeof value !== 'string' || !value.startsWith('@media:')) return;
        const key = value.slice(7);
        if (key) referencedMedia.add(key);
      });

      const serialKey = keyFor(record.serial);
      if (serialKey) {
        const group = serialGroups.get(serialKey) || [];
        group.push({ id: recordId, label, serial: cleanText(record.serial) });
        serialGroups.set(serialKey, group);
      }

      const manufacturerSuggestions = reviewSuggestions(record.make, 'manufacturer');
      if (manufacturerSuggestions.length) addIssue({
        id: issueId(['manufacturer-suggestion', recordId, keyFor(record.make)]), category: 'manufacturers', severity: 'warning',
        recordId, field: 'make', title: 'Review manufacturer spelling', suggestions: manufacturerSuggestions,
        message: '“' + cleanText(record.make) + '” may mean ' + manufacturerSuggestions.map(value => '“' + value + '”').join(' or ') + '. Review it before changing; this suggestion is not applied automatically.'
      });
      const seenTagSuggestions = new Set();
      (Array.isArray(record.tags) ? record.tags : []).forEach(tag => {
        const tagKey = keyFor(cleanText(tag));
        if (!tagKey || seenTagSuggestions.has(tagKey)) return;
        seenTagSuggestions.add(tagKey);
        const suggestions = reviewSuggestions(tag, 'tag');
        if (!suggestions.length) return;
        addIssue({
          id: issueId(['tag-suggestion', recordId, tagKey]), category: 'tags', severity: 'warning',
          recordId, field: 'tags', title: 'Review tag wording', suggestions,
          message: '“' + cleanText(tag) + '” may mean ' + suggestions.map(value => '“' + value + '”').join(' or ') + '. Review it before changing; this suggestion is not applied automatically.'
        });
      });
    });

    const duplicates = [];
    serialGroups.forEach((records, key) => {
      if (records.length < 2) return;
      const duplicate = {
        id: issueId(['duplicate-serial', key]), kind: 'serial', key,
        label: String(records[0].serial || ''), recordIds: records.map(record => record.id), records
      };
      duplicates.push(duplicate);
      addIssue({
        id: duplicate.id, category: 'duplicates', severity: 'warning', collection: 'firearms',
        recordId: records[0].id, recordIds: duplicate.recordIds, field: 'serial',
        title: 'Possible duplicate serial number',
        message: records.length + ' records use the same serial number. Review them manually; nothing will be merged automatically.'
      });
    });

    explicitMissing.forEach(key => {
      if (!referencedMedia.has(key)) return;
      let recordId = null;
      if (/^(?:doc|receipt|stamp):firearm:/.test(key)) recordId = key.split(':')[2] || null;
      else if (key.startsWith('doc:')) recordId = key.split(':')[1] || null;
      else {
        const record = firearms.find(item => (item.images || []).map(String).includes(key));
        recordId = record && record.id || null;
      }
      addIssue({
        id: issueId(['missing-media', key]), category: 'attachments', severity: 'warning',
        recordId, field: 'attachments', mediaKey: key, title: 'Attachment needs recovery',
        message: 'A referenced photo or document is unavailable. Reattach it from Sync details or remove only the unavailable reference.'
      });
    });

    fixes.forEach(fix => {
      if (fix.collection !== 'firearms') return;
      const dictionary = fix.reason === 'dictionary';
      addIssue({
        id: issueId(['safe-fix', fix.id]), category: fix.field === 'tags' ? 'tags'
          : fix.field === 'make' ? 'manufacturers'
            : fix.field === 'caliber' ? 'calibers'
              : fix.field === 'barrel' ? 'barrels' : 'formatting',
        severity: 'info', recordId: fix.recordId, field: fix.field, fixId: fix.id,
        title: dictionary
          ? (fix.field === 'tags' ? 'Known tag correction available' : 'Known manufacturer correction available')
          : fix.field === 'tags' ? 'Tag cleanup available' : 'Consistent ' + fix.field + ' formatting available',
        message: dictionary
          ? 'A high-confidence dictionary correction from ' + JSON.stringify(fix.from) + ' to ' + JSON.stringify(fix.to) + ' is available as a guided safe fix.'
          : 'A safe formatting cleanup is available. No record will be deleted or merged.'
      });
    });

    manufacturers.values.filter(item => item.inconsistent).forEach(item => addIssue({
      id: issueId(['manufacturer-variants', item.key]), category: 'manufacturers',
      recordId: item.recordIds[0], recordIds: item.recordIds, field: 'make', title: 'Manufacturer has multiple formats',
      message: item.variants.map(variant => variant.value).join(', ') + ' are treated as the same manufacturer.'
    }));
    calibers.values.filter(item => item.inconsistent).forEach(item => addIssue({
      id: issueId(['caliber-variants', item.key]), category: 'calibers',
      recordId: item.recordIds[0], recordIds: item.recordIds, field: 'caliber', title: 'Caliber has multiple formats',
      message: item.variants.map(variant => variant.value).join(', ') + ' are treated as the same caliber.'
    }));
    tags.values.filter(item => item.inconsistent).forEach(item => addIssue({
      id: issueId(['tag-variants', item.key]), category: 'tags',
      recordId: item.recordIds[0], recordIds: item.recordIds, field: 'tags', title: 'Tag has multiple formats',
      message: item.variants.map(variant => variant.value).join(', ') + ' are treated as the same tag.'
    }));

    issues.sort((left, right) =>
      (SEVERITY_ORDER[left.severity] ?? 9) - (SEVERITY_ORDER[right.severity] ?? 9) ||
      String(left.category).localeCompare(String(right.category)) || String(left.title).localeCompare(String(right.title)));
    duplicates.sort((left, right) => left.label.localeCompare(right.label));

    const total = firearms.length;
    const integrityComplete = Math.max(0, total - new Set(issues
      .filter(issue => issue.category === 'attachments' && issue.title === 'Attachment needs recovery')
      .map(issue => issue.recordId).filter(Boolean)).size);
    const completenessPoints = withIdentity + (total - calibers.missing) + (total - barrels.missing) + withPhotos + integrityComplete;
    const completenessTotal = total * 5;
    const completenessScore = completenessTotal ? Math.round((completenessPoints / completenessTotal) * 100) : 100;
    const duplicatePenalty = Math.min(20, duplicates.length * 5);
    const score = Math.max(0, completenessScore - duplicatePenalty);

    return {
      version: 1,
      score,
      status: total === 0 ? 'empty' : score >= 90 ? 'good' : score >= 70 ? 'attention' : 'needs-work',
      totals: {
        firearms: total,
        issues: issues.length,
        errors: issues.filter(issue => issue.severity === 'error').length,
        warnings: issues.filter(issue => issue.severity === 'warning').length,
        safeFixes: fixes.length,
        duplicateGroups: duplicates.length,
        missingAttachments: issues.filter(issue => issue.title === 'Attachment needs recovery').length,
        photoReferences,
        documentReferences
      },
      coverage: {
        identity: { complete: withIdentity, total, percent: percent(withIdentity, total) },
        manufacturer: { complete: total - manufacturers.missing, total, percent: percent(total - manufacturers.missing, total) },
        caliber: { complete: total - calibers.missing, total, percent: percent(total - calibers.missing, total) },
        barrel: { complete: total - barrels.missing, total, percent: percent(total - barrels.missing, total) },
        photos: { complete: withPhotos, total, percent: percent(withPhotos, total) },
        documents: { complete: withDocuments, total, percent: percent(withDocuments, total) },
        attachmentIntegrity: { complete: integrityComplete, total, percent: percent(integrityComplete, total) }
      },
      facets: { manufacturers, calibers, barrels, tags },
      duplicates,
      issues,
      safeFixes: fixes.map(clone)
    };
  }

  global.VaultDataQuality = Object.freeze({
    analyze,
    applySafeFixes,
    analyzeCollectionHealth,
    cleanupPlan: database => cleanupPlan(database || {}).map(clone),
    cleanText,
    keyFor,
    parseBarrel
  });
})(window);
