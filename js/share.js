// Read-only public viewer for a shared inventory snapshot.
// Reads ?t=<token> and fetches the snapshot via the get_shared_inventory RPC.
(async function () {
  const view = document.getElementById('shareView');
  const token = new URLSearchParams(location.search).get('t');

  const esc = (s) => { const d = document.createElement('div'); d.textContent = (s == null ? '' : String(s)); return d.innerHTML; };
  const money = (n) => '$' + (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmtDate = (d) => { if (!d) return '--'; const x = new Date(d); return isNaN(x) ? '--' : x.toLocaleDateString(); };
  const msg = (m) => { view.innerHTML = '<div class="sv-msg">' + esc(m) + '</div>'; };

  if (!token) return msg('Invalid share link — no token provided.');
  if (!window.sbClient) return msg('Could not connect to the server.');

  let snap;
  try {
    const { data, error } = await window.sbClient.rpc('get_shared_inventory', { share_token: token });
    if (error) throw error;
    snap = data;
  } catch (e) {
    return msg('This link is invalid or has expired.');
  }
  if (!snap) return msg('This link is invalid or has expired.');

  const t = snap.totals || {};
  const cards = (snap.firearms || []).map(f => {
    const img = f.photo ? '<img class="sv-img" src="' + f.photo + '" alt="">' : '<div class="sv-img sv-img-ph">&#10022;</div>';
    const nfa = f.isNFA ? '<span class="sv-nfa">' + esc(f.nfaType || 'NFA') + '</span>' : '';
    return '<div class="sv-card">' + img + '<div class="sv-cbody">' +
      '<div class="sv-title">' + esc(f.make) + ' ' + esc(f.model) + ' ' + nfa + '</div>' +
      '<div class="sv-sub">' + esc(f.type) + ' &middot; ' + esc(f.caliber) + '</div>' +
      '<div class="sv-grid">' +
        (snap.includeSerials ? '<div><label>Serial</label><span>' + esc(f.serial || '--') + '</span></div>' : '') +
        '<div><label>Condition</label><span>' + esc(f.condition || '--') + '</span></div>' +
        '<div><label>Barrel</label><span>' + esc(f.barrel || '--') + '</span></div>' +
        '<div><label>Acquired</label><span>' + fmtDate(f.dateAcquired) + '</span></div>' +
        '<div><label>Value</label><span>' + money(f.price) + '</span></div>' +
      '</div></div></div>';
  }).join('');

  const accRows = (snap.accessories || []).map(a =>
    '<tr><td>' + esc(a.name) + '</td><td>' + esc(a.category) + '</td><td>' + esc(a.brand) + ' ' + esc(a.model) + '</td><td>' + money(a.price) + '</td></tr>'
  ).join('');

  view.innerHTML =
    '<header class="sv-header"><div><h1>' + esc(snap.label || 'Firearms Inventory') + '</h1>' +
      '<div class="sv-meta">Read-only snapshot &middot; generated ' + fmtDate(snap.generatedAt) + '</div></div>' +
      '<button class="btn btn-outline" onclick="window.print()">Print / Save PDF</button></header>' +
    '<div class="sv-kpis">' +
      '<div class="sv-kpi"><div class="v">' + (t.firearms || 0) + '</div><div class="l">Firearms</div></div>' +
      '<div class="sv-kpi"><div class="v">' + money(t.value) + '</div><div class="l">Total value</div></div>' +
      '<div class="sv-kpi"><div class="v">' + (t.accessories || 0) + '</div><div class="l">Accessories</div></div>' +
      '<div class="sv-kpi"><div class="v">' + (Number(t.rounds) || 0).toLocaleString() + '</div><div class="l">Rounds</div></div>' +
    '</div>' +
    '<div class="sv-cards">' + (cards || '<p>No firearms in this snapshot.</p>') + '</div>' +
    (accRows ? '<h2 class="sv-h2">Accessories</h2><table class="sv-table"><thead><tr><th>Name</th><th>Category</th><th>Brand / Model</th><th>Value</th></tr></thead><tbody>' + accRows + '</tbody></table>' : '') +
    '<footer class="sv-footer">Shared from a Personal Firearms Database &middot; private snapshot, please do not redistribute.</footer>';
})();
