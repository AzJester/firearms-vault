// =====================================================
// APP VERSION
// =====================================================
const APP_VERSION = '1.2.0';

// =====================================================
// DATA STRUCTURE & STATE
// =====================================================
let db = { version: 3, encrypted: false, firearms: [], ammo: [], accessories: [], wishlist: [], dealers: [], backups: [], settings: {}, auditTrail: [], valueHistory: [] };

// Ensure tags on all firearms
db.firearms.forEach(f => { if (!f.tags) f.tags = []; });

// Embedded images
const EMBEDDED_IMAGES = {}; // data now loaded from Supabase cloud

let fileHandle = null;
let imagesDb = {};
let editingId = null;
let editingAmmoId = null;
let currentTab = 'all';
let currentView = 'cards';
let tempImages = [];
let thumbCache = {};   // imageId -> small downscaled data URL for fast card/table rendering
let tempDocs = [];
let tempTags = [];
let tempStampPdf = null;
let tempStampPdfName = null;
let sortCol = null;
let sortDir = 'asc';
let currentPassword = null;
let currentImageIndex = 0;
let editingMaintenanceId = null;
let editingAccessoryId = null;
let tempReceipts = { f: null, fName: null, a: null, aName: null, acc: null, accName: null };

// IndexedDB for images
let imageStore = null;
const IDB_NAME = 'FirearmsDB_Images';
const IDB_VERSION = 1;
const IDB_STORE = 'images';

function generateId() { return Date.now().toString(36) + Math.random().toString(36).substr(2, 6); }

// =====================================================
// TOAST NOTIFICATIONS (replaces native toast())
// =====================================================
function toast(message, type, timeout) {
  message = (message == null) ? '' : String(message);
  if (!type) {
    if (/\b(fail|failed|error|invalid|unable|denied|cannot|no )/i.test(message)) type = 'error';
    else if (/\b(success|saved|imported|exported|added|updated|deleted|removed|restored|complete|copied|done)/i.test(message)) type = 'success';
    else type = 'info';
  }
  const host = document.getElementById('toastHost');
  if (!host) { console.warn('[toast]', message); return; }
  const icon = type === 'success' ? '&#10003;' : type === 'error' ? '&#9888;' : '&#8505;';
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.innerHTML = '<span class="toast-icon">' + icon + '</span><div class="toast-msg"></div>' +
                 '<button class="toast-close" aria-label="Dismiss">&times;</button>';
  el.querySelector('.toast-msg').textContent = message;
  const remove = () => { el.classList.add('hide'); setTimeout(() => el.remove(), 200); };
  el.querySelector('.toast-close').onclick = remove;
  host.appendChild(el);
  setTimeout(remove, timeout || (type === 'error' ? 6000 : 3800));
}
window.toast = toast;

// =====================================================
// IMAGE LIGHTBOX
// =====================================================
function openLightbox(src) {
  const lb = document.getElementById('lightbox');
  const img = document.getElementById('lightboxImg');
  if (!lb || !img || !src) return;
  img.src = src;
  lb.style.display = 'flex';
}
function closeLightbox() {
  const lb = document.getElementById('lightbox');
  if (lb) { lb.style.display = 'none'; const i = document.getElementById('lightboxImg'); if (i) i.src = ''; }
}
window.openLightbox = openLightbox;
window.closeLightbox = closeLightbox;
// Click any detail-view photo to open it full-screen
document.addEventListener('click', (e) => {
  const t = e.target;
  if (t && t.classList && t.classList.contains('detail-img')) { e.stopPropagation(); openLightbox(t.src); }
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeLightbox(); });

// =====================================================
// NAVIGATION: dropdown menus, contextual add, bottom nav, filters
// =====================================================
// Dropdown menus (Tools, account gear, bottom-nav "More")
document.addEventListener('click', (e) => {
  const toggle = e.target.closest('[data-menu-toggle]');
  if (toggle) {
    const menu = toggle.closest('.menu');
    const wasOpen = menu.classList.contains('open');
    document.querySelectorAll('.menu.open').forEach(m => m.classList.remove('open'));
    if (!wasOpen) menu.classList.add('open');
    e.stopPropagation();
    return;
  }
  if (e.target.closest('.menu-item')) {                 // run the item's action, then close
    const m = e.target.closest('.menu'); if (m) m.classList.remove('open');
    return;
  }
  document.querySelectorAll('.menu.open').forEach(m => m.classList.remove('open'));
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') document.querySelectorAll('.menu.open').forEach(m => m.classList.remove('open'));
});

// Bottom-nav buttons (and "More" items) reuse the existing top-tab logic
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-bottomtab]');
  if (!b) return;
  const tab = document.querySelector('.tab[data-tab="' + b.dataset.bottomtab + '"]');
  if (tab) tab.click();
});
function updateBottomNav() {
  document.querySelectorAll('.bn-item[data-bottomtab]').forEach(b =>
    b.classList.toggle('active', b.dataset.bottomtab === currentTab));
}
function toggleFilters() {
  const tb = document.getElementById('mainToolbar');
  if (tb) tb.classList.toggle('show-filters');
}

// Contextual primary action ("+ Add") that follows the active tab
let _ctxAdd = null;
function updateContextualActions() {
  try {
    const map = {
      all: ['+ Add Firearm', openAddModal], nfa: ['+ Add Firearm', openAddModal], disposed: ['+ Add Firearm', openAddModal],
      ammo: ['+ Add Ammo', openAddAmmoModal], accessories: ['+ Add Accessory', openAccessoryModal],
      wishlist: ['+ Add Wishlist', openWishlistModal], dealers: ['+ Add Dealer', openDealerModal]
    };
    const spec = map[currentTab] || null;
    _ctxAdd = spec ? spec[1] : null;
    const addBtn = document.getElementById('addBtn');
    const fab = document.getElementById('bnFab');
    if (addBtn) { addBtn.style.display = spec ? '' : 'none'; if (spec) addBtn.textContent = spec[0]; }
    if (fab) fab.style.display = spec ? '' : 'none';
  } catch (err) { console.warn('updateContextualActions failed', err); }
}
function ctxAdd() { try { if (_ctxAdd) _ctxAdd(); } catch (err) { console.warn(err); } }
window.ctxAdd = ctxAdd;
window.toggleFilters = toggleFilters;

// Active-filter chips + filter count badge (chips shown on firearm views)
function updateFilterChips() {
  const chipsEl = document.getElementById('filterChips');
  const fbtn = document.getElementById('filterBtn');
  if (!chipsEl) return;
  const firearmView = ['all', 'nfa', 'disposed'].includes(currentTab);
  const defs = [['searchBox', 'Search'], ['filterType', 'Type'], ['filterCaliber', 'Caliber'], ['filterTag', 'Tag'], ['filterCondition', 'Condition']];
  const active = [];
  defs.forEach(([id, label]) => { const el = document.getElementById(id); if (el) { const v = (el.value || '').trim(); if (v) active.push({ id, label, v }); } });
  if (fbtn) fbtn.innerHTML = '&#9776; Filters' + (active.length ? ' <span class="fbtn-count">' + active.length + '</span>' : '');
  if (!firearmView || !active.length) { chipsEl.style.display = 'none'; chipsEl.innerHTML = ''; return; }
  chipsEl.style.display = 'flex';
  chipsEl.innerHTML = active.map(a =>
    '<span class="chip">' + esc(a.label) + ': ' + esc(a.v) + '<button onclick="clearOneFilter(\'' + a.id + '\')" aria-label="Remove">&times;</button></span>').join('') +
    '<button class="chip-clear" onclick="clearAllFilters()">Clear all</button>';
}
function clearOneFilter(id) { const el = document.getElementById(id); if (el) { el.value = ''; render(); } }
function clearAllFilters() { ['searchBox', 'filterType', 'filterCaliber', 'filterTag', 'filterCondition'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; }); render(); }
window.clearOneFilter = clearOneFilter;
window.clearAllFilters = clearAllFilters;

// =====================================================
// COMMAND PALETTE (Ctrl/Cmd + K)
// =====================================================
let cmdkItems = [], cmdkSel = 0;
function _gotoTab(t) { const el = document.querySelector('.tab[data-tab="' + t + '"]'); if (el) el.click(); }
function cmdkCommands() {
  return [
    { icon: '➕', label: 'Add Firearm', kw: 'new create gun', run: openAddModal },
    { icon: '➕', label: 'Add Ammo', kw: 'new ammunition rounds', run: openAddAmmoModal },
    { icon: '➕', label: 'Add Accessory', kw: 'new optic suppressor', run: openAccessoryModal },
    { icon: '➕', label: 'Add Wishlist item', kw: 'new want', run: openWishlistModal },
    { icon: '➕', label: 'Add FFL Dealer', kw: 'new ffl', run: openDealerModal },
    { icon: '⬇️', label: 'Import FFL Dealers', kw: 'bulk dealers arizona az starter list', run: openDealerImportModal },
    { icon: '📊', label: 'Go to Dashboard', kw: 'home stats charts', run: () => _gotoTab('dashboard') },
    { icon: '🔫', label: 'Go to Firearms', kw: 'all guns', run: () => _gotoTab('all') },
    { icon: '🎯', label: 'Go to Ammunition', kw: 'ammo rounds', run: () => _gotoTab('ammo') },
    { icon: '📦', label: 'Go to Accessories', kw: 'parts optics', run: () => _gotoTab('accessories') },
    { icon: '📄', label: 'Go to NFA Items', kw: 'tax stamp suppressor sbr', run: () => _gotoTab('nfa') },
    { icon: '⭐', label: 'Go to Wishlist', kw: '', run: () => _gotoTab('wishlist') },
    { icon: '🏢', label: 'Go to FFL Dealers', kw: 'ffl', run: () => _gotoTab('dealers') },
    { icon: '📈', label: 'Custom Report', kw: 'export report builder', run: openReportBuilder },
    { icon: '📓', label: 'ATF Bound Book', kw: 'export atf', run: exportATFBoundBook },
    { icon: '📷', label: 'Scan Serial', kw: 'camera ocr', run: openCameraModal },
    { icon: '📗', label: 'Export to Excel', kw: 'xlsx download', run: exportExcel },
    { icon: '⬇️', label: 'Export JSON', kw: 'backup download', run: exportJSON },
    { icon: '🖨️', label: 'Print', kw: '', run: printInventory },
    { icon: '🔔', label: 'Reminders', kw: 'alerts', run: openReminders },
    { icon: '⚙️', label: 'Settings', kw: 'password account', run: openSettingsModal },
    { icon: '💾', label: 'Backup now', kw: '', run: manualBackup },
    { icon: '🌓', label: 'Toggle dark mode', kw: 'theme light', run: toggleTheme }
  ];
}
function cmdkBuild(q) {
  q = (q || '').trim().toLowerCase();
  const out = [];
  if (q) {
    (db.firearms || []).forEach(f => {
      const hay = ((f.make || '') + ' ' + (f.model || '') + ' ' + (f.serial || '') + ' ' + (f.caliber || '') + ' ' + (f.nfaType || '')).toLowerCase();
      if (hay.includes(q)) out.push({
        icon: '🔫', label: ((f.make || '') + ' ' + (f.model || '')).trim() || 'Firearm',
        hint: (f.caliber || '') + (f.serial ? ' · ' + f.serial : ''), run: () => openDetail(f.id)
      });
    });
  }
  let cmds = cmdkCommands();
  if (q) cmds = cmds.filter(c => (c.label + ' ' + (c.kw || '')).toLowerCase().includes(q));
  return out.slice(0, 6).concat(cmds).slice(0, 16);
}
function cmdkRender() {
  const input = document.getElementById('cmdkInput');
  cmdkItems = cmdkBuild(input ? input.value : '');
  cmdkSel = 0;
  const el = document.getElementById('cmdkResults');
  if (!el) return;
  if (!cmdkItems.length) { el.innerHTML = '<div class="cmdk-empty">No matches.</div>'; return; }
  el.innerHTML = cmdkItems.map((it, i) =>
    `<div class="cmdk-item${i === 0 ? ' sel' : ''}" data-i="${i}" onmouseenter="cmdkHover(${i})" onclick="cmdkExec(${i})">
      <span class="cmdk-ico">${it.icon}</span><span class="cmdk-label">${esc(it.label)}</span>${it.hint ? '<span class="cmdk-hint">' + esc(it.hint) + '</span>' : ''}</div>`).join('');
}
function cmdkPaint() { document.querySelectorAll('#cmdkResults .cmdk-item').forEach((el, i) => el.classList.toggle('sel', i === cmdkSel)); }
function cmdkHover(i) { cmdkSel = i; cmdkPaint(); }
function cmdkMove(d) {
  if (!cmdkItems.length) return;
  cmdkSel = (cmdkSel + d + cmdkItems.length) % cmdkItems.length;
  cmdkPaint();
  const sel = document.querySelector('#cmdkResults .cmdk-item.sel');
  if (sel) sel.scrollIntoView({ block: 'nearest' });
}
function cmdkExec(i) {
  const it = cmdkItems[(i != null) ? i : cmdkSel];
  closeCmdK();
  if (it && it.run) { try { it.run(); } catch (e) { console.warn('cmdk run failed', e); } }
}
function openCmdK() {
  const o = document.getElementById('cmdk'); if (!o) return;
  o.style.display = 'flex';
  const inp = document.getElementById('cmdkInput'); if (inp) inp.value = '';
  cmdkRender();
  setTimeout(() => { if (inp) inp.focus(); }, 30);
}
function closeCmdK() { const o = document.getElementById('cmdk'); if (o) o.style.display = 'none'; }
window.openCmdK = openCmdK; window.closeCmdK = closeCmdK;
window.cmdkRender = cmdkRender; window.cmdkExec = cmdkExec; window.cmdkHover = cmdkHover;
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); openCmdK(); return; }
  const o = document.getElementById('cmdk');
  if (!o || o.style.display === 'none') return;
  if (e.key === 'Escape') { e.preventDefault(); closeCmdK(); }
  else if (e.key === 'ArrowDown') { e.preventDefault(); cmdkMove(1); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); cmdkMove(-1); }
  else if (e.key === 'Enter') { e.preventDefault(); cmdkExec(); }
});

// =====================================================
// INDEXEDDB IMAGE STORAGE
// =====================================================
function openImageDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, IDB_VERSION);
    req.onupgradeneeded = (e) => {
      const idb = e.target.result;
      if (!idb.objectStoreNames.contains(IDB_STORE)) {
        idb.createObjectStore(IDB_STORE);
      }
    };
    req.onsuccess = (e) => { imageStore = e.target.result; resolve(imageStore); };
    req.onerror = (e) => { console.error('IndexedDB error:', e); reject(e); };
  });
}

function idbPut(key, value) {
  return new Promise((resolve, reject) => {
    const tx = imageStore.transaction(IDB_STORE, 'readwrite');
    const store = tx.objectStore(IDB_STORE);
    const req = store.put(value, key);
    req.onsuccess = () => resolve();
    req.onerror = (e) => reject(e);
  });
}

function idbGet(key) {
  return new Promise((resolve, reject) => {
    const tx = imageStore.transaction(IDB_STORE, 'readonly');
    const store = tx.objectStore(IDB_STORE);
    const req = store.get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = (e) => reject(e);
  });
}

function idbGetAll() {
  return new Promise((resolve, reject) => {
    const tx = imageStore.transaction(IDB_STORE, 'readonly');
    const store = tx.objectStore(IDB_STORE);
    const keys = store.getAllKeys();
    const vals = store.getAll();
    keys.onsuccess = () => {};
    vals.onsuccess = () => {
      const result = {};
      for (let i = 0; i < keys.result.length; i++) {
        result[keys.result[i]] = vals.result[i];
      }
      resolve(result);
    };
    vals.onerror = (e) => reject(e);
  });
}

function idbDelete(key) {
  return new Promise((resolve, reject) => {
    const tx = imageStore.transaction(IDB_STORE, 'readwrite');
    const store = tx.objectStore(IDB_STORE);
    const req = store.delete(key);
    req.onsuccess = () => resolve();
    req.onerror = (e) => reject(e);
  });
}

// Migrate images from JSON to IndexedDB
async function migrateImagesToIDB(jsonImages) {
  if (!jsonImages || Object.keys(jsonImages).length === 0) return;
  const keys = Object.keys(jsonImages);
  for (const key of keys) {
    await idbPut(key, jsonImages[key]);
    imagesDb[key] = jsonImages[key]; // keep in memory for current session
  }
}

// =====================================================
// DARK MODE
// =====================================================
function toggleTheme() {
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  const newTheme = isDark ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', newTheme);
  localStorage.setItem('firearms-db-theme', newTheme);
  document.getElementById('themeToggle').innerHTML = newTheme === 'dark' ? '&#9788;' : '&#9790;';
}

function loadTheme() {
  const saved = localStorage.getItem('firearms-db-theme');
  if (saved === 'dark') {
    document.documentElement.setAttribute('data-theme', 'dark');
    document.getElementById('themeToggle').innerHTML = '&#9788;';
  }
}

// =====================================================
// AUDIT TRAIL
// =====================================================
function addAuditEntry(action, itemType, itemName, details) {
  if (!db.auditTrail) db.auditTrail = [];
  db.auditTrail.push({
    timestamp: new Date().toISOString(),
    action: action, // 'create', 'edit', 'delete'
    itemType: itemType, // 'firearm', 'ammo', 'accessory', 'maintenance'
    itemName: itemName,
    details: details || ''
  });
  // Keep last 500 entries
  if (db.auditTrail.length > 500) db.auditTrail = db.auditTrail.slice(-500);
}

function renderAuditTrail() {
  const list = document.getElementById('auditList');
  const trail = (db.auditTrail || []).slice().reverse();
  document.getElementById('auditCount').textContent = trail.length + ' entries';

  if (trail.length === 0) {
    list.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text3);font-size:0.82rem;">No activity recorded yet.</div>';
    return;
  }

  list.innerHTML = trail.slice(0, 100).map(e => {
    const d = new Date(e.timestamp);
    const time = d.toLocaleDateString() + ' ' + d.toLocaleTimeString();
    return `<div class="audit-entry">
      <span class="audit-time">${esc(time)}</span>
      <span class="audit-action ${e.action}">${esc(e.action)}</span>
      <span class="audit-detail"><strong>${esc(e.itemType)}</strong>: ${esc(e.itemName)}${e.details ? ' — ' + esc(e.details) : ''}</span>
    </div>`;
  }).join('');
}

async function clearAuditTrail() {
  if (!await confirmDialog('Clear all activity log entries?', { title: 'Clear activity log', okText: 'Clear', danger: true })) return;
  db.auditTrail = [];
  saveData();
  renderAuditTrail();
}

// =====================================================
// TAGS SYSTEM
// =====================================================
function getAllTags() {
  const tags = new Set();
  db.firearms.forEach(f => { if (f.tags) f.tags.forEach(t => tags.add(t)); });
  return [...tags].sort();
}

function renderTagsInput() {
  const container = document.getElementById('tagsInputContainer');
  const input = document.getElementById('tagInput');
  // Remove existing chips
  container.querySelectorAll('.tag-chip').forEach(c => c.remove());
  // Add chips before input
  tempTags.forEach((tag, idx) => {
    const chip = document.createElement('span');
    chip.className = 'tag-chip';
    chip.innerHTML = esc(tag) + ' <span class="tag-remove" onclick="removeTag(' + idx + ')">&times;</span>';
    container.insertBefore(chip, input);
  });
}

function handleTagKey(e) {
  if (e.key === 'Enter' || e.key === ',') {
    e.preventDefault();
    const val = e.target.value.trim().replace(/,/g, '');
    if (val && !tempTags.includes(val)) {
      tempTags.push(val);
      renderTagsInput();
    }
    e.target.value = '';
    hideTagSuggestions();
  } else if (e.key === 'Backspace' && e.target.value === '' && tempTags.length > 0) {
    tempTags.pop();
    renderTagsInput();
  }
}

function removeTag(idx) {
  tempTags.splice(idx, 1);
  renderTagsInput();
}

function showTagSuggestions() {
  const input = document.getElementById('tagInput');
  const val = input.value.toLowerCase().trim();
  const sug = document.getElementById('tagSuggestions');
  if (!val) { sug.classList.remove('open'); return; }

  const all = getAllTags().filter(t => t.toLowerCase().includes(val) && !tempTags.includes(t));
  if (all.length === 0) { sug.classList.remove('open'); return; }

  sug.innerHTML = all.slice(0, 8).map(t =>
    `<div onclick="selectTagSuggestion('${esc(t)}')">${esc(t)}</div>`
  ).join('');
  sug.classList.add('open');
}

function selectTagSuggestion(tag) {
  if (!tempTags.includes(tag)) {
    tempTags.push(tag);
    renderTagsInput();
  }
  document.getElementById('tagInput').value = '';
  hideTagSuggestions();
}

function hideTagSuggestions() {
  document.getElementById('tagSuggestions').classList.remove('open');
}

function updateTagFilter() {
  const sel = document.getElementById('filterTag');
  const cur = sel.value;
  const tags = getAllTags();
  sel.innerHTML = '<option value="">All Tags</option>';
  tags.forEach(t => { const o = document.createElement('option'); o.value = t; o.textContent = t; sel.appendChild(o); });
  sel.value = cur;
}

// =====================================================
// FILE SYSTEM ACCESS
// =====================================================
function checkBrowserSupport() { return ('showSaveFilePicker' in window); }

async function createNewFile() {
  if (!checkBrowserSupport()) { toast('Your browser does not support the File System Access API. Please use Chrome or Edge.'); return; }
  try {
    fileHandle = await window.showSaveFilePicker({
      suggestedName: 'firearms_database.json',
      types: [{ description: 'JSON Database', accept: { 'application/json': ['.json'] } }]
    });
    db = { version: 3, encrypted: false, firearms: [], ammo: [], accessories: [], backups: [], settings: {}, auditTrail: [] };
    currentPassword = null;
    await writeToDisk();
    onFileConnected();
  } catch (e) { if (e.name !== 'AbortError') toast('Could not create file: ' + e.message); }
}

async function openExistingFile() {
  if (!checkBrowserSupport()) { toast('Your browser does not support the File System Access API. Please use Chrome or Edge.'); return; }
  try {
    const [handle] = await window.showOpenFilePicker({
      types: [{ description: 'JSON Database', accept: { 'application/json': ['.json'] } }]
    });
    fileHandle = handle;
    await readFromDisk();
    onFileConnected();
  } catch (e) { if (e.name !== 'AbortError') toast('Could not open file: ' + e.message); }
}

async function readFromDisk() {
  if (!fileHandle) return;
  try {
    const file = await fileHandle.getFile();
    const text = await file.text();
    if (text.trim() === '') {
      db = { version: 3, encrypted: false, firearms: [], ammo: [], accessories: [], backups: [], settings: {}, auditTrail: [] };
    } else {
      const data = JSON.parse(text);
      if (data.encrypted) {
        currentPassword = null;
        document.getElementById('passwordModal').classList.add('open');
        throw new Error('Password required');
      } else {
        if (Array.isArray(data)) db = { version: 3, encrypted: false, firearms: data, ammo: [], accessories: [], backups: [], settings: {}, auditTrail: [] };
        else db = data;
        // Ensure all fields exist (migration from v2)
        if (!db.version || db.version < 3) db.version = 3;
        if (!db.backups) db.backups = [];
        if (!db.ammo) db.ammo = [];
        if (!db.accessories) db.accessories = [];
        if (!db.settings) db.settings = {};
        if (!db.auditTrail) db.auditTrail = [];
        // Ensure tags arrays exist on all firearms
        db.firearms.forEach(f => { if (!f.tags) f.tags = []; });

        // Migrate images from JSON to IndexedDB
        if (db.images && Object.keys(db.images).length > 0) {
          await migrateImagesToIDB(db.images);
          delete db.images;
          // Re-save without images in JSON
          await writeToDisk();
        } else {
          // Load images from IndexedDB
          imagesDb = await idbGetAll();
        }

        // Migrate old single-image format
        db.firearms.forEach(f => {
          if (f.image && (!f.images || f.images.length === 0)) {
            const imgId = 'img_' + generateId();
            imagesDb[imgId] = f.image;
            idbPut(imgId, f.image);
            f.images = [imgId];
            delete f.image;
          }
          if (f.stampImage && !f.stampPdf) {
            f.stampPdf = f.stampImage;
            f.stampPdfName = 'tax_stamp.pdf';
            delete f.stampImage;
          }
        });
      }
    }
  } catch (e) {
    if (e.message === 'Password required') return;
    console.error('Read failed:', e);
    toast('Could not read the file.');
    db = { version: 3, encrypted: false, firearms: [], ammo: [], accessories: [], backups: [], settings: {}, auditTrail: [] };
  }
}

async function writeToDisk() {
  if (!fileHandle) return;
  try {
    let saveObj = Object.assign({}, db, { images: imagesDb });
    let toWrite = saveObj;
    if (db.encrypted && currentPassword) {
      toWrite = await encryptData(JSON.stringify(saveObj), currentPassword);
    }
    const writable = await fileHandle.createWritable();
    await writable.write(JSON.stringify(toWrite, null, 2));
    await writable.close();
    showSaveIndicator();
  } catch (e) {
    console.error('Write failed:', e);
    toast('Failed to save to disk: ' + e.message);
    disconnectFile();
  }
}

function onFileConnected() {
  const _wo = document.getElementById('welcomeOverlay'); if (_wo) _wo.style.display = 'none';
  document.getElementById('statusDot').className = 'file-status-dot connected';
  document.getElementById('fileStatusText').textContent = 'Connected:';
  document.getElementById('fileStatusName').textContent = fileHandle.name;

  if (db.encrypted) {
    document.getElementById('encryptionStatus').innerHTML = ' <span class="lock-indicator">&#128274;</span>';
  } else {
    document.getElementById('encryptionStatus').innerHTML = '';
  }

  document.getElementById('backupBtn').style.display = db.backups.length > 0 ? 'inline-block' : 'none';
  document.getElementById('settingsBtn').style.display = 'inline-block';
  document.getElementById('addFirearmBtn').style.display = 'inline-block';
  document.getElementById('addAmmoBtn').style.display = 'inline-block';
  document.getElementById('addAccessoryBtn').style.display = 'inline-block';
  document.getElementById('reportBtn').style.display = 'inline-block';
  document.getElementById('scanBtn').style.display = 'inline-block';
  document.getElementById('excelBtn').style.display = 'inline-block';
  document.getElementById('jsonBtn').style.display = 'inline-block';
  document.getElementById('importBtn').style.display = 'inline-block';
  document.getElementById('csvBtn').style.display = 'inline-block';
  document.getElementById('addWishlistBtn').style.display = 'inline-block';
  document.getElementById('addDealerBtn').style.display = 'inline-block';
  document.getElementById('atfBtn').style.display = 'inline-block';
  document.getElementById('firstItemBtn').style.display = 'inline-block';

  updateStats();
  render();
}

function disconnectFile() {
  fileHandle = null;
  document.getElementById('statusDot').className = 'file-status-dot disconnected';
  document.getElementById('fileStatusText').textContent = 'No file connected';
  document.getElementById('fileStatusName').textContent = '';
  document.getElementById('encryptionStatus').innerHTML = '';
}

function showSaveIndicator() {
  const el = document.getElementById('saveIndicator');
  el.classList.add('show');
  el.textContent = 'Saved ' + new Date().toLocaleTimeString();
  setTimeout(() => el.classList.remove('show'), 2500);
}

async function saveData() {
  if (!db.backups) db.backups = [];
  if (db.backups.length >= 10) db.backups.shift();
  db.backups.push({
    timestamp: new Date().toISOString(),
    firearms: JSON.parse(JSON.stringify(db.firearms)),
    ammo: JSON.parse(JSON.stringify(db.ammo)),
    accessories: JSON.parse(JSON.stringify(db.accessories))
  });
  await writeToDisk();
  saveToLocalStorage();
  updateStats();
}

// =====================================================
// ENCRYPTION
// =====================================================
async function encryptData(plaintext, password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const keyMaterial = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), { name: 'PBKDF2' }, false, ['deriveBits']);
  const keyBits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: salt, iterations: 100000, hash: 'SHA-256' }, keyMaterial, 256);
  const key = await crypto.subtle.importKey('raw', keyBits, { name: 'AES-GCM' }, false, ['encrypt']);
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, key, new TextEncoder().encode(plaintext));
  return { encrypted: true, algorithm: 'AES-GCM', salt: Array.from(salt), iv: Array.from(iv), ciphertext: Array.from(new Uint8Array(ciphertext)) };
}

async function decryptData(encryptedObj, password) {
  const salt = new Uint8Array(encryptedObj.salt);
  const iv = new Uint8Array(encryptedObj.iv);
  const ciphertext = new Uint8Array(encryptedObj.ciphertext);
  const keyMaterial = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), { name: 'PBKDF2' }, false, ['deriveBits']);
  const keyBits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: salt, iterations: 100000, hash: 'SHA-256' }, keyMaterial, 256);
  const key = await crypto.subtle.importKey('raw', keyBits, { name: 'AES-GCM' }, false, ['decrypt']);
  try {
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv }, key, ciphertext);
    return new TextDecoder().decode(plaintext);
  } catch (e) { throw new Error('Decryption failed - wrong password'); }
}

function openSettingsModal() {
  if (db.encrypted) {
    document.getElementById('encryptionLabel').textContent = 'Change Password';
    document.getElementById('encryptionBtn').textContent = 'Update Password';
    document.getElementById('decryptSection').style.display = 'block';
  } else {
    document.getElementById('encryptionLabel').textContent = 'Set Password';
    document.getElementById('encryptionBtn').textContent = 'Enable Encryption';
    document.getElementById('decryptSection').style.display = 'none';
  }
  renderAuditTrail();
  document.getElementById('settingsModal').classList.add('open');
}

function closeSettingsModal() {
  document.getElementById('settingsModal').classList.remove('open');
  document.getElementById('newPassword').value = '';
  document.getElementById('confirmPassword').value = '';
}

async function setEncryption() {
  const pwd = document.getElementById('newPassword').value.trim();
  const conf = document.getElementById('confirmPassword').value.trim();
  if (!pwd) { toast('Please enter a password.'); return; }
  if (pwd !== conf) { toast('Passwords do not match.'); return; }
  db.encrypted = true;
  currentPassword = pwd;
  await saveData();
  closeSettingsModal();
  toast('Encryption enabled. Your database is now encrypted.');
  location.reload();
}

async function removeEncryption() {
  if (!await confirmDialog('Remove encryption? Your password will no longer be required.', { title: 'Remove encryption', okText: 'Remove', danger: true })) return;
  db.encrypted = false;
  currentPassword = null;
  await saveData();
  closeSettingsModal();
  toast('Encryption removed.');
  location.reload();
}

function closePasswordModal() { document.getElementById('passwordModal').classList.remove('open'); }

async function handlePasswordSubmit() {
  const pwd = document.getElementById('passwordInput').value;
  if (!pwd) { toast('Please enter the password.'); return; }
  try {
    const file = await fileHandle.getFile();
    const text = await file.text();
    const encrypted = JSON.parse(text);
    const decrypted = await decryptData(encrypted, pwd);
    db = JSON.parse(decrypted);
    if (!db.auditTrail) db.auditTrail = [];
    db.firearms.forEach(f => { if (!f.tags) f.tags = []; });
    // Load images from IndexedDB (they are separate from JSON when encrypted too)
    imagesDb = await idbGetAll();
    currentPassword = pwd;
    document.getElementById('passwordModal').classList.remove('open');
    document.getElementById('passwordInput').value = '';
    onFileConnected();
  } catch (e) { toast('Incorrect password or decryption failed.'); }
}

// =====================================================
// BACKUPS
// =====================================================
function openBackupModal() {
  if (db.backups.length === 0) { toast('No backups available.'); return; }
  const list = document.getElementById('backupList');
  list.innerHTML = db.backups.map((b, i) => `
    <div class="backup-item" onclick="selectBackup(${i})">
      <span>${new Date(b.timestamp).toLocaleString()}</span>
      <span style="color: var(--text3); font-size: 0.8rem;">${b.firearms.length} firearms, ${b.ammo.length} ammo</span>
    </div>
  `).join('');
  document.getElementById('backupModal').classList.add('open');
}

function closeBackupModal() { document.getElementById('backupModal').classList.remove('open'); }

async function selectBackup(index) {
  if (!await confirmDialog('Restore this backup? Current data will be replaced.', { title: 'Restore backup', okText: 'Restore', danger: true })) return;
  const backup = db.backups[index];
  db.firearms = JSON.parse(JSON.stringify(backup.firearms));
  db.ammo = JSON.parse(JSON.stringify(backup.ammo));
  db.accessories = JSON.parse(JSON.stringify(backup.accessories || []));
  db.firearms.forEach(f => { if (!f.tags) f.tags = []; });
  addAuditEntry('edit', 'system', 'Backup Restore', 'Restored from backup dated ' + new Date(backup.timestamp).toLocaleString());
  await saveData();
  closeBackupModal();
  render();
  toast('Backup restored successfully.');
}

// =====================================================
// STATS
// =====================================================
function updateStats() {
  const active = db.firearms.filter(f => !f.status || f.status === 'Active');
  document.getElementById('statTotal').textContent = active.length;
  document.getElementById('statNFA').textContent = active.filter(f => f.isNFA).length;
  document.getElementById('statAmmo').textContent = db.ammo.reduce((s, a) => s + (parseInt(a.quantity) || 0), 0).toLocaleString();
  const fVal = db.firearms.reduce((s, f) => s + (parseFloat(f.price) || 0), 0);
  const aVal = db.accessories.reduce((s, a) => s + (parseFloat(a.price) || 0), 0);
  document.getElementById('statValue').textContent = money(fVal + aVal);
  updateCaliberFilter();
  updateTagFilter();
  document.getElementById('backupBtn').style.display = db.backups.length > 0 ? 'inline-block' : 'none';
  updateReminderBadge();
}

// =====================================================
// SMART REMINDERS
// =====================================================
function computeReminders() {
  const out = [];
  const active = db.firearms.filter(f => !f.status || f.status === 'Active');
  active.forEach(f => {
    const name = ((f.make || '') + ' ' + (f.model || '')).trim() || 'Firearm';
    // NFA tax stamp still pending
    if (f.isNFA && f.dateSubmitted && !f.dateApproved && f.stampStatus !== 'Approved' && f.stampStatus !== 'Denied') {
      const days = Math.round((Date.now() - new Date(f.dateSubmitted)) / 86400000);
      out.push({ sev: 'med', icon: '&#128196;', itemType: 'firearm', itemId: f.id,
        text: name + ' — tax stamp pending ' + days + ' day' + (days === 1 ? '' : 's') });
    }
    // Warranty expiring / expired
    if (f.warrantyExp) {
      const st = getWarrantyStatus(f.warrantyExp);
      if (st === 'expired') out.push({ sev: 'high', icon: '&#9888;', itemType: 'firearm', itemId: f.id, text: name + ' — warranty expired (' + fmtDate(f.warrantyExp) + ')' });
      else if (st === 'soon') out.push({ sev: 'med', icon: '&#9201;', itemType: 'firearm', itemId: f.id, text: name + ' — warranty expiring ' + fmtDate(f.warrantyExp) });
    }
  });
  // Low ammunition
  db.ammo.forEach(a => {
    if (isLowStock(a)) out.push({ sev: 'high', icon: '&#127919;', itemType: 'ammo', itemId: a.id,
      text: 'Low ammo: ' + ((a.caliber || '') + ' ' + (a.brand || '')).trim() + ' — ' + (a.quantity || 0) + ' left (alert at ' + a.lowStock + ')' });
  });
  const rank = { high: 0, med: 1, low: 2 };
  out.sort((x, y) => rank[x.sev] - rank[y.sev]);
  return out;
}

function updateReminderBadge() {
  const badge = document.getElementById('reminderBadge');
  if (!badge) return;
  const n = computeReminders().length;
  badge.textContent = n > 99 ? '99+' : n;
  badge.style.display = n > 0 ? 'flex' : 'none';
}

function openReminders() {
  const list = document.getElementById('remindersList');
  const rem = computeReminders();
  if (!rem.length) {
    list.innerHTML = '<div style="padding:24px;text-align:center;color:var(--text3);font-size:0.86rem;">&#127881; All clear — no reminders right now.</div>';
  } else {
    list.innerHTML = rem.map(r =>
      `<div class="reminder-item sev-${r.sev}" onclick="reminderGo('${r.itemType}','${r.itemId}')">
        <span class="reminder-icon">${r.icon}</span><span class="reminder-text">${esc(r.text)}</span>
        <span class="reminder-go">&#8250;</span></div>`).join('');
  }
  document.getElementById('remindersModal').classList.add('open');
}
function closeReminders() { document.getElementById('remindersModal').classList.remove('open'); }
function reminderGo(type, id) {
  closeReminders();
  if (type === 'firearm') { openDetail(id); }
  else if (type === 'ammo') { const t = document.querySelector('.tab[data-tab="ammo"]'); if (t) t.click(); }
}

// =====================================================
// SHARE LINKS (read-only inventory for e.g. insurance)
// =====================================================
function shareUrl(token) { return new URL('share.html?t=' + token, location.href).href; }

function openShareModal() {
  const r = document.getElementById('shareResult'); if (r) r.style.display = 'none';
  document.getElementById('shareModal').classList.add('open');
  renderSharesList();
}
function closeShareModal() { document.getElementById('shareModal').classList.remove('open'); }

async function buildShareSnapshot(opts) {
  const active = db.firearms.filter(f => !f.status || f.status === 'Active');
  const fVal = active.reduce((s, f) => s + (parseFloat(f.price) || 0), 0);
  const accVal = db.accessories.reduce((s, a) => s + (parseFloat(a.price) || 0), 0);
  const rounds = db.ammo.reduce((s, a) => s + (parseInt(a.quantity) || 0), 0);
  const firearms = [];
  for (const f of active) {
    let photo = null;
    if (opts.photos && f.images && f.images[0] && imagesDb[f.images[0]]) {
      try { photo = await compressImage(imagesDb[f.images[0]], 700, 0.6); }
      catch (e) { photo = imagesDb[f.images[0]]; }
    }
    firearms.push({
      make: f.make || '', model: f.model || '', serial: opts.serials ? (f.serial || '') : '',
      type: f.type || '', caliber: f.caliber || '', barrel: f.barrel || '', condition: f.condition || '',
      price: parseFloat(f.price) || 0, dateAcquired: f.dateAcquired || '',
      isNFA: !!f.isNFA, nfaType: f.nfaType || '', photo
    });
  }
  const accessories = db.accessories.map(a => ({ name: a.name || '', category: a.category || '', brand: a.brand || '', model: a.model || '', price: parseFloat(a.price) || 0 }));
  return {
    generatedAt: new Date().toISOString(), label: opts.label || '',
    totals: { firearms: active.length, value: fVal + accVal, accessories: db.accessories.length, rounds },
    includeSerials: opts.serials, firearms, accessories
  };
}

async function createShare() {
  const btn = document.getElementById('createShareBtn');
  btn.disabled = true; btn.textContent = 'Creating…';
  try {
    const opts = {
      label: document.getElementById('shareLabel').value.trim(),
      photos: document.getElementById('sharePhotos').checked,
      serials: document.getElementById('shareSerials').checked
    };
    const expDays = parseInt(document.getElementById('shareExpiry').value);
    const expires_at = expDays > 0 ? new Date(Date.now() + expDays * 86400000).toISOString() : null;
    const snapshot = await buildShareSnapshot(opts);
    const { data, error } = await window.sbClient.from('shares')
      .insert({ owner: CloudSync.uid, label: opts.label || null, snapshot, expires_at })
      .select('token').single();
    if (error) throw error;
    const url = shareUrl(data.token);
    const box = document.getElementById('shareResult');
    box.style.display = 'block';
    box.innerHTML = `<div class="share-result-box"><div style="font-weight:600;margin-bottom:6px;">&#10003; Share link created</div>
      <div class="share-url">${esc(url)}</div>
      <div style="margin-top:8px;"><button class="btn btn-small btn-primary" onclick="copyShareLink('${esc(url)}')">Copy link</button></div></div>`;
    document.getElementById('shareLabel').value = '';
    renderSharesList();
  } catch (e) {
    toast('Could not create share link: ' + (e.message || e), 'error');
  } finally { btn.disabled = false; btn.textContent = 'Create share link'; }
}

function copyShareLink(url) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(url).then(() => toast('Link copied to clipboard.', 'success'))
      .catch(() => toast('Copy failed — select and copy the link manually.', 'error'));
  } else { toast('Copy not supported — select the link manually.', 'info'); }
}

async function renderSharesList() {
  const list = document.getElementById('shareList');
  if (!list) return;
  list.innerHTML = '<div style="color:var(--text3);font-size:0.8rem;">Loading…</div>';
  const { data, error } = await window.sbClient.from('shares')
    .select('token,label,created_at,expires_at').eq('owner', CloudSync.uid).order('created_at', { ascending: false });
  if (error) { list.innerHTML = '<div style="color:var(--red);font-size:0.8rem;">Could not load shares.</div>'; return; }
  if (!data.length) { list.innerHTML = '<div style="color:var(--text3);font-size:0.8rem;">No active share links.</div>'; return; }
  const now = Date.now();
  list.innerHTML = data.map(s => {
    const url = shareUrl(s.token);
    const exp = s.expires_at ? (new Date(s.expires_at).getTime() < now ? 'Expired' : 'Expires ' + fmtDate(s.expires_at)) : 'No expiry';
    return `<div class="share-row"><div class="share-row-info">
      <div class="share-row-label">${esc(s.label || 'Untitled share')}</div>
      <div class="share-row-meta">${exp} &middot; created ${fmtDate(s.created_at)}</div>
      <div class="share-url">${esc(url)}</div></div>
      <button class="btn btn-small btn-outline" onclick="copyShareLink('${esc(url)}')">Copy</button>
      <button class="btn btn-small btn-danger" onclick="revokeShare('${s.token}')">Revoke</button></div>`;
  }).join('');
}

async function revokeShare(token) {
  if (!await confirmDialog('Revoke this share link? Anyone using it will immediately lose access.', { title: 'Revoke share link', okText: 'Revoke', danger: true })) return;
  const { error } = await window.sbClient.from('shares').delete().eq('token', token).eq('owner', CloudSync.uid);
  if (error) { toast('Could not revoke: ' + error.message, 'error'); return; }
  toast('Share link revoked.', 'success');
  renderSharesList();
}

function updateCaliberFilter() {
  const sel = document.getElementById('filterCaliber');
  const cur = sel.value;
  const cals = [...new Set(db.firearms.map(f => f.caliber).filter(Boolean))].sort();
  sel.innerHTML = '<option value="">All Calibers</option>';
  cals.forEach(c => { const o = document.createElement('option'); o.value = c; o.textContent = c; sel.appendChild(o); });
  sel.value = cur;
}

// =====================================================
// VIEW TOGGLE
// =====================================================
function setView(v) {
  currentView = v;
  document.getElementById('viewCards').classList.toggle('active', v === 'cards');
  document.getElementById('viewTable').classList.toggle('active', v === 'table');
  render();
}

// =====================================================
// DASHBOARD
// =====================================================
let _dashCharts = [];
function _destroyDashCharts() { _dashCharts.forEach(c => { try { c.destroy(); } catch (e) {} }); _dashCharts = []; }

let _dashRange = 90;
function setDashRange(n) { _dashRange = n; renderDashboard(); }
window.setDashRange = setDashRange;

function renderDashboard() {
  const container = document.getElementById('dashboardContainer');
  _destroyDashCharts();
  const active = db.firearms.filter(f => !f.status || f.status === 'Active');
  const totalFirearms = active.length;
  const fVal = active.reduce((s, f) => s + (parseFloat(f.price) || 0), 0);
  const accVal = db.accessories.reduce((s, a) => s + (parseFloat(a.price) || 0), 0);
  const totalVal = fVal + accVal;
  const totalAmmoRounds = db.ammo.reduce((s, a) => s + (parseInt(a.quantity) || 0), 0);
  const totalAmmoVal = db.ammo.reduce((s, a) => s + ((parseInt(a.quantity) || 0) * (parseFloat(a.pricePerRound) || 0)), 0);
  const totalInvested = totalVal + totalAmmoVal;
  const fmt$ = n => money(n);
  const note = m => '<div style="color:var(--text3);font-size:0.82rem;padding:8px;">' + m + '</div>';
  const barRow = (label, n, max, color) => '<div class="dash-bar-row"><span class="dash-bar-label">' + esc(label) +
    '</span><div class="dash-bar-track"><div class="dash-bar-fill" style="width:' + (n / max * 100).toFixed(1) + '%;background:' + color + ';"></div></div><span class="dash-bar-val">' + n + '</span></div>';

  // Realized profit/loss from disposed firearms
  let realizedPL = 0, soldCount = 0;
  db.firearms.forEach(f => { const pl = getProfitLoss(f); if (pl !== null) { realizedPL += pl; soldCount++; } });

  // Breakdowns
  const types = {}; active.forEach(f => { const t = f.type || 'Other'; types[t] = (types[t] || 0) + 1; });
  const cals = {}; active.forEach(f => { if (f.caliber) cals[f.caliber] = (cals[f.caliber] || 0) + 1; });
  const calEntries = Object.entries(cals).sort((a, b) => b[1] - a[1]).slice(0, 8);
  const makes = {}; active.forEach(f => { const m = (f.make || 'Unknown').trim() || 'Unknown'; makes[m] = (makes[m] || 0) + 1; });
  const makeEntries = Object.entries(makes).sort((a, b) => b[1] - a[1]).slice(0, 8);

  // NFA
  const nfaItems = active.filter(f => f.isNFA);
  const nfaCount = nfaItems.length;
  const nfaApproved = nfaItems.filter(f => f.stampStatus === 'Approved').length;
  const nfaPending = nfaItems.filter(f => f.stampStatus === 'Pending' || f.stampStatus === 'Submitted').length;
  const nfaDenied = nfaItems.filter(f => f.stampStatus === 'Denied').length;
  const pendingNFA = nfaItems.filter(f => f.dateSubmitted && !f.dateApproved);
  const avgWait = pendingNFA.length ? Math.round(pendingNFA.reduce((s, f) => s + (Date.now() - new Date(f.dateSubmitted)) / 86400000, 0) / pendingNFA.length) : null;

  // Condition / recent / tags
  const conditions = {}; active.forEach(f => { const c = f.condition || 'Unknown'; conditions[c] = (conditions[c] || 0) + 1; });
  let condList = Object.entries(conditions).sort((a, b) => b[1] - a[1]).map(([c, n]) => '<div class="dash-list-item"><span class="label">' + esc(c) + '</span><span class="value">' + n + '</span></div>').join('');
  const recent = [...active].filter(f => f.dateAcquired).sort((a, b) => b.dateAcquired.localeCompare(a.dateAcquired)).slice(0, 5);
  let recentList = recent.map(f => '<div class="dash-list-item"><span class="label">' + esc((f.make || '') + ' ' + (f.model || '')) + '</span><span class="value">' + fmtDate(f.dateAcquired) + '</span></div>').join('');
  if (!recentList) recentList = note('No recent acquisitions.');
  const tagCounts = {}; active.forEach(f => { if (f.tags) f.tags.forEach(t => { tagCounts[t] = (tagCounts[t] || 0) + 1; }); });
  const topTags = Object.entries(tagCounts).sort((a, b) => b[1] - a[1]).slice(0, 10);
  let tagsList = topTags.map(([t, n]) => '<div class="dash-list-item"><span class="label"><span class="tag-pill">' + esc(t) + '</span></span><span class="value">' + n + '</span></div>').join('');
  if (!tagsList) tagsList = note('No tags assigned yet.');

  const thumbOf = f => (f && f.images && f.images[0]) ? (thumbCache[f.images[0]] || imagesDb[f.images[0]]) : null;

  // KPI cards
  const kpis = [
    { icon: '\u{1F6E1}\u{FE0F}', label: 'Active Firearms', value: totalFirearms, color: '#3b82f6' },
    { icon: '\u{1F4B0}', label: 'Collection Value', value: fmt$(totalVal), color: '#10b981' },
    { icon: '\u{1F4C8}', label: 'Total Invested', value: fmt$(totalInvested), color: '#8b5cf6' },
    { icon: '\u{1F3AF}', label: 'Total Rounds', value: totalAmmoRounds.toLocaleString(), color: '#f59e0b' },
    { icon: '\u{1F4C4}', label: 'NFA Items', value: nfaCount, color: '#06b6d4' },
    { icon: '\u{1F4B9}', label: soldCount ? (realizedPL >= 0 ? 'Realized Gain' : 'Realized Loss') : 'Realized P/L',
      value: (realizedPL < 0 ? '-' : '') + fmt$(Math.abs(realizedPL)), color: realizedPL >= 0 ? '#10b981' : '#ef4444' }
  ];
  const kpiRow = '<div class="dash-card dash-kpi-card"><div class="dash-kpis">' +
    kpis.map(k => '<div class="dash-kpi"><div class="dash-kpi-icon" style="background:' + k.color + '22;color:' + k.color + ';">' + k.icon +
      '</div><div class="dash-kpi-text"><div class="dash-kpi-value">' + k.value + '</div><div class="dash-kpi-label">' + k.label + '</div></div></div>').join('') +
    '</div></div>';

  // Alerts (reminders) card
  const reminders = (typeof computeReminders === 'function') ? computeReminders() : [];
  const alertsCard = reminders.length ? '<div class="dash-card dash-wide"><h3>⚠️ Needs attention (' + reminders.length + ')</h3><div class="dash-alerts">' +
    reminders.slice(0, 6).map(r => '<div class="dash-alert sev-' + r.sev + '" onclick="reminderGo(\'' + r.itemType + '\',\'' + r.itemId + '\')"><span class="dash-alert-ico">' + r.icon + '</span><span>' + esc(r.text) + '</span></div>').join('') +
    '</div></div>' : '';

  // Highlights
  let highlightsCard = '';
  if (active.length) {
    const mv = active.reduce((best, f) => getTotalInvestment(f.id) > getTotalInvestment(best.id) ? f : best, active[0]);
    const nw = recent[0];
    const hl = (f, label, sub) => {
      const t = thumbOf(f);
      const img = t ? '<img class="dh-img" src="' + t + '">' : '<div class="dh-img dh-ph">✦</div>';
      return '<div class="dash-highlight" onclick="openDetail(\'' + f.id + '\')">' + img + '<div class="dh-text"><div class="dh-label">' + label +
        '</div><div class="dh-title">' + esc((f.make || '') + ' ' + (f.model || '')) + '</div><div class="dh-sub">' + sub + '</div></div></div>';
    };
    highlightsCard = '<div class="dash-card"><h3>Highlights</h3>' + hl(mv, 'Most valuable', fmt$(getTotalInvestment(mv.id))) + (nw ? hl(nw, 'Newest acquisition', fmtDate(nw.dateAcquired)) : '') + '</div>';
  }

  // Value-over-time with range toggle
  const hist = (db.valueHistory || []).slice(-_dashRange);
  const hasValueChart = hist.length >= 2;
  const rangeBtns = '<span class="dash-range">' + [[30, '30d'], [90, '90d'], [365, '1y'], [100000, 'All']].map(r =>
    '<button class="' + (_dashRange === r[0] ? 'active' : '') + '" onclick="setDashRange(' + r[0] + ')">' + r[1] + '</button>').join('') + '</span>';

  const hasC = !!window.Chart;
  const chartCard = (title, id, fallback) => '<div class="dash-card"><h3>' + title + '</h3>' +
    (hasC ? '<div class="dash-chart-sm"><canvas id="' + id + '"></canvas></div>' : '<div class="dash-bar-chart">' + (fallback || note('No data.')) + '</div>') + '</div>';
  const maxType = Math.max(...Object.values(types), 1);
  const typeFallback = Object.entries(types).sort((a, b) => b[1] - a[1]).map(([t, c]) => barRow(t, c, maxType, 'var(--accent)')).join('');
  const maxCal = Math.max(...calEntries.map(e => e[1]), 1);
  const calFallback = calEntries.map(([c, n]) => barRow(c, n, maxCal, 'var(--green)')).join('');
  const maxMake = Math.max(...makeEntries.map(e => e[1]), 1);
  const mfgFallback = makeEntries.map(([m, n]) => barRow(m, n, maxMake, '#8b5cf6')).join('');

  const nfaCard = '<div class="dash-card"><h3>NFA Items (' + nfaItems.length + ')</h3>' +
    '<div class="dash-nfa-status">' +
      '<div class="dash-nfa-pill" style="background:var(--green-bg);color:var(--green);"><span class="si">✓</span>Approved: ' + nfaApproved + '</div>' +
      '<div class="dash-nfa-pill" style="background:var(--yellow-bg);color:#8a6d00;"><span class="si">⧖</span>Pending: ' + nfaPending + '</div>' +
      (nfaDenied > 0 ? '<div class="dash-nfa-pill" style="background:var(--red-light);color:var(--red);"><span class="si">✕</span>Denied: ' + nfaDenied + '</div>' : '') +
    '</div>' +
    (avgWait !== null ? '<div class="dash-list-item" style="margin-top:12px;"><span class="label">Avg pending wait</span><span class="value">' + avgWait + ' days</span></div>' : '') +
    (pendingNFA.length ? '<div style="margin-top:10px;"><h4 style="font-size:0.74rem;color:var(--text3);margin-bottom:6px;">PENDING</h4>' +
      pendingNFA.map(f => { const days = Math.round((Date.now() - new Date(f.dateSubmitted)) / 86400000); return '<div class="dash-list-item"><span class="label">' + esc((f.make || '') + ' ' + (f.model || '')) + '</span><span class="value">' + days + ' days</span></div>'; }).join('') + '</div>' : '') +
    '</div>';

  const ammoCard = '<div class="dash-card"><h3>Ammunition</h3><div class="dash-big-num">' + totalAmmoRounds.toLocaleString() + '</div><div class="dash-sub">Total Rounds</div>' +
    '<div style="margin-top:10px;" class="dash-list-item"><span class="label">Ammo Value</span><span class="value">$' + totalAmmoVal.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + '</span></div>' +
    '<div style="margin-top:4px;" class="dash-list-item"><span class="label">Ammo Types</span><span class="value">' + db.ammo.length + '</span></div></div>';

  container.innerHTML = alertsCard + kpiRow +
    '<div class="dash-card dash-wide"><h3 class="dash-h3-flex"><span>Collection Value Over Time</span>' + rangeBtns + '</h3>' +
      (hasValueChart ? '<div class="dash-chart-wrap"><canvas id="valueChartCanvas"></canvas></div>' : note('Value history builds over time — check back after a few days of use.')) + '</div>' +
    highlightsCard +
    chartCard('Firearms by Type', 'typeChartCanvas', typeFallback) +
    chartCard('Top Calibers', 'calChartCanvas', calFallback) +
    chartCard('Top Manufacturers', 'mfgChartCanvas', mfgFallback) +
    nfaCard + ammoCard +
    '<div class="dash-card"><h3>Condition</h3><div class="dash-list">' + (condList || note('No data.')) + '</div></div>' +
    '<div class="dash-card"><h3>Recent Acquisitions</h3><div class="dash-list">' + recentList + '</div></div>' +
    '<div class="dash-card"><h3>Tags</h3><div class="dash-list">' + tagsList + '</div></div>';

  // ---- Chart.js instances ----
  if (hasC) {
    const css = getComputedStyle(document.body);
    const cv = (k, d) => (css.getPropertyValue(k) || d).trim();
    const accent = cv('--accent', '#1a3a5c'), gridc = cv('--border-light', '#e8eaed'), textc = cv('--text2', '#5f6368');
    // Consistent chart styling across every canvas; Inter to match the UI.
    Chart.defaults.font.family = "'Inter','Segoe UI',system-ui,sans-serif";
    Chart.defaults.color = textc;
    // Categorical palette capped at 7 hues (more than that adds clutter).
    const palette = ['#3b82f6', '#10b981', '#8b5cf6', '#f59e0b', '#ef4444', '#06b6d4', '#ec4899'];
    const mk = (id, cfg) => { const c = document.getElementById(id); if (!c) return; try { _dashCharts.push(new Chart(c, cfg)); } catch (e) { console.warn('chart ' + id, e); } };
    // Declutter: no category-axis gridlines, no axis borders, faint value grid.
    const barOpts = { indexAxis: 'y', responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } },
      scales: { x: { ticks: { color: textc, precision: 0 }, grid: { color: gridc }, border: { display: false } },
                y: { ticks: { color: textc }, grid: { display: false }, border: { display: false } } } };
    const typeLabels = Object.keys(types), typeData = Object.values(types);
    if (typeData.length) mk('typeChartCanvas', { type: 'doughnut', data: { labels: typeLabels, datasets: [{ data: typeData, backgroundColor: palette, borderWidth: 0 }] },
      options: { responsive: true, maintainAspectRatio: false, cutout: '60%', plugins: { legend: { position: 'bottom', labels: { color: textc, boxWidth: 12, padding: 8, font: { size: 11 } } } } } });
    if (calEntries.length) mk('calChartCanvas', { type: 'bar', data: { labels: calEntries.map(e => e[0]), datasets: [{ data: calEntries.map(e => e[1]), backgroundColor: '#10b981', borderRadius: 4 }] }, options: barOpts });
    if (makeEntries.length) mk('mfgChartCanvas', { type: 'bar', data: { labels: makeEntries.map(e => e[0]), datasets: [{ data: makeEntries.map(e => e[1]), backgroundColor: '#8b5cf6', borderRadius: 4 }] }, options: barOpts });
    if (hasValueChart) mk('valueChartCanvas', { type: 'line', data: { labels: hist.map(h => h.date), datasets: [{ label: 'Value', data: hist.map(h => h.value), borderColor: accent, backgroundColor: accent + '22', fill: true, tension: 0.3, pointRadius: hist.length > 30 ? 0 : 3, borderWidth: 2 }] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => money(c.parsed.y) } } }, scales: { x: { grid: { display: false }, border: { display: false }, ticks: { color: textc, maxTicksLimit: 8 } }, y: { grid: { color: gridc }, border: { display: false }, ticks: { color: textc, callback: v => '$' + Number(v).toLocaleString() } } } } });
  }
}

// =====================================================
// FILTERING
// =====================================================
function getFilteredItems() {
  const search = document.getElementById('searchBox').value.toLowerCase();
  const tf = document.getElementById('filterType').value;
  const cf = document.getElementById('filterCaliber').value;
  const tagFilter = document.getElementById('filterTag').value;
  let items = db.firearms;

  if (currentTab === 'nfa') items = items.filter(f => f.isNFA);
  else if (currentTab === 'disposed') items = items.filter(f => f.status && f.status !== 'Active');
  else if (currentTab === 'all') items = items.filter(f => !f.status || f.status === 'Active');

  if (search) items = items.filter(f =>
    (f.make||'').toLowerCase().includes(search) || (f.model||'').toLowerCase().includes(search) ||
    (f.serial||'').toLowerCase().includes(search) || (f.caliber||'').toLowerCase().includes(search) ||
    (f.notes||'').replace(/<[^>]*>/g,'').toLowerCase().includes(search) || (f.nfaType||'').toLowerCase().includes(search) ||
    (f.tags||[]).some(t => t.toLowerCase().includes(search)));

  if (tf && currentTab !== 'ammo') items = items.filter(f => f.type === tf);
  if (cf && currentTab !== 'ammo') items = items.filter(f => f.caliber === cf);
  if (tagFilter) items = items.filter(f => f.tags && f.tags.includes(tagFilter));
  const condFilter = document.getElementById('filterCondition').value;
  if (condFilter) items = items.filter(f => f.condition === condFilter);

  if (sortCol && currentView === 'table') {
    items = [...items].sort((a, b) => {
      let va = a[sortCol]||'', vb = b[sortCol]||'';
      if (sortCol === 'price') { va = parseFloat(va)||0; vb = parseFloat(vb)||0; }
      else { va = String(va).toLowerCase(); vb = String(vb).toLowerCase(); }
      return va < vb ? (sortDir==='asc'?-1:1) : va > vb ? (sortDir==='asc'?1:-1) : 0;
    });
  }
  return items;
}

// =====================================================
// RENDER
// =====================================================
function render() {
  const grid = document.getElementById('cardGrid');
  const tc = document.getElementById('tableContainer');
  const empty = document.getElementById('emptyState');
  const dash = document.getElementById('dashboardContainer');
  const toolbar = document.getElementById('mainToolbar');

  updateContextualActions();
  updateBottomNav();
  updateFilterChips();

  // Show/hide toolbar based on tab
  // Show/hide card sort
  document.getElementById('cardSort').style.display = (currentView === 'cards' && ['all','nfa','disposed'].includes(currentTab)) ? 'inline-block' : 'none';

  if (currentTab === 'dashboard') {
    toolbar.style.display = 'none';
    grid.style.display = 'none';
    tc.style.display = 'none';
    empty.style.display = 'none';
    dash.style.display = 'grid';
    recordValueSnapshot();
    renderDashboard();
    return;
  } else {
    toolbar.style.display = 'flex';
    dash.style.display = 'none';
  }

  if (currentTab === 'ammo') { renderAmmoTab(); return; }
  if (currentTab === 'accessories') { renderAccessoriesTab(); return; }
  if (currentTab === 'wishlist') { renderWishlistTab(); return; }
  if (currentTab === 'dealers') { renderDealersTab(); return; }

  const items = getFilteredItems();
  if (db.firearms.length === 0) { grid.style.display='none'; tc.style.display='none'; empty.style.display='block'; return; }
  empty.style.display = 'none';

  if (items.length === 0) {
    grid.style.display='none'; tc.style.display='none';
    const t = currentView==='cards'?grid:tc;
    t.style.display = currentView==='cards'?'grid':'block';
    t.innerHTML = '<div class="empty-inline"><div class="icon">&#128269;</div><p>No items match your search or filters.</p><button class="btn btn-outline" onclick="clearAllFilters()">Clear filters</button></div>';
    return;
  }

  if (currentView === 'cards') { grid.style.display='grid'; tc.style.display='none'; renderCards(getCardSortedItems(items)); }
  else { grid.style.display='none'; tc.style.display='block'; renderTable(items); }
}

function renderAmmoTab() {
  document.getElementById('cardGrid').style.display = 'none';
  document.getElementById('tableContainer').style.display = 'block';
  document.getElementById('emptyState').style.display = 'none';
  const items = db.ammo;
  const totalRounds = items.reduce((s, a) => s + (parseInt(a.quantity) || 0), 0);
  const totalCost = items.reduce((s, a) => s + ((parseInt(a.quantity) || 0) * (parseFloat(a.pricePerRound) || 0)), 0);

  let h = `<div style="padding: 16px 24px; background: var(--bg2); border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; font-size: 0.86rem; font-weight: 600;">
    <span>Total Rounds: <span style="color: var(--accent);">${totalRounds.toLocaleString()}</span></span>
    <span>Total Value: <span style="color: var(--accent);">$${totalCost.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})}</span></span>
  </div>`;

  if (items.length === 0) {
    h += tabEmpty('🎯', 'No ammunition tracked yet', 'Log rounds on hand, calibers, and value as you stock up.', '<button class="btn btn-primary" onclick="openAddAmmoModal()">+ Add Ammo</button>');
    document.getElementById('tableContainer').innerHTML = h;
    return;
  }

  h += '<table class="data-table"><thead><tr><th onclick="sortTable(\'brand\')">Brand / Type</th><th onclick="sortTable(\'caliber\')">Caliber</th><th class="num" onclick="sortTable(\'quantity\')">Quantity</th><th onclick="sortTable(\'purchaseDate\')">Purchase Date</th><th class="num" onclick="sortTable(\'pricePerRound\')">Price/Round</th><th class="num">Total Cost</th><th onclick="sortTable(\'location\')">Location</th><th>Receipt</th><th></th></tr></thead><tbody>';

  items.forEach(a => {
    const tc2 = (parseInt(a.quantity) || 0) * (parseFloat(a.pricePerRound) || 0);
    const low = isLowStock(a);
    const hasReceipt = a.receipt ? true : false;
    h += `<tr style="cursor:pointer;" onclick="editAmmo('${a.id}')" class="${low?'low-stock':''}">
      <td>${esc(a.brand||'--')}</td>
      <td>${esc(a.caliber||'--')}</td>
      <td class="num">${(parseInt(a.quantity) || 0).toLocaleString()}${low?'<span class="low-stock-badge">LOW</span>':''}</td>
      <td>${fmtDate(a.purchaseDate)}</td>
      <td class="num">$${(parseFloat(a.pricePerRound) || 0).toFixed(2)}</td>
      <td class="num">$${tc2.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})}</td>
      <td>${esc(a.location||'--')}</td>
      <td>${hasReceipt ? '<button class="btn btn-small btn-outline" onclick="event.stopPropagation();viewReceiptInBrowser(\''+a.id+'\',\'ammo\')">View</button> <a href="'+a.receipt+'" download="'+(a.receiptName||'receipt')+'" onclick="event.stopPropagation();" class="btn btn-small btn-file" style="text-decoration:none;display:inline-block;">DL</a>' : '<span style="color:var(--text3);">--</span>'}</td>
      <td style="text-align:right;white-space:nowrap;">
        <button class="btn btn-small btn-outline" onclick="event.stopPropagation();quickAmmoAdjust('${a.id}',-1)" title="Subtract">-</button>
        <button class="btn btn-small btn-outline" onclick="event.stopPropagation();quickAmmoAdjust('${a.id}',1)" title="Add">+</button>
        <button class="btn btn-small btn-danger" onclick="event.stopPropagation(); deleteAmmo('${a.id}')">Del</button>
      </td>
    </tr>`;
  });

  h += '</tbody></table>';
  document.getElementById('tableContainer').innerHTML = h;
}

// Generate small thumbnails for card/table images once, then refresh the view.
let _buildingThumbs = false;
async function buildThumbnails() {
  if (_buildingThumbs || typeof compressImage !== 'function') return;
  _buildingThumbs = true;
  try {
    const ids = new Set();
    (db.firearms || []).forEach(f => (f.images || []).forEach(i => { if (i) ids.add(i); }));
    let made = false;
    for (const id of ids) {
      if (thumbCache[id] || !imagesDb[id]) continue;
      try { thumbCache[id] = await compressImage(imagesDb[id], 420, 0.62); made = true; }
      catch (e) { /* keep full image as fallback */ }
    }
    if (made && typeof render === 'function') render();
  } finally { _buildingThumbs = false; }
}
window.buildThumbnails = buildThumbnails;

// Skeleton cards shown during the initial boot / cloud pull so the grid reads
// as "loading structure" instead of blank; render() replaces them when ready.
function showGridSkeleton(n) {
  const grid = document.getElementById('cardGrid');
  if (!grid) return;
  grid.style.display = 'grid';
  grid.innerHTML = Array.from({ length: n || 8 }).map(() =>
    '<div class="skeleton-card" aria-hidden="true"><div class="sk-block sk-img"></div>' +
    '<div class="sk-body"><div class="sk-block sk-line mid"></div>' +
    '<div class="sk-block sk-line short"></div>' +
    '<div class="sk-block sk-line"></div></div></div>').join('');
}
window.showGridSkeleton = showGridSkeleton;

function renderCards(items) {
  document.getElementById('cardGrid').innerHTML = items.map(f => {
    const img0 = f.images && f.images.length > 0 ? (thumbCache[f.images[0]] || imagesDb[f.images[0]]) : null;
    const img = img0 ? `<img class="card-img" loading="lazy" src="${img0}" alt="${esc(f.make)} ${esc(f.model)}">` : `<div class="card-img-placeholder">&#10022;</div>`;
    const nfa = f.isNFA ? `<div class="nfa-badge">${esc(f.nfaType||'NFA')}</div>` : '';
    let stamp = '';
    if (f.isNFA && f.stampStatus) {
      const c = f.stampStatus==='Approved'?'stamp-approved':f.stampStatus==='Pending'?'stamp-pending':'stamp-submitted';
      stamp = `<div class="stamp-badge ${c}">${stampIcon(f.stampStatus)}${esc(f.stampStatus)}</div>`;
    }
    const p = f.price ? money(f.price) : '--';
    const disposed = (f.status && f.status !== 'Active') ? ' disposed' : '';
    const tags = (f.tags && f.tags.length > 0) ? `<div class="card-tags">${f.tags.map(t => `<span class="tag-pill">${esc(t)}</span>`).join('')}</div>` : '';
    const checked = bulkSelected.has(f.id) ? 'checked' : '';
    return `<div class="card${disposed}" onclick="openDetail('${f.id}')"><input type="checkbox" class="card-checkbox" ${checked} onclick="toggleBulkSelect('${f.id}',event)">${img}${nfa}${stamp}<div class="card-body">
      <div class="card-title">${esc(f.make||'')} ${esc(f.model||'')}</div>
      <div class="card-subtitle">${esc(f.type||'')} &middot; ${esc(f.caliber||'')}</div>
      <div class="card-details">
        <div class="card-detail"><label>Serial</label><span>${esc(f.serial||'--')}</span></div>
        <div class="card-detail"><label>Barrel</label><span>${esc(f.barrel||'--')}</span></div>
        <div class="card-detail"><label>Condition</label><span>${esc(f.condition||'--')}</span></div>
        <div class="card-detail"><label>Value</label><span>${p}</span></div>
      </div>${tags}</div></div>`;
  }).join('');
}

function renderTable(items) {
  const cols = [{key:'_cb',label:'',sortable:false},{key:'_img',label:'',sortable:false},{key:'make',label:'Make'},{key:'model',label:'Model'},{key:'serial',label:'Serial #'},{key:'caliber',label:'Caliber'},{key:'type',label:'Type'},{key:'barrel',label:'Barrel'},{key:'condition',label:'Condition'},{key:'price',label:'Price',num:true},{key:'dateAcquired',label:'Acquired'},{key:'status',label:'Status'},{key:'_nfa',label:'NFA',sortable:false},{key:'_tags',label:'Tags',sortable:false}];
  const arrow = k => sortCol!==k ? '' : `<span class="sort-arrow">${sortDir==='asc'?'&#9650;':'&#9660;'}</span>`;
  let h = '<table class="data-table"><thead><tr>';
  cols.forEach(c => { const s=c.sortable!==false; h+=`<th class="${c.num?'num':''}" ${s?`onclick="sortTable('${c.key}')"`:''}style="${s?'':'cursor:default'}">${c.label}${s?arrow(c.key):''}</th>`; });
  h += '</tr></thead><tbody>';

  items.forEach(f => {
    const tsrc = f.images && f.images.length > 0 ? (thumbCache[f.images[0]] || imagesDb[f.images[0]]) : null;
    const im = tsrc?`<img class="thumb" loading="lazy" src="${tsrc}">` : `<span class="thumb-placeholder">&#10022;</span>`;
    const pr = f.price?money(f.price):'--';
    let nfa='';
    if(f.isNFA){nfa=`<span class="nfa-tag">${esc(f.nfaType||'NFA')}</span>`;if(f.stampStatus){const c=f.stampStatus==='Approved'?'approved':f.stampStatus==='Pending'?'pending':'submitted';nfa+=` <span class="stamp-tag ${c}">${stampIcon(f.stampStatus)}${esc(f.stampStatus)}</span>`;}}
    const status = f.status && f.status !== 'Active' ? `<span class="nfa-tag disposed-tag">${esc(f.status)}</span>` : '';
    const pl = getProfitLoss(f);
    const plStr = pl !== null ? ` <span class="${pl>=0?'profit':'loss'}">${money(Math.abs(pl))} ${pl>=0?'+':'-'}</span>` : '';
    const tags = (f.tags && f.tags.length > 0) ? f.tags.map(t => `<span class="tag-pill">${esc(t)}</span>`).join(' ') : '';
    h+=`<tr onclick="openDetail('${f.id}')" style="cursor:pointer"><td><input type="checkbox" class="card-checkbox table-cb" ${bulkSelected.has(f.id)?'checked':''} onclick="toggleBulkSelect('${f.id}',event)"></td><td>${im}</td><td>${esc(f.make||'--')}</td><td>${esc(f.model||'--')}</td><td class="mono-id">${esc(f.serial||'--')}</td><td>${esc(f.caliber||'--')}</td><td>${esc(f.type||'--')}</td><td>${esc(f.barrel||'--')}</td><td>${esc(f.condition||'--')}</td><td class="num">${pr}</td><td>${fmtDate(f.dateAcquired)}</td><td>${status}${plStr}</td><td>${nfa}</td><td>${tags}</td></tr>`;
  });

  h += '</tbody></table>';
  document.getElementById('tableContainer').innerHTML = h;
}

function sortTable(key) { if(sortCol===key) sortDir=sortDir==='asc'?'desc':'asc'; else{sortCol=key;sortDir='asc';} saveSortPreference(); render(); }
function esc(s) { const d=document.createElement('div'); d.textContent=s; return d.innerHTML; }
function escAttr(s) { return esc(s).replace(/"/g, '&quot;'); } // safe inside double-quoted attributes
// Read a rich-text (.rte-content) editor's HTML, treating an empty editor as ''.
function rteValue(id) { const v = (document.getElementById(id).innerHTML || '').trim(); return v === '<br>' ? '' : v; }
// Render stored rich-text for display (skips the empty-<br> sentinel).
function rteShow(html) { return (html && html !== '<br>') ? html : ''; }
// Consistent friendly empty state for a tab (icon, title, optional sub + action button).
function tabEmpty(icon, title, sub, actionHtml) {
  return '<div class="empty-inline"><div class="icon">' + icon + '</div><h3>' + esc(title) + '</h3>' +
    (sub ? '<p>' + esc(sub) + '</p>' : '') + (actionHtml || '') + '</div>';
}
function fmtDate(d) { if(!d) return '--'; const p=d.split('-'); if(p.length!==3) return d; return p[1]+'/'+p[2]+'/'+p[0]; }
// Currency: always two decimals, e.g. money(1088.3) -> "$1,088.30".
function money(n) { return '$' + (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
// Distinct status glyph (check / hourglass / partial / cross) so NFA stamp
// state is conveyed by shape, not colour alone (WCAG 1.4.1 "use of colour").
function stampIcon(s) { const m = { Approved: '✓', Pending: '⧖', Submitted: '◔', Denied: '✕' }; return m[s] ? ('<span class="si">' + m[s] + '</span>') : ''; }
// Normalize a user-entered URL for use in href: only allow http(s)/mailto;
// schemeless input gets https:// prepended; anything else (e.g. javascript:) is neutralized.
function safeHref(u) {
  const s = (u == null ? '' : String(u)).trim();
  if (!s) return '#';
  if (/^(https?:|mailto:)/i.test(s)) return s;
  return 'https://' + s.replace(/^\/+/, '');
}

// ---- Styled in-app dialogs (replace native confirm()/prompt()) ----------
// Returns a Promise: confirmDialog -> boolean; promptDialog -> string|null.
function _appDialog(o) {
  return new Promise((resolve) => {
    const ov = document.createElement('div');
    ov.className = 'modal-overlay app-dialog open';
    const okClass = o.danger ? 'btn-danger' : 'btn-primary';
    ov.innerHTML = '<div class="modal" style="max-width:430px;">'
      + '<div class="modal-header"><h2>' + esc(o.title || 'Please confirm') + '</h2></div>'
      + '<div class="modal-body"><p style="margin:0;line-height:1.5;color:var(--text);">' + esc(o.message || '') + '</p>'
      + (o.input ? '<input type="text" id="_dlgInput" class="dlg-input" value="' + escAttr(o.def || '') + '">' : '')
      + '</div><div class="modal-footer">'
      + (o.cancel === false ? '' : '<button class="btn btn-outline" data-dlg="cancel">' + esc(o.cancelText || 'Cancel') + '</button>')
      + '<button class="btn ' + okClass + '" data-dlg="ok">' + esc(o.okText || 'OK') + '</button>'
      + '</div></div>';
    document.body.appendChild(ov);
    const input = ov.querySelector('#_dlgInput');
    const fail = o.input ? null : false;
    const finish = (val) => { document.removeEventListener('keydown', onKey, true); ov.remove(); resolve(val); };
    const ok = () => finish(o.input ? (input ? input.value.trim() : '') : true);
    ov.querySelector('[data-dlg="ok"]').addEventListener('click', ok);
    const cancelBtn = ov.querySelector('[data-dlg="cancel"]');
    if (cancelBtn) cancelBtn.addEventListener('click', () => finish(fail));
    ov.addEventListener('click', (e) => { if (e.target === ov) finish(fail); });
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(fail); }
      else if (e.key === 'Enter' && (!o.input || document.activeElement === input)) { e.preventDefault(); e.stopPropagation(); ok(); }
    }
    document.addEventListener('keydown', onKey, true);
    setTimeout(() => { (input || ov.querySelector('[data-dlg="ok"]')).focus(); if (input) input.select(); }, 20);
  });
}
function confirmDialog(message, opts) { opts = opts || {}; return _appDialog({ message, title: opts.title || 'Please confirm', okText: opts.okText || 'Confirm', cancelText: opts.cancelText, danger: opts.danger }); }
function promptDialog(message, def, opts) { opts = opts || {}; return _appDialog({ message, def: def || '', input: true, title: opts.title || '', okText: opts.okText || 'OK' }); }

// Rich text editor
function rteCmd(cmd, val) { document.execCommand(cmd, false, val||null); }
async function rteLink() {
  // Save the editor selection — focusing the dialog input would otherwise lose it.
  const sel = window.getSelection();
  const range = (sel && sel.rangeCount) ? sel.getRangeAt(0).cloneRange() : null;
  const url = await promptDialog('Enter the URL to link to:', 'https://', { title: 'Insert link', okText: 'Insert' });
  if (!url) return;
  if (range && sel) { sel.removeAllRanges(); sel.addRange(range); }
  document.execCommand('createLink', false, url);
}

// =====================================================
// TABS
// =====================================================
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    currentTab = tab.dataset.tab;
    sortCol = null;
    render();
  });
});

document.getElementById('searchBox').addEventListener('input', render);
document.getElementById('filterType').addEventListener('change', render);
document.getElementById('filterCaliber').addEventListener('change', render);
document.getElementById('filterTag').addEventListener('change', render);
document.getElementById('filterCondition').addEventListener('change', render);

// =====================================================
// FIREARM MODAL
// =====================================================
function openAddModal() {
  editingId = null;
  document.getElementById('modalTitle').textContent = 'Add Firearm';
  document.getElementById('saveBtn').textContent = 'Save Firearm';
  clearForm();
  populateDispDealerPicker();
  document.getElementById('formModal').classList.add('open');
}

function openEditModal(id) {
  const f = db.firearms.find(x => x.id === id);
  if (!f) return;
  editingId = id;
  document.getElementById('modalTitle').textContent = 'Edit Firearm';
  document.getElementById('saveBtn').textContent = 'Update Firearm';
  populateForm(f);
  populateDispDealerPicker();
  document.getElementById('formModal').classList.add('open');
}

// Fill the disposition "FFL Dealer" picker from saved dealers (preferred first, then A-Z).
function populateDispDealerPicker() {
  const sel = document.getElementById('fDispDealerPick');
  if (!sel) return;
  const dealers = [...(db.dealers || [])].sort((a, b) =>
    ((b.favorite ? 1 : 0) - (a.favorite ? 1 : 0)) || (a.name || '').localeCompare(b.name || ''));
  let opts = '<option value="">— Pick a saved dealer —</option>';
  dealers.forEach(d => {
    const label = (d.favorite ? '★ ' : '') + (d.name || 'Unnamed') + (d.address ? ' — ' + d.address.split(',')[0] : '');
    opts += '<option value="' + escAttr(d.id) + '">' + esc(label) + '</option>';
  });
  sel.innerHTML = opts;
  sel.value = '';
}

// Picking a dealer fills the free-text FFL Dealer field (with FFL # when known).
function pickDispDealer() {
  const sel = document.getElementById('fDispDealerPick');
  const d = (db.dealers || []).find(x => x.id === sel.value);
  if (d) document.getElementById('fDispFFL').value = d.name + (d.ffl ? ' (FFL ' + d.ffl + ')' : '');
  sel.value = '';
}

function closeModal() {
  document.getElementById('formModal').classList.remove('open');
  editingId=null; tempImages=[]; tempTags=[]; tempStampPdf=null; tempStampPdfName=null;
  hideTagSuggestions();
}

function clearForm() {
  ['fMake','fModel','fSerial','fCaliber','fBarrel','fDateAcquired','fPrice','fDateSubmitted','fDateApproved','fDispDate','fDispBuyer','fDispPrice','fDispFFL'].forEach(id => document.getElementById(id).value='');
  document.getElementById('fNotes').innerHTML='';
  document.getElementById('fDispNotes').innerHTML='';
  document.getElementById('fType').value='Rifle';
  document.getElementById('fCondition').value='New';
  document.getElementById('fStatus').value='Active';
  document.getElementById('fIsNFA').checked=false;
  document.getElementById('fNFAType').value='SBR';
  document.getElementById('fFormType').value='Form 1';
  document.getElementById('fStampStatus').value='Pending';
  document.getElementById('fRegType').value='Individual';
  toggleNFAFields();
  toggleDispositionFields();
  tempImages=[];
  tempDocs=[]; renderDocList();
  tempTags=[];
  tempStampPdf=null;
  tempStampPdfName=null;
  document.getElementById('imgGallery').innerHTML='';
  resetImgUpload();
  resetStampUpload();
  tempReceipts.f = null; tempReceipts.fName = null;
  resetReceiptUpload('f');
  renderTagsInput();
  document.getElementById('tagInput').value = '';
  document.getElementById('fRoundCount').value = '';
  document.getElementById('fWarrantyExp').value = '';
  tempCustomFields = [];
  renderCustomFields();
}

function populateForm(f) {
  document.getElementById('fMake').value=f.make||'';
  document.getElementById('fModel').value=f.model||'';
  document.getElementById('fSerial').value=f.serial||'';
  document.getElementById('fCaliber').value=f.caliber||'';
  document.getElementById('fType').value=f.type||'Rifle';
  document.getElementById('fBarrel').value=f.barrel||'';
  document.getElementById('fDateAcquired').value=f.dateAcquired||'';
  document.getElementById('fPrice').value=f.price||'';
  document.getElementById('fCondition').value=f.condition||'New';
  document.getElementById('fStatus').value=f.status||'Active';
  document.getElementById('fNotes').innerHTML=f.notes||'';
  document.getElementById('fIsNFA').checked=!!f.isNFA;

  if(f.isNFA){
    document.getElementById('fNFAType').value=f.nfaType||'SBR';
    document.getElementById('fFormType').value=f.formType||'Form 1';
    document.getElementById('fDateSubmitted').value=f.dateSubmitted||'';
    document.getElementById('fDateApproved').value=f.dateApproved||'';
    document.getElementById('fStampStatus').value=f.stampStatus||'Pending';
    document.getElementById('fRegType').value=f.regType||'Individual';
  }
  toggleNFAFields();

  if(f.status && f.status !== 'Active') {
    document.getElementById('fDispDate').value=f.dispDate||'';
    document.getElementById('fDispBuyer').value=f.dispBuyer||'';
    document.getElementById('fDispPrice').value=f.dispPrice||'';
    document.getElementById('fDispFFL').value=f.dispFFL||'';
    document.getElementById('fDispNotes').innerHTML=f.dispNotes||'';
  }
  toggleDispositionFields();

  tempImages = f.images ? [...f.images] : [];
  tempDocs = f.documents ? f.documents.map(d => ({ id: d.id, name: d.name, type: d.type, data: d.data })) : [];
  renderDocList();
  tempTags = f.tags ? [...f.tags] : [];
  document.getElementById('fRoundCount').value = f.roundCount || '';
  document.getElementById('fWarrantyExp').value = f.warrantyExp || '';
  tempCustomFields = f.customFields ? JSON.parse(JSON.stringify(f.customFields)) : [];
  renderCustomFields();
  tempStampPdf=f.stampPdf||null;
  tempStampPdfName=f.stampPdfName||null;

  renderImageGallery();
  renderTagsInput();
  const sa=document.getElementById('stampUploadArea');
  if(f.stampPdf) sa.innerHTML=`<span style="font-size:1.5rem;">&#128196;</span><span class="upload-text" style="color:var(--text);font-weight:600;">${esc(f.stampPdfName||'tax_stamp.pdf')}</span><button class="remove-img" onclick="event.stopPropagation();removeStampPdf()">&times;</button>`;
  else resetStampUpload();

  tempReceipts.f = f.receipt || null;
  tempReceipts.fName = f.receiptName || null;
  showReceiptInUploadArea('f', f.receipt, f.receiptName);
}

function toggleNFAFields() { document.getElementById('nfaFields').style.display=document.getElementById('fIsNFA').checked?'block':'none'; }

function toggleDispositionFields() {
  const status = document.getElementById('fStatus').value;
  document.getElementById('dispositionFields').style.display = (status && status !== 'Active') ? 'block' : 'none';
}

document.getElementById('fStatus').addEventListener('change', toggleDispositionFields);

async function saveFirearm() {
  const make=document.getElementById('fMake').value.trim();
  const model=document.getElementById('fModel').value.trim();
  if(!make&&!model){toast('Please enter at least a Make or Model.');return;}

  const isNFA=document.getElementById('fIsNFA').checked;
  const status = document.getElementById('fStatus').value;
  const oldData = editingId ? db.firearms.find(f => f.id === editingId) : null;

  const data = {
    id:editingId||generateId(),
    make, model,
    serial:document.getElementById('fSerial').value.trim(),
    caliber:document.getElementById('fCaliber').value.trim(),
    type:document.getElementById('fType').value,
    barrel:document.getElementById('fBarrel').value.trim(),
    dateAcquired:document.getElementById('fDateAcquired').value,
    price:document.getElementById('fPrice').value,
    condition:document.getElementById('fCondition').value,
    notes:document.getElementById('fNotes').innerHTML.trim(),
    images: tempImages,
    tags: tempTags,
    isNFA,
    nfaType:isNFA?document.getElementById('fNFAType').value:null,
    formType:isNFA?document.getElementById('fFormType').value:null,
    dateSubmitted:isNFA?document.getElementById('fDateSubmitted').value:null,
    dateApproved:isNFA?document.getElementById('fDateApproved').value:null,
    stampStatus:isNFA?document.getElementById('fStampStatus').value:null,
    regType:isNFA?document.getElementById('fRegType').value:null,
    stampPdf:isNFA?tempStampPdf:null,
    stampPdfName:isNFA?tempStampPdfName:null,
    status: status,
    dispDate: status !== 'Active' ? document.getElementById('fDispDate').value : null,
    dispBuyer: status !== 'Active' ? document.getElementById('fDispBuyer').value.trim() : null,
    dispPrice: status !== 'Active' ? document.getElementById('fDispPrice').value : null,
    dispFFL: status !== 'Active' ? document.getElementById('fDispFFL').value.trim() : null,
    dispNotes: status !== 'Active' ? rteValue('fDispNotes') : null,
    maintenanceLog: editingId ? (oldData?.maintenanceLog || []) : [],
    receipt: tempReceipts.f,
    receiptName: tempReceipts.fName,
    documents: tempDocs.map(d => ({ id: d.id, name: d.name, type: d.type, data: d.data })),
    roundCount: parseInt(document.getElementById('fRoundCount').value) || 0,
    warrantyExp: document.getElementById('fWarrantyExp').value || null,
    customFields: tempCustomFields.filter(cf => cf.name && cf.value)
  };

  // Audit trail
  const itemName = (make + ' ' + model).trim();
  if (editingId) {
    // Detect changed fields
    const changes = [];
    if (oldData) {
      ['make','model','serial','caliber','type','barrel','price','condition','status'].forEach(k => {
        if (String(data[k]||'') !== String(oldData[k]||'')) changes.push(k);
      });
    }
    addAuditEntry('edit', 'firearm', itemName, changes.length > 0 ? 'Changed: ' + changes.join(', ') : 'Updated');
    const i=db.firearms.findIndex(f=>f.id===editingId);
    if(i>-1) db.firearms[i]=data;
  } else {
    addAuditEntry('create', 'firearm', itemName, '');
    db.firearms.push(data);
  }

  await saveData();
  render();
  closeModal();
}

// =====================================================
// IMAGE HANDLING
// =====================================================
function handleImageUpload(e) {
  const files = e.target.files;
  if(!files) return;
  for(let i = 0; i < files.length; i++) {
    const f = files[i];
    const r = new FileReader();
    r.onload = async (ev) => {
      const id = generateId();
      // Compress image to max 1600px width, 80% JPEG quality
      const compressed = await compressImage(ev.target.result, 1600, 0.80);
      imagesDb[id] = compressed;
      await idbPut(id, compressed);
      tempImages.push(id);
      renderImageGallery();
    };
    r.readAsDataURL(f);
  }
  e.target.value = '';
}

function renderImageGallery() {
  const gal = document.getElementById('imgGallery');
  gal.innerHTML = tempImages.map((imgId, idx) => {
    const src = imagesDb[imgId];
    if (!src) return '';
    return `<div style="position:relative;width:60px;height:60px;">
      <img src="${src}" class="img-thumbnail ${idx===0?'active':''}" onclick="currentImageIndex=${idx}; renderImageGallery()">
      <button class="remove-thumbnail" style="display:flex;" onclick="event.stopPropagation(); removeImage(${idx})">&#215;</button>
      <button style="position:absolute;bottom:0;left:0;background:var(--accent);color:#fff;border:none;font-size:0.55rem;padding:1px 4px;border-radius:2px;cursor:pointer;" onclick="event.stopPropagation();openCropModal('${imgId}')">Edit</button>
    </div>`;
  }).join('');
}

function removeImage(idx) { tempImages.splice(idx, 1); currentImageIndex = 0; renderImageGallery(); }
function resetImgUpload() { document.getElementById('imgUploadArea').innerHTML='<span class="upload-text">Click to upload images (or drag &amp; drop)</span>'; }

function handleStampUpload(e) {
  const f=e.target.files[0]; if(!f) return;
  const r=new FileReader();
  r.onload=(ev)=>{
    tempStampPdf=ev.target.result; tempStampPdfName=f.name;
    document.getElementById('stampUploadArea').innerHTML=`<span style="font-size:1.5rem;">&#128196;</span><span class="upload-text" style="color:var(--text);font-weight:600;">${esc(f.name)}</span><button class="remove-img" onclick="event.stopPropagation();removeStampPdf()">&times;</button>`;
  };
  r.readAsDataURL(f); e.target.value='';
}

function removeStampPdf() { tempStampPdf=null; tempStampPdfName=null; resetStampUpload(); }
function resetStampUpload() { document.getElementById('stampUploadArea').innerHTML='<span class="upload-text">Click to upload approved tax stamp PDF</span>'; }

function handleReceiptUpload(e, prefix) {
  const f = e.target.files[0]; if (!f) return;
  const r = new FileReader();
  r.onload = (ev) => {
    tempReceipts[prefix] = ev.target.result;
    tempReceipts[prefix + 'Name'] = f.name;
    const icon = f.type === 'application/pdf' ? '&#128196;' : '&#129534;';
    document.getElementById(prefix + 'ReceiptUploadArea').innerHTML = `${icon} <span class="upload-text" style="color:var(--text);font-weight:600;">${esc(f.name)}</span><button class="remove-img" onclick="event.stopPropagation();removeReceipt('${prefix}')">&times;</button>`;
  };
  r.readAsDataURL(f); e.target.value = '';
}

function removeReceipt(prefix) { tempReceipts[prefix] = null; tempReceipts[prefix + 'Name'] = null; resetReceiptUpload(prefix); }

// ---- Documents (multiple per firearm) ----
function handleDocUpload(e) {
  const files = Array.from(e.target.files || []);
  let pending = files.length;
  files.forEach(file => {
    const r = new FileReader();
    r.onload = (ev) => {
      tempDocs.push({ id: generateId(), name: file.name, type: file.type, data: ev.target.result });
      if (--pending <= 0) renderDocList();
      else renderDocList();
    };
    r.readAsDataURL(file);
  });
  e.target.value = '';
}
function removeDoc(id) { tempDocs = tempDocs.filter(d => d.id !== id); renderDocList(); }
function renderDocList() {
  const el = document.getElementById('docList');
  if (!el) return;
  if (!tempDocs.length) { el.innerHTML = ''; return; }
  el.innerHTML = tempDocs.map(d => {
    const isPdf = (d.name || '').toLowerCase().endsWith('.pdf') || d.type === 'application/pdf';
    return `<div class="doc-chip"><span class="doc-chip-icon">${isPdf ? '&#128196;' : '&#129534;'}</span>
      <span class="doc-chip-name">${esc(d.name || 'document')}</span>
      <button type="button" class="doc-chip-x" onclick="removeDoc('${d.id}')" title="Remove">&times;</button></div>`;
  }).join('');
}
function resetReceiptUpload(prefix) { document.getElementById(prefix + 'ReceiptUploadArea').innerHTML = '<span class="upload-text">Click to upload receipt</span>'; }
function showReceiptInUploadArea(prefix, data, name) {
  if (!data) { resetReceiptUpload(prefix); return; }
  const icon = (name && name.toLowerCase().endsWith('.pdf')) ? '&#128196;' : '&#129534;';
  document.getElementById(prefix + 'ReceiptUploadArea').innerHTML = `${icon} <span class="upload-text" style="color:var(--text);font-weight:600;">${esc(name || 'receipt')}</span><button class="remove-img" onclick="event.stopPropagation();removeReceipt('${prefix}')">&times;</button>`;
}

// Drag and drop
const imgArea=document.getElementById('imgUploadArea');
imgArea.addEventListener('dragover',e=>{e.preventDefault();imgArea.style.borderColor='var(--accent)';});
imgArea.addEventListener('dragleave',()=>{imgArea.style.borderColor='';});
imgArea.addEventListener('drop',e=>{
  e.preventDefault();imgArea.style.borderColor='';
  const files = e.dataTransfer.files; if(!files) return;
  for(let i = 0; i < files.length; i++) {
    const f = files[i]; if(!f.type.startsWith('image/')) continue;
    const r = new FileReader();
    r.onload = async (ev) => { const id = generateId(); const compressed = await compressImage(ev.target.result, 1600, 0.80); imagesDb[id] = compressed; await idbPut(id, compressed); tempImages.push(id); renderImageGallery(); };
    r.readAsDataURL(f);
  }
});

const stampArea=document.getElementById('stampUploadArea');
stampArea.addEventListener('dragover',e=>{e.preventDefault();stampArea.style.borderColor='var(--accent)';});
stampArea.addEventListener('dragleave',()=>{stampArea.style.borderColor='';});
stampArea.addEventListener('drop',e=>{
  e.preventDefault();stampArea.style.borderColor='';
  const f=e.dataTransfer.files[0]; if(!f||f.type!=='application/pdf') return;
  const r=new FileReader();
  r.onload=(ev)=>{ tempStampPdf=ev.target.result; tempStampPdfName=f.name; stampArea.innerHTML=`<span style="font-size:1.5rem;">&#128196;</span><span class="upload-text" style="color:var(--text);font-weight:600;">${esc(f.name)}</span><button class="remove-img" onclick="event.stopPropagation();removeStampPdf()">&times;</button>`; };
  r.readAsDataURL(f);
});

// =====================================================
// AMMUNITION
// =====================================================
function openAddAmmoModal() {
  editingAmmoId = null;
  document.getElementById('ammoModalTitle').textContent = 'Add Ammunition';
  document.getElementById('saveAmmoBtn').textContent = 'Save Ammunition';
  clearAmmoForm();
  document.getElementById('ammoModal').classList.add('open');
}

function editAmmo(id) {
  const a = db.ammo.find(x => x.id === id); if (!a) return;
  editingAmmoId = id;
  document.getElementById('ammoModalTitle').textContent = 'Edit Ammunition';
  document.getElementById('saveAmmoBtn').textContent = 'Update Ammunition';
  document.getElementById('aCaliber').value = a.caliber || '';
  document.getElementById('aBrand').value = a.brand || '';
  document.getElementById('aQuantity').value = a.quantity || '';
  document.getElementById('aPurchaseDate').value = a.purchaseDate || '';
  document.getElementById('aPricePerRound').value = a.pricePerRound || '';
  document.getElementById('aLocation').value = a.location || '';
  document.getElementById('aLowStock').value = a.lowStock || '';
  document.getElementById('aNotes').innerHTML = a.notes || '';
  tempReceipts.a = a.receipt || null; tempReceipts.aName = a.receiptName || null;
  showReceiptInUploadArea('a', a.receipt, a.receiptName);
  document.getElementById('ammoModal').classList.add('open');
}

function clearAmmoForm() {
  ['aCaliber','aBrand','aQuantity','aPurchaseDate','aPricePerRound','aLocation','aLowStock'].forEach(id => document.getElementById(id).value='');
  document.getElementById('aNotes').innerHTML = '';
  tempReceipts.a = null; tempReceipts.aName = null; resetReceiptUpload('a');
}

function closeAmmoModal() { document.getElementById('ammoModal').classList.remove('open'); editingAmmoId = null; }

async function saveAmmo() {
  const caliber = document.getElementById('aCaliber').value.trim();
  if (!caliber) { toast('Please enter a caliber.'); return; }
  const data = {
    id: editingAmmoId || generateId(), caliber,
    brand: document.getElementById('aBrand').value.trim(),
    quantity: document.getElementById('aQuantity').value,
    purchaseDate: document.getElementById('aPurchaseDate').value,
    pricePerRound: document.getElementById('aPricePerRound').value,
    location: document.getElementById('aLocation').value.trim(),
    lowStock: document.getElementById('aLowStock').value || 0,
    notes: document.getElementById('aNotes').innerHTML.trim(),
    receipt: tempReceipts.a, receiptName: tempReceipts.aName
  };
  const itemName = (data.brand || data.caliber);
  if (editingAmmoId) {
    addAuditEntry('edit', 'ammo', itemName, '');
    const i = db.ammo.findIndex(a => a.id === editingAmmoId); if (i > -1) db.ammo[i] = data;
  } else {
    addAuditEntry('create', 'ammo', itemName, '');
    db.ammo.push(data);
  }
  await saveData(); render(); closeAmmoModal();
}

async function quickAmmoAdjust(id, direction) {
  const amt = await promptDialog(direction > 0 ? 'How many rounds to add?' : 'How many rounds to subtract?', '20', { title: direction > 0 ? 'Add rounds' : 'Subtract rounds' });
  if (!amt || isNaN(parseInt(amt))) return;
  const a = db.ammo.find(x => x.id === id);
  if (!a) return;
  const qty = Math.max(0, (parseInt(a.quantity)||0) + (parseInt(amt) * direction));
  a.quantity = String(qty);
  addAuditEntry('edit','ammo',(a.brand||a.caliber),'Quantity '+(direction>0?'+':'-')+amt+' = '+qty);
  await saveData(); render();
}

async function deleteAmmo(id) {
  if (!await confirmDialog('Delete this ammunition entry?', { title: 'Delete ammunition', okText: 'Delete', danger: true })) return;
  deleteWithUndo('ammo', id);
}

// =====================================================
// ACCESSORIES
// =====================================================
function openAccessoryModal(editId) {
  editingAccessoryId = editId || null;
  document.getElementById('accessoryModalTitle').textContent = editId ? 'Edit Accessory' : 'Add Accessory';
  document.getElementById('saveAccBtn').textContent = editId ? 'Update Accessory' : 'Save Accessory';
  populateFirearmDropdown();
  if (editId) {
    const a = db.accessories.find(x => x.id === editId); if (!a) return;
    document.getElementById('accName').value = a.name || '';
    document.getElementById('accCategory').value = a.category || 'Optic';
    document.getElementById('accBrand').value = a.brand || '';
    document.getElementById('accModel').value = a.model || '';
    document.getElementById('accSerial').value = a.serial || '';
    document.getElementById('accPrice').value = a.price || '';
    document.getElementById('accDate').value = a.purchaseDate || '';
    document.getElementById('accCondition').value = a.condition || 'New';
    document.getElementById('accFirearm').value = a.firearmId || '';
    document.getElementById('accNotes').innerHTML = a.notes || '';
    tempReceipts.acc = a.receipt || null; tempReceipts.accName = a.receiptName || null;
    showReceiptInUploadArea('acc', a.receipt, a.receiptName);
  } else { clearAccessoryForm(); }
  document.getElementById('accessoryModal').classList.add('open');
}

function closeAccessoryModal() { document.getElementById('accessoryModal').classList.remove('open'); editingAccessoryId = null; }

function clearAccessoryForm() {
  ['accName','accBrand','accModel','accSerial','accPrice','accDate'].forEach(id => document.getElementById(id).value = '');
  document.getElementById('accNotes').innerHTML = '';
  document.getElementById('accCategory').value = 'Optic'; document.getElementById('accCondition').value = 'New';
  document.getElementById('accFirearm').value = '';
  tempReceipts.acc = null; tempReceipts.accName = null; resetReceiptUpload('acc');
}

function populateFirearmDropdown() {
  const sel = document.getElementById('accFirearm'); const cur = sel.value;
  sel.innerHTML = '<option value="">Not Assigned / In Storage</option>';
  db.firearms.filter(f => !f.status || f.status === 'Active').forEach(f => {
    const o = document.createElement('option'); o.value = f.id;
    o.textContent = (f.make || '') + ' ' + (f.model || '') + (f.serial ? ' (' + f.serial + ')' : '');
    sel.appendChild(o);
  });
  sel.value = cur;
}

async function saveAccessory() {
  const name = document.getElementById('accName').value.trim();
  if (!name) { toast('Please enter an accessory name.'); return; }
  const data = {
    id: editingAccessoryId || generateId(), name,
    category: document.getElementById('accCategory').value,
    brand: document.getElementById('accBrand').value.trim(),
    model: document.getElementById('accModel').value.trim(),
    serial: document.getElementById('accSerial').value.trim(),
    price: document.getElementById('accPrice').value,
    purchaseDate: document.getElementById('accDate').value,
    condition: document.getElementById('accCondition').value,
    firearmId: document.getElementById('accFirearm').value,
    notes: document.getElementById('accNotes').innerHTML.trim(),
    receipt: tempReceipts.acc, receiptName: tempReceipts.accName
  };
  if (editingAccessoryId) {
    addAuditEntry('edit', 'accessory', name, '');
    const i = db.accessories.findIndex(a => a.id === editingAccessoryId); if (i > -1) db.accessories[i] = data;
  } else {
    addAuditEntry('create', 'accessory', name, '');
    db.accessories.push(data);
  }
  await saveData(); render(); closeAccessoryModal();
}

async function deleteAccessory(id) {
  if (!await confirmDialog('Delete this accessory?', { title: 'Delete accessory', okText: 'Delete', danger: true })) return;
  deleteWithUndo('accessory', id);
}

function getFirearmLabel(firearmId) {
  if (!firearmId) return 'Not Assigned';
  const f = db.firearms.find(x => x.id === firearmId);
  return f ? (f.make || '') + ' ' + (f.model || '') : 'Unknown';
}

function renderAccessoriesTab() {
  document.getElementById('cardGrid').style.display = 'none';
  document.getElementById('tableContainer').style.display = 'block';
  document.getElementById('emptyState').style.display = 'none';
  const search = document.getElementById('searchBox').value.toLowerCase();
  let items = db.accessories;
  if (search) {
    items = items.filter(a => (a.name||'').toLowerCase().includes(search) || (a.brand||'').toLowerCase().includes(search) || (a.model||'').toLowerCase().includes(search) || (a.category||'').toLowerCase().includes(search) || (a.serial||'').toLowerCase().includes(search) || getFirearmLabel(a.firearmId).toLowerCase().includes(search) || (a.notes||'').replace(/<[^>]*>/g,'').toLowerCase().includes(search));
  }
  const totalValue = db.accessories.reduce((s, a) => s + (parseFloat(a.price) || 0), 0);
  let h = `<div style="padding: 16px 24px; background: var(--bg2); border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; font-size: 0.86rem; font-weight: 600;">
    <span>Accessories: <span style="color: var(--accent);">${db.accessories.length}</span></span>
    <span>Total Value: <span style="color: var(--accent);">$${totalValue.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})}</span></span>
  </div>`;
  if (items.length === 0) {
    h += db.accessories.length === 0
      ? tabEmpty('📦', 'No accessories tracked yet', 'Optics, suppressors, lights, magazines — track them and link them to builds.', '<button class="btn btn-primary" onclick="openAccessoryModal()">+ Add Accessory</button>')
      : tabEmpty('🔍', 'No accessories match your search', 'Try a different term or clear the search box.', '');
    document.getElementById('tableContainer').innerHTML = h; return;
  }
  h += '<table class="data-table"><thead><tr><th>Name</th><th>Category</th><th>Brand</th><th>Model / Part #</th><th>Assigned To</th><th>Condition</th><th>Price</th><th>Date</th><th>Receipt</th><th></th></tr></thead><tbody>';
  items.forEach(a => {
    const firearmLabel = getFirearmLabel(a.firearmId);
    const pr = a.price ? money(a.price) : '--';
    const hasReceipt = a.receipt ? true : false;
    h += `<tr style="cursor:pointer;" onclick="openAccessoryModal('${a.id}')">
      <td style="font-weight:600;">${esc(a.name||'--')}</td>
      <td><span style="padding:2px 8px;background:var(--bg3);border-radius:4px;font-size:0.78rem;">${esc(a.category||'--')}</span></td>
      <td>${esc(a.brand||'--')}</td><td>${esc(a.model||'--')}</td>
      <td>${a.firearmId ? '<span style="color:var(--accent);font-weight:500;">' + esc(firearmLabel) + '</span>' : '<span style="color:var(--text3);">Not Assigned</span>'}</td>
      <td>${esc(a.condition||'--')}</td><td>${pr}</td><td>${fmtDate(a.purchaseDate)}</td>
      <td>${hasReceipt ? '<button class="btn btn-small btn-outline" onclick="event.stopPropagation();viewReceiptInBrowser(\''+a.id+'\',\'accessories\')">View</button> <a href="'+a.receipt+'" download="'+(a.receiptName||'receipt')+'" onclick="event.stopPropagation();" class="btn btn-small btn-file" style="text-decoration:none;display:inline-block;">DL</a>' : '<span style="color:var(--text3);">--</span>'}</td>
      <td style="text-align:right;"><button class="btn btn-small btn-danger" onclick="event.stopPropagation(); deleteAccessory('${a.id}')">Del</button></td>
    </tr>`;
  });
  h += '</tbody></table>';
  document.getElementById('tableContainer').innerHTML = h;
}

// =====================================================
// MAINTENANCE LOG
// =====================================================
function openMaintenanceModal(firearmId) {
  editingMaintenanceId = firearmId;
  document.getElementById('maintenanceTitle').textContent = 'Add Maintenance Log Entry';
  document.getElementById('mDate').value = new Date().toISOString().split('T')[0];
  document.getElementById('mType').value = 'Cleaning';
  document.getElementById('mRoundCount').value = '';
  document.getElementById('mParts').value = '';
  document.getElementById('mDescription').innerHTML = '';
  document.getElementById('maintenanceModal').classList.add('open');
}

function closeMaintenanceModal() { document.getElementById('maintenanceModal').classList.remove('open'); editingMaintenanceId = null; }

async function saveMaintenanceEntry() {
  const firearm = db.firearms.find(f => f.id === editingMaintenanceId);
  if (!firearm) return;
  if (!firearm.maintenanceLog) firearm.maintenanceLog = [];
  const entry = {
    id: generateId(),
    date: document.getElementById('mDate').value,
    type: document.getElementById('mType').value,
    roundCount: document.getElementById('mRoundCount').value,
    parts: document.getElementById('mParts').value.trim(),
    description: rteValue('mDescription')
  };
  firearm.maintenanceLog.push(entry);
  addAuditEntry('create', 'maintenance', (firearm.make||'')+' '+(firearm.model||''), entry.type);
  await saveData();
  closeMaintenanceModal();
  openDetail(editingMaintenanceId);
}

// =====================================================
// DETAIL VIEW
// =====================================================
function openDetail(id) {
  const f=db.firearms.find(x=>x.id===id); if(!f) return;

  const ic=document.getElementById('detailImgContainer');
  if (f.images && f.images.length > 0) {
    const imgs = f.images.filter(imgId => imagesDb[imgId]);
    if (imgs.length > 0) {
      let galNav = '';
      if (imgs.length > 1) {
        galNav = '<div class="detail-gallery-nav">' + imgs.map((_, idx) =>
          `<div class="detail-gallery-dot ${idx === currentImageIndex ? 'active' : ''}" onclick="currentImageIndex = ${idx}; openDetail('${id}')"></div>`
        ).join('') + '</div>';
      }
      const prevBtn = currentImageIndex > 0 ? `<span class="swipe-hint left" onclick="event.stopPropagation();currentImageIndex--;openDetail('${id}')">&#8249;</span>` : '';
      const nextBtn = currentImageIndex < imgs.length-1 ? `<span class="swipe-hint right" onclick="event.stopPropagation();currentImageIndex++;openDetail('${id}')">&#8250;</span>` : '';
      ic.innerHTML=`<div style="position:relative;">${prevBtn}${nextBtn}${galNav}<img class="detail-img" src="${imagesDb[imgs[currentImageIndex]]}" alt="${esc(f.make)} ${esc(f.model)}"></div>`;
    } else { ic.innerHTML=`<div class="detail-img-placeholder">&#10022;</div>`; }
  } else { ic.innerHTML=`<div class="detail-img-placeholder">&#10022;</div>`; }

  const pr=f.price?money(f.price):'--';
  const dt=fmtDate(f.dateAcquired);

  // Tags display
  const tagsH = (f.tags && f.tags.length > 0) ? `<div style="margin-top:10px;display:flex;gap:4px;flex-wrap:wrap;">${f.tags.map(t => `<span class="tag-pill">${esc(t)}</span>`).join('')}</div>` : '';

  let nfaH='';
  if(f.isNFA){
    const sd=fmtDate(f.dateSubmitted);const ad=fmtDate(f.dateApproved);
    let wd='';
    if(f.dateSubmitted&&f.dateApproved){const d=Math.round((new Date(f.dateApproved)-new Date(f.dateSubmitted))/86400000);wd=`<div class="detail-field"><label>Wait Time</label><span>${d} days</span></div>`;}
    else if(f.dateSubmitted&&!f.dateApproved){const d=Math.round((new Date()-new Date(f.dateSubmitted))/86400000);wd=`<div class="detail-field"><label>Waiting</label><span>${d} days so far</span></div>`;}
    let si='';
    if(f.stampPdf){si=`<div style="margin-top:12px;"><label style="display:block;font-size:0.7rem;color:var(--text3);text-transform:uppercase;margin-bottom:6px;font-weight:600;">Tax Stamp PDF</label><a href="${f.stampPdf}" download="${esc(f.stampPdfName||'tax_stamp.pdf')}" style="display:inline-flex;align-items:center;gap:8px;padding:10px 16px;background:var(--accent);color:#fff;border-radius:6px;text-decoration:none;font-size:0.84rem;font-weight:600;" onclick="event.stopPropagation();">&#128196; ${esc(f.stampPdfName||'tax_stamp.pdf')} — Download</a><button onclick="event.stopPropagation();viewStampPdf('${f.id}')" style="margin-left:8px;padding:10px 16px;background:var(--bg2);color:var(--text);border:1px solid var(--border);border-radius:6px;font-size:0.84rem;font-weight:600;cursor:pointer;">View in Browser</button></div>`;}
    nfaH=`<div class="detail-section detail-nfa-section"><h3>NFA / Tax Stamp Details</h3><div class="detail-grid">
      <div class="detail-field"><label>NFA Type</label><span>${esc(f.nfaType||'--')}</span></div>
      <div class="detail-field"><label>Form Type</label><span>${esc(f.formType||'--')}</span></div>
      <div class="detail-field"><label>Status</label><span>${esc(f.stampStatus||'--')}</span></div>
      <div class="detail-field"><label>Date Submitted</label><span>${sd}</span></div>
      <div class="detail-field"><label>Date Approved</label><span>${ad}</span></div>
      ${wd}<div class="detail-field"><label>Registration</label><span>${esc(f.regType||'--')}</span></div>
    </div>${si}</div>`;
  }

  let compatAmmo = '';
  if (f.caliber) {
    const ammoList = db.ammo.filter(a => a.caliber === f.caliber);
    if (ammoList.length > 0) {
      compatAmmo = '<div class="detail-section"><h3>Compatible Ammunition</h3><div style="display: flex; flex-direction: column; gap: 10px;">';
      ammoList.forEach(a => {
        const tc2 = (parseInt(a.quantity) || 0) * (parseFloat(a.pricePerRound) || 0);
        compatAmmo += `<div style="padding: 10px; background: var(--bg3); border-radius: 6px; border-left: 3px solid var(--accent);">
          <div style="font-weight: 600; margin-bottom: 4px;">${esc(a.brand||'Ammo')}</div>
          <div style="font-size: 0.8rem; color: var(--text2);">
            <span>${(parseInt(a.quantity) || 0).toLocaleString()} rounds</span> &bull;
            <span>$${(parseFloat(a.pricePerRound) || 0).toFixed(2)}/round</span> &bull;
            <span>Total: $${tc2.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})}</span>
          </div>
        </div>`;
      });
      compatAmmo += '</div></div>';
    }
  }

  let accessoriesH = '';
  const assignedAcc = db.accessories.filter(a => a.firearmId === f.id);
  const firearmPrice = parseFloat(f.price) || 0;
  const accTotal = assignedAcc.reduce((s, a) => s + (parseFloat(a.price) || 0), 0);
  const buildTotal = firearmPrice + accTotal;
  const addBuildBtn = `<button class="btn btn-small btn-primary" onclick="event.stopPropagation(); closeDetail(); openAccessoryModal(); setTimeout(function(){var s=document.getElementById('accFirearm'); if(s) s.value='${f.id}';}, 60);">+ Add to build</button>`;
  const buildHeader = `<div class="build-summary">
      <div><div class="build-summary-label">Total build value</div><div class="build-summary-value">${money(buildTotal)}</div></div>
      <div class="build-summary-meta">Firearm ${money(firearmPrice)} &nbsp;+&nbsp; ${assignedAcc.length} part${assignedAcc.length===1?'':'s'} ${money(accTotal)}</div>
    </div>`;
  if (assignedAcc.length > 0) {
    accessoriesH = '<div class="detail-section"><h3 style="display:flex;justify-content:space-between;align-items:center;gap:10px;">Build / Loadout (' + assignedAcc.length + ' parts) ' + addBuildBtn + '</h3>' + buildHeader + '<div style="display: flex; flex-direction: column; gap: 8px;">';
    assignedAcc.slice().sort((a,b)=>(a.category||'').localeCompare(b.category||'')).forEach(a => {
      const apr = a.price ? money(a.price) : '';
      accessoriesH += `<div style="padding: 10px; background: var(--bg3); border-radius: 6px; border-left: 3px solid var(--blue); display: flex; justify-content: space-between; align-items: center;">
        <div><div style="font-weight: 600; margin-bottom: 2px;">${esc(a.name)}</div>
          <div style="font-size: 0.8rem; color: var(--text2);"><span style="padding:2px 6px;background:var(--bg2);border-radius:3px;margin-right:6px;">${esc(a.category||'')}</span>${a.brand ? esc(a.brand) : ''}${a.model ? ' ' + esc(a.model) : ''}${apr ? ' &middot; ' + apr : ''}</div>
        </div>
        <button class="btn btn-small btn-outline" onclick="event.stopPropagation(); closeDetail(); openAccessoryModal('${a.id}');">Edit</button>
      </div>`;
    });
    accessoriesH += '</div></div>';
  } else {
    accessoriesH = '<div class="detail-section"><h3 style="display:flex;justify-content:space-between;align-items:center;gap:10px;">Build / Loadout ' + addBuildBtn + '</h3><p style="color: var(--text3); font-size: 0.8rem;">No parts added to this build yet. Add optics, suppressors, lights and more — the total build value updates automatically.</p></div>';
  }

  let maintenanceH = '';
  if (f.maintenanceLog && f.maintenanceLog.length > 0) {
    maintenanceH = '<div class="detail-section"><h3>Maintenance History</h3>';
    const sorted = [...f.maintenanceLog].sort((a, b) => new Date(b.date) - new Date(a.date));
    sorted.forEach(entry => {
      maintenanceH += `<div style="padding: 10px; background: var(--bg3); border-radius: 6px; border-left: 3px solid var(--green); margin-bottom: 8px;">
        <div style="font-weight: 600; margin-bottom: 4px;">${esc(entry.type)} - ${fmtDate(entry.date)}</div>
        <div style="font-size: 0.8rem; color: var(--text2); margin-bottom: 4px;">${entry.roundCount ? 'Round Count: '+entry.roundCount : ''}${entry.parts ? ' &bull; Parts: '+esc(entry.parts) : ''}</div>
        ${rteShow(entry.description) ? `<div class="rte-display" style="font-size: 0.8rem; color: var(--text);">${entry.description}</div>` : ''}
      </div>`;
    });
    maintenanceH += `<button class="btn btn-small btn-primary" onclick="openMaintenanceModal('${f.id}'); closeDetail();" style="margin-top: 8px;">+ Add Entry</button></div>`;
  } else {
    maintenanceH = `<div class="detail-section"><h3>Maintenance History</h3><p style="color: var(--text3); font-size: 0.8rem;">No maintenance records yet.</p><button class="btn btn-small btn-primary" onclick="openMaintenanceModal('${f.id}'); closeDetail();">+ Add Entry</button></div>`;
  }

  let dispositionH = '';
  if (f.status && f.status !== 'Active') {
    dispositionH = `<div class="detail-section" style="background: var(--yellow-bg); border: 1px solid var(--yellow);"><h3 style="color: var(--yellow);">Disposition</h3><div class="detail-grid">
      <div class="detail-field"><label>Status</label><span>${esc(f.status)}</span></div>
      ${f.dispDate ? `<div class="detail-field"><label>Date</label><span>${fmtDate(f.dispDate)}</span></div>` : ''}
      ${f.dispBuyer ? `<div class="detail-field"><label>Buyer</label><span>${esc(f.dispBuyer)}</span></div>` : ''}
      ${f.dispPrice ? `<div class="detail-field"><label>Sale Price</label><span>${money(f.dispPrice)}</span></div>` : ''}
      ${f.dispFFL ? `<div class="detail-field"><label>FFL Dealer</label><span>${esc(f.dispFFL)}</span></div>` : ''}
      ${rteShow(f.dispNotes) ? `<div class="detail-field" style="grid-column: 1/-1;"><label>Notes</label><span class="rte-display">${f.dispNotes}</span></div>` : ''}
      ${(()=>{ const pl = getProfitLoss(f); return pl !== null ? '<div class="detail-field"><label>Profit/Loss</label><span class="'+(pl>=0?'profit':'loss')+'">'+money(Math.abs(pl))+' '+(pl>=0?'Gain':'Loss')+'</span></div>' : ''; })()}
    </div></div>`;
  }

  const notesH=(f.notes && f.notes !== '<br>')?`<div class="detail-notes"><label>Notes</label>${f.notes}</div>`:'';

  let receiptH = '';
  if (f.receipt) {
    const isPdf = f.receiptName && f.receiptName.toLowerCase().endsWith('.pdf');
    const icon = isPdf ? '&#128196;' : '&#129534;';
    receiptH = `<div class="detail-section"><h3>Receipt</h3>
      <div style="display:flex;gap:8px;align-items:center;">
        <a href="${f.receipt}" download="${esc(f.receiptName||'receipt')}" style="display:inline-flex;align-items:center;gap:8px;padding:10px 16px;background:var(--accent);color:#fff;border-radius:6px;text-decoration:none;font-size:0.84rem;font-weight:600;" onclick="event.stopPropagation();">${icon} ${esc(f.receiptName||'receipt')} — Download</a>
        <button onclick="event.stopPropagation();viewReceiptInBrowser('${f.id}','firearms')" style="padding:10px 16px;background:var(--bg2);color:var(--text);border:1px solid var(--border);border-radius:6px;font-size:0.84rem;font-weight:600;cursor:pointer;">View</button>
      </div>
    </div>`;
  }

  let docsH = '';
  if (f.documents && f.documents.length > 0) {
    docsH = '<div class="detail-section"><h3>Documents (' + f.documents.length + ')</h3><div class="doc-list">';
    f.documents.forEach(d => {
      const isPdf = (d.name || '').toLowerCase().endsWith('.pdf') || d.type === 'application/pdf';
      const icon = isPdf ? '&#128196;' : '&#129534;';
      const open = d.data ? `<a class="doc-open" href="${d.data}" target="_blank" rel="noopener" onclick="event.stopPropagation();">View</a>
        <a class="doc-open" href="${d.data}" download="${esc(d.name||'document')}" onclick="event.stopPropagation();">Download</a>`
        : '<span style="color:var(--text3);font-size:0.78rem;">syncing…</span>';
      docsH += `<div class="doc-chip"><span class="doc-chip-icon">${icon}</span><span class="doc-chip-name">${esc(d.name||'document')}</span>${open}</div>`;
    });
    docsH += '</div></div>';
  }

  document.getElementById('detailBody').innerHTML=`
    <h2>${esc(f.make||'')} ${esc(f.model||'')}</h2>
    <div class="sub">${esc(f.type||'')} &middot; ${esc(f.caliber||'')}${tagsH}</div>
    <div class="detail-grid">
      <div class="detail-field"><label>Serial Number</label><span>${esc(f.serial||'--')}</span></div>
      <div class="detail-field"><label>Caliber</label><span>${esc(f.caliber||'--')}</span></div>
      <div class="detail-field"><label>Barrel Length</label><span>${esc(f.barrel||'--')}</span></div>
      <div class="detail-field"><label>Date Acquired</label><span>${dt}</span></div>
      <div class="detail-field"><label>Purchase Price</label><span>${pr}</span></div>
      <div class="detail-field"><label>Condition</label><span>${esc(f.condition||'--')}</span></div>
      <div class="detail-field"><label>Round Count</label><span>${f.roundCount||0}</span></div>
      <div class="detail-field"><label>Total Invested</label><span class="investment-badge">${money(getTotalInvestment(f.id))}</span></div>
      ${f.warrantyExp ? '<div class="detail-field"><label>Warranty</label><span class="warranty-'+getWarrantyStatus(f.warrantyExp)+'">'+(getWarrantyStatus(f.warrantyExp)==='expired'?'EXPIRED':getWarrantyStatus(f.warrantyExp)==='soon'?'Expiring Soon':fmtDate(f.warrantyExp))+'</span></div>' : ''}
    </div>${(f.customFields&&f.customFields.length>0)?'<div class="detail-section"><h3>Custom Fields</h3><div class="detail-grid">'+f.customFields.map(cf=>'<div class="detail-field"><label>'+esc(cf.name)+'</label><span>'+esc(cf.value)+'</span></div>').join('')+'</div></div>':''}${notesH}${receiptH}${docsH}${dispositionH}${nfaH}${compatAmmo}${accessoriesH}${maintenanceH}`;

  currentImageIndex = 0;
  document.getElementById('detailQRBtn').onclick=()=>{generateQR(id);};
  document.getElementById('detailDupeBtn').onclick=()=>{closeDetail();duplicateFirearm(id);};
  document.getElementById('detailEditBtn').onclick=()=>{closeDetail();openEditModal(id);};
  document.getElementById('detailDeleteBtn').onclick=async()=>{
    if(await confirmDialog(`Delete ${f.make} ${f.model}?`, { title: 'Delete firearm', okText: 'Delete', danger: true })){
      closeDetail();
      deleteWithUndo('firearm', id);
    }
  };

  document.getElementById('detailView').classList.add('open');
}

function closeDetail(){ document.getElementById('detailView').classList.remove('open'); currentImageIndex = 0; }

function viewStampPdf(id){
  const f=db.firearms.find(x=>x.id===id); if(!f||!f.stampPdf) return;
  const w=window.open();
  w.document.write(`<html><head><title>Tax Stamp - ${esc(f.make)} ${esc(f.model)}</title></head><body style="margin:0;"><iframe src="${f.stampPdf}" style="width:100%;height:100vh;border:none;"></iframe></body></html>`);
}

function viewReceiptInBrowser(id, type) {
  let item;
  if (type === 'firearms') item = db.firearms.find(x => x.id === id);
  else if (type === 'ammo') item = db.ammo.find(x => x.id === id);
  else if (type === 'accessories') item = db.accessories.find(x => x.id === id);
  if (!item || !item.receipt) return;
  const isPdf = item.receiptName && item.receiptName.toLowerCase().endsWith('.pdf');
  const w = window.open();
  if (isPdf) w.document.write(`<html><head><title>Receipt</title></head><body style="margin:0;"><iframe src="${item.receipt}" style="width:100%;height:100vh;border:none;"></iframe></body></html>`);
  else w.document.write(`<html><head><title>Receipt</title></head><body style="margin:0;background:#222;display:flex;justify-content:center;align-items:center;min-height:100vh;"><img src="${item.receipt}" style="max-width:100%;max-height:100vh;object-fit:contain;"></body></html>`);
}

// =====================================================
// INSURANCE REPORT PDF
// =====================================================
async function exportInsuranceReport() {
  if (db.firearms.length === 0) { toast('No firearms to export.'); return; }
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF();
  doc.setFontSize(16); doc.text('Personal Firearms Inventory Report', 14, 15);
  doc.setFontSize(10); doc.text('Generated: ' + new Date().toLocaleString(), 14, 25);
  const rows = db.firearms.map(f => [f.make + ' ' + f.model, f.serial || '--', f.caliber || '--', f.type || '--', fmtDate(f.dateAcquired), f.price ? money(f.price) : '--', f.condition || '--']);
  doc.autoTable({ head: [['Make/Model', 'Serial #', 'Caliber', 'Type', 'Acquired', 'Price', 'Condition']], body: rows, startY: 35, theme: 'grid' });
  let finalY = doc.lastAutoTable.finalY + 10;
  const totalValue = db.firearms.reduce((s, f) => s + (parseFloat(f.price) || 0), 0);
  doc.setFontSize(11); doc.setFont(undefined, 'bold');
  doc.text('Total Estimated Value: $' + totalValue.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2}), 14, finalY);
  const nfaItems = db.firearms.filter(f => f.isNFA);
  if (nfaItems.length > 0) {
    finalY += 15; doc.setFontSize(12); doc.text('NFA Items', 14, finalY);
    const nfaRows = nfaItems.map(f => [f.nfaType || '--', f.make + ' ' + f.model, f.formType || '--', f.stampStatus || '--']);
    doc.autoTable({ head: [['NFA Type', 'Item', 'Form', 'Status']], body: nfaRows, startY: finalY + 5, theme: 'grid' });
  }
  doc.save('Firearms_Insurance_Report_' + new Date().toISOString().slice(0, 10) + '.pdf');
}

// =====================================================
// CAMERA SCANNING
// =====================================================
async function openCameraModal() {
  document.getElementById('cameraModal').classList.add('open');
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    document.getElementById('cameraFeed').srcObject = stream;
  } catch (e) { toast('Could not access camera: ' + e.message); closeCameraModal(); }
}

function closeCameraModal() {
  const video = document.getElementById('cameraFeed');
  if (video.srcObject) video.srcObject.getTracks().forEach(track => track.stop());
  document.getElementById('cameraModal').classList.remove('open');
  document.getElementById('ocrResult').style.display = 'none';
}

async function captureSnapshot() {
  const video = document.getElementById('cameraFeed');
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth; canvas.height = video.videoHeight;
  canvas.getContext('2d').drawImage(video, 0, 0);
  try {
    const { data: { text } } = await Tesseract.recognize(canvas, 'eng');
    document.getElementById('scannedText').value = text.trim();
    document.getElementById('ocrResult').style.display = 'block';
  } catch (e) { toast('OCR error: ' + e.message); }
}

function searchScannedSerial() {
  const text = document.getElementById('scannedText').value.trim();
  const found = db.firearms.find(f => (f.serial || '').toLowerCase().includes(text.toLowerCase()));
  if (found) { closeCameraModal(); openDetail(found.id); }
  else toast('No firearm found with that serial number.');
}

// =====================================================
// EXCEL EXPORT
// =====================================================
function exportExcel() {
  if(db.firearms.length===0){toast('No data to export.');return;}
  const allRows=db.firearms.map(f=>({'Make':f.make||'','Model':f.model||'','Serial Number':f.serial||'','Caliber':f.caliber||'','Type':f.type||'','Barrel Length':f.barrel||'','Date Acquired':fmtDate(f.dateAcquired),'Purchase Price':f.price?parseFloat(f.price):'','Condition':f.condition||'','Status':f.status||'Active','NFA Item':f.isNFA?'Yes':'No','Tags':(f.tags||[]).join(', '),'Notes':(f.notes||'').replace(/<[^>]*>/g,'')}));
  const nfaRows=db.firearms.filter(f=>f.isNFA).map(f=>{
    let w='';if(f.dateSubmitted&&f.dateApproved)w=Math.round((new Date(f.dateApproved)-new Date(f.dateSubmitted))/86400000);
    else if(f.dateSubmitted)w=Math.round((new Date()-new Date(f.dateSubmitted))/86400000)+' (pending)';
    return{'Make':f.make||'','Model':f.model||'','Serial Number':f.serial||'','Caliber':f.caliber||'','NFA Type':f.nfaType||'','Form Type':f.formType||'','Date Submitted':fmtDate(f.dateSubmitted),'Date Approved':fmtDate(f.dateApproved),'Stamp Status':f.stampStatus||'','Registration Type':f.regType||'','Wait Time (Days)':w,'Purchase Price':f.price?parseFloat(f.price):''};
  });
  const ammoRows = db.ammo.map(a => ({'Caliber':a.caliber||'','Brand/Type':a.brand||'','Quantity':a.quantity||'','Purchase Date':fmtDate(a.purchaseDate),'Price Per Round':a.pricePerRound?parseFloat(a.pricePerRound):'','Location':a.location||'','Notes':(a.notes||'').replace(/<[^>]*>/g,'')}));
  const wb=XLSX.utils.book_new();
  const ws1=XLSX.utils.json_to_sheet(allRows);
  ws1['!cols']=[{wch:18},{wch:20},{wch:16},{wch:14},{wch:10},{wch:12},{wch:14},{wch:14},{wch:12},{wch:12},{wch:10},{wch:20},{wch:30}];
  XLSX.utils.book_append_sheet(wb,ws1,'All Firearms');
  if(nfaRows.length>0){const ws2=XLSX.utils.json_to_sheet(nfaRows);XLSX.utils.book_append_sheet(wb,ws2,'NFA Items');}
  if(ammoRows.length>0){const ws3=XLSX.utils.json_to_sheet(ammoRows);XLSX.utils.book_append_sheet(wb,ws3,'Ammunition');}
  const accRows = db.accessories.map(a => ({'Name':a.name||'','Category':a.category||'','Brand':a.brand||'','Model/Part #':a.model||'','Serial Number':a.serial||'','Assigned To':getFirearmLabel(a.firearmId),'Purchase Price':a.price?parseFloat(a.price):'','Purchase Date':fmtDate(a.purchaseDate),'Condition':a.condition||'','Notes':(a.notes||'').replace(/<[^>]*>/g,'')}));
  if(accRows.length>0){const ws4=XLSX.utils.json_to_sheet(accRows);XLSX.utils.book_append_sheet(wb,ws4,'Accessories');}
  XLSX.writeFile(wb,'Firearms_Database_'+new Date().toISOString().slice(0,10)+'.xlsx');
}

// =====================================================
// JSON EXPORT / IMPORT
// =====================================================
function exportJSON() {
  if(db.firearms.length===0){toast('No data to export.');return;}
  const b=new Blob([JSON.stringify(db,null,2)],{type:'application/json'});
  const u=URL.createObjectURL(b);const a=document.createElement('a');a.href=u;
  a.download='firearms_database_'+new Date().toISOString().slice(0,10)+'.json';a.click();URL.revokeObjectURL(u);
}
function importJSON(){document.getElementById('importFile').click();}
function handleImport(event){
  const file=event.target.files[0];if(!file)return;
  const reader=new FileReader();
  reader.onload=async function(e){
    try{const data=JSON.parse(e.target.result);
      let toImport = [];
      if(Array.isArray(data)) toImport = data;
      else if(data.firearms && Array.isArray(data.firearms)) toImport = data.firearms;
      if(toImport.length === 0) throw new Error('No firearms found');
      if(await confirmDialog(`Import ${toImport.length} firearm(s)? This will ADD to your existing database.`, { title: 'Import firearms', okText: 'Import' })){
        toImport.forEach(item=>{if(!item.id)item.id=generateId();if(!item.tags)item.tags=[];db.firearms.push(item);});
        addAuditEntry('create', 'import', toImport.length + ' firearms', 'Bulk import');
        await saveData();render();toast(`Imported ${toImport.length} firearm(s) successfully.`);
      }
    }catch(err){toast('Invalid file format.');}
  };
  reader.readAsText(file);event.target.value='';
}

// =====================================================
// EVENT LISTENERS
// =====================================================
document.getElementById('formModal').addEventListener('click',e=>{if(e.target===document.getElementById('formModal'))closeModal();});
document.getElementById('detailView').addEventListener('click',e=>{if(e.target===document.getElementById('detailView'))closeDetail();});
document.getElementById('ammoModal').addEventListener('click',e=>{if(e.target===document.getElementById('ammoModal'))closeAmmoModal();});
document.getElementById('maintenanceModal').addEventListener('click',e=>{if(e.target===document.getElementById('maintenanceModal'))closeMaintenanceModal();});
document.getElementById('backupModal').addEventListener('click',e=>{if(e.target===document.getElementById('backupModal'))closeBackupModal();});
document.getElementById('cameraModal').addEventListener('click',e=>{if(e.target===document.getElementById('cameraModal'))closeCameraModal();});
document.getElementById('accessoryModal').addEventListener('click',e=>{if(e.target===document.getElementById('accessoryModal'))closeAccessoryModal();});
document.getElementById('settingsModal').addEventListener('click',e=>{if(e.target===document.getElementById('settingsModal'))closeSettingsModal();});
document.getElementById('passwordModal').addEventListener('click',e=>{if(e.target===document.getElementById('passwordModal'))closePasswordModal();});
document.getElementById('wishlistModal').addEventListener('click',e=>{if(e.target===document.getElementById('wishlistModal'))closeWishlistModal();});
document.getElementById('dealerModal').addEventListener('click',e=>{if(e.target===document.getElementById('dealerModal'))closeDealerModal();});
document.getElementById('dealerImportModal').addEventListener('click',e=>{if(e.target===document.getElementById('dealerImportModal'))closeDealerImportModal();});
document.getElementById('cropModal').addEventListener('click',e=>{if(e.target===document.getElementById('cropModal'))closeCropModal();});
document.getElementById('qrModal').addEventListener('click',e=>{if(e.target===document.getElementById('qrModal'))closeQRModal();});
document.getElementById('shortcutsModal').addEventListener('click',e=>{if(e.target===document.getElementById('shortcutsModal'))closeShortcutsModal();});
document.getElementById('reportBuilderModal').addEventListener('click',e=>{if(e.target===document.getElementById('reportBuilderModal'))closeReportBuilder();});

document.addEventListener('keydown',e=>{
  if(e.key==='Escape'){
    closeModal();closeDetail();closeAmmoModal();closeAccessoryModal();closeMaintenanceModal();closeBackupModal();closeCameraModal();closeSettingsModal();closePasswordModal();closeWishlistModal();closeDealerModal();closeDealerImportModal();closeCropModal();closeQRModal();closeShortcutsModal();closeReportBuilder();
    return;
  }
  // Alt+Key shortcuts
  if (!e.altKey) return;
  // Don't trigger if a modal is open
  if (document.querySelector('.modal-overlay.open') || document.querySelector('.detail-overlay.open')) return;
  const key = e.key.toLowerCase();
  if (key === 'n') { e.preventDefault(); if (currentTab === 'wishlist') openWishlistModal(); else if (currentTab === 'dealers') openDealerModal(); else if (currentTab === 'ammo') openAddAmmoModal(); else if (currentTab === 'accessories') openAccessoryModal(); else openAddModal(); }
  else if (key === '/') { e.preventDefault(); document.getElementById('searchBox').focus(); }
  else if (key === 'd') { e.preventDefault(); const t = document.querySelector('[data-tab="dashboard"]'); if (t) t.click(); }
  else if (key === 'v') { e.preventDefault(); setView(currentView === 'cards' ? 'table' : 'cards'); }
  else if (key === 'b') { e.preventDefault(); manualBackup(); }
  else if (key === 'p') { e.preventDefault(); printInventory(); }
  else if (key === '?') { e.preventDefault(); showShortcutsHelp(); }
  else if (key >= '1' && key <= '7') {
    e.preventDefault();
    const tabs = document.querySelectorAll('.tab');
    const idx = parseInt(key) - 1;
    if (idx < tabs.length) tabs[idx].click();
  }
});

// Close tag suggestions on outside click
document.addEventListener('click', e => {
  if (!e.target.closest('#tagsInputContainer') && !e.target.closest('#tagSuggestions')) hideTagSuggestions();
});

// =====================================================
// INIT
// =====================================================

// Accessibility: give icon-only controls screen-reader labels.
(function labelIconControls() {
  try {
    document.querySelectorAll('.modal-close').forEach(b => { if (!b.getAttribute('aria-label')) b.setAttribute('aria-label', 'Close'); });
    const tt = document.getElementById('themeToggle'); if (tt && !tt.getAttribute('aria-label')) tt.setAttribute('aria-label', 'Toggle dark mode');
  } catch (e) { /* non-fatal */ }
})();

// =====================================================
// DB SCHEMA ADDITIONS (ensure fields exist)
// =====================================================
if (!db.wishlist) db.wishlist = [];
if (!db.dealers) db.dealers = [];
if (!db.valueHistory) db.valueHistory = [];
db.firearms.forEach(f => { if (!f.roundCount) f.roundCount = 0; if (!f.customFields) f.customFields = []; });
db.ammo.forEach(a => { if (!a.lowStock) a.lowStock = 0; });

// Record current value snapshot for history
function recordValueSnapshot() {
  if (!db.valueHistory) db.valueHistory = [];
  const today = new Date().toISOString().slice(0,10);
  const last = db.valueHistory[db.valueHistory.length - 1];
  if (last && last.date === today) return; // already recorded today
  const active = db.firearms.filter(f => !f.status || f.status === 'Active');
  const fVal = active.reduce((s, f) => s + (parseFloat(f.price) || 0), 0);
  const aVal = db.accessories.reduce((s, a) => s + (parseFloat(a.price) || 0), 0);
  db.valueHistory.push({ date: today, value: fVal + aVal, count: active.length });
  if (db.valueHistory.length > 365) db.valueHistory = db.valueHistory.slice(-365);
}

// =====================================================
// WISHLIST
// =====================================================
let editingWishlistId = null;

function openWishlistModal(editId) {
  editingWishlistId = editId || null;
  document.getElementById('wishlistModalTitle').textContent = editId ? 'Edit Wishlist Item' : 'Add to Wishlist';
  if (editId) {
    const w = db.wishlist.find(x => x.id === editId);
    if (!w) return;
    document.getElementById('wMake').value = w.make || '';
    document.getElementById('wModel').value = w.model || '';
    document.getElementById('wCaliber').value = w.caliber || '';
    document.getElementById('wType').value = w.type || 'Rifle';
    document.getElementById('wPrice').value = w.price || '';
    document.getElementById('wPriority').value = w.priority || 'medium';
    document.getElementById('wDealer').value = w.dealer || '';
    document.getElementById('wURL').value = w.url || '';
    document.getElementById('wNotes').innerHTML = w.notes || '';
  } else {
    ['wMake','wModel','wCaliber','wPrice','wDealer','wURL'].forEach(id => document.getElementById(id).value = '');
    document.getElementById('wNotes').innerHTML = '';
    document.getElementById('wType').value = 'Rifle';
    document.getElementById('wPriority').value = 'medium';
  }
  document.getElementById('wishlistModal').classList.add('open');
}

function closeWishlistModal() { document.getElementById('wishlistModal').classList.remove('open'); editingWishlistId = null; }

async function saveWishlistItem() {
  const make = document.getElementById('wMake').value.trim();
  const model = document.getElementById('wModel').value.trim();
  if (!make && !model) { toast('Enter at least a Make or Model.'); return; }
  const data = {
    id: editingWishlistId || generateId(), make, model,
    caliber: document.getElementById('wCaliber').value.trim(),
    type: document.getElementById('wType').value,
    price: document.getElementById('wPrice').value,
    priority: document.getElementById('wPriority').value,
    dealer: document.getElementById('wDealer').value.trim(),
    url: document.getElementById('wURL').value.trim(),
    notes: rteValue('wNotes'),
    dateAdded: editingWishlistId ? (db.wishlist.find(x=>x.id===editingWishlistId)?.dateAdded || new Date().toISOString().slice(0,10)) : new Date().toISOString().slice(0,10)
  };
  if (editingWishlistId) { const i = db.wishlist.findIndex(x => x.id === editingWishlistId); if (i > -1) db.wishlist[i] = data; addAuditEntry('edit','wishlist',make+' '+model,''); }
  else { db.wishlist.push(data); addAuditEntry('create','wishlist',make+' '+model,''); }
  await saveData(); render(); closeWishlistModal();
}

async function deleteWishlistItem(id) {
  if (!await confirmDialog('Remove from wishlist?', { title: 'Remove from wishlist', okText: 'Remove', danger: true })) return;
  const w = db.wishlist.find(x => x.id === id);
  addAuditEntry('delete','wishlist', w ? (w.make+' '+w.model) : 'Unknown','');
  db.wishlist = db.wishlist.filter(x => x.id !== id);
  saveData(); render();
}

async function moveWishlistToCollection(id) {
  const w = db.wishlist.find(x => x.id === id);
  if (!w) return;
  if (!await confirmDialog('Move "' + (w.make||'')+' '+(w.model||'')+'" to your collection? This will open the Add Firearm form.', { title: 'Move to collection', okText: 'Move' })) return;
  closeWishlistModal();
  openAddModal();
  document.getElementById('fMake').value = w.make || '';
  document.getElementById('fModel').value = w.model || '';
  document.getElementById('fCaliber').value = w.caliber || '';
  document.getElementById('fType').value = w.type || 'Rifle';
  document.getElementById('fPrice').value = w.price || '';
}

let _wishFilter = 'all';
const _wishPrio = (w) => (w.priority === 'high' || w.priority === 'low') ? w.priority : 'medium';
function setWishlistFilter(p) { _wishFilter = p; renderWishlistTab(); }
// Click a priority pill to cycle High → Medium → Low.
function cycleWishlistPriority(id) {
  const w = (db.wishlist || []).find(x => x.id === id);
  if (!w) return;
  const order = ['high', 'medium', 'low'];
  w.priority = order[(order.indexOf(_wishPrio(w)) + 1) % order.length];
  saveData(); renderWishlistTab();
}

function renderWishlistTab() {
  document.getElementById('cardGrid').style.display = 'none';
  document.getElementById('tableContainer').style.display = 'block';
  document.getElementById('emptyState').style.display = 'none';
  const items = db.wishlist || [];
  const totalTarget = items.reduce((s, w) => s + (parseFloat(w.price) || 0), 0);
  let h = '<div style="padding:16px 24px;background:var(--bg2);border-bottom:1px solid var(--border);display:flex;justify-content:space-between;font-size:0.86rem;font-weight:600;"><span>Wishlist Items: <span style="color:var(--accent);">' + items.length + '</span></span><span>Target Budget: <span style="color:var(--accent);">' + money(totalTarget) + '</span></span></div>';
  if (items.length === 0) { h += tabEmpty('⭐', 'Your wishlist is empty', 'Track guns you want, set a target price and priority, then move them to your collection when you buy.', '<button class="btn btn-primary" onclick="openWishlistModal()">+ Add Wishlist Item</button>'); document.getElementById('tableContainer').innerHTML = h; return; }

  // Budget split + counts by priority
  const byP = { high: 0, medium: 0, low: 0 }, cnt = { high: 0, medium: 0, low: 0 };
  items.forEach(w => { const p = _wishPrio(w); byP[p] += parseFloat(w.price) || 0; cnt[p]++; });
  if (totalTarget > 0) {
    const seg = (p, c) => byP[p] > 0 ? '<span style="width:' + (byP[p] / totalTarget * 100).toFixed(1) + '%;background:' + c + ';" title="' + p + ': ' + money(byP[p]) + '"></span>' : '';
    const leg = (p, c, label) => '<span><i style="background:' + c + '"></i>' + label + ' ' + money(byP[p]) + '</span>';
    h += '<div class="wish-budget"><div class="wish-budget-bar">' + seg('high', 'var(--red)') + seg('medium', '#d9a400') + seg('low', 'var(--green)') + '</div>'
      + '<div class="wish-budget-legend">' + leg('high', 'var(--red)', 'High') + leg('medium', '#d9a400', 'Medium') + leg('low', 'var(--green)', 'Low') + '</div></div>';
  }

  // Priority filter chips
  if (_wishFilter !== 'all' && !cnt[_wishFilter]) _wishFilter = 'all';
  const chip = (p, label, n) => '<button class="dealer-chip' + (_wishFilter === p ? ' active' : '') + '" onclick="setWishlistFilter(\'' + p + '\')">' + label + ' <span class="dealer-chip-n">' + n + '</span></button>';
  h += '<div class="dealer-filterbar"><div class="dealer-chips">' + chip('all', 'All', items.length) + chip('high', 'High', cnt.high) + chip('medium', 'Medium', cnt.medium) + chip('low', 'Low', cnt.low) + '</div></div>';

  let rows = [...items].sort((a, b) => { const o = { high: 0, medium: 1, low: 2 }; return o[_wishPrio(a)] - o[_wishPrio(b)]; });
  if (_wishFilter !== 'all') rows = rows.filter(w => _wishPrio(w) === _wishFilter);

  h += '<table class="data-table"><thead><tr><th>Priority</th><th>Make</th><th>Model</th><th>Caliber</th><th>Type</th><th>Target Price</th><th>Dealer</th><th>Added</th><th></th></tr></thead><tbody>';
  rows.forEach(w => {
    const pr = w.price ? money(w.price) : '--';
    h += '<tr style="cursor:pointer;" onclick="openWishlistModal(\''+w.id+'\')">';
    h += '<td><button class="wishlist-priority '+_wishPrio(w)+'" title="Click to change priority" aria-label="Priority: '+_wishPrio(w)+' (click to change)" onclick="event.stopPropagation();cycleWishlistPriority(\''+w.id+'\')">'+_wishPrio(w).toUpperCase()+'</button></td>';
    h += '<td>'+esc(w.make||'--')+'</td><td>'+esc(w.model||'--')+'</td><td>'+esc(w.caliber||'--')+'</td><td>'+esc(w.type||'--')+'</td><td>'+pr+'</td>';
    h += '<td>'+(w.url?'<a href="'+escAttr(safeHref(w.url))+'" target="_blank" rel="noopener" onclick="event.stopPropagation()" style="color:var(--accent);">'+esc(w.dealer||'Link')+'</a>':esc(w.dealer||'--'))+'</td>';
    h += '<td>'+fmtDate(w.dateAdded)+'</td>';
    h += '<td style="text-align:right;white-space:nowrap;"><button class="btn btn-small btn-primary" onclick="event.stopPropagation();moveWishlistToCollection(\''+w.id+'\')">Buy</button> <button class="btn btn-small btn-danger" onclick="event.stopPropagation();deleteWishlistItem(\''+w.id+'\')">Del</button></td></tr>';
    if (rteShow(w.notes)) h += '<tr class="wishlist-note-row" style="cursor:pointer;" onclick="openWishlistModal(\''+w.id+'\')"><td colspan="9"><div class="rte-display wishlist-note">' + w.notes + '</div></td></tr>';
  });
  h += '</tbody></table>';
  document.getElementById('tableContainer').innerHTML = h;
}

// =====================================================
// FFL DEALERS
// =====================================================
let editingDealerId = null;

function openDealerModal(editId) {
  editingDealerId = editId || null;
  document.getElementById('dealerModalTitle').textContent = editId ? 'Edit Dealer' : 'Add FFL Dealer';
  if (editId) {
    const d = db.dealers.find(x => x.id === editId);
    if (!d) return;
    document.getElementById('dName').value = d.name || '';
    document.getElementById('dFFL').value = d.ffl || '';
    document.getElementById('dPhone').value = d.phone || '';
    document.getElementById('dEmail').value = d.email || '';
    document.getElementById('dAddress').value = d.address || '';
    document.getElementById('dWebsite').value = d.website || '';
    document.getElementById('dNotes').innerHTML = d.notes || '';
  } else {
    ['dName','dFFL','dPhone','dEmail','dAddress','dWebsite'].forEach(id => document.getElementById(id).value = '');
    document.getElementById('dNotes').innerHTML = '';
  }
  document.getElementById('dealerModal').classList.add('open');
}

function closeDealerModal() { document.getElementById('dealerModal').classList.remove('open'); editingDealerId = null; }

async function saveDealer() {
  const name = document.getElementById('dName').value.trim();
  if (!name) { toast('Enter a dealer name.'); return; }
  let notes = document.getElementById('dNotes').innerHTML.trim();
  if (notes === '<br>') notes = ''; // contenteditable leaves a stray <br> when emptied
  const existing = editingDealerId ? db.dealers.find(x => x.id === editingDealerId) : null;
  const data = { id: editingDealerId || generateId(), name, ffl: document.getElementById('dFFL').value.trim(), phone: document.getElementById('dPhone').value.trim(), email: document.getElementById('dEmail').value.trim(), address: document.getElementById('dAddress').value.trim(), website: document.getElementById('dWebsite').value.trim(), notes, favorite: existing ? !!existing.favorite : false };
  if (editingDealerId) { const i = db.dealers.findIndex(x => x.id === editingDealerId); if (i > -1) db.dealers[i] = data; addAuditEntry('edit','dealer',name,''); }
  else { db.dealers.push(data); addAuditEntry('create','dealer',name,''); }
  await saveData(); render(); closeDealerModal();
}

async function deleteDealer(id) {
  if (!await confirmDialog('Delete this dealer?', { title: 'Delete dealer', okText: 'Delete', danger: true })) return;
  const d = db.dealers.find(x => x.id === id);
  addAuditEntry('delete','dealer',d?d.name:'Unknown','');
  db.dealers = db.dealers.filter(x => x.id !== id); saveData(); render();
}

// Toggle a dealer's "preferred" flag; favorites sort to the top of the list.
function toggleDealerFavorite(id) {
  const d = db.dealers.find(x => x.id === id);
  if (!d) return;
  d.favorite = !d.favorite;
  saveData(); render();
}

// ---- Bulk import -------------------------------------------------------
// FICTIONAL sample dealers — included only to demonstrate the import and the
// dealer-directory features. Every name, address, and phone number is made up
// (555 phone prefix and placeholder "Anytown, ST 00000" addresses). FFL license
// numbers are intentionally blank; real ones must be verified via the ATF FFL
// eZ Check. Each dealer card gets a "Look up FFL #" link.
const SAMPLE_FFL_DEALERS = [
  { name: "Cedar Creek Firearms", phone: "(555) 012-3401", address: "100 Main St, Anytown, ST 00000", website: "https://example.com", notes: "Sample dealer — full-service gun shop & transfers." },
  { name: "Liberty Arms & Indoor Range", phone: "(555) 012-3402", address: "248 Range Rd, Lake Haven, ST 00000", website: "https://example.com", notes: "Sample dealer — retail, indoor range & CCW classes." },
  { name: "Old Glory Gun Co.", phone: "(555) 012-3403", address: "57 Liberty Ave, Cedar Falls, ST 00000", website: "", notes: "Sample dealer — sporting & hunting firearms." },
  { name: "Frontier Defense & Supply", phone: "(555) 012-3404", address: "1203 Frontier Blvd, Pine Ridge, ST 00000", website: "https://example.com", notes: "Sample dealer — tactical gear & NFA items." },
  { name: "Summit Outfitters", phone: "(555) 012-3405", address: "9 Summit Way, Riverbend, ST 00000", website: "", notes: "Sample dealer — outdoor outfitter with a firearms counter." },
  { name: "Patriot Pawn & Firearms", phone: "(555) 012-3406", address: "640 Commerce St, Fort Sterling, ST 00000", website: "", notes: "Sample dealer — buys, sells & transfers." },
  { name: "Ironwood Tactical", phone: "(555) 012-3407", address: "315 Industrial Pkwy, Junction City, ST 00000", website: "https://example.com", notes: "Sample dealer — gunsmithing & custom builds." },
  { name: "Lakeside Sporting Goods", phone: "(555) 012-3408", address: "82 Harbor Dr, Bayport, ST 00000", website: "", notes: "Sample dealer — sporting goods & ammunition." }
];

function _dealerKey(d) { return ((d.name || '') + '|' + (d.address || '')).toLowerCase().replace(/\s+/g, ' ').trim(); }

// Merge a list of raw dealer objects into db.dealers, skipping blanks and
// duplicates (matched on name + address). Returns { added, skipped }.
function mergeDealers(list) {
  if (!Array.isArray(list)) return { added: 0, skipped: 0 };
  if (!db.dealers) db.dealers = [];
  const seen = new Set(db.dealers.map(_dealerKey));
  let added = 0, skipped = 0;
  list.forEach(raw => {
    const name = (raw && raw.name != null ? String(raw.name) : '').trim();
    if (!name) { skipped++; return; }
    const d = {
      id: generateId(),
      name,
      ffl: (raw.ffl != null ? String(raw.ffl) : '').trim(),
      phone: (raw.phone != null ? String(raw.phone) : '').trim(),
      email: (raw.email != null ? String(raw.email) : '').trim(),
      address: (raw.address != null ? String(raw.address) : '').trim(),
      website: (raw.website != null ? String(raw.website) : '').trim(),
      notes: (raw.notes != null ? String(raw.notes) : '').trim()
    };
    const key = _dealerKey(d);
    if (seen.has(key)) { skipped++; return; }
    seen.add(key);
    db.dealers.push(d);
    added++;
  });
  if (added) addAuditEntry('import', 'dealer', added + ' dealers', '');
  return { added, skipped };
}

function openDealerImportModal() {
  const ta = document.getElementById('dealerImportText'); if (ta) ta.value = '';
  document.getElementById('dealerImportModal').classList.add('open');
}
function closeDealerImportModal() { document.getElementById('dealerImportModal').classList.remove('open'); }

async function loadSampleDealers() {
  const r = mergeDealers(SAMPLE_FFL_DEALERS);
  if (r.added) { await saveData(); render(); }
  closeDealerImportModal();
  toast(r.added + ' dealer' + (r.added === 1 ? '' : 's') + ' added' + (r.skipped ? ', ' + r.skipped + ' already present' : '') + '.');
}

async function importDealersFromText() {
  const txt = document.getElementById('dealerImportText').value.trim();
  if (!txt) { toast('Paste dealer JSON first.'); return; }
  let parsed;
  try { parsed = JSON.parse(txt); }
  catch (e) { toast('Could not parse JSON — check the format.'); return; }
  const list = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.dealers) ? parsed.dealers : null);
  if (!list) { toast('Expected a JSON array of dealer objects.'); return; }
  const r = mergeDealers(list);
  if (r.added) { await saveData(); render(); closeDealerImportModal(); }
  toast(r.added + ' imported' + (r.skipped ? ', ' + r.skipped + ' skipped (duplicate/blank)' : '') + '.');
}

// ---- Dealer filtering --------------------------------------------------
let _dealerFilterQ = '', _dealerFilterArea = 'all', _dealerSort = 'fav';

// Derive an area bucket from a dealer's address — the city segment — so the
// area filter works for any list of dealers. "Street, City, ST ZIP" => "City";
// falls back to "Other" when a city can't be determined.
function dealerArea(d) {
  const parts = String(d.address || '').split(',').map(s => s.trim()).filter(Boolean);
  if (parts.length >= 3) return parts[parts.length - 2] || 'Other';
  if (parts.length === 2) return parts[0] || 'Other';
  return 'Other';
}

// Google search that surfaces the dealer's current ATF FFL license number.
function dealerFFLLookupUrl(d) {
  return 'https://www.google.com/search?q=' + encodeURIComponent(((d.name || '') + ' ' + (d.address || '')).trim() + ' FFL license number');
}

function setDealerArea(area) {
  _dealerFilterArea = area;
  document.querySelectorAll('.dealer-chip').forEach(c => c.classList.toggle('active', c.dataset.area === area));
  applyDealerFilter();
}

function setDealerSort(v) { _dealerSort = v; renderDealersTab(); }

// Filter the already-rendered cards in place (keeps search-box focus, no rebuild).
function applyDealerFilter() {
  const input = document.getElementById('dealerSearch');
  if (input) _dealerFilterQ = input.value.trim().toLowerCase();
  let shown = 0;
  document.querySelectorAll('#dealerGrid .ffl-card').forEach(card => {
    const okArea = _dealerFilterArea === 'all' || card.dataset.area === _dealerFilterArea;
    const okText = !_dealerFilterQ || (card.dataset.text || '').indexOf(_dealerFilterQ) > -1;
    const show = okArea && okText;
    card.style.display = show ? '' : 'none';
    if (show) shown++;
  });
  const noMatch = document.getElementById('dealerNoMatch');
  if (noMatch) noMatch.style.display = shown ? 'none' : 'block';
  const cnt = document.getElementById('dealerShownCount');
  if (cnt) cnt.textContent = shown;
}

function renderDealersTab() {
  document.getElementById('cardGrid').style.display = 'none';
  document.getElementById('tableContainer').style.display = 'block';
  document.getElementById('emptyState').style.display = 'none';
  const items = db.dealers || [];
  let h = '<div style="padding:16px 24px;background:var(--bg2);border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;">'
    + '<span style="font-size:0.86rem;font-weight:600;">FFL Dealers: <span style="color:var(--accent);" id="dealerShownCount">' + items.length + '</span></span>'
    + '<button class="btn btn-small btn-secondary" onclick="openDealerImportModal()">⬇️ Import dealers</button>'
    + '</div>';
  if (items.length === 0) { h += tabEmpty('🏢', 'No dealers saved yet', 'Add your go-to FFLs, or load the built-in sample dealers to see how it works.', '<button class="btn btn-primary" onclick="openDealerImportModal()">⬇️ Import dealers</button>'); document.getElementById('tableContainer').innerHTML = h; return; }

  // Area counts for the filter chips
  const counts = {}; items.forEach(d => { const a = dealerArea(d); counts[a] = (counts[a] || 0) + 1; });
  if (_dealerFilterArea !== 'all' && !counts[_dealerFilterArea]) _dealerFilterArea = 'all';
  const labelFor = a => a === 'all' ? 'All' : a;
  const chip = (area, n) => '<button class="dealer-chip' + (_dealerFilterArea === area ? ' active' : '') + '" data-area="' + area + '" onclick="setDealerArea(\'' + area + '\')">' + labelFor(area) + ' <span class="dealer-chip-n">' + n + '</span></button>';
  let chips = chip('all', items.length);
  // Areas present, alphabetical, with "Other" last.
  Object.keys(counts).sort((a, b) => a === 'Other' ? 1 : b === 'Other' ? -1 : a.localeCompare(b)).forEach(a => { chips += chip(a, counts[a]); });

  const sortSel = '<select class="dealer-sort" onchange="setDealerSort(this.value)" title="Sort dealers">'
    + [['fav', 'Preferred first'], ['name', 'Name (A–Z)'], ['region', 'Area']].map(o =>
        '<option value="' + o[0] + '"' + (_dealerSort === o[0] ? ' selected' : '') + '>' + o[1] + '</option>').join('')
    + '</select>';
  h += '<div class="dealer-filterbar">'
    + '<input type="text" id="dealerSearch" class="dealer-search" placeholder="Search name, city, notes…" oninput="applyDealerFilter()" value="' + escAttr(_dealerFilterQ) + '">'
    + '<div class="dealer-chips">' + chips + '</div>'
    + sortSel + '</div>';

  h += '<div id="dealerGrid" style="padding:16px 24px;display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,300px),1fr));gap:12px;">';
  const byName = (a, b) => (a.name || '').localeCompare(b.name || '');
  const ordered = [...items];
  if (_dealerSort === 'name') ordered.sort(byName);
  else if (_dealerSort === 'region') ordered.sort((a, b) => dealerArea(a).localeCompare(dealerArea(b)) || byName(a, b));
  else ordered.sort((a, b) => (b.favorite ? 1 : 0) - (a.favorite ? 1 : 0)); // 'fav' (default): preferred first
  ordered.forEach(d => {
    const area = dealerArea(d);
    const notesText = (d.notes || '').replace(/<[^>]*>/g, ' '); // strip rich-text tags for search
    const text = ((d.name || '') + ' ' + (d.address || '') + ' ' + (d.phone || '') + ' ' + (d.email || '') + ' ' + notesText + ' ' + (d.ffl || '')).toLowerCase();
    h += '<div class="ffl-card' + (d.favorite ? ' is-fav' : '') + '" data-area="' + area + '" data-text="' + escAttr(text) + '" style="cursor:pointer;" onclick="openDealerModal(\'' + d.id + '\')">';
    h += '<span class="ffl-area-badge">' + esc(labelFor(area)) + '</span>';
    h += '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;"><h4>' + esc(d.name) + '</h4>'
      + '<div style="display:flex;gap:4px;align-items:center;flex-shrink:0;">'
      + '<button class="dealer-fav' + (d.favorite ? ' active' : '') + '" title="' + (d.favorite ? 'Remove from preferred' : 'Mark as preferred') + '" aria-label="' + (d.favorite ? 'Remove from preferred dealers' : 'Mark as preferred dealer') + '" aria-pressed="' + (d.favorite ? 'true' : 'false') + '" onclick="event.stopPropagation();toggleDealerFavorite(\'' + d.id + '\')">' + (d.favorite ? '★' : '☆') + '</button>'
      + '<button class="btn btn-small btn-danger" onclick="event.stopPropagation();deleteDealer(\'' + d.id + '\')">Del</button>'
      + '</div></div>';
    if (d.ffl) h += '<div class="ffl-detail">FFL: ' + esc(d.ffl) + ' · <a href="https://fflezcheck.atf.gov/" target="_blank" rel="noopener" onclick="event.stopPropagation()" style="color:var(--accent);">verify</a></div>';
    else h += '<div class="ffl-detail"><a href="' + esc(dealerFFLLookupUrl(d)) + '" target="_blank" rel="noopener" onclick="event.stopPropagation()" style="color:var(--accent);">🔎 Look up FFL #</a></div>';
    if (d.phone) h += '<div class="ffl-detail">Phone: ' + esc(d.phone) + '</div>';
    if (d.email) h += '<div class="ffl-detail">Email: ' + esc(d.email) + '</div>';
    if (d.address) h += '<div class="ffl-detail">' + esc(d.address) + '</div>';
    if (d.website) h += '<div class="ffl-detail"><a href="' + escAttr(safeHref(d.website)) + '" target="_blank" rel="noopener" onclick="event.stopPropagation()" style="color:var(--accent);">Website</a></div>';
    if (d.notes && d.notes !== '<br>') h += '<div class="ffl-detail dealer-notes">' + d.notes + '</div>';
    h += '</div>';
  });
  h += '</div>';
  h += '<div id="dealerNoMatch" style="display:none;text-align:center;padding:30px;color:var(--text2);">No dealers match your filter.</div>';
  document.getElementById('tableContainer').innerHTML = h;
  applyDealerFilter();
}

// =====================================================
// ROUND COUNT, WARRANTY, CUSTOM FIELDS
// =====================================================
let tempCustomFields = [];

function addCustomField(name, value) {
  tempCustomFields.push({ name: name || '', value: value || '' });
  renderCustomFields();
}

function removeCustomField(idx) { tempCustomFields.splice(idx, 1); renderCustomFields(); }

function renderCustomFields() {
  const c = document.getElementById('customFieldsContainer');
  c.innerHTML = tempCustomFields.map((f, i) =>
    '<div class="custom-field-row"><input type="text" placeholder="Field name" value="'+esc(f.name)+'" onchange="tempCustomFields['+i+'].name=this.value"><input type="text" placeholder="Value" value="'+esc(f.value)+'" onchange="tempCustomFields['+i+'].value=this.value"><button type="button" onclick="removeCustomField('+i+')">&times;</button></div>'
  ).join('');
}

function getWarrantyStatus(dateStr) {
  if (!dateStr) return null;
  const exp = new Date(dateStr);
  const now = new Date();
  const diff = (exp - now) / 86400000;
  if (diff < 0) return 'expired';
  if (diff < 90) return 'soon';
  return 'ok';
}

// =====================================================
// IMAGE CROP/ROTATE
// =====================================================
let cropImageData = null;
let cropImageId = null;
let cropRotation = 0;
let cropFlipH = false;
let cropFlipV = false;

function openCropModal(imgId) {
  cropImageId = imgId;
  cropRotation = 0; cropFlipH = false; cropFlipV = false;
  cropImageData = imagesDb[imgId];
  drawCropCanvas();
  document.getElementById('cropModal').classList.add('open');
}

function closeCropModal() { document.getElementById('cropModal').classList.remove('open'); cropImageData = null; cropImageId = null; }

function drawCropCanvas() {
  const canvas = document.getElementById('cropCanvas');
  const ctx = canvas.getContext('2d');
  const img = new Image();
  img.onload = () => {
    const isRotated = Math.abs(cropRotation) % 180 !== 0;
    canvas.width = isRotated ? img.height : img.width;
    canvas.height = isRotated ? img.width : img.height;
    if (canvas.width > 550) { const scale = 550/canvas.width; canvas.width *= scale; canvas.height *= scale; }
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.save();
    ctx.translate(canvas.width/2, canvas.height/2);
    ctx.rotate(cropRotation * Math.PI / 180);
    ctx.scale(cropFlipH ? -1 : 1, cropFlipV ? -1 : 1);
    const dw = isRotated ? canvas.height : canvas.width;
    const dh = isRotated ? canvas.width : canvas.height;
    ctx.drawImage(img, -dw/2, -dh/2, dw, dh);
    ctx.restore();
  };
  img.src = cropImageData;
}

function rotateImage(deg) { cropRotation = (cropRotation + deg) % 360; drawCropCanvas(); }
function flipImage(dir) { if (dir === 'h') cropFlipH = !cropFlipH; else cropFlipV = !cropFlipV; drawCropCanvas(); }

async function applyCrop() {
  const canvas = document.getElementById('cropCanvas');
  const newData = canvas.toDataURL('image/jpeg', 0.9);
  imagesDb[cropImageId] = newData;
  await idbPut(cropImageId, newData);
  closeCropModal();
  renderImageGallery();
}

// =====================================================
// QR CODE GENERATION
// =====================================================
let currentQRFirearmId = null;
let currentQRInstance = null;

function generateQR(firearmId) {
  const f = db.firearms.find(x => x.id === firearmId);
  if (!f) return;
  currentQRFirearmId = firearmId;
  const qrData = JSON.stringify({ id: f.id, make: f.make, model: f.model, serial: f.serial, caliber: f.caliber, type: f.type });
  const container = document.getElementById('qrContainer');
  container.innerHTML = '';
  if (typeof QRCode !== 'undefined') {
    currentQRInstance = new QRCode(container, {
      text: qrData,
      width: 250,
      height: 250,
      colorDark: '#1a3a5c',
      colorLight: '#ffffff',
      correctLevel: QRCode.CorrectLevel.M
    });
  }
  document.getElementById('qrLabel').textContent = (f.make||'')+' '+(f.model||'')+' \u2014 '+(f.serial||'N/A');
  document.getElementById('qrModal').classList.add('open');
}

function closeQRModal() { document.getElementById('qrModal').classList.remove('open'); currentQRFirearmId = null; currentQRInstance = null; }

function getQRDataURL() {
  const container = document.getElementById('qrContainer');
  const canvas = container.querySelector('canvas');
  if (canvas) return canvas.toDataURL('image/png');
  const img = container.querySelector('img');
  if (img) return img.src;
  return null;
}

function downloadQR() {
  const dataUrl = getQRDataURL();
  if (!dataUrl) { toast('No QR code to download.'); return; }
  const f = db.firearms.find(x => x.id === currentQRFirearmId);
  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = 'QR_' + (f ? (f.make+'_'+f.model).replace(/\s+/g,'_') : 'firearm') + '.png';
  a.click();
}

function printQR() {
  const dataUrl = getQRDataURL();
  if (!dataUrl) return;
  const f = db.firearms.find(x => x.id === currentQRFirearmId);
  const w = window.open();
  w.document.write('<html><head><title>QR Code</title></head><body style="text-align:center;padding:40px;font-family:sans-serif;"><h2>'+esc(f?(f.make||'')+' '+(f.model||''):'Firearm')+'</h2><p>Serial: '+esc(f?f.serial||'N/A':'')+'</p><img src="'+dataUrl+'" style="width:250px;height:250px;"><br><br><button onclick="window.print()">Print</button></body></html>');
}

// =====================================================
// KEYBOARD SHORTCUTS
// =====================================================
function showShortcutsHelp() { document.getElementById('shortcutsModal').classList.add('open'); }
function closeShortcutsModal() { document.getElementById('shortcutsModal').classList.remove('open'); }

// =====================================================
// CSV IMPORT
// =====================================================
function importCSV() { document.getElementById('csvImportFile').click(); }

function handleCSVImport(event) {
  const file = event.target.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = async (e) => {
    try {
      const text = e.target.result;
      const sep = text.includes('\t') ? '\t' : ',';
      const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
      if (lines.length < 2) { toast('CSV must have a header row and at least one data row.'); return; }
      const headers = lines[0].split(sep).map(h => h.replace(/^"|"$/g,'').trim().toLowerCase());
      const firearms = [];
      for (let i = 1; i < lines.length; i++) {
        const vals = lines[i].split(sep).map(v => v.replace(/^"|"$/g,'').trim());
        const row = {};
        headers.forEach((h, idx) => { row[h] = vals[idx] || ''; });
        const f = {
          id: generateId(),
          make: row.make || row.manufacturer || '',
          model: row.model || '',
          serial: row.serial || row['serial number'] || row['serial #'] || '',
          caliber: row.caliber || row.gauge || row['caliber/gauge'] || '',
          type: row.type || 'Other',
          barrel: row.barrel || row['barrel length'] || '',
          dateAcquired: row['date acquired'] || row.acquired || row.date || '',
          price: row.price || row['purchase price'] || '',
          condition: row.condition || 'Good',
          status: row.status || 'Active',
          notes: row.notes || '',
          images: [], tags: row.tags ? row.tags.split(',').map(t=>t.trim()) : [],
          isNFA: (row.nfa||'').toLowerCase() === 'yes',
          maintenanceLog: [], roundCount: parseInt(row['round count'])||0,
          customFields: []
        };
        if (f.make || f.model) firearms.push(f);
      }
      if (firearms.length === 0) { toast('No valid rows found.'); return; }
      if (await confirmDialog('Import ' + firearms.length + ' firearm(s) from CSV? This will ADD to your existing database.', { title: 'Import from CSV', okText: 'Import' })) {
        firearms.forEach(f => db.firearms.push(f));
        addAuditEntry('create','import',firearms.length+' firearms','CSV import');
        await saveData(); render();
        toast('Imported ' + firearms.length + ' firearm(s) from CSV.');
      }
    } catch (err) { toast('CSV parse error: ' + err.message); }
  };
  reader.readAsText(file); event.target.value = '';
}

// =====================================================
// PRINT INVENTORY
// =====================================================
function printInventory() {
  document.getElementById('printDate').textContent = new Date().toLocaleString();
  window.print();
}

// =====================================================
// DUPLICATE FIREARM
// =====================================================
function duplicateFirearm(id) {
  const f = db.firearms.find(x => x.id === id);
  if (!f) return;
  const clone = JSON.parse(JSON.stringify(f));
  clone.id = generateId();
  clone.serial = '';
  clone.maintenanceLog = [];
  clone.roundCount = 0;
  clone.notes = (clone.notes || '') + (clone.notes ? '<br>' : '') + '<em>Duplicated from ' + esc((f.make||'')+' '+(f.model||'')) + '</em>';
  db.firearms.push(clone);
  addAuditEntry('create','firearm',(clone.make||'')+' '+(clone.model||''),'Duplicated from '+f.serial);
  saveData(); render();
  toast('Duplicated! Edit the new entry to update the serial number.');
}

// =====================================================
// CARD VIEW SORTING
// =====================================================
function getCardSortedItems(items) {
  const sortVal = document.getElementById('cardSort').value;
  if (!sortVal) return items;
  const [key, dir] = sortVal.split('-');
  return [...items].sort((a, b) => {
    let va = a[key] || '', vb = b[key] || '';
    if (key === 'price') { va = parseFloat(va)||0; vb = parseFloat(vb)||0; }
    else { va = String(va).toLowerCase(); vb = String(vb).toLowerCase(); }
    return va < vb ? (dir==='asc'?-1:1) : va > vb ? (dir==='asc'?1:-1) : 0;
  });
}

// =====================================================
// AMMO LOW-STOCK ALERTS
// =====================================================
function isLowStock(ammo) {
  if (!ammo.lowStock || parseInt(ammo.lowStock) <= 0) return false;
  return (parseInt(ammo.quantity) || 0) <= parseInt(ammo.lowStock);
}

// =====================================================
// CUSTOM REPORT BUILDER
// =====================================================
const REPORT_FIELDS = [
  {key:'make',label:'Make'},{key:'model',label:'Model'},{key:'serial',label:'Serial #'},
  {key:'caliber',label:'Caliber'},{key:'type',label:'Type'},{key:'barrel',label:'Barrel Length'},
  {key:'dateAcquired',label:'Date Acquired'},{key:'price',label:'Purchase Price'},{key:'condition',label:'Condition'},
  {key:'status',label:'Status'},{key:'roundCount',label:'Round Count'},{key:'tags',label:'Tags'},
  {key:'notes',label:'Notes'},{key:'warrantyExp',label:'Warranty'}
];

function openReportBuilder() {
  const list = document.getElementById('reportFieldList');
  list.innerHTML = REPORT_FIELDS.map(f =>
    '<label class="report-field-item"><input type="checkbox" data-field="'+f.key+'" '+((['make','model','serial','caliber','type','price','condition'].includes(f.key))?'checked':'')+'>'+f.label+'</label>'
  ).join('');
  document.getElementById('reportBuilderModal').classList.add('open');
}

function closeReportBuilder() { document.getElementById('reportBuilderModal').classList.remove('open'); }

function generateCustomReport() {
  const fields = [];
  document.querySelectorAll('#reportFieldList input[type="checkbox"]:checked').forEach(cb => {
    const f = REPORT_FIELDS.find(x => x.key === cb.dataset.field);
    if (f) fields.push(f);
  });
  if (fields.length === 0) { toast('Select at least one field.'); return; }
  const format = document.querySelector('input[name="rptFormat"]:checked').value;
  const title = document.getElementById('reportTitle').value.trim() || 'Firearms Report';
  const includeNFA = document.getElementById('rptNFA').checked;
  const includeAmmo = document.getElementById('rptAmmo').checked;
  const includeAcc = document.getElementById('rptAcc').checked;
  const includeDisposed = document.getElementById('rptDisposed').checked;

  let firearms = db.firearms.filter(f => !f.status || f.status === 'Active');
  if (includeDisposed) firearms = db.firearms;

  if (format === 'excel') {
    const wb = XLSX.utils.book_new();
    const rows = firearms.map(f => {
      const row = {};
      fields.forEach(fld => {
        let v = f[fld.key];
        if (fld.key === 'tags') v = (f.tags||[]).join(', ');
        else if (fld.key === 'notes') v = (f.notes||'').replace(/<[^>]*>/g,'');
        else if (fld.key === 'price' && v) v = parseFloat(v);
        row[fld.label] = v || '';
      });
      return row;
    });
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'Firearms');
    if (includeNFA) { const nr = db.firearms.filter(f=>f.isNFA).map(f=>({Make:f.make,Model:f.model,Serial:f.serial,'NFA Type':f.nfaType,'Form':f.formType,'Status':f.stampStatus,'Submitted':fmtDate(f.dateSubmitted),'Approved':fmtDate(f.dateApproved)})); if(nr.length) XLSX.utils.book_append_sheet(wb,XLSX.utils.json_to_sheet(nr),'NFA Items'); }
    if (includeAmmo) { const ar = db.ammo.map(a=>({Caliber:a.caliber,Brand:a.brand,Qty:a.quantity,Location:a.location,'Price/Rd':a.pricePerRound})); if(ar.length) XLSX.utils.book_append_sheet(wb,XLSX.utils.json_to_sheet(ar),'Ammunition'); }
    if (includeAcc) { const acr = db.accessories.map(a=>({Name:a.name,Category:a.category,Brand:a.brand,Price:a.price,'Assigned To':getFirearmLabel(a.firearmId)})); if(acr.length) XLSX.utils.book_append_sheet(wb,XLSX.utils.json_to_sheet(acr),'Accessories'); }
    XLSX.writeFile(wb, title.replace(/\s+/g,'_') + '_' + new Date().toISOString().slice(0,10) + '.xlsx');
  } else {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation: fields.length > 8 ? 'landscape' : 'portrait' });
    doc.setFontSize(16); doc.text(title, 14, 15);
    doc.setFontSize(10); doc.text('Generated: ' + new Date().toLocaleString(), 14, 25);
    const head = fields.map(f => f.label);
    const body = firearms.map(f => fields.map(fld => {
      if (fld.key === 'tags') return (f.tags||[]).join(', ');
      if (fld.key === 'notes') return (f.notes||'').replace(/<[^>]*>/g,'').substring(0,60);
      if (fld.key === 'price') return f.price ? money(f.price) : '--';
      if (fld.key === 'dateAcquired') return fmtDate(f.dateAcquired);
      return f[fld.key] || '--';
    }));
    doc.autoTable({ head: [head], body, startY: 35, theme: 'grid', styles: { fontSize: 7 } });
    let fy = doc.lastAutoTable.finalY + 10;
    const totalVal = firearms.reduce((s,f)=>s+(parseFloat(f.price)||0),0);
    doc.setFontSize(11); doc.setFont(undefined,'bold');
    doc.text('Total Value: '+money(totalVal), 14, fy);
    doc.save(title.replace(/\s+/g,'_') + '_' + new Date().toISOString().slice(0,10) + '.pdf');
  }
  closeReportBuilder();
}

// =====================================================
// ATF BOUND BOOK EXPORT
// =====================================================
function exportATFBoundBook() {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF('landscape');
  doc.setFontSize(14); doc.text('Acquisition & Disposition Record (Bound Book Format)', 14, 15);
  doc.setFontSize(8); doc.text('Generated: ' + new Date().toLocaleString() + '  |  FOR PERSONAL RECORDS ONLY - NOT AN OFFICIAL ATF DOCUMENT', 14, 22);
  const rows = db.firearms.map(f => {
    const acq = fmtDate(f.dateAcquired);
    const disp = f.status && f.status !== 'Active' ? fmtDate(f.dispDate) : '';
    const buyer = f.status && f.status !== 'Active' ? (f.dispBuyer||'') : '';
    const ffl = f.status && f.status !== 'Active' ? (f.dispFFL||'') : '';
    return [f.make||'', f.model||'', f.serial||'', f.caliber||'', f.type||'', acq, f.price?money(f.price):'', f.condition||'', f.status||'Active', disp, buyer, ffl];
  });
  doc.autoTable({
    head: [['Manufacturer','Model','Serial Number','Caliber','Type','Date Acquired','Price','Condition','Status','Date Disposed','Transferee','FFL Dealer']],
    body: rows, startY: 28, theme: 'grid',
    styles: { fontSize: 6.5, cellPadding: 2 },
    headStyles: { fillColor: [26,58,92], fontSize: 6, fontStyle: 'bold' }
  });
  doc.save('ATF_Bound_Book_' + new Date().toISOString().slice(0,10) + '.pdf');
}

// =====================================================
// VALUE HISTORY CHART (for dashboard)
// =====================================================
function renderValueChart() {
  const hist = db.valueHistory || [];
  if (hist.length < 2) return '<div style="color:var(--text3);font-size:0.82rem;padding:8px;">Not enough data yet. Value history builds over time.</div>';
  const recent = hist.slice(-30);
  const maxVal = Math.max(...recent.map(h => h.value), 1);
  let bars = recent.map(h => {
    const pct = (h.value / maxVal * 100).toFixed(1);
    const d = h.date.slice(5);
    return '<div class="value-chart-bar" style="height:'+pct+'%;" title="$'+h.value.toLocaleString()+' on '+h.date+'"><span class="value-chart-val">$'+(h.value/1000).toFixed(1)+'k</span><span class="value-chart-label">'+d+'</span></div>';
  }).join('');
  return '<div class="value-chart" style="margin-bottom:24px;">'+bars+'</div>';
}



// =====================================================
// INDEXEDDB AUTO-SAVE (replaces localStorage - no size limit)
// =====================================================
const STATE_IDB_NAME = 'FirearmsDB_State';
const STATE_IDB_VERSION = 1;
const STATE_IDB_STORE = 'state';
let stateStore = null;
const LS_SORT_KEY = 'firearms_db_sort';
let hasUnsavedChanges = false;

function openStateDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(STATE_IDB_NAME, STATE_IDB_VERSION);
    req.onupgradeneeded = (e) => {
      const idb = e.target.result;
      if (!idb.objectStoreNames.contains(STATE_IDB_STORE)) {
        idb.createObjectStore(STATE_IDB_STORE);
      }
    };
    req.onsuccess = (e) => { stateStore = e.target.result; resolve(stateStore); };
    req.onerror = (e) => { console.error('State IndexedDB error:', e); reject(e); };
  });
}

function statePut(key, value) {
  return new Promise((resolve, reject) => {
    const tx = stateStore.transaction(STATE_IDB_STORE, 'readwrite');
    const store = tx.objectStore(STATE_IDB_STORE);
    const req = store.put(value, key);
    req.onsuccess = () => resolve();
    req.onerror = (e) => reject(e);
  });
}

function stateGet(key) {
  return new Promise((resolve, reject) => {
    const tx = stateStore.transaction(STATE_IDB_STORE, 'readonly');
    const store = tx.objectStore(STATE_IDB_STORE);
    const req = store.get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = (e) => reject(e);
  });
}

async function saveToLocalStorage() {
  try {
    // Save full db (without backups) to IndexedDB - handles any size
    const saveObj = Object.assign({}, db);
    delete saveObj.backups;
    await statePut('db', saveObj);
    if (window.CloudSync && CloudSync.ready) CloudSync.schedulePush();
    hasUnsavedChanges = true;
    console.log('Auto-saved to IndexedDB');
  } catch (e) {
    console.warn('IndexedDB state save failed:', e.message);
  }
}

async function loadFromLocalStorage() {
  try {
    const data = await stateGet('db');
    if (!data) return false;
    if (!data.firearms || data.firearms.length === 0) return false;
    // Saved state takes priority over embedded data
    db.firearms = data.firearms;
    db.ammo = data.ammo || db.ammo;
    db.accessories = data.accessories || db.accessories;
    db.wishlist = data.wishlist || db.wishlist || [];
    db.dealers = data.dealers || db.dealers || [];
    db.auditTrail = data.auditTrail || db.auditTrail || [];
    db.valueHistory = data.valueHistory || db.valueHistory || [];
    db.settings = data.settings || db.settings || {};
    // Ensure fields
    db.firearms.forEach(f => {
      if (!f.tags) f.tags = [];
      if (!f.roundCount) f.roundCount = 0;
      if (!f.customFields) f.customFields = [];
    });
    db.ammo.forEach(a => { if (!a.lowStock) a.lowStock = 0; });
    console.log('Loaded saved state from IndexedDB');
    return true;
  } catch (e) {
    console.warn('IndexedDB state load failed:', e);
    return false;
  }
}

function saveSortPreference() {
  try {
    localStorage.setItem(LS_SORT_KEY, JSON.stringify({
      col: sortCol, dir: sortDir,
      cardSort: document.getElementById('cardSort').value,
      view: currentView
    }));
  } catch(e) {}
}

function loadSortPreference() {
  try {
    const saved = localStorage.getItem(LS_SORT_KEY);
    if (!saved) return;
    const pref = JSON.parse(saved);
    if (pref.col) sortCol = pref.col;
    if (pref.dir) sortDir = pref.dir;
    if (pref.cardSort) document.getElementById('cardSort').value = pref.cardSort;
    if (pref.view) { currentView = pref.view; setView(currentView); }
  } catch(e) {}
}

// =====================================================
// UNSAVED CHANGES WARNING
// =====================================================
window.addEventListener('beforeunload', (e) => {
  if (hasUnsavedChanges) {
    e.preventDefault();
    e.returnValue = 'You have unsaved changes. Use "Backup Now" or "Save to File" to export your data before leaving.';
    return e.returnValue;
  }
});

// =====================================================
// DUPLICATE SERIAL CHECK
// =====================================================
function checkDuplicateSerial() {
  const serial = document.getElementById('fSerial').value.trim();
  const warning = document.getElementById('serialWarning');
  if (!serial) { warning.style.display = 'none'; return; }
  const dupe = db.firearms.find(f => f.serial && f.serial.toLowerCase() === serial.toLowerCase() && f.id !== editingId);
  if (dupe) {
    warning.textContent = 'Duplicate serial! Already exists on: ' + (dupe.make||'') + ' ' + (dupe.model||'');
    warning.style.display = 'block';
  } else {
    warning.style.display = 'none';
  }
}

// =====================================================
// IMAGE COMPRESSION
// =====================================================
function compressImage(dataUrl, maxWidth, quality) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      let w = img.width, h = img.height;
      if (w > maxWidth) { h = h * maxWidth / w; w = maxWidth; }
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, w, h);
      resolve(canvas.toDataURL('image/jpeg', quality));
    };
    img.src = dataUrl;
  });
}

// =====================================================
// TOTAL INVESTMENT CALCULATOR
// =====================================================
function getTotalInvestment(firearmId) {
  const f = db.firearms.find(x => x.id === firearmId);
  if (!f) return 0;
  const fPrice = parseFloat(f.price) || 0;
  const accPrice = db.accessories
    .filter(a => a.firearmId === firearmId)
    .reduce((s, a) => s + (parseFloat(a.price) || 0), 0);
  return fPrice + accPrice;
}

// =====================================================
// PROFIT/LOSS ON DISPOSED
// =====================================================
function getProfitLoss(f) {
  if (!f.status || f.status === 'Active') return null;
  const buyPrice = parseFloat(f.price) || 0;
  const sellPrice = parseFloat(f.dispPrice) || 0;
  if (!sellPrice) return null;
  return sellPrice - buyPrice;
}

// =====================================================
// UNDO DELETE
// =====================================================
let undoData = null;
let undoTimer = null;

function deleteWithUndo(type, id) {
  let item, collection, name;
  if (type === 'firearm') {
    item = db.firearms.find(x => x.id === id);
    if (!item) return;
    name = (item.make||'') + ' ' + (item.model||'');
    db.firearms = db.firearms.filter(x => x.id !== id);
    collection = 'firearms';
  } else if (type === 'ammo') {
    item = db.ammo.find(x => x.id === id);
    if (!item) return;
    name = item.brand || item.caliber;
    db.ammo = db.ammo.filter(x => x.id !== id);
    collection = 'ammo';
  } else if (type === 'accessory') {
    item = db.accessories.find(x => x.id === id);
    if (!item) return;
    name = item.name;
    db.accessories = db.accessories.filter(x => x.id !== id);
    collection = 'accessories';
  } else return;

  undoData = { type, collection, item };
  addAuditEntry('delete', type, name, '');
  saveData(); render();

  // Show undo toast
  const toast = document.getElementById('undoToast');
  document.getElementById('undoMessage').textContent = name + ' deleted';
  toast.style.display = 'flex';
  // Reset animation
  const bar = toast.querySelector('.undo-timer-bar');
  bar.style.animation = 'none';
  bar.offsetHeight; // reflow
  bar.style.animation = 'undoCountdown 8s linear forwards';

  clearTimeout(undoTimer);
  undoTimer = setTimeout(() => {
    toast.style.display = 'none';
    undoData = null;
  }, 8000);
}

function undoDelete() {
  if (!undoData) return;
  db[undoData.collection].push(undoData.item);
  addAuditEntry('create', undoData.type, (undoData.item.make||undoData.item.name||undoData.item.brand||'Item'), 'Undo delete');
  saveData(); render();
  document.getElementById('undoToast').style.display = 'none';
  clearTimeout(undoTimer);
  undoData = null;
}

// =====================================================
// BULK TAG EDITING
// =====================================================
let bulkSelected = new Set();

function toggleBulkSelect(id, e) {
  e.stopPropagation();
  if (bulkSelected.has(id)) bulkSelected.delete(id);
  else bulkSelected.add(id);
  updateBulkBar();
}

function updateBulkBar() {
  const bar = document.getElementById('bulkBar');
  if (bulkSelected.size > 0) {
    bar.classList.add('show');
    document.getElementById('bulkCount').textContent = bulkSelected.size + ' selected';
  } else {
    bar.classList.remove('show');
  }
}

function clearBulkSelection() {
  bulkSelected.clear();
  updateBulkBar();
  render();
}

async function bulkAddTag() {
  const tag = document.getElementById('bulkTagInput').value.trim();
  if (!tag) { toast('Enter a tag name.'); return; }
  let count = 0;
  bulkSelected.forEach(id => {
    const f = db.firearms.find(x => x.id === id);
    if (f) {
      if (!f.tags) f.tags = [];
      if (!f.tags.includes(tag)) { f.tags.push(tag); count++; }
    }
  });
  addAuditEntry('edit', 'bulk', count + ' firearms', 'Added tag: ' + tag);
  document.getElementById('bulkTagInput').value = '';
  await saveData();
  clearBulkSelection();
}

async function bulkRemoveTag() {
  const tag = document.getElementById('bulkTagInput').value.trim();
  if (!tag) { toast('Enter a tag name to remove.'); return; }
  let count = 0;
  bulkSelected.forEach(id => {
    const f = db.firearms.find(x => x.id === id);
    if (f && f.tags) {
      const idx = f.tags.indexOf(tag);
      if (idx > -1) { f.tags.splice(idx, 1); count++; }
    }
  });
  addAuditEntry('edit', 'bulk', count + ' firearms', 'Removed tag: ' + tag);
  document.getElementById('bulkTagInput').value = '';
  await saveData();
  clearBulkSelection();
}

// =====================================================
// MOBILE SWIPE FOR DETAIL IMAGE GALLERY
// =====================================================
let touchStartX = 0;

function initDetailSwipe() {
  const container = document.getElementById('detailImgContainer');
  container.addEventListener('touchstart', (e) => {
    touchStartX = e.changedTouches[0].screenX;
  }, { passive: true });
  container.addEventListener('touchend', (e) => {
    const diff = e.changedTouches[0].screenX - touchStartX;
    if (Math.abs(diff) < 50) return;
    const f = document.querySelector('.detail-overlay.open');
    if (!f) return;
    const dots = document.querySelectorAll('.detail-gallery-dot');
    if (dots.length < 2) return;
    if (diff > 0 && currentImageIndex > 0) {
      currentImageIndex--;
      dots[0].click();
    } else if (diff < 0 && currentImageIndex < dots.length - 1) {
      currentImageIndex++;
      dots[0].click();
    }
  }, { passive: true });
}

// Manual backup - downloads a timestamped full backup file
function manualBackup() {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const saveObj = Object.assign({}, db, { images: imagesDb });
  const b = new Blob([JSON.stringify(saveObj, null, 2)], {type: 'application/json'});
  const u = URL.createObjectURL(b);
  const a = document.createElement('a');
  a.href = u;
  a.download = 'firearms_backup_' + timestamp + '.json';
  a.click();
  URL.revokeObjectURL(u);

  const el = document.getElementById('saveIndicator');
  el.classList.add('show');
  el.textContent = 'Backup saved ' + new Date().toLocaleTimeString();
  setTimeout(() => el.classList.remove('show'), 3000);

  addAuditEntry('create', 'system', 'Manual Backup', 'Downloaded backup file');
  hasUnsavedChanges = false;
}

// Save all data to a JSON file on demand
async function saveToFile() {
  try {
    if (fileHandle) {
      await writeToDisk();
      return;
    }
    if ('showSaveFilePicker' in window) {
      fileHandle = await window.showSaveFilePicker({
        suggestedName: 'firearms_database.json',
        types: [{ description: 'JSON Database', accept: { 'application/json': ['.json'] } }]
      });
      await writeToDisk();
      hasUnsavedChanges = false;
      document.getElementById('statusDot').className = 'file-status-dot connected';
      document.getElementById('fileStatusText').textContent = 'Connected:';
      document.getElementById('fileStatusName').textContent = fileHandle.name;
    } else {
      const saveObj = Object.assign({}, db, { images: imagesDb });
      const b = new Blob([JSON.stringify(saveObj, null, 2)], {type: 'application/json'});
      const u = URL.createObjectURL(b);
      const a = document.createElement('a');
      a.href = u;
      a.download = 'firearms_database.json';
      a.click();
      URL.revokeObjectURL(u);
    }
  } catch (e) {
    if (e.name !== 'AbortError') toast('Save failed: ' + e.message);
  }
}

async function bootApp(){
  loadTheme();
  showGridSkeleton();   // visible structure while local cache + cloud pull load
  await openImageDB();
  await openStateDB();

  // Load any saved changes from IndexedDB (overrides embedded data)
  await loadFromLocalStorage();

  // Load embedded images into IndexedDB and memory
  if (EMBEDDED_IMAGES && Object.keys(EMBEDDED_IMAGES).length > 0) {
    const existingImages = await idbGetAll();
    if (Object.keys(existingImages).length === 0) {
      for (const [key, val] of Object.entries(EMBEDDED_IMAGES)) {
        await idbPut(key, val);
        imagesDb[key] = val;
      }
    } else {
      imagesDb = existingImages;
    }
    for (const [key, val] of Object.entries(EMBEDDED_IMAGES)) {
      if (!imagesDb[key]) imagesDb[key] = val;
    }
  }

  // Pull the latest data from the Supabase cloud (authoritative across devices)
  if (window.CloudSync && CloudSync.uid) {
    try { await CloudSync.pull(); }
    catch (e) { console.warn('Cloud pull failed; using local cache.', e); }
  }

  // Show all UI elements immediately - no file picker needed
  document.getElementById('statusDot').className = 'file-status-dot connected';
  document.getElementById('fileStatusText').textContent = 'Cloud synced';
  document.getElementById('fileStatusName').textContent = db.firearms.length + ' firearms loaded';

  document.getElementById('backupBtn').style.display = db.backups.length > 0 ? 'inline-block' : 'none';
  document.getElementById('settingsBtn').style.display = 'inline-block';
  document.getElementById('addFirearmBtn').style.display = 'inline-block';
  document.getElementById('addAmmoBtn').style.display = 'inline-block';
  document.getElementById('addAccessoryBtn').style.display = 'inline-block';
  document.getElementById('reportBtn').style.display = 'inline-block';
  document.getElementById('scanBtn').style.display = 'inline-block';
  document.getElementById('excelBtn').style.display = 'inline-block';
  document.getElementById('jsonBtn').style.display = 'inline-block';
  document.getElementById('importBtn').style.display = 'inline-block';
  document.getElementById('csvBtn').style.display = 'inline-block';
  document.getElementById('addWishlistBtn').style.display = 'inline-block';
  document.getElementById('addDealerBtn').style.display = 'inline-block';
  document.getElementById('atfBtn').style.display = 'inline-block';
  document.getElementById('firstItemBtn').style.display = 'inline-block';

  loadSortPreference();
  initDetailSwipe();
  recordValueSnapshot();
  updateStats();
  render();
  buildThumbnails(); // background: speed up card/table rendering
  hasUnsavedChanges = false; // reset after initial load
}
window.bootApp = bootApp;

