// Read-only public viewer for an expiring/revocable inventory snapshot.
(function initSharedInventory() {
  'use strict';
  const view = document.getElementById('shareView');
  const hashToken = new URLSearchParams(location.hash.replace(/^#/, '')).get('t');
  const queryToken = new URLSearchParams(location.search).get('t');
  const token = hashToken || queryToken;
  if (queryToken && !hashToken && /^[0-9a-f-]{36}$/i.test(queryToken)) {
    history.replaceState(null, '', 'share.html#t=' + encodeURIComponent(queryToken));
  }

  const esc = (value) => { const node = document.createElement('div'); node.textContent = value == null ? '' : String(value); return node.innerHTML; };
  const escAttr = (value) => esc(value).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const money = (value) => '$' + (Number(value) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmtDate = (value) => { if (!value) return '--'; const date = new Date(value); return Number.isNaN(date.getTime()) ? '--' : date.toLocaleDateString(); };
  const safePhoto = (value) => {
    if (typeof value !== 'string' || value.length > 7 * 1024 * 1024) return '';
    const match = /^data:image\/(?:png|jpe?g|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$/i.exec(value);
    return match && match[1].length % 4 === 0 ? value : '';
  };

  function message(text) {
    view.setAttribute('aria-busy', 'false');
    view.innerHTML = '<div class="sv-msg" role="alert">' + esc(text) + '</div>';
  }

  function requestPasscode(invalid) {
    view.setAttribute('aria-busy', 'false');
    view.innerHTML = '<section class="sv-msg sv-code-card" aria-labelledby="shareCodeTitle">' +
      '<h1 id="shareCodeTitle">Passcode required</h1>' +
      '<p>This private snapshot requires the passcode supplied by its owner.</p>' +
      '<form id="shareCodeForm"><label for="shareViewerCode">Share passcode</label>' +
      '<input id="shareViewerCode" type="password" minlength="6" autocomplete="one-time-code" required>' +
      (invalid ? '<p class="sv-code-error" role="alert">That passcode was not accepted.</p>' : '') +
      '<button class="btn btn-primary" type="submit">Open snapshot</button></form></section>';
    const form = document.getElementById('shareCodeForm');
    const input = document.getElementById('shareViewerCode');
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (input.value.length < 6) return;
      view.setAttribute('aria-busy', 'true');
      await loadSnapshot(input.value);
    });
    input.focus();
  }

  function renderSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return message('This snapshot is not valid.');
    const totals = snapshot.totals && typeof snapshot.totals === 'object' ? snapshot.totals : {};
    const firearms = Array.isArray(snapshot.firearms) ? snapshot.firearms : [];
    const accessories = Array.isArray(snapshot.accessories) ? snapshot.accessories : [];
    const cards = firearms.map(item => {
      item = item && typeof item === 'object' ? item : {};
      const title = ((item.make || '') + ' ' + (item.model || '')).trim() || 'inventory item';
      const photo = safePhoto(item.photo);
      const image = photo
        ? '<img class="sv-img" src="' + photo + '" alt="Photo of ' + escAttr(title) + '">'
        : '<div class="sv-img sv-img-ph" role="img" aria-label="No photo available">&#10022;</div>';
      const nfa = item.isNFA ? '<span class="sv-nfa">' + esc(item.nfaType || 'NFA') + '</span>' : '';
      return '<article class="sv-card">' + image + '<div class="sv-cbody">' +
        '<div class="sv-title">' + esc(item.make) + ' ' + esc(item.model) + ' ' + nfa + '</div>' +
        '<div class="sv-sub">' + esc(item.type) + ' &middot; ' + esc(item.caliber) + '</div>' +
        '<dl class="sv-grid">' +
          (snapshot.includeSerials ? '<div><dt>Serial</dt><dd>' + esc(item.serial || '--') + '</dd></div>' : '') +
          '<div><dt>Condition</dt><dd>' + esc(item.condition || '--') + '</dd></div>' +
          '<div><dt>Barrel</dt><dd>' + esc(item.barrel || '--') + '</dd></div>' +
          '<div><dt>Acquired</dt><dd>' + fmtDate(item.dateAcquired) + '</dd></div>' +
          '<div><dt>Value</dt><dd>' + money(item.price) + '</dd></div>' +
        '</dl></div></article>';
    }).join('');

    const accessoryRows = accessories.map(rawItem => {
      const item = rawItem && typeof rawItem === 'object' ? rawItem : {};
      return (
      '<tr><td>' + esc(item.name) + '</td><td>' + esc(item.category) + '</td><td>' + esc(item.brand) + ' ' + esc(item.model) + '</td><td>' + money(item.price) + '</td></tr>'
      );
    }).join('');

    view.removeAttribute('aria-live');
    view.setAttribute('aria-busy', 'false');
    view.innerHTML =
      '<header class="sv-header"><div><h1>' + esc(snapshot.label || 'Firearms Inventory') + '</h1>' +
        '<div class="sv-meta">Read-only snapshot &middot; generated ' + fmtDate(snapshot.generatedAt) + '</div></div>' +
        '<button class="btn btn-outline" id="printShare" type="button">Print / Save PDF</button></header>' +
      '<div class="sv-kpis" role="list" aria-label="Snapshot totals">' +
        '<div class="sv-kpi" role="listitem"><div class="v">' + (Number(totals.firearms) || 0).toLocaleString() + '</div><div class="l">Firearms</div></div>' +
        '<div class="sv-kpi" role="listitem"><div class="v">' + money(totals.value) + '</div><div class="l">Total value</div></div>' +
        '<div class="sv-kpi" role="listitem"><div class="v">' + (Number(totals.accessories) || 0).toLocaleString() + '</div><div class="l">Accessories</div></div>' +
        '<div class="sv-kpi" role="listitem"><div class="v">' + (Number(totals.rounds) || 0).toLocaleString() + '</div><div class="l">Rounds</div></div>' +
      '</div>' +
      '<div class="sv-cards">' + (cards || '<p>No firearms in this snapshot.</p>') + '</div>' +
      (accessoryRows ? '<div class="sv-table-wrap" tabindex="0" role="region" aria-label="Accessories table"><table class="sv-table"><caption>Accessories</caption><thead><tr><th scope="col">Name</th><th scope="col">Category</th><th scope="col">Brand / Model</th><th scope="col">Value</th></tr></thead><tbody>' + accessoryRows + '</tbody></table></div>' : '') +
      '<footer class="sv-footer">Private read-only snapshot &middot; please do not redistribute.</footer>';
    document.getElementById('printShare').addEventListener('click', () => window.print());
  }

  async function loadSnapshot(code) {
    if (!token || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(token)) return message('Invalid share link — no valid token was provided.');
    if (!window.sbClient) return message('Could not connect to the server.');
    try {
      const { data, error } = await window.sbClient.rpc('get_shared_inventory', { share_token: token, share_code: code || null });
      if (error) throw error;
      if (!data) return message('This link is invalid, expired, revoked, or has reached its view limit.');
      if (data.rateLimited) return message('Too many incorrect attempts. Wait 15 minutes or ask the owner for a new link.');
      if (data.requiresCode) return requestPasscode(Boolean(data.invalidCode));
      renderSnapshot(data);
    } catch (_) {
      message('This link is unavailable. Check the link or ask its owner for a new one.');
    }
  }

  loadSnapshot(null);
})();
