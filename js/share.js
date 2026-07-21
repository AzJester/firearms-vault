// Read-only public viewer for an expiring/revocable Firearms Vault snapshot.
(function initSharedInventory() {
  'use strict';

  const view = document.getElementById('shareView');
  const tokenPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const hashToken = new URLSearchParams(location.hash.replace(/^#/, '')).get('t');
  const queryToken = new URLSearchParams(location.search).get('t');
  const token = hashToken || queryToken;

  // Move a valid legacy query token into the URL fragment so it is not sent in
  // future HTTP requests, referrers, or most server logs.
  if (queryToken && !hashToken) {
    const safeLocation = tokenPattern.test(queryToken)
      ? location.pathname + '#t=' + encodeURIComponent(queryToken)
      : location.pathname;
    history.replaceState(null, '', safeLocation);
  }

  const esc = (value) => {
    const node = document.createElement('div');
    node.textContent = value == null ? '' : String(value);
    return node.innerHTML;
  };
  const escAttr = (value) => esc(value).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const finiteNumber = (value) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  };
  const count = (value) => Math.max(0, Math.trunc(finiteNumber(value))).toLocaleString('en-US');
  const money = (value) => '$' + finiteNumber(value).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
  const parseDate = (value) => {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  };
  const fmtDate = (value) => {
    const date = parseDate(value);
    return date ? date.toLocaleDateString(undefined, { dateStyle: 'medium' }) : 'Not provided';
  };
  const fmtDateTime = (value) => {
    const date = parseDate(value);
    return date ? date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'date not provided';
  };
  const safePhoto = (value) => {
    if (typeof value !== 'string' || value.length > 7 * 1024 * 1024) return '';
    const match = /^data:image\/(?:png|jpe?g|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$/i.exec(value);
    return match && match[1].length % 4 === 0 ? value : '';
  };

  function brandHeader() {
    return '<div class="sv-site-header">' +
      '<a class="sv-brand" href="./" aria-label="Open Firearms Vault">' +
        '<img src="icons/icon.svg" alt="" width="38" height="38">' +
        '<span class="sv-brand-copy"><span class="sv-brand-name">Firearms Vault</span>' +
        '<span class="sv-brand-tag">Secure collection records</span></span>' +
      '</a>' +
      '<span class="sv-secure-label">Read-only private share</span>' +
    '</div>';
  }

  function renderState(options) {
    const retry = Boolean(options.retry);
    document.title = options.title + ' | Firearms Vault';
    view.setAttribute('aria-busy', 'false');
    view.innerHTML = brandHeader() +
      '<section class="sv-msg sv-state" role="alert" aria-labelledby="shareStateTitle">' +
        '<div class="sv-state-icon" aria-hidden="true">' + (options.icon || '!') + '</div>' +
        '<h1 id="shareStateTitle">' + esc(options.title) + '</h1>' +
        '<p>' + esc(options.message) + '</p>' +
        (options.help ? '<p class="sv-state-help">' + esc(options.help) + '</p>' : '') +
        '<div class="sv-state-actions">' +
          (retry ? '<button class="btn btn-primary" id="shareRetry" type="button">Try again</button>' : '') +
          '<a class="btn btn-outline" href="./">Open Firearms Vault</a>' +
        '</div>' +
      '</section>';
    if (retry) document.getElementById('shareRetry').addEventListener('click', () => loadSnapshot(null));
  }

  function requestPasscode(invalid) {
    document.title = 'Passcode Required | Firearms Vault';
    view.setAttribute('aria-busy', 'false');
    view.innerHTML = brandHeader() +
      '<section class="sv-msg sv-code-card" aria-labelledby="shareCodeTitle">' +
        '<div class="sv-state-icon" aria-hidden="true">*</div>' +
        '<h1 id="shareCodeTitle">Passcode required</h1>' +
        '<p>This Firearms Vault snapshot has an additional passcode set by its owner.</p>' +
        '<form id="shareCodeForm">' +
          '<label for="shareViewerCode">Share passcode</label>' +
          '<input id="shareViewerCode" type="password" minlength="12" maxlength="72" ' +
            'autocomplete="one-time-code" autocapitalize="none" spellcheck="false" aria-describedby="shareCodeHelp" required>' +
          '<div class="sv-code-tools"><p class="sv-code-help" id="shareCodeHelp">Enter the 12+ character passcode the owner sent separately. It is not part of the link.</p>' +
            '<button class="sv-show-code" id="showShareCode" type="button" aria-pressed="false">Show</button></div>' +
          (invalid ? '<p class="sv-code-error" role="alert">That passcode was not accepted. Check it carefully or ask the owner for a new share.</p>' : '') +
          '<button class="btn btn-primary" id="openShareButton" type="submit">Open snapshot</button>' +
        '</form>' +
        '<div class="sv-state-actions"><a class="btn btn-outline" href="./">Open Firearms Vault</a></div>' +
      '</section>';

    const form = document.getElementById('shareCodeForm');
    const input = document.getElementById('shareViewerCode');
    const show = document.getElementById('showShareCode');
    show.addEventListener('click', () => {
      const revealing = input.type === 'password';
      input.type = revealing ? 'text' : 'password';
      show.textContent = revealing ? 'Hide' : 'Show';
      show.setAttribute('aria-pressed', String(revealing));
      input.focus();
    });
    form.addEventListener('submit', async event => {
      event.preventDefault();
      const code = input.value.trim();
      if (code.length < 12) {
        input.setCustomValidity('Enter the complete passcode. Firearms Vault passcodes contain at least 12 characters.');
        input.reportValidity();
        return;
      }
      input.setCustomValidity('');
      document.getElementById('openShareButton').disabled = true;
      view.setAttribute('aria-busy', 'true');
      await loadSnapshot(code);
    });
    input.addEventListener('input', () => input.setCustomValidity(''));
    input.focus();
  }

  function renderSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
      renderState({
        title: 'This snapshot could not be read',
        message: 'The share did not contain a valid Firearms Vault snapshot.',
        help: 'Ask the owner to revoke this link and create a new one.'
      });
      return;
    }

    const totals = snapshot.totals && typeof snapshot.totals === 'object' && !Array.isArray(snapshot.totals)
      ? snapshot.totals : {};
    const firearms = Array.isArray(snapshot.firearms) ? snapshot.firearms : [];
    const accessories = Array.isArray(snapshot.accessories) ? snapshot.accessories : [];
    const includeSerials = snapshot.includeSerials === true;
    const includePhotos = snapshot.includePhotos === true || firearms.some(rawItem => {
      const item = rawItem && typeof rawItem === 'object' ? rawItem : {};
      return Boolean(safePhoto(item.photo));
    });
    const label = String(snapshot.label || '').trim() || 'Shared collection';
    document.title = label + ' | Firearms Vault';

    const cards = firearms.map(rawItem => {
      const item = rawItem && typeof rawItem === 'object' ? rawItem : {};
      const title = ((item.make || '') + ' ' + (item.model || '')).trim() || 'Inventory item';
      const photo = safePhoto(item.photo);
      const image = photo
        ? '<img class="sv-img" src="' + photo + '" alt="Photo of ' + escAttr(title) + '">'
        : '<div class="sv-img sv-img-ph" role="img" aria-label="No photo available">&#10022;</div>';
      const nfa = item.isNFA ? '<span class="sv-nfa">' + esc(item.nfaType || 'NFA') + '</span>' : '';
      const subtitle = [item.type, item.caliber].filter(Boolean).join(' / ');
      return '<article class="sv-card">' + image + '<div class="sv-cbody">' +
        '<div class="sv-title">' + esc(title) + ' ' + nfa + '</div>' +
        (subtitle ? '<div class="sv-sub">' + esc(subtitle) + '</div>' : '') +
        '<dl class="sv-grid">' +
          (includeSerials ? '<div><dt>Serial</dt><dd>' + esc(item.serial || 'Not provided') + '</dd></div>' : '') +
          '<div><dt>Condition</dt><dd>' + esc(item.condition || 'Not provided') + '</dd></div>' +
          '<div><dt>Barrel</dt><dd>' + esc(item.barrel || 'Not provided') + '</dd></div>' +
          '<div><dt>Acquired</dt><dd>' + fmtDate(item.dateAcquired) + '</dd></div>' +
          '<div><dt>Value</dt><dd>' + money(item.price) + '</dd></div>' +
        '</dl></div></article>';
    }).join('');

    const accessoryRows = accessories.map(rawItem => {
      const item = rawItem && typeof rawItem === 'object' ? rawItem : {};
      return '<tr><td>' + esc(item.name || 'Unnamed accessory') + '</td><td>' + esc(item.category) + '</td><td>' +
        esc([item.brand, item.model].filter(Boolean).join(' ')) + '</td><td>' + money(item.price) + '</td></tr>';
    }).join('');

    const generated = fmtDateTime(snapshot.generatedAt);
    const privacyBadges = [
      '<span class="sv-trust-badge is-private">Read-only</span>',
      '<span class="sv-trust-badge">Values included</span>',
      '<span class="sv-trust-badge' + (includeSerials ? '' : ' is-private') + '">Serials ' + (includeSerials ? 'included' : 'excluded') + '</span>',
      '<span class="sv-trust-badge' + (includePhotos ? '' : ' is-private') + '">Photos ' + (includePhotos ? 'included' : 'excluded') + '</span>'
    ].join('');

    view.removeAttribute('aria-live');
    view.setAttribute('aria-busy', 'false');
    view.innerHTML = brandHeader() +
      '<header class="sv-header"><div><div class="sv-eyebrow">Shared snapshot</div><h1>' + esc(label) + '</h1>' +
        '<div class="sv-meta">Created ' + esc(generated) + '</div></div>' +
        '<button class="btn btn-outline" id="printShare" type="button">Print / Save PDF</button></header>' +
      '<aside class="sv-trust" aria-label="About this share"><div class="sv-trust-copy">' +
        '<strong>Static copy from Firearms Vault.</strong> This page cannot change the owner\'s vault and will not update when their collection changes.' +
        '</div><div class="sv-trust-badges">' + privacyBadges + '</div></aside>' +
      '<div class="sv-kpis" role="list" aria-label="Snapshot totals">' +
        '<div class="sv-kpi" role="listitem"><div class="v">' + count(totals.firearms) + '</div><div class="l">Firearms</div></div>' +
        '<div class="sv-kpi" role="listitem"><div class="v">' + money(totals.value) + '</div><div class="l">Total value</div></div>' +
        '<div class="sv-kpi" role="listitem"><div class="v">' + count(totals.accessories) + '</div><div class="l">Accessories</div></div>' +
        '<div class="sv-kpi" role="listitem"><div class="v">' + count(totals.rounds) + '</div><div class="l">Rounds</div></div>' +
      '</div>' +
      '<div class="sv-cards">' + (cards || '<p>No firearms are included in this snapshot.</p>') + '</div>' +
      (accessoryRows ? '<div class="sv-table-wrap" tabindex="0" role="region" aria-label="Accessories table"><table class="sv-table"><caption>Accessories</caption><thead><tr><th scope="col">Name</th><th scope="col">Category</th><th scope="col">Brand / Model</th><th scope="col">Value</th></tr></thead><tbody>' + accessoryRows + '</tbody></table></div>' : '') +
      '<footer class="sv-footer">Private Firearms Vault snapshot. Verify important details with the owner and do not redistribute.</footer>';
    document.getElementById('printShare').addEventListener('click', () => window.print());
  }

  async function loadSnapshot(code) {
    if (!token || !tokenPattern.test(token)) {
      renderState({
        title: 'This share link is incomplete',
        message: 'The private token needed to open this Firearms Vault share is missing or incomplete.',
        help: 'Open the complete link you received, or ask the owner to copy and send it again.'
      });
      return;
    }
    if (!window.sbClient) {
      renderState({
        title: 'Firearms Vault is temporarily unavailable',
        message: 'The secure sharing service could not be reached.',
        help: 'Check your connection and try again. Your device has not changed the owner\'s data.',
        retry: true
      });
      return;
    }
    try {
      const { data, error } = await window.sbClient.rpc('get_shared_inventory', {
        share_token: token,
        share_code: code || null
      });
      if (error) throw error;
      if (!data) {
        renderState({
          title: 'This share is no longer available',
          message: 'It may have expired, been revoked, reached its open limit, or been replaced by the owner.',
          help: 'Ask the owner to create a new Firearms Vault share. For privacy, no collection details are shown here.'
        });
        return;
      }
      if (data.rateLimited) {
        renderState({
          title: 'Too many passcode attempts',
          message: 'This share is temporarily locked after several incorrect passcodes.',
          help: 'Wait 15 minutes before trying again, or ask the owner for a new share link.'
        });
        return;
      }
      if (data.requiresCode) {
        requestPasscode(Boolean(data.invalidCode));
        return;
      }
      renderSnapshot(data);
    } catch (_) {
      renderState({
        title: 'We could not open this share',
        message: 'Firearms Vault could not securely retrieve the snapshot.',
        help: 'Check your connection and try again. If the problem continues, ask the owner for a new link.',
        retry: true
      });
    }
  }

  loadSnapshot(null);
})();
