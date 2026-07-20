// Firearms Vault security helpers.
// Loaded before app.js so every import, rich-text field, and dynamic URL can use
// the same conservative policy.
(function initVaultSecurity(global) {
  'use strict';

  const ALLOWED_TAGS = new Set([
    'P', 'BR', 'STRONG', 'B', 'EM', 'I', 'U', 'S',
    'UL', 'OL', 'LI', 'BLOCKQUOTE', 'CODE', 'A'
  ]);
  const RICH_TEXT_KEY = /^(notes?|description|details|comments?|dispNotes|dealerNotes|workPerformed)$/i;
  const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
  const TOP_LEVEL_ARRAYS = [
    'firearms', 'ammo', 'accessories', 'wishlist', 'dealers',
    'auditTrail', 'valueHistory', 'backups', 'conflicts'
  ];
  const MAX_DEPTH = 14;
  const MAX_ARRAY_ITEMS = 100000;
  const MAX_TEXT_LENGTH = 250000;
  const MAX_DATA_URL_LENGTH = 75 * 1024 * 1024;

  function escapeHTML(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function safeURL(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    try {
      const parsed = new URL(raw, global.location ? global.location.origin : 'https://vault.invalid');
      if (!['http:', 'https:', 'mailto:'].includes(parsed.protocol)) return '';
      if (parsed.protocol === 'mailto:' && /[\r\n]/.test(raw)) return '';
      return raw;
    } catch (_) {
      return '';
    }
  }

  function sanitizeRichText(value) {
    const input = String(value == null ? '' : value).trim();
    if (!input || input === '<br>') return '';
    if (!global.DOMParser || !global.document) return escapeHTML(input);

    const doc = new DOMParser().parseFromString('<body>' + input + '</body>', 'text/html');
    const body = doc.body;

    // Preserve an anchor's URL outside the DOM before attributes are removed.
    const anchorHrefs = new WeakMap();
    Array.from(body.querySelectorAll('a')).forEach((anchor) => {
      anchorHrefs.set(anchor, anchor.getAttribute('href') || '');
    });
    function cleanWithAnchors(parent) {
      Array.from(parent.childNodes).forEach((node) => {
        if (node.nodeType === 8) {
          node.remove();
          return;
        }
        if (node.nodeType !== 1) return;
        const tag = node.tagName.toUpperCase();
        if (!ALLOWED_TAGS.has(tag)) {
          const fragment = doc.createDocumentFragment();
          while (node.firstChild) fragment.appendChild(node.firstChild);
          node.replaceWith(fragment);
          cleanWithAnchors(parent);
          return;
        }
        const originalHref = tag === 'A' ? (anchorHrefs.get(node) || '') : '';
        Array.from(node.attributes).forEach((attribute) => node.removeAttribute(attribute.name));
        if (tag === 'A') {
          const href = safeURL(originalHref);
          if (href) {
            node.setAttribute('href', href);
            node.setAttribute('rel', 'noopener noreferrer nofollow');
            if (/^https?:/i.test(href)) node.setAttribute('target', '_blank');
          }
        }
        cleanWithAnchors(node);
      });
    }
    cleanWithAnchors(body);
    const result = body.innerHTML.trim();
    return result === '<br>' ? '' : result;
  }

  function newId() {
    if (global.crypto && typeof global.crypto.randomUUID === 'function') return global.crypto.randomUUID();
    return 'fv-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12);
  }

  function safeId(value, regenerateInvalid) {
    const candidate = String(value || '').trim();
    if (/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(candidate)) return candidate;
    return regenerateInvalid ? newId() : '';
  }

  function sanitizeString(value, key, warnings, path) {
    let text = String(value == null ? '' : value);
    if (RICH_TEXT_KEY.test(key)) return sanitizeRichText(text);
    const limit = /^data:/i.test(text) ? MAX_DATA_URL_LENGTH : MAX_TEXT_LENGTH;
    if (text.length > limit) {
      warnings.push(path + ' was truncated because it exceeded the safe size limit.');
      text = text.slice(0, limit);
    }
    return text.replace(/\u0000/g, '');
  }

  function sanitizeValue(value, options, warnings, path, depth, key) {
    if (depth > MAX_DEPTH) {
      warnings.push(path + ' exceeded the supported nesting depth and was removed.');
      return null;
    }
    if (value == null || typeof value === 'boolean' || typeof value === 'number') {
      return Number.isFinite(value) || value == null || typeof value === 'boolean' ? value : null;
    }
    if (typeof value === 'string') return sanitizeString(value, key || '', warnings, path);
    if (Array.isArray(value)) {
      if (value.length > MAX_ARRAY_ITEMS) throw new Error(path + ' contains too many items.');
      return value.map((item, index) => sanitizeValue(item, options, warnings, path + '[' + index + ']', depth + 1, key));
    }
    if (typeof value !== 'object') return null;

    const result = {};
    Object.keys(value).forEach((childKey) => {
      if (DANGEROUS_KEYS.has(childKey)) {
        warnings.push(path + '.' + childKey + ' was removed.');
        return;
      }
      let childValue = sanitizeValue(value[childKey], options, warnings, path + '.' + childKey, depth + 1, childKey);
      if (childKey === 'id') childValue = safeId(childValue, options.regenerateInvalidIds !== false);
      if (/url|link|website/i.test(childKey) && typeof childValue === 'string' && childValue) {
        childValue = safeURL(childValue);
      }
      result[childKey] = childValue;
    });
    return result;
  }

  function normalizeDatabase(raw, options) {
    options = Object.assign({ regenerateInvalidIds: true, allowUnknownTopLevel: false }, options || {});
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Backup must contain a database object.');
    const warnings = [];
    const normalized = {
      version: Math.max(3, Number.parseInt(raw.version, 10) || 3),
      encrypted: false,
      settings: sanitizeValue(raw.settings || {}, options, warnings, '$.settings', 0, 'settings') || {}
    };
    TOP_LEVEL_ARRAYS.forEach((key) => {
      const source = raw[key] == null ? [] : raw[key];
      if (!Array.isArray(source)) throw new Error('Backup field "' + key + '" must be a list.');
      normalized[key] = sanitizeValue(source, options, warnings, '$.' + key, 0, key);
    });

    if (options.allowUnknownTopLevel) {
      Object.keys(raw).forEach((key) => {
        if (key in normalized || DANGEROUS_KEYS.has(key)) return;
        normalized[key] = sanitizeValue(raw[key], options, warnings, '$.' + key, 0, key);
      });
    }

    const ids = new Set();
    ['firearms', 'ammo', 'accessories', 'wishlist', 'dealers'].forEach((collection) => {
      normalized[collection].forEach((record) => {
        if (!record || typeof record !== 'object') return;
        let id = safeId(record.id, true);
        while (ids.has(id)) id = newId();
        if (record.id !== id) warnings.push('A missing, unsafe, or duplicate record ID was replaced.');
        record.id = id;
        ids.add(id);
      });
    });

    return { data: normalized, warnings };
  }

  function safeJSONParse(text, options) {
    const source = String(text || '');
    if (source.length > 150 * 1024 * 1024) throw new Error('Backup is too large to import safely.');
    return normalizeDatabase(JSON.parse(source), options);
  }

  global.VaultSecurity = Object.freeze({
    escapeHTML,
    safeURL,
    safeId,
    sanitizeRichText,
    normalizeDatabase,
    safeJSONParse
  });
})(window);
