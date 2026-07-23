// =====================================================
// APP VERSION
// =====================================================
const APP_VERSION = '2.3.0';

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
let tempAccessoryImages = [];
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
let accessorySortField = 'item';
let accessoryGroupField = 'none';
let pendingWishlistMoveId = null;
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
// SAVE STATUS + DEVICE PRIVACY
// =====================================================
// CloudSync calls this hook too, so local and cloud persistence share one
// calm, non-popup status message. Errors remain visible until a later save.
function setSaveStatus(state, detail) {
  const el = document.getElementById('syncStatus');
  if (!el) return;
  const labels = {
    saving: 'Saving changes…', saved: 'Saved to cloud',
    local: 'Safe on this device — waiting for cloud',
    offline: 'Offline — safe on this device',
    failed: 'Changes not safe — keep this page open',
    conflict: 'Sync needs review', degraded: 'Saved with a warning',
    syncing: 'Checking cloud…'
  };
  const kinds = { saving: 'syncing', syncing: 'syncing', saved: 'ok', local: 'warning', offline: 'warning', failed: 'error', conflict: 'error', degraded: 'warning' };
  const text = detail || labels[state] || 'Saved to cloud';
  const actionable = state === 'conflict' || state === 'degraded' || state === 'failed' ||
    !!(window.CloudSync && Array.isArray(CloudSync.missingMedia) && CloudSync.missingMedia.length);
  el.dataset.saveState = state || '';
  el.dataset.kind = kinds[state] || el.dataset.kind || '';
  el.dataset.actionable = actionable ? 'true' : 'false';
  el.textContent = text;
  el.title = actionable ? text + '. Open sync details.' : 'Open sync details: ' + text;
  el.setAttribute('aria-label', el.title);
  const live = document.getElementById('syncStatusLive');
  if (live) live.textContent = text;
  if (window.CloudSync && CloudSync.uid) {
    const dot = document.getElementById('statusDot');
    const account = document.getElementById('fileStatusText');
    if (state === 'local' || state === 'offline') {
      if (dot) dot.className = 'file-status-dot local';
      if (account) account.textContent = 'Using safe device copy';
    } else if (state === 'failed') {
      if (dot) dot.className = 'file-status-dot disconnected';
      if (account) account.textContent = 'Cloud unavailable';
    } else if (state === 'conflict' || state === 'degraded') {
      if (dot) dot.className = 'file-status-dot local';
      if (account) account.textContent = 'Cloud connected - needs attention';
    } else {
      if (dot) dot.className = 'file-status-dot connected';
      if (account) account.textContent = 'Cloud account connected';
    }
  }
}
window.setSaveStatus = setSaveStatus;

function showPersistentFeatureError(message) {
  let alert = document.querySelector('#featureLoadError');
  if (!alert) {
    alert = document.createElement('div');
    alert.id = 'featureLoadError'; alert.className = 'feature-load-error'; alert.setAttribute('role', 'alert');
    const text = document.createElement('span'); text.className = 'feature-load-error-text';
    const dismiss = document.createElement('button'); dismiss.type = 'button'; dismiss.setAttribute('aria-label', 'Dismiss feature error'); dismiss.innerHTML = '&times;';
    dismiss.addEventListener('click', () => alert.remove());
    alert.append(text, dismiss);
    const statusBar = document.querySelector('.file-status-bar');
    if (statusBar) statusBar.insertAdjacentElement('afterend', alert); else document.body.prepend(alert);
  }
  alert.querySelector('.feature-load-error-text').textContent = message;
}

async function ensureFeatureAsset(group, label) {
  try {
    if (!window.VaultAssets) throw new Error('Feature loader is unavailable.');
    await window.VaultAssets.ensure(group);
    return true;
  } catch (error) {
    const message = (label || 'This feature') + ' could not load. Check your connection and try again.';
    showPersistentFeatureError(message);
    toast(message, 'error', 10000);
    console.error('Optional feature load failed:', group, error);
    return false;
  }
}

// =====================================================
// SYNC DETAILS + ATTACHMENT RECOVERY
// =====================================================
let pendingMissingMediaKey = null;

function closeSyncCenter() {
  const modal = document.getElementById('syncCenterModal');
  if (modal) modal.classList.remove('open');
}

function syncRecordLabel(collectionName, id) {
  const collections = {
    firearms: db.firearms, ammo: db.ammo, accessories: db.accessories,
    wishlist: db.wishlist, dealers: db.dealers
  };
  const record = (collections[collectionName] || []).find(item => String(item.id) === String(id));
  if (!record) return 'A record';
  return [record.make, record.model].filter(Boolean).join(' ').trim() || record.name || record.description || 'Untitled record';
}

function humanizeConflictPath(path) {
  const value = String(path || '');
  const match = /^(firearms|ammo|accessories|wishlist|dealers)\[([^\]]+)\](?:\.(.+))?$/.exec(value);
  if (!match) return 'Collection data';
  const field = (match[3] || 'record').split('.').pop().replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ');
  return syncRecordLabel(match[1], match[2]) + ' - ' + field.charAt(0).toUpperCase() + field.slice(1);
}

function makeSyncIssue(title, description, className) {
  const item = document.createElement('div');
  item.className = 'sync-issue ' + (className || '');
  const copy = document.createElement('div');
  copy.className = 'sync-issue-copy';
  const heading = document.createElement('strong'); heading.textContent = title;
  const body = document.createElement('p'); body.textContent = description;
  copy.append(heading, body); item.append(copy);
  return item;
}

async function renderSyncCenter() {
  const list = document.getElementById('syncIssueList');
  const summary = document.getElementById('syncCenterSummary');
  const current = document.getElementById('syncCenterCurrent');
  const resolve = document.getElementById('syncConflictActions');
  if (!list || !summary || !current || !resolve) return;

  const sync = window.CloudSync;
  const missing = sync && Array.isArray(sync.missingMedia) ? sync.missingMedia : [];
  let pending = sync && sync.pendingConflict;
  if (sync && sync.uid) {
    const outbox = await sync.storeGet('outbox', sync.uid).catch(() => null);
    if (outbox && Array.isArray(outbox.conflictPaths) && outbox.conflictPaths.length) {
      pending = {
        paths: outbox.conflictPaths,
        at: outbox.conflictAt || outbox.queuedAt || null,
        canResolve: !!outbox.conflictRemoteData
      };
      sync.pendingConflict = pending;
    }
  }
  const conflicts = pending && Array.isArray(pending.paths) ? pending.paths : [];
  const status = document.getElementById('syncStatus');
  const state = status && status.dataset.saveState;
  current.textContent = status ? status.textContent : 'Sync status is not available.';
  current.dataset.state = state || '';

  list.replaceChildren();
  missing.forEach(detail => {
    const title = detail.filename || detail.label || 'Unavailable attachment';
    const description = (detail.recordName && detail.recordName !== 'Unknown record')
      ? 'Attached to ' + detail.recordName + '. The record is saved, but this file is not available from cloud storage.'
      : 'The record is saved, but this file is not available from cloud storage.';
    const item = makeSyncIssue(title, description, 'missing-media');
    const actions = document.createElement('div'); actions.className = 'sync-issue-actions';
    const reattach = document.createElement('button'); reattach.type = 'button'; reattach.className = 'btn btn-small btn-primary'; reattach.textContent = 'Reattach file';
    reattach.addEventListener('click', () => beginMissingMediaReattach(detail.key));
    const dismiss = document.createElement('button'); dismiss.type = 'button'; dismiss.className = 'btn btn-small btn-outline'; dismiss.textContent = 'Remove reference';
    dismiss.addEventListener('click', () => dismissMissingMedia(detail.key));
    actions.append(reattach, dismiss); item.append(actions); list.append(item);
  });

  conflicts.forEach(path => {
    list.append(makeSyncIssue(
      humanizeConflictPath(path),
      'This device and another device changed the same field. Your device copy is safe; nothing will be overwritten automatically.',
      'sync-conflict-item'
    ));
  });

  const canResolve = !conflicts.length || !pending || pending.canResolve !== false;
  resolve.style.display = conflicts.length && canResolve ? 'block' : 'none';
  if (missing.length && conflicts.length) summary.textContent = 'Your records are safe, but some files need recovery and some fields need a choice.';
  else if (missing.length) summary.textContent = missing.length + ' attachment' + (missing.length === 1 ? ' needs' : 's need') + ' recovery. Reattach the original file, or remove only its unavailable reference.';
  else if (conflicts.length && canResolve) summary.textContent = 'Choose which version to use only for the fields listed below. Unrelated changes from both devices will be preserved.';
  else if (conflicts.length) summary.textContent = 'Your device copy is safe. Try sync again once to refresh the comparison details, then return here to choose the listed fields.';
  else if (state === 'failed') summary.textContent = 'The latest changes are not yet safe. Keep this page open and try saving again.';
  else if (state === 'local' || state === 'offline') summary.textContent = 'Your latest changes are safe on this device and will upload automatically when cloud access returns.';
  else summary.textContent = 'No sync problems need your attention.';

  if (!missing.length && !conflicts.length) {
    list.append(makeSyncIssue('Everything looks good', 'No missing attachments or overlapping edits were found.', 'sync-ok-item'));
  }
}

async function openSyncCenter() {
  const modal = document.getElementById('syncCenterModal');
  if (!modal) return;
  modal.classList.add('open');
  await renderSyncCenter();
}

function beginMissingMediaReattach(key) {
  if (!window.CloudSync) return;
  const detail = CloudSync.describeMediaKey(key);
  const input = document.getElementById('missingMediaFile');
  if (!input) return;
  pendingMissingMediaKey = String(key || '');
  input.accept = detail.accept || 'application/pdf,image/*';
  input.value = '';
  input.click();
}

function readFileAsDataURL(file) {
  return trackPendingVaultOperation(new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error('The selected file could not be read.'));
    reader.readAsDataURL(file);
  }));
}

function applyRecoveredFilename(detail, file) {
  const collections = {
    firearm: db.firearms, ammo: db.ammo, accessory: db.accessories
  };
  const record = (collections[detail.recordKind] || []).find(item => String(item.id) === String(detail.recordId));
  if (detail.type === 'receipt' && record) record.receiptName = file.name;
  else if (detail.type === 'stamp' && record) record.stampPdfName = file.name;
  else if (detail.type === 'document') {
    const firearm = db.firearms.find(item => String(item.id) === String(detail.recordId));
    const documentRecord = firearm && (firearm.documents || []).find(item => String(item.id) === String(detail.documentId));
    if (documentRecord) { documentRecord.name = file.name; documentRecord.type = file.type; }
  }
}

async function handleMissingMediaFile(event) {
  const file = event.target.files && event.target.files[0];
  const key = pendingMissingMediaKey;
  event.target.value = '';
  pendingMissingMediaKey = null;
  if (!file || !key || !window.CloudSync) return;
  const account = CloudSync.accountContext();
  const detail = CloudSync.describeMediaKey(key);
  const allowed = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/gif']);
  if (!allowed.has(file.type) || (detail.type === 'stamp' && file.type !== 'application/pdf')) {
    toast(detail.type === 'stamp' ? 'Choose a PDF for the tax stamp.' : 'Choose a PDF, JPEG, PNG, WebP, or GIF file.', 'error');
    return;
  }
  if (file.size > 20 * 1024 * 1024) { toast('Choose a file smaller than 20 MB.', 'error'); return; }

  try {
    let dataURL = await readFileAsDataURL(file);
    if (detail.type === 'photo') dataURL = await compressImage(dataURL, 1600, 0.82);
    if (!CloudSync.contextActive(account)) return;
    if (!CloudSync.applyMedia(key, dataURL)) throw new Error('The matching database record could not be found.');
    applyRecoveredFilename(detail, file);
    const metadata = await CloudSync.mediaMetadata(dataURL);
    metadata.path = CloudSync.contentPath(key, metadata.sha256);
    await CloudSync.putScopedMedia(CloudSync.uid, key, dataURL, metadata);
    if (typeof idbPut === 'function') await idbPut(key, dataURL);
    CloudSync.markMediaRecovered(key);
    addAuditEntry('edit', detail.recordKind || 'attachment', detail.recordName || 'Attachment', 'Reattached ' + (detail.filename || file.name));
    await saveData();
    const result = await CloudSync.syncNow();
    render();
    await renderSyncCenter();
    toast(result && result.ok ? 'Attachment restored and saved to cloud.' : 'Attachment restored on this device; cloud upload will retry.', result && result.ok ? 'success' : 'info', 7000);
  } catch (error) {
    toast('Could not reattach the file: ' + (error.message || error), 'error', 9000);
  }
}

async function dismissMissingMedia(key) {
  if (!window.CloudSync) return;
  const detail = CloudSync.describeMediaKey(key);
  const approved = await confirmDialog(
    'Remove the unavailable "' + (detail.filename || 'attachment') + '" reference? The inventory record will stay, but this file entry cannot be restored unless you attach it again later.',
    { title: 'Remove unavailable attachment', okText: 'Remove reference', danger: true }
  );
  if (!approved) return;
  try {
    const result = CloudSync.removeMediaReference(key);
    if (!result.ok) throw new Error('The matching attachment reference could not be found.');
    await CloudSync.storeDelete('media', CloudSync.mediaId(CloudSync.uid, key)).catch(() => {});
    if (typeof idbDelete === 'function') await idbDelete(key).catch(() => {});
    addAuditEntry('delete', detail.recordKind || 'attachment', detail.recordName || 'Attachment', 'Removed unavailable ' + (detail.filename || 'attachment') + ' reference');
    await saveData();
    const cloud = await CloudSync.syncNow();
    render();
    await renderSyncCenter();
    toast(cloud && cloud.ok ? 'Unavailable attachment reference removed.' : 'Reference removed on this device; cloud sync will retry.', cloud && cloud.ok ? 'success' : 'info', 7000);
  } catch (error) {
    toast('Could not remove the attachment reference: ' + (error.message || error), 'error', 9000);
  }
}

async function resolveSyncChanges(preference) {
  if (!window.CloudSync) return;
  const useCloud = preference === 'cloud';
  const approved = await confirmDialog(
    (useCloud ? 'Use the cloud version' : 'Use this device\'s version') + ' for the listed fields? Unrelated changes from both devices will still be preserved, and the selected result will be saved as a new revision.',
    { title: 'Resolve overlapping edits', okText: useCloud ? 'Use cloud fields' : 'Use device fields', danger: false }
  );
  if (!approved) return;
  try {
    const result = await CloudSync.resolvePendingConflict(useCloud ? 'cloud' : 'device');
    if (!result.ok) throw new Error(result.status === 'no-pending-conflict' ? 'Those changes were already resolved.' : 'The reviewed changes could not be saved.');
    await renderSyncCenter();
    toast('Reviewed changes saved.', 'success');
  } catch (error) {
    toast('Could not finish the review: ' + (error.message || error), 'error', 9000);
    await renderSyncCenter();
  }
}

async function retrySyncFromCenter() {
  if (!window.CloudSync) return;
  const result = (CloudSync.missingMedia || []).length && !CloudSync.pendingConflict
    ? await CloudSync.pull({ awaitMedia: true })
    : await CloudSync.syncNow();
  await renderSyncCenter();
  if (!result.ok && !result.localSafe) toast('The latest changes are not safe yet. Keep this page open and try again.', 'error', 9000);
}

function openBackupFromSyncCenter() {
  closeSyncCenter();
  return openBackupModal();
}

window.openSyncCenter = openSyncCenter;
window.closeSyncCenter = closeSyncCenter;
window.openBackupFromSyncCenter = openBackupFromSyncCenter;
window.renderSyncCenter = renderSyncCenter;
window.resolveSyncChanges = resolveSyncChanges;
window.retrySyncFromCenter = retrySyncFromCenter;

const PRIVACY_MODE_KEY = 'firearms_vault_privacy_mode';
let privacyMode = false;
try { privacyMode = localStorage.getItem(PRIVACY_MODE_KEY) === 'true'; } catch (_) {}

function refreshSensitiveElements(root) {
  const scope = root && root.querySelectorAll ? root : document;
  ['statValue', 'authedEmail', 'settingsEmail'].forEach(id => {
    const el = document.getElementById(id); if (el) el.classList.add('sensitive-value');
  });
  scope.querySelectorAll('.mono-id, [data-sensitive]').forEach(el => el.classList.add('sensitive-value'));
  scope.querySelectorAll('input[type="email"], input[id*="Serial"], input[id*="Price"], input[id*="FFL"]').forEach(el => el.classList.add('sensitive-input'));
  scope.querySelectorAll('.card-detail, .detail-field, .sv-grid > div, .dash-kpi, .dash-list-item').forEach(group => {
    const label = group.querySelector('label, .dash-kpi-label, .label');
    if (!label || !/(serial|value|price|investment|budget|email|ffl)/i.test(label.textContent)) return;
    group.querySelectorAll('span, .dash-kpi-value, .value, input').forEach(el => el.classList.add(el.matches('input') ? 'sensitive-input' : 'sensitive-value'));
  });
  scope.querySelectorAll('td, span, div').forEach(el => {
    if (el.children.length === 0 && /^\s*\$[\d,.]+\s*$/.test(el.textContent || '')) el.classList.add('sensitive-value');
  });
  scope.querySelectorAll('.sensitive-value').forEach(el => {
    if (privacyMode) { el.setAttribute('aria-hidden', 'true'); el.dataset.privacyHidden = 'true'; }
    else if (el.dataset.privacyHidden === 'true') { el.removeAttribute('aria-hidden'); delete el.dataset.privacyHidden; }
  });
}

function setPrivacyMode(enabled) {
  privacyMode = !!enabled;
  document.body.classList.toggle('privacy-mode', privacyMode);
  try { localStorage.setItem(PRIVACY_MODE_KEY, String(privacyMode)); } catch (_) {}
  const btn = document.getElementById('privacyToggle');
  if (btn) {
    btn.setAttribute('aria-pressed', String(privacyMode));
    btn.setAttribute('aria-label', privacyMode ? 'Reveal sensitive information' : 'Hide sensitive information');
    btn.title = privacyMode ? 'Reveal sensitive information' : 'Hide sensitive information';
    btn.classList.toggle('active', privacyMode);
  }
  const setting = document.getElementById('privacySetting');
  if (setting && setting.checked !== privacyMode) setting.checked = privacyMode;
  refreshSensitiveElements(document);
}
function togglePrivacyMode() { setPrivacyMode(!privacyMode); }
window.setPrivacyMode = setPrivacyMode;
window.togglePrivacyMode = togglePrivacyMode;

function runDataQualityCheck() {
  const result = document.getElementById('dataQualityResult');
  const apply = document.getElementById('applyDataQualityBtn');
  if (!window.VaultDataQuality) { result.textContent = 'The data-quality checker is unavailable.'; return; }
  const report = VaultDataQuality.analyze(db);
  const warnings = report.findings.filter(item => item.severity === 'warning').length;
  const errors = report.findings.filter(item => item.severity === 'error').length;
  result.innerHTML = '<strong>' + report.safeFixes + '</strong> safe formatting cleanup' + (report.safeFixes === 1 ? '' : 's') +
    ' available. <strong>' + warnings + '</strong> item' + (warnings === 1 ? '' : 's') +
    ' need manual review' + (errors ? ', and <strong>' + errors + '</strong> invalid record value' + (errors === 1 ? '' : 's') : '') + '.' +
    (report.duplicateSerials ? '<br><span class="quality-warning">Possible duplicate serials were found. They will not be merged automatically.</span>' : '');
  apply.style.display = report.safeFixes ? 'inline-flex' : 'none';
}

async function applyDataQualityCleanup() {
  if (!window.VaultDataQuality) return;
  const approved = await confirmDialog('Apply whitespace, capitalization, and duplicate-tag cleanup? No records will be deleted or merged.', {
    title: 'Apply safe data cleanup', okText: 'Apply cleanup'
  });
  if (!approved) return;
  try {
    if (window.VaultDataSafety && window.CloudSync && CloudSync.uid) {
      await VaultDataSafety.createBackup(CloudSync.uid, db, 'before-data-cleanup');
    }
    const outcome = VaultDataQuality.applySafeFixes(db);
    if (outcome.changed) {
      addAuditEntry('edit', 'system', 'Data Quality Cleanup', outcome.changed + ' safe normalization changes');
      await saveData();
      render();
    }
    runDataQualityCheck();
    toast(outcome.changed ? 'Safe data cleanup applied.' : 'No safe cleanup was needed.', 'success');
  } catch (error) {
    toast('Data cleanup failed: ' + error.message, 'error');
  }
}
window.runDataQualityCheck = runDataQualityCheck;
window.applyDataQualityCleanup = applyDataQualityCleanup;

function formatStorageBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return value + ' B';
  if (value < 1048576) return (value / 1024).toFixed(1) + ' KiB';
  if (value < 1073741824) return (value / 1048576).toFixed(1) + ' MiB';
  return (value / 1073741824).toFixed(2) + ' GiB';
}

async function refreshDataSafetyPanel() {
  const cloud = document.getElementById('safetyCloud');
  if (!cloud) return;
  const pending = document.getElementById('safetyPending');
  const backup = document.getElementById('safetyBackup');
  const storage = document.getElementById('safetyStorage');
  const build = document.getElementById('safetyBuild');
  try {
    cloud.textContent = window.CloudSync && CloudSync.uid
      ? ((CloudSync.ready ? 'Connected' : 'Starting') + ' · revision ' + (Number(CloudSync.revision) || 0))
      : 'Not signed in';
    if (window.VaultDataSafety && window.CloudSync && CloudSync.uid) {
      const [outbox, backups] = await Promise.all([
        VaultDataSafety.listOutbox(CloudSync.uid), VaultDataSafety.listBackups(CloudSync.uid)
      ]);
      const scopedPending = await CloudSync.storeGet('outbox', CloudSync.uid).catch(() => null);
      const count = Math.max(outbox.length, scopedPending ? 1 : 0);
      pending.textContent = count ? count + ' safely queued' : 'None';
      backup.textContent = backups.length ? new Date(backups[0].createdAt).toLocaleString() : 'Not created yet';
    } else {
      pending.textContent = 'Unavailable'; backup.textContent = 'Unavailable';
    }
    if (navigator.storage && navigator.storage.estimate) {
      const estimate = await navigator.storage.estimate();
      const persistent = navigator.storage.persisted ? await navigator.storage.persisted() : false;
      storage.textContent = formatStorageBytes(estimate.usage) + ' of ' + formatStorageBytes(estimate.quota) + (persistent ? ' · protected' : ' · browser managed');
    } else storage.textContent = 'Estimate unavailable';
    const response = await fetch('build-info.json', { cache: 'no-store' });
    if (response.ok) {
      const info = await response.json();
      build.textContent = info.buildId || info.version || APP_VERSION;
    } else build.textContent = APP_VERSION + ' (development)';
  } catch (error) {
    console.warn('Data-safety panel refresh failed:', error);
  }
}

async function runDataSafetyCheck() {
  const result = document.getElementById('safetyCheckResult');
  result.textContent = 'Checking local integrity and cloud write/delete canary…';
  try {
    if (!window.CloudSync || !CloudSync.uid || !window.VaultDataSafety) throw new Error('Sign in before running this check.');
    const state = await VaultDataSafety.getState(CloudSync.uid);
    if (!state || !state.data || !state.checksum) throw new Error('No durable local state is available yet. Make a change or sync first.');
    const actual = await VaultDataSafety.digestText(JSON.stringify(state.data));
    if (actual !== state.checksum) throw new Error('The local integrity checksum does not match.');
    const canary = await window.sbClient.rpc('run_health_check_canary', { p_source: 'in-app-safety-check' });
    if (canary.error) throw canary.error;
    if (!canary.data || canary.data.ok !== true) throw new Error('The cloud canary did not confirm its cleanup.');
    result.textContent = 'Passed: local checksum verified and the isolated cloud write/delete canary completed.';
    await refreshDataSafetyPanel();
  } catch (error) {
    result.textContent = 'Safety check needs attention: ' + (error.message || error);
  }
}
async function requestPersistentStorage() {
  const result = document.getElementById('safetyCheckResult');
  try {
    if (!navigator.storage || !navigator.storage.persist) throw new Error('This browser does not offer persistent site storage.');
    const already = navigator.storage.persisted ? await navigator.storage.persisted() : false;
    const granted = already || await navigator.storage.persist();
    result.textContent = granted
      ? 'Offline storage is protected from routine browser cleanup on this device.'
      : 'The browser kept storage under its normal cleanup policy. Cloud sync and downloaded backups remain available.';
    await refreshDataSafetyPanel();
  } catch (error) {
    result.textContent = 'Offline storage protection is unavailable: ' + (error.message || error);
  }
}
async function cleanUnusedMedia() {
  const result = document.getElementById('safetyCheckResult');
  result.textContent = 'Checking retained recovery versions and media…';
  try {
    if (!window.CloudSync || typeof CloudSync.cleanupOrphanMedia !== 'function') throw new Error('Media cleanup is unavailable.');
    const scan = await CloudSync.cleanupOrphanMedia({ dryRun: true });
    if (!scan.ok) throw new Error((scan.error && scan.error.message) || 'Media history could not be checked.');
    if (!scan.unused.length) { result.textContent = 'No unused media objects were found.'; return; }
    const approved = await confirmDialog('Remove ' + scan.unused.length + ' media object' + (scan.unused.length === 1 ? '' : 's') + ' that are not referenced by the current collection or any retained recovery version?', {
      title: 'Clean unused media', okText: 'Remove unused media', danger: true
    });
    if (!approved) { result.textContent = 'Media cleanup cancelled.'; return; }
    const cleaned = await CloudSync.cleanupOrphanMedia({ dryRun: false });
    if (!cleaned.ok) throw new Error((cleaned.error && cleaned.error.message) || 'Some media could not be removed.');
    result.textContent = 'Removed ' + cleaned.removed.length + ' unused media object' + (cleaned.removed.length === 1 ? '' : 's') + '.';
  } catch (error) {
    result.textContent = 'Media cleanup needs attention: ' + (error.message || error);
  }
}
window.refreshDataSafetyPanel = refreshDataSafetyPanel;
window.runDataSafetyCheck = runDataSafetyCheck;
window.requestPersistentStorage = requestPersistentStorage;
window.cleanUnusedMedia = cleanUnusedMedia;
window.addEventListener('firearms-vault-sync-state', () => refreshDataSafetyPanel());

// =====================================================
// SAFE RICH TEXT
// =====================================================
// Notes are rich text, but imported backups must never be able to inject
// scripts, event handlers, styles, SVG, or unsafe URL schemes.
function sanitizeRichText(value) {
  if (window.VaultSecurity && typeof window.VaultSecurity.sanitizeRichText === 'function') {
    return window.VaultSecurity.sanitizeRichText(value);
  }
  if (!value || value === '<br>') return '';
  const template = document.createElement('template');
  template.innerHTML = String(value);
  const allowed = new Set(['P', 'BR', 'DIV', 'B', 'STRONG', 'I', 'EM', 'U', 'UL', 'OL', 'LI', 'A']);
  const nodes = Array.from(template.content.querySelectorAll('*')).reverse();
  nodes.forEach(node => {
    if (!allowed.has(node.tagName)) {
      const text = document.createTextNode(node.textContent || '');
      node.replaceWith(text);
      return;
    }
    const original = node.tagName === 'A' ? String(node.getAttribute('href') || '').trim() : '';
    Array.from(node.attributes).forEach(attr => node.removeAttribute(attr.name));
    if (node.tagName === 'A') {
      if (/^(https?:|mailto:)/i.test(original)) {
        node.setAttribute('href', original);
        node.setAttribute('target', '_blank');
        node.setAttribute('rel', 'noopener noreferrer');
      }
    }
  });
  return template.innerHTML.trim();
}

function normalizeRichTextData() {
  (db.firearms || []).forEach(f => {
    f.notes = sanitizeRichText(f.notes);
    f.dispNotes = sanitizeRichText(f.dispNotes);
    (f.maintenanceLog || []).forEach(m => { m.description = sanitizeRichText(m.description); });
  });
  (db.ammo || []).forEach(a => { a.notes = sanitizeRichText(a.notes); });
  (db.accessories || []).forEach(a => { a.notes = sanitizeRichText(a.notes); });
  (db.wishlist || []).forEach(w => { w.notes = sanitizeRichText(w.notes); });
  (db.dealers || []).forEach(d => { d.notes = sanitizeRichText(d.notes); });
}
function normalizeInternalIds() {
  const valid = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value);
  const firearmMap = new Map();
  const ensure = (record, map) => {
    const old = record && record.id;
    if (!record) return;
    if (!valid(old)) record.id = generateId();
    if (map && old !== record.id) map.set(String(old || ''), record.id);
  };
  (db.firearms || []).forEach(f => {
    ensure(f, firearmMap);
    (f.maintenanceLog || []).forEach(entry => ensure(entry));
    (f.documents || []).forEach(doc => ensure(doc));
    f.images = (f.images || []).filter(id => typeof id === 'string' && /^[A-Za-z0-9._-]{1,160}$/.test(id));
  });
  (db.ammo || []).forEach(a => ensure(a));
  (db.accessories || []).forEach(a => { ensure(a); if (firearmMap.has(String(a.firearmId || ''))) a.firearmId = firearmMap.get(String(a.firearmId || '')); });
  (db.wishlist || []).forEach(w => ensure(w));
  (db.dealers || []).forEach(d => ensure(d));
}
window.sanitizeRichText = sanitizeRichText;

function clearFieldError(input) {
  if (!input) return;
  input.removeAttribute('aria-invalid');
  const id = input.getAttribute('aria-describedby');
  if (id && id.endsWith('-error')) {
    const err = document.getElementById(id); if (err) err.remove();
    input.removeAttribute('aria-describedby');
  }
}
function showFieldError(input, message) {
  if (!input) return false;
  clearFieldError(input);
  const id = input.id + '-error';
  const err = document.createElement('div');
  err.id = id; err.className = 'field-error'; err.setAttribute('role', 'alert'); err.textContent = message;
  input.setAttribute('aria-invalid', 'true');
  input.setAttribute('aria-describedby', id);
  input.insertAdjacentElement('afterend', err);
  input.focus();
  return false;
}
document.addEventListener('input', e => { if (e.target && e.target.matches('input, select, textarea, [contenteditable]')) clearFieldError(e.target); });

// =====================================================
// IMAGE LIGHTBOX
// =====================================================
function openLightbox(src, alt) {
  const lb = document.getElementById('lightbox');
  const img = document.getElementById('lightboxImg');
  if (!lb || !img || !src) return;
  img.src = src;
  img.alt = alt || 'Full-size firearm photo';
  lb.style.display = 'flex';
}
function closeLightbox() {
  const lb = document.getElementById('lightbox');
  if (lb) {
    lb.style.display = 'none';
    const image = document.getElementById('lightboxImg');
    if (image) { image.src = ''; image.alt = ''; }
  }
}
window.openLightbox = openLightbox;
window.closeLightbox = closeLightbox;
// Click any detail-view photo to open it full-screen
document.addEventListener('click', (e) => {
  const t = e.target;
  if (t && t.classList && t.classList.contains('detail-img')) {
    e.stopPropagation();
    openLightbox(t.src, t.alt);
  }
});
document.addEventListener('keydown', (e) => {
  const target = e.target;
  if ((e.key === 'Enter' || e.key === ' ') && target && target.classList && target.classList.contains('detail-img')) {
    e.preventDefault();
    e.stopPropagation();
    openLightbox(target.src, target.alt);
    return;
  }
  if (e.key === 'Escape') closeLightbox();
});

// =====================================================
// NAVIGATION: dropdown menus, contextual add, bottom nav, filters
// =====================================================
// Dropdown menus (Tools, account gear, bottom-nav "More")
function closeOpenMenus({ restoreFocus = false } = {}) {
  document.querySelectorAll('.menu.open').forEach(menu => {
    menu.classList.remove('open');
    const button = menu.querySelector('[data-menu-toggle]');
    if (button) {
      button.setAttribute('aria-expanded', 'false');
      if (restoreFocus) button.focus();
    }
  });
}
document.querySelectorAll('[data-menu-toggle]').forEach(button => button.setAttribute('aria-expanded', 'false'));
document.addEventListener('click', (e) => {
  const toggle = e.target.closest('[data-menu-toggle]');
  if (toggle) {
    const menu = toggle.closest('.menu');
    const wasOpen = menu.classList.contains('open');
    closeOpenMenus();
    if (!wasOpen) menu.classList.add('open');
    toggle.setAttribute('aria-expanded', wasOpen ? 'false' : 'true');
    e.stopPropagation();
    return;
  }
  if (e.target.closest('.menu-item')) {                 // run the item's action, then close
    closeOpenMenus();
    return;
  }
  closeOpenMenus();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeOpenMenus({ restoreFocus: true });
});

// Bottom-nav buttons (and "More" items) reuse the existing top-tab logic
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-bottomtab]');
  if (!b) return;
  const tab = document.querySelector('.tab[data-tab="' + b.dataset.bottomtab + '"]');
  if (tab) tab.click();
});
function updateBottomNav() {
  const moreTabs = ['accessories', 'nfa', 'disposed', 'wishlist', 'dealers'];
  document.querySelectorAll('.bn-item[data-bottomtab], #bnMoreMenu .menu-item[data-bottomtab]').forEach(b => {
    const active = b.dataset.bottomtab === currentTab;
    b.classList.toggle('active', active);
    if (active) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });
  const moreButton = document.querySelector('#bnMoreMenu [data-menu-toggle]');
  if (moreButton) {
    const active = moreTabs.includes(currentTab);
    moreButton.classList.toggle('active', active);
    if (active) moreButton.setAttribute('aria-current', 'page');
    else moreButton.removeAttribute('aria-current');
  }
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
      all: ['Add firearm', openAddModal], nfa: ['Add NFA item', openAddNfaModal],
      ammo: ['Add ammunition', openAddAmmoModal], accessories: ['Add accessory', openAccessoryModal],
      wishlist: ['Add wishlist item', openWishlistModal], dealers: ['Add dealer', openDealerModal]
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

function updatePageContext(count) {
  if (window.VaultUI && typeof VaultUI.updateContext === 'function') {
    VaultUI.updateContext(currentTab, Number.isFinite(count) ? { count } : undefined);
  }
}

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
    { icon: '📸', label: 'Mobile Quick Capture', kw: 'camera photo receipt tax stamp ocr', run: () => window.openQuickCaptureModal() },
    { icon: '✓', label: 'Collection Health', kw: 'quality fix duplicate typo missing attachments', run: () => window.openCollectionHealth() },
    { icon: '↺', label: 'Activity History', kw: 'audit changes restore record', run: () => window.openActivityCenter() },
    { icon: '🛡️', label: 'Insurance / Theft Package', kw: 'encrypted report redacted evidence', run: () => window.openReportPackageModal() },
    { icon: '📗', label: 'Export to Excel', kw: 'xlsx download', run: exportExcel },
    { icon: '⬇️', label: 'Export JSON', kw: 'backup download', run: exportJSON },
    { icon: '🔗', label: 'Share inventory', kw: 'insurance link', run: openShareModal },
    { icon: '🖨️', label: 'Print', kw: '', run: printInventory },
    { icon: '🔔', label: 'Reminders', kw: 'alerts', run: openReminders },
    { icon: '⚙️', label: 'Settings', kw: 'password account', run: openSettingsModal },
    { icon: '💾', label: 'Backup now', kw: '', run: manualBackup },
    { icon: '🔄', label: 'Sync now', kw: 'cloud', run: () => CloudSync.syncNow() },
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
  return runCompatibilityWrite(() => new Promise((resolve, reject) => {
    const tx = imageStore.transaction(IDB_STORE, 'readwrite');
    const store = tx.objectStore(IDB_STORE);
    const req = store.put(value, key);
    req.onsuccess = () => resolve();
    req.onerror = (e) => reject(e);
  }));
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
  return runCompatibilityWrite(() => new Promise((resolve, reject) => {
    const tx = imageStore.transaction(IDB_STORE, 'readwrite');
    const store = tx.objectStore(IDB_STORE);
    const req = store.delete(key);
    req.onsuccess = () => resolve();
    req.onerror = (e) => reject(e);
  }));
}

function referencedInventoryImageIds() {
  const ids = new Set();
  (db.firearms || []).forEach(firearm => {
    (Array.isArray(firearm.images) ? firearm.images : []).forEach(id => {
      if (typeof id === 'string' && id) ids.add(id);
    });
  });
  (db.accessories || []).forEach(accessory => {
    (Array.isArray(accessory.images) ? accessory.images : []).forEach(id => {
      if (typeof id === 'string' && id) ids.add(id);
    });
  });
  return ids;
}

// Keep the original public name for backup and release-safety callers.
function referencedFirearmImageIds() {
  return referencedInventoryImageIds();
}

function getReferencedFirearmImages() {
  const images = {};
  referencedInventoryImageIds().forEach(id => {
    if (Object.prototype.hasOwnProperty.call(imagesDb || {}, id)) images[id] = imagesDb[id];
  });
  return images;
}

function referencedMediaKeysForExport() {
  if (window.CloudSync && typeof CloudSync.referencedMediaKeys === 'function') {
    return [...new Set(CloudSync.referencedMediaKeys(db).map(String).filter(Boolean))];
  }
  return [...referencedInventoryImageIds()].map(String);
}

function residentMediaBytes(key) {
  let value = null;
  if (window.CloudSync && typeof CloudSync.residentMedia === 'function') {
    try { value = CloudSync.residentMedia(String(key)); } catch (_) {}
  } else if (!String(key).includes(':')) value = imagesDb && imagesDb[key];
  return typeof value === 'string' && value.startsWith('data:') ? value : null;
}

let mediaReadinessRetry = null;
async function ensureReferencedMediaReady(options) {
  const opts = Object.assign({ retry: true }, options || {});
  const keys = [...new Set((opts.keys || referencedMediaKeysForExport()).map(String).filter(Boolean))];
  const missingKeys = async () => {
    let manifest = window.CloudSync && CloudSync.serverMediaManifest || {};
    if (window.CloudSync && CloudSync.uid && typeof CloudSync.storeGet === 'function') {
      const outbox = await CloudSync.storeGet('outbox', CloudSync.uid).catch(() => null);
      if (outbox && outbox.mediaManifest) manifest = outbox.mediaManifest;
    }
    const unavailable = [];
    for (const key of keys) {
      const bytes = residentMediaBytes(key);
      if (!bytes) { unavailable.push(key); continue; }
      const expected = manifest && manifest[key];
      if (expected && expected.sha256 && window.CloudSync && typeof CloudSync.mediaMetadata === 'function') {
        const actual = await CloudSync.mediaMetadata(bytes).catch(() => null);
        if (!actual || actual.sha256 !== expected.sha256) unavailable.push(key);
      }
    }
    return unavailable;
  };
  let missing = await missingKeys();

  // A normal cloud pull paints structured records first and intentionally
  // hydrates their bytes in the background. Explicit export/share operations
  // must join that work before deciding that an attachment is unavailable.
  const hydration = window.CloudSync && CloudSync._mediaHydrationPromise;
  if (missing.length && hydration && typeof hydration.then === 'function') {
    try { await hydration; } catch (_) {}
    missing = await missingKeys();
  }

  // A manual operation gets one fresh, fully-awaited pull in case the earlier
  // background request was interrupted. Deduplicate concurrent button clicks.
  if (missing.length && opts.retry && window.CloudSync && CloudSync.uid && typeof CloudSync.pull === 'function') {
    if (!mediaReadinessRetry) {
      mediaReadinessRetry = Promise.resolve()
        .then(() => CloudSync.pull({ awaitMedia: true }))
        .catch(() => null)
        .finally(() => { mediaReadinessRetry = null; });
    }
    await mediaReadinessRetry;
    missing = await missingKeys();
  }

  const details = missing.map(key => {
    if (window.CloudSync && typeof CloudSync.describeMediaKey === 'function') {
      try { return CloudSync.describeMediaKey(key); } catch (_) {}
    }
    return { key, filename: 'Attachment' };
  });
  return { ok: missing.length === 0, keys, missing, details };
}

let lastIncompleteMediaWarning = { signature: '', at: 0 };
function warnIncompleteMedia(result, operation, options) {
  const opts = options || {};
  const count = result && result.missing ? result.missing.length : 0;
  const signature = String(operation || '') + ':' + ((result && result.missing) || []).join('|');
  const now = Date.now();
  if (!opts.force && signature === lastIncompleteMediaWarning.signature && now - lastIncompleteMediaWarning.at < 15000) return;
  lastIncompleteMediaWarning = { signature, at: now };
  const label = count === 1 ? '1 referenced attachment is' : count + ' referenced attachments are';
  toast((operation || 'This operation') + ' stopped because ' + label +
    ' not available on this device. Open Sync & Recovery to retry or reattach the missing file' +
    (count === 1 ? '.' : 's.'), 'error', 10000);
}

async function removeUnreferencedDraftImages(ids) {
  const saved = referencedInventoryImageIds();
  const candidates = [...new Set(Array.from(ids || []).filter(id => typeof id === 'string' && id))];
  for (const id of candidates) {
    if (saved.has(id)) continue;
    delete imagesDb[id];
    delete thumbCache[id];
    if (imageStore) {
      try { await idbDelete(id); } catch (error) { console.warn('Draft image cleanup failed:', id, error); }
    }
  }
}

window.getReferencedFirearmImages = getReferencedFirearmImages;
window.ensureReferencedMediaReady = ensureReferencedMediaReady;

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
function addAuditEntry(action, itemType, itemName, details, metadata) {
  if (!db.auditTrail) db.auditTrail = [];
  const entry = window.VaultActivity
    ? VaultActivity.createEntry(action, itemType, itemName, details, metadata)
    : {
        id: generateId(),
        timestamp: new Date().toISOString(),
        action: action, // 'create', 'edit', 'delete'
        itemType: itemType, // 'firearm', 'ammo', 'accessory', 'maintenance'
        itemName: itemName,
        details: details || ''
      };
  db.auditTrail.push(entry);
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
    chip.append(document.createTextNode(tag + ' '));
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'tag-remove';
    remove.setAttribute('aria-label', 'Remove tag ' + tag);
    remove.textContent = '×';
    remove.addEventListener('click', event => { event.stopPropagation(); removeTag(idx); });
    chip.appendChild(remove);
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
      saveFirearmDraftSoon();
    }
    e.target.value = '';
    hideTagSuggestions();
  } else if (e.key === 'Backspace' && e.target.value === '' && tempTags.length > 0) {
    tempTags.pop();
    renderTagsInput();
    saveFirearmDraftSoon();
  }
}

function removeTag(idx) {
  tempTags.splice(idx, 1);
  renderTagsInput();
  saveFirearmDraftSoon();
}

function showTagSuggestions() {
  const input = document.getElementById('tagInput');
  const val = input.value.toLowerCase().trim();
  const sug = document.getElementById('tagSuggestions');
  if (!val) { sug.classList.remove('open'); return; }

  const all = getAllTags().filter(t => t.toLowerCase().includes(val) && !tempTags.includes(t));
  if (all.length === 0) { sug.classList.remove('open'); return; }

  sug.replaceChildren();
  all.slice(0, 8).forEach((tag) => {
    const option = document.createElement('button');
    option.type = 'button';
    option.className = 'tag-suggestion';
    option.textContent = tag;
    option.addEventListener('click', () => selectTagSuggestion(tag));
    sug.appendChild(option);
  });
  sug.classList.add('open');
}

function selectTagSuggestion(tag) {
  if (!tempTags.includes(tag)) {
    tempTags.push(tag);
    renderTagsInput();
    saveFirearmDraftSoon();
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

async function writeToDisk(options) {
  if (!fileHandle) return;
  const opts = options || {};
  try {
    const readiness = opts.readiness || await ensureReferencedMediaReady({ retry: !!opts.manual });
    if (!readiness.ok) {
      warnIncompleteMedia(
        readiness,
        opts.manual ? 'File export' : 'The connected file was not overwritten',
        { force: !!opts.manual }
      );
      return false;
    }
    let saveObj = Object.assign({}, db, { images: getReferencedFirearmImages() });
    let toWrite = saveObj;
    if (db.encrypted && currentPassword) {
      toWrite = await encryptData(JSON.stringify(saveObj), currentPassword);
    }
    const writable = await fileHandle.createWritable();
    await writable.write(JSON.stringify(toWrite, null, 2));
    await writable.close();
    showSaveIndicator();
    return true;
  } catch (e) {
    console.error('Write failed:', e);
    toast('Failed to save to disk: ' + e.message);
    disconnectFile();
    return false;
  }
}

function onFileConnected() {
  normalizeRichTextData();
  normalizeInternalIds();
  const _wo = document.getElementById('welcomeOverlay'); if (_wo) _wo.style.display = 'none';
  document.getElementById('statusDot').className = 'file-status-dot connected';
  document.getElementById('fileStatusText').textContent = 'Connected:';
  document.getElementById('fileStatusName').textContent = fileHandle.name;

  if (db.encrypted) {
    document.getElementById('encryptionStatus').innerHTML = ' <span class="lock-indicator">&#128274;</span>';
  } else {
    document.getElementById('encryptionStatus').innerHTML = '';
  }

  document.getElementById('backupBtn').style.display = 'inline-block';
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
  setSaveStatus('saved', 'Saved ' + new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }));
}

async function saveData() {
  // Mark the in-memory edit unsafe before the first await. This matters for
  // callers that intentionally do not await saveData(): closing during an
  // export-file write must warn until IndexedDB or the scoped outbox commits.
  hasUnsavedChanges = true;
  setSaveStatus('saving');
  await writeToDisk();
  let persisted = false;
  try { persisted = await saveToLocalStorage(); }
  catch (error) { console.warn('Durable save failed:', error); }
  updateStats();
  if (!persisted) setSaveStatus('failed', 'Not saved - keep this page open');
  return persisted;
}

async function keepFormOpenAfterSaveFailure(previousDatabase, attemptedDatabase, modalId, label) {
  const safeToRollbackWholeSnapshot = !attemptedDatabase || editValuesEqual(db, attemptedDatabase);
  if (safeToRollbackWholeSnapshot) {
    db = previousDatabase;
    hasUnsavedChanges = false;
  }
  const modal = document.getElementById(modalId);
  if (modal) modal.dataset.dirty = 'true';
  if (safeToRollbackWholeSnapshot) {
    try {
      const safeCopy = Object.assign({}, db);
      delete safeCopy.backups;
      await statePut('db', safeCopy);
    } catch (error) { console.warn('Previous device snapshot could not be restored after the failed form save:', error); }
  } else {
    console.warn('A newer database mutation arrived while this save was pending; the newer state was preserved instead of applying a whole-database rollback.');
  }
  render();
  setSaveStatus('failed', (label || 'Changes') + ' not saved');
  toast((label || 'Changes') + ' could not be confirmed as saved, so the form was kept open. Keep this page open and retry.', 'error', 9000);
}

const activeFormSaves = new Set();
let activeFormSavePromise = null;
async function withFormSaveLock(key, buttonId, operation) {
  if (activeFormSaves.size > 0) {
    toast('Another save is still finishing. Wait a moment, then try again.', 'warning', 5000);
    return false;
  }
  activeFormSaves.add(key);
  const button = buttonId && document.getElementById(buttonId);
  const modal = button && button.closest('.modal-overlay');
  const previousDisabled = button && button.disabled;
  const previousText = button && button.textContent;
  if (modal) modal.dataset.saving = 'true';
  if (button) { button.disabled = true; button.textContent = 'Saving...'; }
  const execution = Promise.resolve().then(operation);
  activeFormSavePromise = execution;
  try { return await execution; }
  finally {
    if (activeFormSavePromise === execution) activeFormSavePromise = null;
    activeFormSaves.delete(key);
    if (modal && modal.isConnected) modal.dataset.saving = 'false';
    if (button && button.isConnected) {
      button.disabled = !!previousDisabled;
      button.textContent = previousText;
    }
  }
}

window.waitForActiveFormSave = async function waitForActiveFormSave(timeoutMs) {
  const pending = activeFormSavePromise;
  if (!pending) return { ok: true, active: false };
  const timeout = Math.max(1000, Number(timeoutMs) || 12000);
  let timeoutId;
  const timedOut = new Promise(resolve => {
    timeoutId = setTimeout(() => resolve({ ok: false, active: true, status: 'timeout' }), timeout);
  });
  const settled = pending.then(
    result => ({ ok: true, active: true, result }),
    error => ({ ok: true, active: true, result: false, error: String(error && error.message || error || '') })
  );
  const outcome = await Promise.race([settled, timedOut]);
  clearTimeout(timeoutId);
  return outcome;
};

// =====================================================
// ENCRYPTION
// =====================================================
async function encryptData(plaintext, password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const iterations = 310000;
  const keyMaterial = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), { name: 'PBKDF2' }, false, ['deriveBits']);
  const keyBits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: salt, iterations, hash: 'SHA-256' }, keyMaterial, 256);
  const key = await crypto.subtle.importKey('raw', keyBits, { name: 'AES-GCM' }, false, ['encrypt']);
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, key, new TextEncoder().encode(plaintext));
  return { encrypted: true, algorithm: 'AES-256-GCM', kdf: 'PBKDF2-SHA-256', iterations, salt: Array.from(salt), iv: Array.from(iv), ciphertext: Array.from(new Uint8Array(ciphertext)) };
}

async function decryptData(encryptedObj, password) {
  if (!encryptedObj || !Array.isArray(encryptedObj.salt) || !Array.isArray(encryptedObj.iv) || !Array.isArray(encryptedObj.ciphertext)) throw new Error('Encrypted file format is invalid');
  const salt = new Uint8Array(encryptedObj.salt);
  const iv = new Uint8Array(encryptedObj.iv);
  const ciphertext = new Uint8Array(encryptedObj.ciphertext);
  const iterations = Number(encryptedObj.iterations || 100000);
  if (salt.length !== 16 || iv.length !== 12 || !Number.isInteger(iterations) || iterations < 100000 || iterations > 1000000) throw new Error('Encrypted file parameters are invalid');
  const keyMaterial = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), { name: 'PBKDF2' }, false, ['deriveBits']);
  const keyBits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: salt, iterations, hash: 'SHA-256' }, keyMaterial, 256);
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
  const privacySetting = document.getElementById('privacySetting');
  if (privacySetting) privacySetting.checked = privacyMode;
  if (typeof window.refreshMfaSettings === 'function') window.refreshMfaSettings();
  refreshDataSafetyPanel();
  document.getElementById('settingsModal').classList.add('open');
}

function closeSettingsModal() {
  document.getElementById('settingsModal').classList.remove('open');
  ['acctCurrentPassword', 'acctNewPassword', 'acctConfirmPassword'].forEach(id => { const field = document.getElementById(id); if (field) field.value = ''; });
  document.getElementById('newPassword').value = '';
  document.getElementById('confirmPassword').value = '';
  if (typeof window.cancelMfaEnrollment === 'function') window.cancelMfaEnrollment({ silent: true }).catch(() => {});
}

async function setEncryption() {
  const pwd = document.getElementById('newPassword').value;
  const conf = document.getElementById('confirmPassword').value;
  if (!pwd) { toast('Please enter a password.'); return; }
  if (pwd.length < 12) { toast('Use at least 12 characters for local file encryption.', 'error'); return; }
  if (pwd !== conf) { toast('Passwords do not match.'); return; }
  db.encrypted = true;
  currentPassword = pwd;
  await saveData();
  closeSettingsModal();
  toast('Encryption enabled for the connected local export file. Cloud data and downloaded backups are unchanged.');
  location.reload();
}

async function removeEncryption() {
  if (!await confirmDialog('Remove encryption? Your password will no longer be required.', { title: 'Remove encryption', okText: 'Remove', danger: true })) return;
  db.encrypted = false;
  currentPassword = null;
  await saveData();
  closeSettingsModal();
  toast('Connected local export-file encryption removed.');
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
    const parsed = JSON.parse(decrypted);
    db = window.VaultSecurity
      ? window.VaultSecurity.normalizeDatabase(parsed, { regenerateInvalidIds: true, allowUnknownTopLevel: true }).data
      : parsed;
    normalizeRichTextData();
    normalizeInternalIds();
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
let durableBackupList = [];

async function openBackupModal() {
  const list = document.getElementById('backupList');
  list.innerHTML = '<p class="backup-empty" role="status">Loading recovery points&hellip;</p>';
  document.getElementById('backupModal').classList.add('open');
  if (window.IndependentBackupVault) IndependentBackupVault.refreshStatus().catch(() => {});
  durableBackupList = [];
  let readError = null;
  try {
    if (window.VaultDataSafety && window.CloudSync && CloudSync.uid) {
      durableBackupList = await VaultDataSafety.listBackups(CloudSync.uid);
    }
  } catch (error) {
    console.warn('Could not read recovery points:', error);
    readError = error;
  }
  if (readError) {
    list.innerHTML = '<div class="backup-empty backup-read-error" role="alert"><strong>Recovery points could not be read.</strong><br>' +
      '<span>Your current collection has not been changed. Check this device\'s storage access, then try again.</span>' +
      '<div class="backup-actions"><button type="button" class="btn btn-outline" onclick="openBackupModal()">Retry</button></div></div>';
    return;
  }
  if (!durableBackupList.length) {
    list.innerHTML = '<p class="backup-empty" role="status">No recovery points yet. They are created after successful cloud saves; you can download a full backup below at any time.</p>';
    return;
  }
  list.innerHTML = durableBackupList.map((backup, index) => {
    const counts = backup.counts || {};
    const summary = [
      (counts.firearms || 0) + ' firearms',
      (counts.ammo || 0) + ' ammunition records',
      (counts.accessories || 0) + ' accessories'
    ].join(', ');
    return '<button type="button" class="backup-item" onclick="selectBackup(' + index + ')">' +
      '<span>' + esc(new Date(backup.createdAt).toLocaleString()) + '</span>' +
      '<span class="backup-summary">' + esc(summary) + ' &middot; ' + esc(backup.reason || 'automatic') + '</span>' +
      '</button>';
  }).join('');
}

function closeBackupModal() { document.getElementById('backupModal').classList.remove('open'); }

async function selectBackup(index) {
  if (!await confirmDialog('Restore this backup? Current data will be replaced.', { title: 'Restore backup', okText: 'Restore', danger: true })) return;
  const backup = durableBackupList[index];
  if (!backup || !window.VaultDataSafety || !window.CloudSync) { toast('That recovery point is unavailable.', 'error'); return; }
  try {
    if (!await VaultDataSafety.verifyBackup(backup)) throw new Error('The recovery-point integrity check failed.');
    CloudSync.applyStructured(structuredClone(backup.data));
    normalizeRichTextData();
    normalizeInternalIds();
    addAuditEntry('edit', 'system', 'Recovery Point Restore', 'Restored recovery point dated ' + new Date(backup.createdAt).toLocaleString());
    const queued = await CloudSync.queueCurrentSnapshot('recovery-restore');
    if (!queued.ok) throw new Error((queued.error && queued.error.message) || 'The restored copy could not be saved locally.');
    const cloud = await CloudSync.push({ capture: false, reason: 'recovery-restore' });
    closeBackupModal();
    render();
    toast(cloud.ok ? 'Recovery point restored and synced.' : 'Recovery point restored on this device; cloud sync will retry.', cloud.ok ? 'success' : 'info', 7000);
  } catch (error) {
    toast('Recovery failed: ' + error.message, 'error', 9000);
  }
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
  document.getElementById('backupBtn').style.display = 'inline-block';
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
      `<button type="button" class="reminder-item sev-${r.sev}" style="width:100%;background:transparent;color:inherit;font:inherit;text-align:left;" onclick="reminderGo('${r.itemType}','${r.itemId}')">
        <span class="reminder-icon">${r.icon}</span><span class="reminder-text">${esc(r.text)}</span>
        <span class="reminder-go">&#8250;</span></button>`).join('');
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
function shareUrl(token) {
  const url = new URL('share.html', location.href);
  url.search = '';
  url.hash = 't=' + encodeURIComponent(String(token || ''));
  return url.href;
}

function openShareModal() {
  const r = document.getElementById('shareResult'); if (r) r.style.display = 'none';
  document.getElementById('sharePhotos').checked = false;
  document.getElementById('shareSerials').checked = false;
  document.getElementById('shareExpiry').value = '7';
  document.getElementById('shareCode').value = '';
  document.getElementById('shareMaxViews').value = '';
  document.getElementById('shareModal').classList.add('open');
  renderSharesList();
}
function closeShareModal() { document.getElementById('shareModal').classList.remove('open'); }

async function buildShareSnapshot(opts) {
  const active = db.firearms.filter(f => !f.status || f.status === 'Active');
  if (opts.photos) {
    const photoKeys = active
      .map(firearm => Array.isArray(firearm.images) && firearm.images[0])
      .filter(Boolean)
      .map(String);
    const readiness = await ensureReferencedMediaReady({ keys: photoKeys, retry: true });
    if (!readiness.ok) {
      const error = new Error('Selected photos are not available on this device.');
      error.code = 'MEDIA_INCOMPLETE';
      error.mediaReadiness = readiness;
      throw error;
    }
  }
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
    snapshotVersion: 1,
    source: 'Firearms Vault',
    appVersion: APP_VERSION,
    generatedAt: new Date().toISOString(), label: opts.label || '',
    totals: { firearms: active.length, value: fVal + accVal, accessories: db.accessories.length, rounds },
    includePhotos: opts.photos,
    includeSerials: opts.serials,
    firearms,
    accessories
  };
}

async function createShare() {
  const btn = document.getElementById('createShareBtn');
  btn.disabled = true; btn.textContent = 'Creating…';
  try {
    const rawCode = document.getElementById('shareCode').value;
    const opts = {
      label: document.getElementById('shareLabel').value.trim(),
      photos: document.getElementById('sharePhotos').checked,
      serials: document.getElementById('shareSerials').checked,
      code: rawCode.trim(),
      maxViews: parseInt(document.getElementById('shareMaxViews').value, 10) || null
    };
    if (rawCode && !opts.code) { toast('A passcode cannot contain only spaces.', 'error'); return; }
    if (opts.code && opts.code.length < 12) { toast('A share passcode must contain at least 12 characters.', 'error'); return; }
    if (opts.code && new TextEncoder().encode(opts.code).length > 72) { toast('A share passcode cannot exceed 72 bytes.', 'error'); return; }
    const expDays = parseInt(document.getElementById('shareExpiry').value);
    if (opts.photos || opts.serials || expDays === 0) {
      const included = [opts.photos ? 'photos' : '', opts.serials ? 'serial numbers' : '', expDays === 0 ? 'a link that never expires' : ''].filter(Boolean).join(', ');
      const approved = await confirmDialog('This share includes ' + included + '. Anyone with the link can view those details. Continue?', {
        title: 'Review sensitive share', okText: 'Create link'
      });
      if (!approved) return;
    }
    const expires_at = expDays > 0 ? new Date(Date.now() + expDays * 86400000).toISOString() : null;
    const snapshot = await buildShareSnapshot(opts);
    const { data, error } = await window.sbClient.rpc('create_inventory_share', {
      p_label: opts.label || null,
      p_snapshot: snapshot,
      p_expires_at: expires_at,
      p_access_code: opts.code || null,
      p_max_views: opts.maxViews
    });
    if (error) throw error;
    const token = typeof data === 'string' ? data : data && data.token;
    if (!token) throw new Error('The share service did not return a link token.');
    const url = shareUrl(token);
    const box = document.getElementById('shareResult');
    box.style.display = 'block';
    box.replaceChildren();
    const result = document.createElement('div'); result.className = 'share-result-box';
    const heading = document.createElement('div'); heading.style.fontWeight = '600'; heading.style.marginBottom = '6px';
    heading.textContent = '✓ Share link created' + (opts.code ? ' · passcode protected' : '');
    const summary = document.createElement('div'); summary.className = 'share-row-meta';
    summary.textContent = [
      expires_at ? 'Expires ' + fmtDate(expires_at) : 'No expiry',
      opts.maxViews ? opts.maxViews + ' open' + (opts.maxViews === 1 ? '' : 's') + ' maximum' : 'Unlimited opens until expiry',
      opts.photos ? 'photos included' : 'photos excluded',
      opts.serials ? 'serial numbers included' : 'serial numbers excluded',
      opts.code ? 'passcode protected' : 'link only'
    ].join(' | ');
    const urlText = document.createElement('div'); urlText.className = 'share-url'; urlText.textContent = url;
    const actions = document.createElement('div'); actions.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;margin-top:10px;';
    const copy = document.createElement('button'); copy.type = 'button'; copy.className = 'btn btn-small btn-primary'; copy.textContent = 'Copy link';
    copy.addEventListener('click', () => copyShareLink(url, copy, urlText));
    actions.append(copy);
    result.append(heading, summary, urlText, actions);
    if (opts.code) {
      const codeNote = document.createElement('p'); codeNote.className = 'share-privacy-note';
      codeNote.style.marginTop = '10px';
      codeNote.textContent = 'The passcode is not included in this link and cannot be recovered. Send it separately through a different channel.';
      result.appendChild(codeNote);
    }
    box.appendChild(result);
    document.getElementById('shareLabel').value = '';
    document.getElementById('shareCode').value = '';
    document.getElementById('shareMaxViews').value = '';
    document.getElementById('shareModal').dataset.dirty = 'false';
    renderSharesList();
  } catch (e) {
    if (e && e.code === 'MEDIA_INCOMPLETE') warnIncompleteMedia(e.mediaReadiness, 'Photo sharing', { force: true });
    else toast('Could not create share link: ' + (e.message || e), 'error');
  } finally { btn.disabled = false; btn.textContent = 'Create share link'; }
}

function showShareLinkForManualCopy(url, target) {
  if (target) {
    target.textContent = url;
    target.title = '';
  }
  toast('Copy failed - the full link is now shown for manual copying.', 'error');
}

function copyShareLink(url, button, manualTarget) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(url).then(() => {
      toast('Link copied to clipboard.', 'success');
      if (!button) return;
      const original = button.textContent;
      button.textContent = 'Copied';
      button.disabled = true;
      setTimeout(() => { button.textContent = original; button.disabled = false; }, 1800);
    })
      .catch(() => showShareLinkForManualCopy(url, manualTarget));
  } else { showShareLinkForManualCopy(url, manualTarget); }
}

async function renderSharesList() {
  const list = document.getElementById('shareList');
  if (!list) return;
  list.innerHTML = '<div style="color:var(--text3);font-size:0.8rem;">Loading…</div>';
  const cleanup = await window.sbClient.from('shares').delete().eq('owner', CloudSync.uid).lt('expires_at', new Date().toISOString());
  const { data, error } = await window.sbClient.from('shares')
    .select('token,label,created_at,expires_at,max_views,access_count,last_accessed_at,has_access_code').eq('owner', CloudSync.uid).order('created_at', { ascending: false });
  if (error) { list.innerHTML = '<div style="color:var(--red);font-size:0.8rem;">Could not load shares.</div>'; return; }
  if (!data.length) { list.innerHTML = '<div style="color:var(--text3);font-size:0.8rem;">No active share links.</div>'; return; }
  const now = Date.now();
  list.replaceChildren();
  if (cleanup.error) {
    const warning = document.createElement('div');
    warning.className = 'share-privacy-note';
    warning.setAttribute('role', 'status');
    warning.textContent = 'Expired links could not be cleaned up just now. They remain inactive and can still be revoked below.';
    list.appendChild(warning);
  }
  data.forEach(s => {
    const url = shareUrl(s.token);
    const expired = !!(s.expires_at && new Date(s.expires_at).getTime() < now);
    const exp = s.expires_at ? (expired ? 'Expired' : 'Expires ' + fmtDate(s.expires_at)) : 'No expiry';
    const opens = (Number(s.access_count) || 0) + (s.max_views ? '/' + s.max_views : '') + ' open' + ((Number(s.access_count) || 0) === 1 ? '' : 's');
    const metadata = [expired ? 'Inactive' : 'Active', exp, opens, s.has_access_code ? 'passcode protected' : 'link only'];
    if (s.last_accessed_at) metadata.push('last opened ' + fmtDate(s.last_accessed_at));
    metadata.push('created ' + fmtDate(s.created_at));
    const row = document.createElement('div'); row.className = 'share-row';
    const info = document.createElement('div'); info.className = 'share-row-info';
    const label = document.createElement('div'); label.className = 'share-row-label'; label.textContent = s.label || 'Untitled share';
    const meta = document.createElement('div'); meta.className = 'share-row-meta'; meta.textContent = metadata.join(' · ');
    const urlText = document.createElement('div'); urlText.className = 'share-url';
    urlText.textContent = 'Private link ending ' + String(s.token).slice(-8);
    urlText.title = url;
    info.append(label, meta, urlText);
    const copy = document.createElement('button'); copy.type = 'button'; copy.className = 'btn btn-small btn-outline'; copy.textContent = 'Copy';
    copy.addEventListener('click', () => copyShareLink(url, copy, urlText));
    const revoke = document.createElement('button'); revoke.type = 'button'; revoke.className = 'btn btn-small btn-danger'; revoke.textContent = 'Revoke';
    revoke.addEventListener('click', () => revokeShare(s.token, s.label));
    row.append(info, copy, revoke); list.appendChild(row);
  });
}

async function revokeShare(token, label) {
  const name = String(label || 'this share link');
  if (!await confirmDialog('Revoke "' + name + '"? This prevents future opens and reloads, but cannot recall a copy that someone already opened or saved.', { title: 'Revoke share link', okText: 'Revoke', danger: true })) return;
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
let _dashboardChartLoadStarted = false;
function _destroyDashCharts() { _dashCharts.forEach(c => { try { c.destroy(); } catch (e) {} }); _dashCharts = []; }

let _dashRange = 90;
function setDashRange(n) { _dashRange = n; render(); }
window.setDashRange = setDashRange;
let _dashAnalyticsExpanded = false;
function toggleDashboardAnalytics() {
  _dashAnalyticsExpanded = !_dashAnalyticsExpanded;
  const analytics = document.querySelector('#dashAnalytics');
  const button = document.querySelector('#dashAnalyticsToggle');
  if (analytics) analytics.hidden = !_dashAnalyticsExpanded;
  if (button) {
    button.setAttribute('aria-expanded', _dashAnalyticsExpanded ? 'true' : 'false');
    button.textContent = _dashAnalyticsExpanded ? 'Hide analytics' : 'Explore analytics';
  }
  if (_dashAnalyticsExpanded) requestAnimationFrame(() => _dashCharts.forEach(chart => { try { chart.resize(); } catch (_) {} }));
}
window.toggleDashboardAnalytics = toggleDashboardAnalytics;

function renderDashboard() {
  if (!window.Chart && window.VaultAssets && !_dashboardChartLoadStarted) {
    _dashboardChartLoadStarted = true;
    window.VaultAssets.ensure('charts').then(() => {
      if (currentTab === 'dashboard') render();
    }).catch(error => {
      const message = 'Charts could not load; dashboard summaries remain available.';
      showPersistentFeatureError(message);
      console.error('Dashboard chart load failed', error);
    });
  }
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
    reminders.slice(0, 6).map(r => '<button type="button" class="dash-alert sev-' + r.sev + '" style="width:100%;border-top:0;border-right:0;border-bottom:0;font:inherit;text-align:left;" onclick="reminderGo(\'' + r.itemType + '\',\'' + r.itemId + '\')"><span class="dash-alert-ico">' + r.icon + '</span><span>' + esc(r.text) + '</span></button>').join('') +
    '</div></div>' : '';

  // Highlights
  let highlightsCard = '';
  if (active.length) {
    const mv = active.reduce((best, f) => getTotalInvestment(f.id) > getTotalInvestment(best.id) ? f : best, active[0]);
    const nw = recent[0];
    const hl = (f, label, sub) => {
      const t = thumbOf(f);
      const img = t ? '<img class="dh-img" src="' + t + '" alt="">' : '<div class="dh-img dh-ph" aria-hidden="true">✦</div>';
      return '<button type="button" class="dash-highlight" style="width:100%;background:transparent;border:0;color:inherit;font:inherit;text-align:left;" onclick="openDetail(\'' + f.id + '\')">' + img + '<span class="dh-text"><span class="dh-label" style="display:block;">' + label +
        '</span><span class="dh-title" style="display:block;">' + esc((f.make || '') + ' ' + (f.model || '')) + '</span><span class="dh-sub" style="display:block;">' + sub + '</span></span></button>';
    };
    highlightsCard = '<div class="dash-card"><h3>Highlights</h3>' + hl(mv, 'Most valuable', fmt$(getTotalInvestment(mv.id))) + (nw ? hl(nw, 'Newest acquisition', fmtDate(nw.dateAcquired)) : '') + '</div>';
  }

  // Value-over-time with range toggle
  const hist = (db.valueHistory || []).slice(-_dashRange);
  const hasValueChart = hist.length >= 2;
  const rangeBtns = '<span class="dash-range">' + [[30, '30d'], [90, '90d'], [365, '1y'], [100000, 'All']].map(r =>
    '<button class="' + (_dashRange === r[0] ? 'active' : '') + '" aria-pressed="' + (_dashRange === r[0] ? 'true' : 'false') + '" onclick="setDashRange(' + r[0] + ')">' + r[1] + '</button>').join('') + '</span>';

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
      '<div class="dash-nfa-pill" style="background:var(--yellow-bg);color:var(--warning-text);"><span class="si">◷</span>Pending: ' + nfaPending + '</div>' +
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
    '<div class="dash-card"><h3>Recent Acquisitions</h3><div class="dash-list">' + recentList + '</div></div>' +
    '<div class="dash-section-head"><div><h3>Collection analytics</h3><p>Breakdowns by type, caliber, manufacturer, NFA status, condition, and tags.</p></div>' +
      '<button type="button" class="btn btn-outline" id="dashAnalyticsToggle" aria-controls="dashAnalytics" aria-expanded="' + (_dashAnalyticsExpanded ? 'true' : 'false') + '" onclick="toggleDashboardAnalytics()">' + (_dashAnalyticsExpanded ? 'Hide analytics' : 'Explore analytics') + '</button></div>' +
    '<div class="dash-analytics-grid" id="dashAnalytics"' + (_dashAnalyticsExpanded ? '' : ' hidden') + '>' +
      chartCard('Firearms by Type', 'typeChartCanvas', typeFallback) +
      chartCard('Top Calibers', 'calChartCanvas', calFallback) +
      chartCard('Top Manufacturers', 'mfgChartCanvas', mfgFallback) +
      nfaCard + ammoCard +
      '<div class="dash-card"><h3>Condition</h3><div class="dash-list">' + (condList || note('No data.')) + '</div></div>' +
      '<div class="dash-card"><h3>Tags</h3><div class="dash-list">' + tagsList + '</div></div>' +
    '</div>';

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

  try {

  updateContextualActions();
  updateBottomNav();
  updateFilterChips();
  updatePageContext();

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
  updatePageContext(items.length);
  if (db.firearms.length === 0) { grid.style.display='none'; tc.style.display='none'; empty.style.display='block'; return; }
  empty.style.display = 'none';

  if (items.length === 0) {
    grid.style.display='none'; tc.style.display='none';
    const t = currentView==='cards'?grid:tc;
    t.style.display = currentView==='cards'?'grid':'block';
    const hasFilters = ['searchBox', 'filterType', 'filterCaliber', 'filterTag', 'filterCondition']
      .some(id => (document.getElementById(id)?.value || '').trim());
    if (!hasFilters && currentTab === 'nfa') {
      t.innerHTML = tabEmpty('📄', 'No NFA items yet', 'Use Add NFA item when you are ready to track a suppressor, SBR, or other regulated item.', '');
    } else if (!hasFilters && currentTab === 'disposed') {
      t.innerHTML = tabEmpty('↗', 'No sold or transferred records yet', 'Records appear here after you mark a firearm sold, transferred, consigned, or otherwise disposed.', '');
    } else {
      t.innerHTML = '<div class="empty-inline"><div class="icon">&#128269;</div><p>No items match your search or filters.</p><button class="btn btn-outline" onclick="clearAllFilters()">Clear filters</button></div>';
    }
    return;
  }

  if (currentView === 'cards') { grid.style.display='grid'; tc.style.display='none'; renderCards(getCardSortedItems(items)); }
  else { grid.style.display='none'; tc.style.display='block'; renderTable(items); }
  } finally {
    // Privacy mode must apply before this render yields; relying only on the
    // mutation observer can expose newly-created serials or values for a frame.
    refreshSensitiveElements(document);
  }
}

function renderAmmoTab() {
  document.getElementById('cardGrid').style.display = 'none';
  document.getElementById('tableContainer').style.display = 'block';
  document.getElementById('emptyState').style.display = 'none';
  const allItems = db.ammo || [];
  const query = (document.getElementById('searchBox').value || '').trim().toLowerCase();
  const items = query ? allItems.filter(a => [a.brand, a.caliber, a.location, a.notes]
    .some(value => String(value || '').replace(/<[^>]*>/g, ' ').toLowerCase().includes(query))) : allItems;
  const totalRounds = items.reduce((s, a) => s + (parseInt(a.quantity) || 0), 0);
  const totalCost = items.reduce((s, a) => s + ((parseInt(a.quantity) || 0) * (parseFloat(a.pricePerRound) || 0)), 0);
  updatePageContext(items.length);

  let h = `<div style="padding: 16px 24px; background: var(--bg2); border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; font-size: 0.86rem; font-weight: 600;">
    <span>Rounds shown: <span style="color: var(--accent);">${totalRounds.toLocaleString()}</span></span>
    <span>Value shown: <span style="color: var(--accent);">$${totalCost.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})}</span></span>
  </div>`;

  if (items.length === 0) {
    h += allItems.length
      ? tabEmpty('🔍', 'No ammunition matches your search', 'Try a caliber, brand, load, or storage location.', '<button class="btn btn-outline" onclick="clearAllFilters()">Clear search</button>')
      : tabEmpty('🎯', 'No ammunition tracked yet', 'Log rounds on hand, calibers, and value as you stock up.', '<button class="btn btn-primary" onclick="openAddAmmoModal()">Add ammunition</button>');
    document.getElementById('tableContainer').innerHTML = h;
    return;
  }

  h += '<table class="data-table"><thead><tr><th onclick="sortTable(\'brand\')">Brand / Type</th><th onclick="sortTable(\'caliber\')">Caliber</th><th class="num" onclick="sortTable(\'quantity\')">Quantity</th><th onclick="sortTable(\'purchaseDate\')">Purchase Date</th><th class="num" onclick="sortTable(\'pricePerRound\')">Price/Round</th><th class="num">Total Cost</th><th onclick="sortTable(\'location\')">Location</th><th>Receipt</th><th></th></tr></thead><tbody>';

  items.forEach(a => {
    const tc2 = (parseInt(a.quantity) || 0) * (parseFloat(a.pricePerRound) || 0);
    const low = isLowStock(a);
    const hasReceipt = a.receipt ? true : false;
    h += `<tr class="${low?'low-stock':''}">
      <td>${esc(a.brand||'--')}</td>
      <td>${esc(a.caliber||'--')}</td>
      <td class="num">${(parseInt(a.quantity) || 0).toLocaleString()}${low?'<span class="low-stock-badge">LOW</span>':''}</td>
      <td>${fmtDate(a.purchaseDate)}</td>
      <td class="num">$${(parseFloat(a.pricePerRound) || 0).toFixed(2)}</td>
      <td class="num">$${tc2.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})}</td>
      <td>${esc(a.location||'--')}</td>
      <td>${hasReceipt ? '<button class="btn btn-small btn-outline" onclick="event.stopPropagation();viewReceiptInBrowser(\''+a.id+'\',\'ammo\')">View</button> <a href="'+a.receipt+'" download="'+(a.receiptName||'receipt')+'" onclick="event.stopPropagation();" class="btn btn-small btn-file" style="text-decoration:none;display:inline-block;">DL</a>' : '<span style="color:var(--text3);">--</span>'}</td>
      <td style="text-align:right;white-space:nowrap;">
        <button class="btn btn-small btn-outline" data-item-id="${escAttr(a.id)}" onclick="editAmmo(this.dataset.itemId)">Edit</button>
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
    (db.accessories || []).forEach(a => (a.images || []).forEach(i => { if (i) ids.add(i); }));
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
    const itemName = ((f.make || '') + ' ' + (f.model || '')).trim() || 'firearm';
    return `<article class="card${disposed}"><input type="checkbox" class="card-checkbox" data-item-id="${escAttr(f.id)}" ${checked} onclick="toggleBulkSelect(this.dataset.itemId,event)"><button type="button" class="card-hitarea" data-card-id="${escAttr(f.id)}" aria-label="Open ${escAttr(itemName)} details" onclick="openDetail(this.dataset.cardId)"></button>${img}${nfa}${stamp}<div class="card-body">
      <div class="card-title">${esc(f.make||'')} ${esc(f.model||'')}</div>
      <div class="card-subtitle">${esc(f.type||'')} &middot; ${esc(f.caliber||'')}</div>
      <div class="card-details">
        <div class="card-detail"><label>Serial</label><span>${esc(f.serial||'--')}</span></div>
        <div class="card-detail"><label>Barrel</label><span>${esc(f.barrel||'--')}</span></div>
        <div class="card-detail"><label>Condition</label><span>${esc(f.condition||'--')}</span></div>
        <div class="card-detail"><label>Value</label><span>${p}</span></div>
      </div>${tags}</div></article>`;
  }).join('');
}

function renderTable(items) {
  const cols = [{key:'_cb',label:'',sortable:false},{key:'_img',label:'',sortable:false},{key:'make',label:'Make'},{key:'model',label:'Model'},{key:'serial',label:'Serial #'},{key:'caliber',label:'Caliber'},{key:'type',label:'Type'},{key:'barrel',label:'Barrel'},{key:'condition',label:'Condition'},{key:'price',label:'Price',num:true},{key:'dateAcquired',label:'Acquired'},{key:'status',label:'Status'},{key:'_nfa',label:'NFA',sortable:false},{key:'_tags',label:'Tags',sortable:false},{key:'_open',label:'Actions',sortable:false}];
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
    h+=`<tr><td><input type="checkbox" class="card-checkbox table-cb" data-item-id="${escAttr(f.id)}" ${bulkSelected.has(f.id)?'checked':''} onclick="toggleBulkSelect(this.dataset.itemId,event)"></td><td>${im}</td><td>${esc(f.make||'--')}</td><td>${esc(f.model||'--')}</td><td class="mono-id">${esc(f.serial||'--')}</td><td>${esc(f.caliber||'--')}</td><td>${esc(f.type||'--')}</td><td>${esc(f.barrel||'--')}</td><td>${esc(f.condition||'--')}</td><td class="num">${pr}</td><td>${fmtDate(f.dateAcquired)}</td><td>${status}${plStr}</td><td>${nfa}</td><td>${tags}</td><td><button type="button" class="btn btn-small btn-outline" data-card-id="${escAttr(f.id)}" onclick="openDetail(this.dataset.cardId)">View</button></td></tr>`;
  });

  h += '</tbody></table>';
  document.getElementById('tableContainer').innerHTML = h;
}

function sortTable(key) { if(sortCol===key) sortDir=sortDir==='asc'?'desc':'asc'; else{sortCol=key;sortDir='asc';} saveSortPreference(); render(); }
function esc(s) { const d=document.createElement('div'); d.textContent=s; return d.innerHTML; }
function escAttr(s) { return esc(s).replace(/"/g, '&quot;'); } // safe inside double-quoted attributes
// Read a rich-text (.rte-content) editor's HTML, treating an empty editor as ''.
function rteValue(id) { return sanitizeRichText((document.getElementById(id).innerHTML || '').trim()); }
// Render stored rich-text for display (skips the empty-<br> sentinel).
function rteShow(html) { return sanitizeRichText(html); }
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
function stampIcon(s) { const m = { Approved: '✓', Pending: '◷', Submitted: '◔', Denied: '✕' }; return m[s] ? ('<span class="si" aria-hidden="true">' + m[s] + '</span>') : ''; }
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
    const inputLabel = o.inputLabel || o.title || 'Response';
    ov.innerHTML = '<div class="modal" style="max-width:430px;">'
      + '<div class="modal-header"><h2>' + esc(o.title || 'Please confirm') + '</h2></div>'
      + '<div class="modal-body"><p id="_dlgMessage" style="margin:0;line-height:1.5;color:var(--text);">' + esc(o.message || '') + '</p>'
      + (o.input ? '<label class="dlg-input-label" for="_dlgInput">' + esc(inputLabel) + '</label><input type="text" id="_dlgInput" class="dlg-input" aria-describedby="_dlgMessage" value="' + escAttr(o.def || '') + '">' : '')
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
function promptDialog(message, def, opts) { opts = opts || {}; return _appDialog({ message, def: def || '', input: true, inputLabel: opts.inputLabel, title: opts.title || '', okText: opts.okText || 'OK' }); }

// ---- Safe edit sessions -------------------------------------------------
// A form can stay open while cloud sync refreshes db in the background. Keep
// the record as it looked when the form opened, then three-way merge on save:
// untouched form fields follow the latest record, local-only edits are applied,
// and overlapping field edits always ask the user which value to keep.
const recordEditSessions = Object.create(null);
const RECORD_EDIT_LABELS = {
  firearms: {
    make: 'Manufacturer', model: 'Model', serial: 'Serial number', caliber: 'Caliber', type: 'Type',
    barrel: 'Barrel length', dateAcquired: 'Date acquired', price: 'Purchase price', condition: 'Condition',
    notes: 'Notes', images: 'Photos', tags: 'Tags', isNFA: 'NFA item', nfaType: 'NFA type',
    formType: 'Form type', dateSubmitted: 'Date submitted', dateApproved: 'Date approved',
    stampStatus: 'Stamp status', regType: 'Registration type', stampPdf: 'Tax stamp file',
    stampPdfName: 'Tax stamp filename', status: 'Collection status', dispDate: 'Disposition date',
    dispBuyer: 'Transferee', dispPrice: 'Disposition price', dispFFL: 'Disposition FFL',
    dispNotes: 'Disposition notes', receipt: 'Receipt', receiptName: 'Receipt filename',
    documents: 'Documents', roundCount: 'Round count', warrantyExp: 'Warranty expiration',
    customFields: 'Custom fields'
  },
  ammo: {
    caliber: 'Caliber', brand: 'Brand or type', quantity: 'Quantity', purchaseDate: 'Purchase date',
    pricePerRound: 'Price per round', location: 'Storage location', lowStock: 'Low-stock alert',
    notes: 'Notes', receipt: 'Receipt', receiptName: 'Receipt filename'
  },
  accessories: {
    name: 'Accessory name', category: 'Category', brand: 'Manufacturer', model: 'Model or part number',
    serial: 'Serial number', price: 'Purchase price', purchaseDate: 'Purchase date', condition: 'Condition',
    firearmId: 'Assigned firearm', notes: 'Notes', receipt: 'Receipt', receiptName: 'Receipt filename'
  },
  wishlist: {
    make: 'Manufacturer', model: 'Model', caliber: 'Caliber', type: 'Type', price: 'Target price',
    priority: 'Priority', dealer: 'Dealer or source', url: 'Link', notes: 'Notes'
  },
  dealers: {
    name: 'Dealer name', ffl: 'FFL number', phone: 'Phone', email: 'Email', address: 'Address',
    website: 'Website', notes: 'Notes'
  }
};

function cloneEditValue(value) {
  if (value === undefined || value === null || typeof value !== 'object') return value;
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function editValuesEqual(left, right) {
  if (Object.is(left, right)) return true;
  if (left === undefined || right === undefined) return false;
  try { return JSON.stringify(left) === JSON.stringify(right); } catch (_) { return false; }
}

function beginRecordEdit(collection, id, formRecord) {
  const current = (db[collection] || []).find(item => String(item.id) === String(id));
  if (!current) { delete recordEditSessions[collection]; return false; }
  recordEditSessions[collection] = {
    id: String(id),
    baselineRecord: cloneEditValue(current),
    baselineForm: cloneEditValue(formRecord || {})
  };
  return true;
}

function endRecordEdit(collection) { delete recordEditSessions[collection]; }

function recordEditFieldLabel(collection, field) {
  const configured = RECORD_EDIT_LABELS[collection] && RECORD_EDIT_LABELS[collection][field];
  if (configured) return configured;
  const words = String(field || 'field').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function summarizeEditConflictValue(value) {
  if (privacyMode) return 'Hidden while privacy mode is on';
  if (value === undefined || value === null || value === '') return '(empty)';
  if (Array.isArray(value)) return value.length + ' item' + (value.length === 1 ? '' : 's');
  if (typeof value === 'object') return 'Updated information';
  let text = String(value);
  if (text.startsWith('data:') || text.startsWith('@media:')) return 'Attached file';
  text = text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  return text.length > 80 ? text.slice(0, 77) + '...' : text;
}

async function mergeRecordEdit(collection, id, formRecord, attempt) {
  attempt = Number(attempt) || 0;
  const records = db[collection] || [];
  const currentRecord = records.find(item => String(item.id) === String(id));
  const current = cloneEditValue(currentRecord);
  const session = recordEditSessions[collection];

  // Defensive fallback for callers that did not open through the normal form:
  // patch editable fields onto the latest record instead of replacing it.
  if (!session || session.id !== String(id)) {
    return { record: Object.assign(cloneEditValue(current || {}), cloneEditValue(formRecord), { id }), conflicts: [], localFields: Object.keys(formRecord || {}).filter(key => key !== 'id') };
  }

  const localFields = Object.keys(formRecord || {}).filter(field =>
    field !== 'id' && !editValuesEqual(formRecord[field], session.baselineForm[field]));

  if (!current) {
    const restore = await confirmDialog(
      'This record was deleted on another device while you were editing it. Restore the record with your changes, or leave it deleted and keep this form open?',
      { title: 'Record deleted elsewhere', okText: 'Restore my edited record', cancelText: 'Leave deleted' }
    );
    if (!restore) return { record: null, conflicts: ['record'], localFields, cancelled: true };
    const appeared = (db[collection] || []).find(item => String(item.id) === String(id));
    if (appeared) return mergeRecordEdit(collection, id, formRecord, attempt + 1);
    const restored = cloneEditValue(session.baselineRecord);
    localFields.forEach(field => { restored[field] = cloneEditValue(formRecord[field]); });
    restored.id = id;
    return { record: restored, conflicts: ['record'], localFields, restored: true };
  }

  const merged = cloneEditValue(current);
  const conflicts = [];
  localFields.forEach(field => {
    const remoteChanged = !editValuesEqual(current[field], session.baselineRecord[field]);
    if (remoteChanged && !editValuesEqual(current[field], formRecord[field])) conflicts.push(field);
    else merged[field] = cloneEditValue(formRecord[field]);
  });

  for (const field of conflicts) {
    const label = recordEditFieldLabel(collection, field);
    const keepMine = await confirmDialog(
      label + ' changed on another device while this form was open. Latest saved value: "' +
        summarizeEditConflictValue(current[field]) + '". Your value: "' +
        summarizeEditConflictValue(formRecord[field]) + '".',
      { title: 'Choose ' + label, okText: 'Keep my change', cancelText: 'Use latest saved value' }
    );
    merged[field] = cloneEditValue(keepMine ? formRecord[field] : current[field]);
  }
  const latest = (db[collection] || []).find(item => String(item.id) === String(id));
  if (!editValuesEqual(latest, current)) {
    if (attempt < 3) return mergeRecordEdit(collection, id, formRecord, attempt + 1);
    toast('This record is still changing on another device. Review the latest changes and try Save again.', 'error', 8000);
    return { record: null, conflicts, localFields, cancelled: true };
  }
  merged.id = id;
  return { record: merged, conflicts, localFields };
}

window.mergeRecordEdit = mergeRecordEdit;

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
const sectionSearchValues = Object.create(null);
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    const search = document.getElementById('searchBox');
    if (search) sectionSearchValues[currentTab] = search.value;
    document.querySelectorAll('.tab').forEach(t => {
      t.classList.remove('active'); t.setAttribute('aria-selected', 'false'); t.tabIndex = -1;
    });
    tab.classList.add('active');
    tab.setAttribute('aria-selected', 'true'); tab.tabIndex = 0;
    currentTab = tab.dataset.tab;
    if (search) search.value = sectionSearchValues[currentTab] || '';
    sortCol = null;
    render();
  });
  tab.addEventListener('keydown', e => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    const tabs = Array.from(document.querySelectorAll('.tab'));
    let i = tabs.indexOf(tab);
    if (e.key === 'Home') i = 0;
    else if (e.key === 'End') i = tabs.length - 1;
    else i = (i + (['ArrowRight', 'ArrowDown'].includes(e.key) ? 1 : -1) + tabs.length) % tabs.length;
    tabs[i].focus(); tabs[i].click();
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
async function openAddModal() {
  editingId = null;
  endRecordEdit('firearms');
  beginAttachmentSession('formModal');
  const formModal = document.getElementById('formModal');
  delete formModal.dataset.draftSaveCommitted;
  delete formModal.dataset.firearmDraftKey;
  document.getElementById('modalTitle').textContent = 'Add Firearm';
  document.getElementById('saveBtn').disabled = false;
  document.getElementById('saveBtn').textContent = 'Save Firearm';
  clearForm();
  await restoreFirearmDraft();
  syncFirearmDisclosure(null);
  populateDispDealerPicker();
  document.getElementById('formModal').classList.add('open');
}

async function openAddNfaModal() {
  await openAddModal();
  document.getElementById('modalTitle').textContent = 'Add NFA Item';
  document.getElementById('saveBtn').textContent = 'Save NFA Item';
  document.getElementById('fIsNFA').checked = true;
  document.getElementById('fStatus').value = 'Active';
  toggleNFAFields();
  toggleDispositionFields();
  saveFirearmDraftSoon();
}

function openEditModal(id) {
  const f = db.firearms.find(x => x.id === id);
  if (!f) return;
  editingId = id;
  beginAttachmentSession('formModal');
  delete document.getElementById('formModal').dataset.draftSaveCommitted;
  _firearmDraftOwnedImages.clear();
  setFirearmDraftStatus('');
  document.getElementById('modalTitle').textContent = 'Edit Firearm';
  document.getElementById('saveBtn').textContent = 'Update Firearm';
  populateForm(f);
  beginRecordEdit('firearms', id, collectFirearmFormRecord(id));
  syncFirearmDisclosure(f);
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
  endAttachmentSession('formModal');
  document.getElementById('formModal').classList.remove('open');
  editingId=null; tempImages=[]; tempTags=[]; tempStampPdf=null; tempStampPdfName=null;
  endRecordEdit('firearms');
  pendingWishlistMoveId = null;
  hideTagSuggestions();
}

const FIREARM_DRAFT_FIELDS = [
  'fMake', 'fModel', 'fSerial', 'fCaliber', 'fType', 'fBarrel', 'fDateAcquired', 'fPrice',
  'fCondition', 'fStatus', 'fIsNFA', 'fNFAType', 'fFormType', 'fDateSubmitted',
  'fDateApproved', 'fStampStatus', 'fRegType', 'fDispDate', 'fDispBuyer', 'fDispPrice',
  'fDispFFL', 'fRoundCount', 'fWarrantyExp'
];
let _firearmDraftTimer = null;
let _firearmDraftRevision = 0;
const _firearmDraftOwnedImages = new Set();
const _pendingVaultOperations = new Set();
function trackPendingVaultOperation(operation) {
  const tracked = Promise.resolve(operation);
  _pendingVaultOperations.add(tracked);
  tracked.finally(() => _pendingVaultOperations.delete(tracked)).catch(() => {});
  return tracked;
}
async function flushPendingVaultOperations() {
  let ok = true;
  while (_pendingVaultOperations.size) {
    const results = await Promise.allSettled([..._pendingVaultOperations]);
    if (results.some(result => result.status === 'rejected')) ok = false;
  }
  return ok;
}
async function waitForFormAttachments(modalId, label) {
  const session = captureAttachmentSession(modalId);
  const safe = await flushPendingVaultOperations();
  if (!safe) {
    toast((label || 'Attachment') + ' processing failed. The form was kept open so you can retry.', 'error', 9000);
    return false;
  }
  return attachmentSessionActive(session);
}
function runCompatibilityWrite(writer) {
  const sync = window.CloudSync;
  if (sync && sync._runtimeWritesBlocked) {
    return Promise.reject(new Error('Device cache writes are paused while the account is closing.'));
  }
  let operation;
  if (sync && sync.uid && typeof sync.writeRuntime === 'function' && typeof sync.accountContext === 'function') {
    const account = sync.accountContext();
    operation = sync.writeRuntime(account, writer).then(active => {
      if (!active) throw new Error('The account changed before the device cache write completed.');
      return true;
    });
  } else {
    operation = Promise.resolve().then(writer);
  }
  return trackPendingVaultOperation(operation);
}
function beginAttachmentSession(modalId) {
  const modal = document.getElementById(modalId);
  if (modal) modal.dataset.attachmentSession = generateId();
}
function endAttachmentSession(modalId) {
  const modal = document.getElementById(modalId);
  if (modal) modal.dataset.attachmentSession = generateId();
}
function captureAttachmentSession(modalId) {
  const modal = document.getElementById(modalId);
  return {
    modalId,
    token: modal && modal.dataset.attachmentSession,
    account: window.CloudSync && CloudSync.uid && typeof CloudSync.accountContext === 'function'
      ? CloudSync.accountContext()
      : null
  };
}
function attachmentSessionActive(session) {
  const modal = session && document.getElementById(session.modalId);
  if (!modal || !modal.classList.contains('open') || modal.dataset.attachmentSession !== session.token) return false;
  return !session.account || (window.CloudSync && typeof CloudSync.contextActive === 'function' && CloudSync.contextActive(session.account));
}
function requireAttachmentSession(session) {
  if (attachmentSessionActive(session)) return;
  const error = new Error('The form changed before the attachment finished loading.');
  error.code = 'STALE_ATTACHMENT_SESSION';
  throw error;
}
window.flushPendingVaultOperations = flushPendingVaultOperations;

// A remote/cross-tab auth sign-out cannot be cancelled. Preserve the active
// record-entry form in the sync database before the shared runtime stores are
// cleared, then offer it only to the same uid on the next authenticated boot.
const OPEN_FORM_RECOVERY_VERSION = 1;
const OPEN_FORM_RECOVERY_MODAL_IDS = [
  'formModal', 'ammoModal', 'accessoryModal',
  'maintenanceModal', 'wishlistModal', 'dealerModal'
];
const OPEN_FORM_RECOVERY_TIMEOUT_MS = 5000;
const VAULT_TAB_SESSION_KEY = 'fv:tab-id:v1';
const VAULT_TAB_WINDOW_PREFIX = 'fv-tab-v1:';
let _openFormRecoveryRefreshTimer = null;
let _openFormRecoveryRefreshModalId = null;
let _openFormRecoveryRefreshWarned = false;
const _openFormRecoveryRefreshes = new Set();
let _vaultTabFallbackId = null;
const _vaultTabInstanceId = crypto.randomUUID ? crypto.randomUUID() : generateId();
const _vaultTabStartedAt = Number(performance && performance.timeOrigin || Date.now());
let _vaultTabIdentityPromise = null;
let _vaultTabChannel = null;

function clearClonedTabPointers() {
  try {
    const keys = [];
    for (let index = 0; index < sessionStorage.length; index++) keys.push(sessionStorage.key(index));
    keys.filter(key => key && /^fv:(?:open-form-recovery|firearm-form-draft):.*:active$/.test(key))
      .forEach(key => sessionStorage.removeItem(key));
  } catch (_) {}
}

function assignVaultTabId(id, cloned) {
  _vaultTabFallbackId = String(id || (crypto.randomUUID ? crypto.randomUUID() : generateId()));
  try { sessionStorage.setItem(VAULT_TAB_SESSION_KEY, _vaultTabFallbackId); } catch (_) {}
  try {
    if (!window.name || String(window.name).startsWith(VAULT_TAB_WINDOW_PREFIX)) {
      window.name = VAULT_TAB_WINDOW_PREFIX + _vaultTabFallbackId;
    }
  } catch (_) {}
  if (cloned) clearClonedTabPointers();
  return _vaultTabFallbackId;
}

function vaultTabId() {
  if (_vaultTabFallbackId) return _vaultTabFallbackId;
  try {
    if (String(window.name || '').startsWith(VAULT_TAB_WINDOW_PREFIX)) {
      return assignVaultTabId(String(window.name).slice(VAULT_TAB_WINDOW_PREFIX.length), false);
    }
  } catch (_) {}
  try {
    const existing = sessionStorage.getItem(VAULT_TAB_SESSION_KEY);
    // window.open clones sessionStorage. A fresh child browsing context must
    // never adopt the opener's recovery/draft pointers.
    if (existing && !window.opener) return assignVaultTabId(existing, false);
  } catch (_) {}
  return assignVaultTabId(null, !!window.opener);
}

function ensureVaultTabIdentity() {
  if (_vaultTabIdentityPromise) return _vaultTabIdentityPromise;
  _vaultTabIdentityPromise = new Promise(resolve => {
    const initialId = vaultTabId();
    if (typeof BroadcastChannel !== 'function') { resolve(initialId); return; }
    let losesClaim = false;
    try {
      _vaultTabChannel = new BroadcastChannel('fv-tab-identity-v1');
      _vaultTabChannel.addEventListener('message', event => {
        const message = event.data || {};
        if (!['probe', 'presence'].includes(message.type) || message.instanceId === _vaultTabInstanceId ||
            message.tabId !== vaultTabId()) return;
        const remoteWins = Number(message.startedAt || 0) < _vaultTabStartedAt ||
          (Number(message.startedAt || 0) === _vaultTabStartedAt && String(message.instanceId) < _vaultTabInstanceId);
        if (remoteWins) losesClaim = true;
        if (message.type === 'probe') try {
          _vaultTabChannel.postMessage({
            type: 'presence', tabId: vaultTabId(), instanceId: _vaultTabInstanceId,
            startedAt: _vaultTabStartedAt
          });
        } catch (_) {}
      });
      _vaultTabChannel.postMessage({
        type: 'probe', tabId: initialId, instanceId: _vaultTabInstanceId,
        startedAt: _vaultTabStartedAt
      });
      setTimeout(() => {
        if (losesClaim) assignVaultTabId(null, true);
        resolve(vaultTabId());
      }, 80);
    } catch (_) { resolve(initialId); }
  });
  return _vaultTabIdentityPromise;
}

void ensureVaultTabIdentity();

function legacyOpenFormRecoveryKey(uid) {
  return 'fv:open-form-recovery:' + String(uid || '');
}

function openFormRecoveryPrefix(uid) {
  return legacyOpenFormRecoveryKey(uid) + ':';
}

function openFormRecoveryActivePointerKey(uid) {
  return legacyOpenFormRecoveryKey(uid) + ':active';
}

function activeOpenFormRecoveryId(uid, create) {
  const pointerKey = openFormRecoveryActivePointerKey(uid);
  try {
    const existing = sessionStorage.getItem(pointerKey);
    if (existing) return existing;
  } catch (_) {}
  if (create === false) return null;
  const id = crypto.randomUUID ? crypto.randomUUID() : generateId();
  try { sessionStorage.setItem(pointerKey, id); } catch (_) {}
  return id;
}

function openFormRecoveryKey(uid, recoveryId) {
  return openFormRecoveryPrefix(uid) + String(recoveryId || activeOpenFormRecoveryId(uid, true));
}

function openFormRecoveryResolvedKey(uid, recoveryKey) {
  return String(recoveryKey || openFormRecoveryKey(uid)) + ':resolved';
}

function hasOpenFormRecoveryResolution(uid, recoveryKey) {
  const key = openFormRecoveryResolvedKey(uid, recoveryKey);
  const valid = raw => {
    try {
      const value = JSON.parse(raw || 'null');
      return !!value && value.version === 1 && String(value.uid || '') === String(uid || '') &&
        (!value.recoveryKey || value.recoveryKey === String(recoveryKey || openFormRecoveryKey(uid)));
    } catch (_) { return false; }
  };
  try { if (valid(localStorage.getItem(key))) return true; } catch (_) {}
  try { if (valid(sessionStorage.getItem(key))) return true; } catch (_) {}
  return false;
}

function markOpenFormRecoveryResolved(uid, recoveryKey) {
  const targetKey = String(recoveryKey || openFormRecoveryKey(uid));
  const key = openFormRecoveryResolvedKey(uid, targetKey);
  const value = JSON.stringify({
    version: 1, uid: String(uid || ''), recoveryKey: targetKey,
    resolvedAt: new Date().toISOString()
  });
  let durable = false;
  try { localStorage.setItem(key, value); durable = true; } catch (_) {}
  // Helpful for a same-tab retry, but never sufficient on its own: closing the
  // browser would lose it while a stale IndexedDB recovery record survives.
  try { sessionStorage.setItem(key, value); } catch (_) {}
  return durable;
}

function clearOpenFormRecoveryResolution(uid, recoveryKey) {
  const key = openFormRecoveryResolvedKey(uid, recoveryKey);
  try { localStorage.removeItem(key); } catch (_) {}
  try { sessionStorage.removeItem(key); } catch (_) {}
  return !hasOpenFormRecoveryResolution(uid, recoveryKey);
}

function activeRecoverableForm() {
  for (const id of OPEN_FORM_RECOVERY_MODAL_IDS) {
    const modal = document.getElementById(id);
    if (modal && modal.classList.contains('open') && modal.dataset.dirty === 'true') return modal;
  }
  return null;
}

function recoveryFormContext(modalId) {
  if (modalId === 'formModal') return { mode: editingId ? 'edit' : 'add', recordId: editingId || null };
  if (modalId === 'ammoModal') return { mode: editingAmmoId ? 'edit' : 'add', recordId: editingAmmoId || null };
  if (modalId === 'accessoryModal') return { mode: editingAccessoryId ? 'edit' : 'add', recordId: editingAccessoryId || null };
  if (modalId === 'maintenanceModal') return { mode: 'add', recordId: editingMaintenanceId || null };
  if (modalId === 'wishlistModal') return { mode: editingWishlistId ? 'edit' : 'add', recordId: editingWishlistId || null };
  if (modalId === 'dealerModal') return { mode: editingDealerId ? 'edit' : 'add', recordId: editingDealerId || null };
  return null;
}

function serializeRecoveryControls(modal) {
  const controls = [];
  modal.querySelectorAll('input[id], select[id], textarea[id], [contenteditable="true"][id]').forEach(control => {
    const type = String(control.type || '').toLowerCase();
    if (['file', 'password', 'hidden', 'button', 'submit', 'reset'].includes(type)) return;
    if (control.isContentEditable) {
      controls.push({ id: control.id, kind: 'html', value: sanitizeRichText(control.innerHTML || '') });
    } else if (type === 'checkbox' || type === 'radio') {
      controls.push({ id: control.id, kind: 'checked', value: !!control.checked });
    } else {
      controls.push({ id: control.id, kind: 'value', value: String(control.value == null ? '' : control.value) });
    }
  });
  return controls;
}

function recoveryAttachment(value, kind) {
  if (typeof value !== 'string') return null;
  if (kind === 'image') return /^data:image\/(?:png|jpe?g|webp|gif|bmp);base64,/i.test(value) ? value : null;
  return /^data:(?:application\/pdf|image\/(?:png|jpe?g|webp|gif|bmp));base64,/i.test(value) ? value : null;
}

function captureRecoveryExtras(modalId) {
  if (modalId === 'formModal') {
    const draft = collectFirearmDraft();
    return {
      images: draft.images,
      ownedImages: draft.ownedImages,
      imageData: draft.imageData,
      documents: draft.documents,
      tags: draft.tags,
      stampPdf: draft.stampPdf,
      stampPdfName: draft.stampPdfName,
      receipt: draft.receipt,
      receiptName: draft.receiptName,
      customFields: draft.customFields,
      imageIndex: draft.imageIndex,
      sourceWishlistId: draft.sourceWishlistId
    };
  }
  if (modalId === 'ammoModal') {
    return { receipt: tempReceipts.a, receiptName: tempReceipts.aName };
  }
  if (modalId === 'accessoryModal') {
    const imageData = {};
    tempAccessoryImages.forEach(id => {
      if (typeof imagesDb[id] === 'string') imageData[id] = imagesDb[id];
    });
    return {
      receipt: tempReceipts.acc,
      receiptName: tempReceipts.accName,
      images: [...tempAccessoryImages],
      ownedImages: [..._accessoryDraftOwnedImages],
      imageData
    };
  }
  return {};
}

function validOpenFormRecovery(snapshot, uid) {
  return !!snapshot && snapshot.version === OPEN_FORM_RECOVERY_VERSION &&
    String(snapshot.uid || '') === String(uid || '') &&
    OPEN_FORM_RECOVERY_MODAL_IDS.includes(snapshot.modalId) &&
    (snapshot.mode === 'add' || snapshot.mode === 'edit') &&
    Array.isArray(snapshot.controls) && snapshot.controls.length <= 150 &&
    snapshot.controls.every(control => control && typeof control.id === 'string' && control.id.length <= 100 &&
      ['value', 'checked', 'html'].includes(control.kind));
}

async function waitForRecoveryAttachments() {
  let timer = null;
  const timeout = new Promise(resolve => {
    timer = setTimeout(() => resolve({ complete: false, ok: false }), OPEN_FORM_RECOVERY_TIMEOUT_MS);
  });
  const settled = flushPendingVaultOperations()
    .then(ok => ({ complete: true, ok }))
    .catch(() => ({ complete: true, ok: false }));
  const result = await Promise.race([settled, timeout]);
  clearTimeout(timer);
  return result;
}

async function persistOpenFormRecoverySnapshot(modal, owner, attachments, recoveryKey) {
  await ensureVaultTabIdentity();
  const key = String(recoveryKey || modal.dataset.recoveryKey || openFormRecoveryKey(owner));
  // A later genuine recovery supersedes any cleanup tombstone from a form that
  // was already saved/discarded.
  if (!clearOpenFormRecoveryResolution(owner, key)) {
    return { ok: false, status: 'resolution-marker-locked', captured: false };
  }
  const context = recoveryFormContext(modal.id);
  if (!context) return { ok: true, status: 'unsupported-form', captured: false };
  const savedAt = new Date().toISOString();
  const snapshot = {
    version: OPEN_FORM_RECOVERY_VERSION,
    uid: owner,
    tabId: vaultTabId(),
    recoveryKey: key,
    savedAt,
    modalId: modal.id,
    mode: context.mode,
    recordId: context.recordId,
    controls: serializeRecoveryControls(modal),
    extras: captureRecoveryExtras(modal.id),
    attachmentsComplete: attachments.complete && attachments.ok
  };
  let fallbackSafe = false;
  let primarySafe = false;
  try {
    sessionStorage.setItem(key, JSON.stringify(snapshot));
    fallbackSafe = true;
  } catch (_) {}
  try {
    await CloudSync.storePut('meta', { key, uid: owner, value: snapshot, updatedAt: savedAt });
    primarySafe = true;
  } catch (error) {
    console.warn('Open form recovery could not be saved to IndexedDB:', error);
  }
  // Bind even a best-effort snapshot to the live modal. If sign-out fails
  // closed and the user reauthenticates in this tab, the eventual Save or
  // Discard will resolve this exact record instead of leaving a stale Add.
  modal.dataset.recoveredForm = 'true';
  modal.dataset.recoveryOwner = owner;
  modal.dataset.recoveryKey = key;
  return {
    // A recovery record without every pending attachment is useful as a
    // best-effort fallback, but it is not safe enough to authorize teardown.
    // Callers such as forced sign-out must fail closed and keep this tab alive
    // until the photo/PDF reads finish or the user explicitly discards them.
    ok: primarySafe && snapshot.attachmentsComplete,
    status: !snapshot.attachmentsComplete ? 'attachments-incomplete'
      : primarySafe ? 'saved' : fallbackSafe ? 'session-fallback-unsafe' : 'failed',
    captured: true,
    attachmentsComplete: snapshot.attachmentsComplete
  };
}

async function preserveOpenDirtyFormSession(uid) {
  const owner = String(uid || '');
  if (!owner || !window.CloudSync || String(CloudSync.uid || '') !== owner) {
    return { ok: false, status: 'account-changed' };
  }

  // Select synchronously: flushFirearmDraft can legitimately clear data-dirty.
  const modal = activeRecoverableForm();
  if (!modal) return { ok: true, status: 'no-open-form', captured: false };
  if (modal.dataset.recoverySaveCommitted === 'true' || modal.dataset.draftSaveCommitted === 'true') {
    return { ok: false, status: 'committed-cleanup-pending', captured: false };
  }
  const context = recoveryFormContext(modal.id);
  if (!context) return { ok: true, status: 'unsupported-form', captured: false };

  const attachments = await waitForRecoveryAttachments();
  if (!modal.classList.contains('open') || String(CloudSync.uid || '') !== owner) {
    return { ok: false, status: 'account-changed' };
  }

  return persistOpenFormRecoverySnapshot(modal, owner, attachments, modal.dataset.recoveryKey || null);
}

async function refreshRecoveredFormSession(modalId) {
  const modal = document.getElementById(modalId);
  const owner = modal && modal.dataset.recoveryOwner;
  if (!modal || modal.dataset.recoveredForm !== 'true' || modal.dataset.recoveryResolving === 'true' || !modal.classList.contains('open') ||
      !owner || !window.CloudSync || String(CloudSync.uid || '') !== String(owner)) {
    return { ok: false, status: 'inactive' };
  }
  const attachments = await waitForRecoveryAttachments();
  if (modal.dataset.recoveredForm !== 'true' || !modal.classList.contains('open') ||
      String(CloudSync.uid || '') !== String(owner)) {
    return { ok: false, status: 'inactive' };
  }
  const result = await persistOpenFormRecoverySnapshot(
    modal, String(owner), attachments, modal.dataset.recoveryKey || null
  );
  if (result.ok) {
    _openFormRecoveryRefreshWarned = false;
  } else if (!_openFormRecoveryRefreshWarned) {
    _openFormRecoveryRefreshWarned = true;
    toast('This recovered form could not update its device recovery copy. Keep this tab open and try again.', 'error', 9000);
  }
  return result;
}

function saveRecoveredFormSoon(modalId) {
  const modal = document.getElementById(modalId);
  if (!modal || modal.dataset.recoveredForm !== 'true' || modal.dataset.recoveryResolving === 'true' || !modal.classList.contains('open')) return;
  clearTimeout(_openFormRecoveryRefreshTimer);
  _openFormRecoveryRefreshModalId = modalId;
  _openFormRecoveryRefreshTimer = setTimeout(() => {
    _openFormRecoveryRefreshTimer = null;
    _openFormRecoveryRefreshModalId = null;
    const refresh = refreshRecoveredFormSession(modalId);
    _openFormRecoveryRefreshes.add(refresh);
    refresh.finally(() => _openFormRecoveryRefreshes.delete(refresh)).catch(() => {});
  }, 450);
}

async function readOpenFormRecovery(uid) {
  await ensureVaultTabIdentity();
  const owner = String(uid || '');
  const activeId = activeOpenFormRecoveryId(owner, false);
  const activeKey = activeId ? openFormRecoveryKey(owner, activeId) : null;
  const legacyKey = legacyOpenFormRecoveryKey(owner);
  const candidates = [];
  const addCandidate = (key, value, priority) => {
    if (!validOpenFormRecovery(value, owner)) return;
    candidates.push({ key, priority, value: Object.assign({}, value, { recoveryKey: key }) });
  };

  // The per-tab pointer is authoritative. Each tab therefore reopens its own
  // unfinished form even when another tab saved a different form later.
  if (activeKey) {
    try { addCandidate(activeKey, JSON.parse(sessionStorage.getItem(activeKey) || 'null'), 400); } catch (_) {}
    if (window.CloudSync && CloudSync.storeGet) {
      try {
        const stored = await CloudSync.storeGet('meta', activeKey);
        addCandidate(activeKey, stored && String(stored.uid || '') === owner ? stored.value : null, 400);
      } catch (error) { console.warn('Open form recovery could not be read from IndexedDB:', error); }
    }
  }

  // One-time compatibility for the original shared key.
  try { addCandidate(legacyKey, JSON.parse(sessionStorage.getItem(legacyKey) || 'null'), 250); } catch (_) {}
  if (window.CloudSync && CloudSync.storeGet) {
    try {
      const legacy = await CloudSync.storeGet('meta', legacyKey);
      addCandidate(legacyKey, legacy && String(legacy.uid || '') === owner ? legacy.value : null, 240);
    } catch (_) {}
  }

  // If this is a restored browser session without its pointer, keep every
  // sibling record intact and offer the newest orphan. Resolution later
  // deletes only the exact recovery key chosen here.
  if (window.CloudSync && CloudSync.storeGetAll) {
    try {
      const records = await CloudSync.storeGetAll('meta');
      records.forEach(record => {
        if (!record || String(record.uid || '') !== owner ||
            !String(record.key || '').startsWith(openFormRecoveryPrefix(owner))) return;
        if (record.value && record.value.tabId && record.value.tabId !== vaultTabId()) return;
        addCandidate(String(record.key), record.value, 100);
      });
    } catch (error) { console.warn('Open form recovery list could not be read:', error); }
  }

  candidates.sort((a, b) => b.priority - a.priority ||
    String(b.value.savedAt || '').localeCompare(String(a.value.savedAt || '')));
  const uniqueCandidates = [];
  const seenKeys = new Set();
  for (const candidate of candidates) {
    if (seenKeys.has(candidate.key)) continue;
    seenKeys.add(candidate.key);
    uniqueCandidates.push(candidate);
  }
  for (const candidate of uniqueCandidates) {
    if (hasOpenFormRecoveryResolution(owner, candidate.key)) {
      try {
        await clearOpenFormRecoveryRecord(owner, candidate.key, { keepResolved: true });
        clearOpenFormRecoveryResolution(owner, candidate.key);
      } catch (_) {}
      continue;
    }
    const id = candidate.key.startsWith(openFormRecoveryPrefix(owner))
      ? candidate.key.slice(openFormRecoveryPrefix(owner).length) : null;
    if (id) {
      try { sessionStorage.setItem(openFormRecoveryActivePointerKey(owner), id); } catch (_) {}
    }
    return candidate.value;
  }
  return null;
}

async function clearOpenFormRecoveryRecord(uid, key, options) {
  const opts = options || {};
  const failures = [];
  try { sessionStorage.removeItem(key); } catch (error) { failures.push(error); }
  if (window.CloudSync && CloudSync.storeDelete) {
    try { await CloudSync.storeDelete('meta', key); } catch (error) { failures.push(error); }
  }
  const activeId = activeOpenFormRecoveryId(uid, false);
  if (activeId && openFormRecoveryKey(uid, activeId) === key) {
    try { sessionStorage.removeItem(openFormRecoveryActivePointerKey(uid)); } catch (error) { failures.push(error); }
  }
  if (!opts.keepResolved && !clearOpenFormRecoveryResolution(uid, key)) {
    failures.push(new Error('Could not clear the resolved recovery marker.'));
  }
  if (failures.length) throw failures[0];
  return true;
}

async function clearOpenFormRecoveryForUser(uid) {
  await ensureVaultTabIdentity();
  const owner = String(uid || '');
  const legacyKey = legacyOpenFormRecoveryKey(owner);
  const prefix = openFormRecoveryPrefix(owner);
  const recoveryKeys = new Set([legacyKey]);
  try {
    for (let index = 0; index < sessionStorage.length; index++) {
      const key = sessionStorage.key(index);
      if (key === legacyKey || (key && key.startsWith(prefix) && !key.endsWith(':resolved') && key !== openFormRecoveryActivePointerKey(owner))) {
        recoveryKeys.add(key);
      }
    }
  } catch (_) {}
  if (window.CloudSync && CloudSync.storeGetAll) {
    try {
      const records = await CloudSync.storeGetAll('meta');
      records.forEach(record => {
        const key = String(record && record.key || '');
        if (String(record && record.uid || '') === owner && (key === legacyKey || key.startsWith(prefix))) recoveryKeys.add(key);
      });
    } catch (error) { throw error; }
  }
  const failures = [];
  for (const key of recoveryKeys) {
    try { await clearOpenFormRecoveryRecord(owner, key); } catch (error) { failures.push(error); }
  }
  try { sessionStorage.removeItem(openFormRecoveryActivePointerKey(owner)); } catch (error) { failures.push(error); }
  // Remove any durable tombstones for this account after every matching
  // recovery record has been deleted (Forget this device).
  try {
    const keys = [];
    for (let index = 0; index < localStorage.length; index++) keys.push(localStorage.key(index));
    keys.filter(key => key && (key === legacyKey + ':resolved' ||
      (key.startsWith(prefix) && key.endsWith(':resolved')))).forEach(key => localStorage.removeItem(key));
  } catch (error) { failures.push(error); }
  if (failures.length) throw failures[0];
  return true;
}

async function resolveRecoveredFormSession(modalId) {
  const modal = document.getElementById(modalId);
  if (!modal || modal.dataset.recoveredForm !== 'true') return true;
  modal.dataset.recoveryResolving = 'true';
  if (_openFormRecoveryRefreshModalId === modalId) {
    clearTimeout(_openFormRecoveryRefreshTimer);
    _openFormRecoveryRefreshTimer = null;
    _openFormRecoveryRefreshModalId = null;
  }
  // A refresh may already be past its debounce and writing IndexedDB. Wait for
  // it before deleting so a late put cannot resurrect a saved/discarded form.
  if (_openFormRecoveryRefreshes.size) await Promise.allSettled([..._openFormRecoveryRefreshes]);
  const owner = modal.dataset.recoveryOwner || (window.CloudSync && CloudSync.uid);
  const recoveryKey = modal.dataset.recoveryKey || openFormRecoveryKey(owner);
  const resolutionSafe = markOpenFormRecoveryResolved(owner, recoveryKey);
  let recoveryCleared = true;
  try {
    await clearOpenFormRecoveryRecord(owner, recoveryKey, { keepResolved: true });
  } catch (error) {
    recoveryCleared = false;
    if (!resolutionSafe) {
      delete modal.dataset.recoveryResolving;
      modal.dataset.dirty = 'true';
      toast('The recovery copy could not be resolved. Keep this tab open and do not save the item again.', 'error', 9000);
      return false;
    }
    console.warn('A stale open-form recovery record was suppressed and will be cleaned up on the next boot.', error);
  }
  if (recoveryCleared) clearOpenFormRecoveryResolution(owner, recoveryKey);
  delete modal.dataset.recoveredForm;
  delete modal.dataset.recoveryOwner;
  delete modal.dataset.recoveryKey;
  delete modal.dataset.recoveryResolving;
  delete modal.dataset.recoverySaveCommitted;
  _openFormRecoveryRefreshWarned = false;
  return true;
}

function holdCommittedRecoveredForm(modalId, buttonId) {
  const modal = document.getElementById(modalId);
  if (modal) {
    modal.dataset.recoverySaveCommitted = 'true';
    modal.dataset.dirty = 'true';
  }
  render();
  setSaveStatus('degraded', 'Saved - recovery cleanup needs attention');
  toast('The item was saved, but its recovery marker could not be cleared. Do not save it again; close this form and confirm discard to retry cleanup.', 'error', 10000);
  setTimeout(() => {
    const button = document.getElementById(buttonId);
    if (button) { button.disabled = true; button.textContent = 'Saved - cleanup needed'; }
  }, 0);
}

async function hasOpenFormRecoveryForUser(uid) {
  await ensureVaultTabIdentity();
  const owner = String(uid || '');
  const legacyKey = legacyOpenFormRecoveryKey(owner);
  const prefix = openFormRecoveryPrefix(owner);
  try {
    for (let index = 0; index < sessionStorage.length; index++) {
      const key = sessionStorage.key(index);
      if ((key === legacyKey || (key && key.startsWith(prefix))) && !key.endsWith(':resolved') &&
          key !== openFormRecoveryActivePointerKey(owner) && sessionStorage.getItem(key)) return true;
    }
  } catch (_) { return true; }
  if (window.CloudSync && CloudSync.storeGetAll) {
    try {
      const records = await CloudSync.storeGetAll('meta');
      return records.some(record => String(record && record.uid || '') === owner &&
        (String(record.key || '') === legacyKey || String(record.key || '').startsWith(prefix)));
    } catch (_) { return true; }
  }
  return false;
}

function waitForRecoveryModalSetup() {
  return new Promise(resolve => {
    let complete = false;
    const finish = () => { if (!complete) { complete = true; resolve(); } };
    const fallback = setTimeout(finish, 120);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      clearTimeout(fallback);
      finish();
    }));
  });
}

async function openRecoveredForm(snapshot) {
  let restoredAsNew = false;
  const id = snapshot.recordId == null ? null : String(snapshot.recordId);
  if (snapshot.modalId === 'formModal') {
    const exists = snapshot.mode === 'edit' && db.firearms.some(item => String(item.id) === id);
    if (exists) openEditModal(id);
    else { restoredAsNew = snapshot.mode === 'edit'; await openAddModal(); }
  } else if (snapshot.modalId === 'ammoModal') {
    const exists = snapshot.mode === 'edit' && db.ammo.some(item => String(item.id) === id);
    if (exists) editAmmo(id);
    else { restoredAsNew = snapshot.mode === 'edit'; openAddAmmoModal(); }
  } else if (snapshot.modalId === 'accessoryModal') {
    const exists = snapshot.mode === 'edit' && db.accessories.some(item => String(item.id) === id);
    restoredAsNew = snapshot.mode === 'edit' && !exists;
    openAccessoryModal(exists ? id : undefined);
  } else if (snapshot.modalId === 'wishlistModal') {
    const exists = snapshot.mode === 'edit' && db.wishlist.some(item => String(item.id) === id);
    restoredAsNew = snapshot.mode === 'edit' && !exists;
    openWishlistModal(exists ? id : undefined);
  } else if (snapshot.modalId === 'dealerModal') {
    const exists = snapshot.mode === 'edit' && db.dealers.some(item => String(item.id) === id);
    restoredAsNew = snapshot.mode === 'edit' && !exists;
    openDealerModal(exists ? id : undefined);
  } else if (snapshot.modalId === 'maintenanceModal') {
    const exists = id && db.firearms.some(item => String(item.id) === id);
    if (!exists) return { ok: false, status: 'missing-parent' };
    openMaintenanceModal(id);
  } else {
    return { ok: false, status: 'unsupported-form' };
  }
  await waitForRecoveryModalSetup();
  return { ok: true, restoredAsNew };
}

function applyRecoveryControls(modal, controls) {
  controls.forEach(saved => {
    const control = document.getElementById(saved.id);
    if (!control || !modal.contains(control)) return;
    if (saved.kind === 'html' && control.isContentEditable) {
      control.innerHTML = sanitizeRichText(String(saved.value || ''));
    } else if (saved.kind === 'checked' && ('checked' in control)) {
      control.checked = !!saved.value;
    } else if (saved.kind === 'value' && 'value' in control) {
      control.value = String(saved.value == null ? '' : saved.value);
    }
  });
}

async function applyRecoveryExtras(snapshot) {
  const extras = snapshot.extras && typeof snapshot.extras === 'object' ? snapshot.extras : {};
  if (snapshot.modalId === 'formModal') {
    const imageData = extras.imageData && typeof extras.imageData === 'object' ? extras.imageData : {};
    for (const [imageId, unsafeData] of Object.entries(imageData)) {
      const dataURL = recoveryAttachment(unsafeData, 'image');
      if (!dataURL || typeof imageId !== 'string' || imageId.length > 200) continue;
      imagesDb[imageId] = dataURL;
      try { await idbPut(imageId, dataURL); }
      catch (error) { console.warn('A recovered form photo could not be cached:', error); }
    }
    tempImages = Array.isArray(extras.images)
      ? extras.images.filter(id => typeof id === 'string' && !!imagesDb[id]).slice(0, 50)
      : [];
    _firearmDraftOwnedImages.clear();
    (Array.isArray(extras.ownedImages) ? extras.ownedImages : []).forEach(id => {
      if (typeof id === 'string' && id.length <= 200) _firearmDraftOwnedImages.add(id);
    });
    tempDocs = (Array.isArray(extras.documents) ? extras.documents : []).slice(0, 50).flatMap(item => {
      const data = item && recoveryAttachment(item.data, 'document');
      return data ? [{ id: String(item.id || generateId()), name: String(item.name || 'Document'), type: String(item.type || ''), data }] : [];
    });
    tempTags = (Array.isArray(extras.tags) ? extras.tags : []).filter(tag => typeof tag === 'string').slice(0, 100);
    tempStampPdf = recoveryAttachment(extras.stampPdf, 'document');
    tempStampPdfName = tempStampPdf ? String(extras.stampPdfName || 'Tax stamp.pdf') : null;
    tempReceipts.f = recoveryAttachment(extras.receipt, 'document');
    tempReceipts.fName = tempReceipts.f ? String(extras.receiptName || 'Receipt') : null;
    tempCustomFields = (Array.isArray(extras.customFields) ? extras.customFields : []).slice(0, 100).map(field => ({
      name: String(field && field.name || ''), value: String(field && field.value || '')
    }));
    pendingWishlistMoveId = extras.sourceWishlistId && db.wishlist.some(item => String(item.id) === String(extras.sourceWishlistId))
      ? extras.sourceWishlistId : null;
    currentImageIndex = Math.max(0, Math.min(Number(extras.imageIndex) || 0, Math.max(0, tempImages.length - 1)));
    renderImageGallery();
    renderDocList();
    renderTagsInput();
    renderCustomFields();
    showStampInUploadArea(tempStampPdf, tempStampPdfName);
    showReceiptInUploadArea('f', tempReceipts.f, tempReceipts.fName);
    toggleNFAFields();
    toggleDispositionFields();
  } else if (snapshot.modalId === 'ammoModal') {
    tempReceipts.a = recoveryAttachment(extras.receipt, 'document');
    tempReceipts.aName = tempReceipts.a ? String(extras.receiptName || 'Receipt') : null;
    showReceiptInUploadArea('a', tempReceipts.a, tempReceipts.aName);
  } else if (snapshot.modalId === 'accessoryModal') {
    const imageData = extras.imageData && typeof extras.imageData === 'object' ? extras.imageData : {};
    for (const [imageId, unsafeData] of Object.entries(imageData)) {
      const dataURL = recoveryAttachment(unsafeData, 'image');
      if (!dataURL || typeof imageId !== 'string' || imageId.length > 200) continue;
      imagesDb[imageId] = dataURL;
      try { await idbPut(imageId, dataURL); }
      catch (error) { console.warn('A recovered accessory photo could not be cached:', error); }
    }
    tempAccessoryImages = Array.isArray(extras.images)
      ? extras.images.filter(id => typeof id === 'string' && !!imagesDb[id]).slice(0, 50)
      : [];
    _accessoryDraftOwnedImages.clear();
    (Array.isArray(extras.ownedImages) ? extras.ownedImages : []).forEach(id => {
      if (typeof id === 'string' && id.length <= 200) _accessoryDraftOwnedImages.add(id);
    });
    renderAccessoryImageGallery();
    tempReceipts.acc = recoveryAttachment(extras.receipt, 'document');
    tempReceipts.accName = tempReceipts.acc ? String(extras.receiptName || 'Receipt') : null;
    showReceiptInUploadArea('acc', tempReceipts.acc, tempReceipts.accName);
  }
}

async function restoreOpenDirtyFormSession(uid) {
  const owner = String(uid || '');
  if (!owner || !window.CloudSync || String(CloudSync.uid || '') !== owner) {
    return { restored: false, status: 'account-changed' };
  }
  const snapshot = await readOpenFormRecovery(owner);
  if (!snapshot) return { restored: false, status: 'none' };

  const opened = await openRecoveredForm(snapshot);
  if (!opened.ok) {
    toast('An unfinished form is still saved on this device, but its original record is no longer available.', 'error', 9000);
    return { restored: false, status: opened.status };
  }
  const modal = document.getElementById(snapshot.modalId);
  applyRecoveryControls(modal, snapshot.controls);
  await applyRecoveryExtras(snapshot);
  // Attachment/gallery rendering mutates the modal subtree and schedules the
  // accessibility observer. Let that refresh finish before asserting dirty.
  await waitForRecoveryModalSetup();
  modal.dataset.dirty = 'true';
  modal.dataset.recoveredForm = 'true';
  modal.dataset.recoveryOwner = owner;
  modal.dataset.recoveryKey = snapshot.recoveryKey || openFormRecoveryKey(owner);

  const label = opened.restoredAsNew ? 'The original record was removed, so your unfinished changes were restored as a new item.'
    : 'Your unfinished form was restored after the other session signed out.';
  toast(label + (snapshot.attachmentsComplete === false ? ' An attachment may need to be added again.' : ''),
    snapshot.attachmentsComplete === false ? 'error' : 'success', 9000);
  setTimeout(() => {
    const first = modal.querySelector('input:not([type="hidden"]):not([type="file"]), select, textarea, [contenteditable="true"]');
    if (first && modal.classList.contains('open')) first.focus();
  }, 80);
  return { restored: true, status: 'restored', modalId: snapshot.modalId, restoredAsNew: opened.restoredAsNew, retained: true };
}

window.preserveOpenDirtyFormSession = preserveOpenDirtyFormSession;
window.restoreOpenDirtyFormSession = restoreOpenDirtyFormSession;
window.clearOpenFormRecoveryForUser = clearOpenFormRecoveryForUser;
window.hasOpenFormRecoveryForUser = hasOpenFormRecoveryForUser;
window.openFormRecoveryKey = openFormRecoveryKey;
window.refreshRecoveredFormSession = refreshRecoveredFormSession;
window.resolveRecoveredFormSession = resolveRecoveredFormSession;

function firearmDraftOwner(uid) {
  return String(uid || ((window.CloudSync && CloudSync.uid) || 'session'));
}
function legacyFirearmDraftKey(uid) { return 'fv:firearm-form-draft:' + firearmDraftOwner(uid); }
function firearmDraftPrefix(uid) { return legacyFirearmDraftKey(uid) + ':'; }
function firearmDraftActivePointerKey(uid) { return legacyFirearmDraftKey(uid) + ':active'; }
function activeFirearmDraftId(uid, create) {
  const pointerKey = firearmDraftActivePointerKey(uid);
  try {
    const existing = sessionStorage.getItem(pointerKey);
    if (existing) return existing;
  } catch (_) {}
  if (create === false) return null;
  const id = crypto.randomUUID ? crypto.randomUUID() : generateId();
  try { sessionStorage.setItem(pointerKey, id); } catch (_) {}
  return id;
}
function firearmDraftKey(uid, draftId) {
  return firearmDraftPrefix(uid) + String(draftId || activeFirearmDraftId(uid, true));
}
function firearmDraftResolutionKey(uid, draftKey) { return String(draftKey || firearmDraftKey(uid)) + ':resolved'; }
function readFirearmDraftResolution(uid, draftKey) {
  try {
    const value = JSON.parse(localStorage.getItem(firearmDraftResolutionKey(uid, draftKey)) || 'null');
    return value && value.version === 1 && (!value.draftKey || value.draftKey === String(draftKey || firearmDraftKey(uid))) ? value : null;
  } catch (_) { return null; }
}
function markFirearmDraftResolved(uid, draftSavedAt, draftKey) {
  const targetKey = String(draftKey || firearmDraftKey(uid));
  try {
    localStorage.setItem(firearmDraftResolutionKey(uid, targetKey), JSON.stringify({
      version: 1, draftKey: targetKey, resolvedAt: new Date().toISOString(), draftSavedAt: draftSavedAt || null
    }));
    return true;
  } catch (_) { return false; }
}
function clearFirearmDraftResolution(uid, draftKey) {
  try { localStorage.removeItem(firearmDraftResolutionKey(uid, draftKey)); } catch (_) {}
  return !readFirearmDraftResolution(uid, draftKey);
}
function setFirearmDraftStatus(message) {
  const status = document.getElementById('formDraftStatus');
  if (status) status.textContent = message || '';
}
async function clearFirearmDraft(uid, options) {
  await ensureVaultTabIdentity();
  const opts = options || {};
  const requiresResolution = !!(opts.committed || opts.discarded);
  clearTimeout(_firearmDraftTimer);
  _firearmDraftTimer = null;
  _firearmDraftRevision++;
  const owner = firearmDraftOwner(uid);
  const modal = document.getElementById('formModal');
  const activeId = activeFirearmDraftId(owner, false);
  const key = (!uid && modal && modal.dataset.firearmDraftKey) ||
    (activeId ? firearmDraftKey(owner, activeId) : firearmDraftKey(owner));
  const draftImageIds = new Set();
  const rememberImages = draft => {
    if (draft && Array.isArray(draft.images)) draft.images.forEach(id => draftImageIds.add(id));
    if (draft && Array.isArray(draft.ownedImages)) draft.ownedImages.forEach(id => draftImageIds.add(id));
  };
  let newestDraftSavedAt = null;
  const rememberDraft = draft => {
    rememberImages(draft);
    if (draft && draft.savedAt && (!newestDraftSavedAt || String(draft.savedAt) > String(newestDraftSavedAt))) {
      newestDraftSavedAt = draft.savedAt;
    }
  };
  try { rememberDraft(JSON.parse(sessionStorage.getItem(key) || 'null')); } catch (_) {}
  const activeDraftUid = (window.CloudSync && CloudSync.uid) || 'session';
  if (!uid || String(uid) === String(activeDraftUid)) tempImages.forEach(id => draftImageIds.add(id));
  let deviceDraftRemoved = true;
  if (window.CloudSync && CloudSync.storeGet) {
    try {
      const stored = await CloudSync.storeGet('meta', key);
      rememberDraft(stored && stored.value);
    } catch (error) { console.warn('Draft image index could not be read:', error); }
  }
  const resolutionSafe = requiresResolution ? markFirearmDraftResolved(owner, newestDraftSavedAt, key) : false;
  try { sessionStorage.removeItem(key); } catch (_) { deviceDraftRemoved = false; }
  try { if (window.CloudSync && CloudSync.storeDelete) await CloudSync.storeDelete('meta', key); }
  catch (error) { deviceDraftRemoved = false; console.warn('Draft cleanup failed:', error); }
  if (deviceDraftRemoved) {
    _firearmDraftOwnedImages.forEach(id => draftImageIds.add(id));
    await removeUnreferencedDraftImages(draftImageIds);
    _firearmDraftOwnedImages.clear();
    if (requiresResolution) clearFirearmDraftResolution(owner, key);
    try {
      if (activeFirearmDraftId(owner, false) && firearmDraftKey(owner, activeFirearmDraftId(owner, false)) === key) {
        sessionStorage.removeItem(firearmDraftActivePointerKey(owner));
      }
    } catch (_) {}
    if (modal && modal.dataset.firearmDraftKey === key) delete modal.dataset.firearmDraftKey;
  }
  if (!requiresResolution) clearFirearmDraftResolution(owner, key);
  setFirearmDraftStatus('');
  return deviceDraftRemoved || resolutionSafe;
}

async function clearAllFirearmDraftsForUser(uid) {
  await ensureVaultTabIdentity();
  const owner = firearmDraftOwner(uid);
  const legacyKey = legacyFirearmDraftKey(owner);
  const prefix = firearmDraftPrefix(owner);
  const keys = new Set([legacyKey]);
  const imageIds = new Set();
  const remember = draft => {
    if (!draft) return;
    (draft.images || []).forEach(id => imageIds.add(id));
    (draft.ownedImages || []).forEach(id => imageIds.add(id));
  };
  try {
    for (let index = 0; index < sessionStorage.length; index++) {
      const key = sessionStorage.key(index);
      if (key === legacyKey || (key && key.startsWith(prefix) && !key.endsWith(':resolved') && key !== firearmDraftActivePointerKey(owner))) {
        keys.add(key);
        try { remember(JSON.parse(sessionStorage.getItem(key) || 'null')); } catch (_) {}
      }
    }
  } catch (_) {}
  const activeId = activeFirearmDraftId(owner, false);
  const currentKey = activeId ? firearmDraftKey(owner, activeId) : firearmDraftKey(owner);
  keys.add(currentKey);
  if (window.CloudSync && CloudSync.storeGet) {
    try {
      const current = await CloudSync.storeGet('meta', currentKey);
      remember(current && current.value);
    } catch (_) {}
  }
  if (window.CloudSync && CloudSync.storeGetAll) {
    const records = await CloudSync.storeGetAll('meta');
    records.forEach(record => {
      const key = String(record && record.key || '');
      if (String(record && record.uid || '') === owner && (key === legacyKey || key.startsWith(prefix))) {
        keys.add(key);
        remember(record.value);
      }
    });
  }
  const failures = [];
  for (const key of keys) {
    try { sessionStorage.removeItem(key); } catch (error) { failures.push(error); }
    try { if (window.CloudSync && CloudSync.storeDelete) await CloudSync.storeDelete('meta', key); }
    catch (error) { failures.push(error); }
    clearFirearmDraftResolution(owner, key);
  }
  try { sessionStorage.removeItem(firearmDraftActivePointerKey(owner)); } catch (error) { failures.push(error); }
  try {
    const markerKeys = [];
    for (let index = 0; index < localStorage.length; index++) markerKeys.push(localStorage.key(index));
    markerKeys.filter(key => key && (key === legacyKey + ':resolved' ||
      (key.startsWith(prefix) && key.endsWith(':resolved')))).forEach(key => localStorage.removeItem(key));
  } catch (error) { failures.push(error); }
  _firearmDraftOwnedImages.forEach(id => imageIds.add(id));
  await removeUnreferencedDraftImages(imageIds);
  _firearmDraftOwnedImages.clear();
  setFirearmDraftStatus('');
  if (failures.length) throw failures[0];
  return true;
}
function collectFirearmDraft() {
  const values = {};
  FIREARM_DRAFT_FIELDS.forEach(id => {
    const control = document.getElementById(id);
    if (control) values[id] = control.type === 'checkbox' ? control.checked : control.value;
  });
  values.fNotes = document.getElementById('fNotes').innerHTML;
  values.fDispNotes = document.getElementById('fDispNotes').innerHTML;
  const ownedImages = [...new Set([..._firearmDraftOwnedImages, ...tempImages])];
  return {
    savedAt: new Date().toISOString(), values,
    tabId: vaultTabId(),
    draftKey: document.getElementById('formModal').dataset.firearmDraftKey || firearmDraftKey(),
    images: [...tempImages],
    ownedImages,
    imageData: Object.fromEntries(ownedImages
      .filter(id => typeof imagesDb[id] === 'string')
      .map(id => [id, imagesDb[id]])),
    documents: tempDocs.map(d => ({ id: d.id, name: d.name, type: d.type, data: d.data })),
    tags: [...tempTags],
    stampPdf: tempStampPdf,
    stampPdfName: tempStampPdfName,
    receipt: tempReceipts.f,
    receiptName: tempReceipts.fName,
    customFields: tempCustomFields.map(field => ({ name: field.name || '', value: field.value || '' })),
    imageIndex: currentImageIndex,
    sourceWishlistId: pendingWishlistMoveId
  };
}
function writeFirearmDraftFallback(draft, key) {
  sessionStorage.setItem(key || draft.draftKey || firearmDraftKey(), JSON.stringify({
    savedAt: draft.savedAt,
    tabId: draft.tabId,
    draftKey: key || draft.draftKey,
    values: draft.values,
    images: draft.images,
    ownedImages: draft.ownedImages,
    tags: draft.tags,
    customFields: draft.customFields,
    imageIndex: draft.imageIndex,
    sourceWishlistId: draft.sourceWishlistId
  }));
}
async function writeFirearmDraft(revision = _firearmDraftRevision) {
  await ensureVaultTabIdentity();
  const modal = document.getElementById('formModal');
  if (editingId !== null || !modal.classList.contains('open') || modal.dataset.draftSaveCommitted === 'true') return true;
  const draft = collectFirearmDraft();
  const key = modal.dataset.firearmDraftKey || draft.draftKey || firearmDraftKey();
  modal.dataset.firearmDraftKey = key;
  draft.draftKey = key;
  let fallbackSafe = false;
  try { writeFirearmDraftFallback(draft, key); fallbackSafe = true; } catch (_) {}
  try {
    if (!window.CloudSync || !CloudSync.storePut) throw new Error('Device draft storage is not ready.');
    await CloudSync.storePut('meta', { key, uid: CloudSync.uid || 'session', value: draft, updatedAt: draft.savedAt });
    if (revision === _firearmDraftRevision) {
      modal.dataset.dirty = 'false';
      setFirearmDraftStatus('Draft saved on this device');
    }
    return true;
  } catch (error) {
    if (revision === _firearmDraftRevision) {
      modal.dataset.dirty = 'true';
      setFirearmDraftStatus(fallbackSafe ? 'Text draft saved; attachments are not protected' : 'Draft could not be saved');
    }
    console.warn('Firearm draft save failed:', error);
    return false;
  }
}
function saveFirearmDraftSoon() {
  const modal = document.getElementById('formModal');
  if (!modal.classList.contains('open')) return;
  modal.dataset.dirty = 'true';
  saveRecoveredFormSoon('formModal');
  if (editingId !== null) return;
  clearTimeout(_firearmDraftTimer);
  const revision = ++_firearmDraftRevision;
  setFirearmDraftStatus('Saving draft on this device…');
  _firearmDraftTimer = setTimeout(() => {
    _firearmDraftTimer = null;
    void writeFirearmDraft(revision);
  }, 350);
}
async function flushFirearmDraft() {
  const operationsSafe = await flushPendingVaultOperations();
  if (!operationsSafe) {
    setFirearmDraftStatus('An attachment could not be saved');
    return false;
  }
  if (editingId !== null || !document.getElementById('formModal').classList.contains('open')) return true;
  clearTimeout(_firearmDraftTimer);
  _firearmDraftTimer = null;
  const revision = ++_firearmDraftRevision;
  return writeFirearmDraft(revision);
}
async function restoreFirearmDraft() {
  await ensureVaultTabIdentity();
  const owner = firearmDraftOwner();
  const activeId = activeFirearmDraftId(owner, false);
  const activeKey = activeId ? firearmDraftKey(owner, activeId) : null;
  const legacyKey = legacyFirearmDraftKey(owner);
  const candidates = [];
  const addDraft = (key, value, priority) => {
    if (value && value.values && typeof value.values === 'object') candidates.push({ key, value, priority });
  };
  if (activeKey) {
    try {
      if (window.CloudSync && CloudSync.storeGet) {
        const stored = await CloudSync.storeGet('meta', activeKey);
        addDraft(activeKey, stored && String(stored.uid || '') === owner ? stored.value : null, 400);
      }
    } catch (_) {}
    try { addDraft(activeKey, JSON.parse(sessionStorage.getItem(activeKey) || 'null'), 400); } catch (_) {}
  }
  try {
    if (window.CloudSync && CloudSync.storeGet) {
      const stored = await CloudSync.storeGet('meta', legacyKey);
      addDraft(legacyKey, stored && String(stored.uid || '') === owner ? stored.value : null, 250);
    }
  } catch (_) {}
  try { addDraft(legacyKey, JSON.parse(sessionStorage.getItem(legacyKey) || 'null'), 250); } catch (_) {}
  if (window.CloudSync && CloudSync.storeGetAll) {
    try {
      const storedDrafts = await CloudSync.storeGetAll('meta');
      storedDrafts.forEach(stored => {
        if (stored && String(stored.uid || '') === owner && String(stored.key || '').startsWith(firearmDraftPrefix(owner))) {
          if (stored.value && stored.value.tabId && stored.value.tabId !== vaultTabId()) return;
          addDraft(String(stored.key), stored.value, 100);
        }
      });
    } catch (_) {}
  }
  candidates.sort((a, b) => b.priority - a.priority ||
    String(b.value.savedAt || '').localeCompare(String(a.value.savedAt || '')));
  const selected = candidates[0] || null;
  let draft = selected && selected.value;
  const selectedKey = selected && selected.key;
  const resolution = selectedKey ? readFirearmDraftResolution(owner, selectedKey) : null;
  if (resolution) {
    const draftIsNewer = !!(draft && draft.savedAt && String(draft.savedAt) > String(resolution.resolvedAt || ''));
    if (!draftIsNewer) {
      try { sessionStorage.removeItem(selectedKey); } catch (_) {}
      try { if (window.CloudSync && CloudSync.storeDelete) await CloudSync.storeDelete('meta', selectedKey); }
      catch (_) { setFirearmDraftStatus('Saved draft cleanup will retry later'); return; }
      try {
        const pointerId = activeFirearmDraftId(owner, false);
        if (pointerId && firearmDraftKey(owner, pointerId) === selectedKey) sessionStorage.removeItem(firearmDraftActivePointerKey(owner));
      } catch (_) {}
      clearFirearmDraftResolution(owner, selectedKey);
      setFirearmDraftStatus('');
      return;
    }
    clearFirearmDraftResolution(owner, selectedKey);
  }
  if (!draft || !draft.values) {
    document.getElementById('formModal').dataset.firearmDraftKey = firearmDraftKey(owner);
    setFirearmDraftStatus('');
    return;
  }
  if (selectedKey && selectedKey.startsWith(firearmDraftPrefix(owner))) {
    const id = selectedKey.slice(firearmDraftPrefix(owner).length);
    try { sessionStorage.setItem(firearmDraftActivePointerKey(owner), id); } catch (_) {}
  }
  document.getElementById('formModal').dataset.firearmDraftKey = selectedKey || firearmDraftKey(owner);
  const restoredImageData = draft.imageData && typeof draft.imageData === 'object' ? draft.imageData : {};
  for (const [id, dataURL] of Object.entries(restoredImageData)) {
    if (typeof dataURL !== 'string' || !dataURL.startsWith('data:')) continue;
    imagesDb[id] = dataURL;
    try { await idbPut(id, dataURL); }
    catch (error) { console.warn('Draft photo could not be restored to the device cache:', error); }
  }
  FIREARM_DRAFT_FIELDS.forEach(id => {
    const control = document.getElementById(id);
    if (!control || draft.values[id] === undefined) return;
    if (control.type === 'checkbox') control.checked = !!draft.values[id];
    else control.value = draft.values[id];
  });
  document.getElementById('fNotes').innerHTML = sanitizeRichText(draft.values.fNotes || '');
  document.getElementById('fDispNotes').innerHTML = sanitizeRichText(draft.values.fDispNotes || '');
  tempImages = Array.isArray(draft.images) ? draft.images.filter(id => imagesDb[id]) : [];
  _firearmDraftOwnedImages.clear();
  (Array.isArray(draft.ownedImages) ? draft.ownedImages : draft.images || []).forEach(id => _firearmDraftOwnedImages.add(id));
  tempDocs = Array.isArray(draft.documents) ? draft.documents.map(d => ({ id: d.id, name: d.name, type: d.type, data: d.data })) : [];
  tempTags = Array.isArray(draft.tags) ? [...draft.tags] : [];
  tempStampPdf = draft.stampPdf || null;
  tempStampPdfName = draft.stampPdfName || null;
  tempReceipts.f = draft.receipt || null;
  tempReceipts.fName = draft.receiptName || null;
  tempCustomFields = Array.isArray(draft.customFields) ? draft.customFields.map(field => ({ name: field.name || '', value: field.value || '' })) : [];
  pendingWishlistMoveId = draft.sourceWishlistId || null;
  currentImageIndex = Math.max(0, Math.min(Number(draft.imageIndex) || 0, Math.max(0, tempImages.length - 1)));
  renderImageGallery();
  renderDocList();
  renderTagsInput();
  renderCustomFields();
  showStampInUploadArea(tempStampPdf, tempStampPdfName);
  showReceiptInUploadArea('f', tempReceipts.f, tempReceipts.fName);
  toggleNFAFields();
  toggleDispositionFields();
  setFirearmDraftStatus('Unsaved draft restored');
}
window.flushFirearmDraft = flushFirearmDraft;
window.clearFirearmDraftForUser = clearAllFirearmDraftsForUser;
window.addEventListener('pagehide', () => {
  const modal = document.getElementById('formModal');
  if (editingId !== null || !modal.classList.contains('open') || modal.dataset.draftSaveCommitted === 'true') return;
  clearTimeout(_firearmDraftTimer);
  _firearmDraftTimer = null;
  _firearmDraftRevision++;
  const draft = collectFirearmDraft();
  const key = modal.dataset.firearmDraftKey || draft.draftKey || firearmDraftKey();
  modal.dataset.firearmDraftKey = key;
  draft.draftKey = key;
  try { writeFirearmDraftFallback(draft, key); } catch (_) {}
  if (window.CloudSync && CloudSync.storePut) {
    void CloudSync.storePut('meta', { key, uid: CloudSync.uid || 'session', value: draft, updatedAt: draft.savedAt }).catch(() => {});
  }
});
document.getElementById('formModal').addEventListener('input', saveFirearmDraftSoon);
document.getElementById('formModal').addEventListener('change', saveFirearmDraftSoon);

function clearForm() {
  pendingWishlistMoveId = null;
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
  _firearmDraftOwnedImages.clear();
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
  showStampInUploadArea(f.stampPdf, f.stampPdfName);

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

function collectFirearmFormRecord(id) {
  const isNFA = document.getElementById('fIsNFA').checked;
  const status = document.getElementById('fStatus').value;
  return {
    id,
    make: document.getElementById('fMake').value.trim(),
    model: document.getElementById('fModel').value.trim(),
    serial: document.getElementById('fSerial').value.trim(),
    caliber: document.getElementById('fCaliber').value.trim(),
    type: document.getElementById('fType').value,
    barrel: document.getElementById('fBarrel').value.trim(),
    dateAcquired: document.getElementById('fDateAcquired').value,
    price: document.getElementById('fPrice').value,
    condition: document.getElementById('fCondition').value,
    notes: rteValue('fNotes'),
    images: [...tempImages],
    tags: [...tempTags],
    isNFA,
    nfaType: isNFA ? document.getElementById('fNFAType').value : null,
    formType: isNFA ? document.getElementById('fFormType').value : null,
    dateSubmitted: isNFA ? document.getElementById('fDateSubmitted').value : null,
    dateApproved: isNFA ? document.getElementById('fDateApproved').value : null,
    stampStatus: isNFA ? document.getElementById('fStampStatus').value : null,
    regType: isNFA ? document.getElementById('fRegType').value : null,
    stampPdf: isNFA ? tempStampPdf : null,
    stampPdfName: isNFA ? tempStampPdfName : null,
    status,
    dispDate: status !== 'Active' ? document.getElementById('fDispDate').value : null,
    dispBuyer: status !== 'Active' ? document.getElementById('fDispBuyer').value.trim() : null,
    dispPrice: status !== 'Active' ? document.getElementById('fDispPrice').value : null,
    dispFFL: status !== 'Active' ? document.getElementById('fDispFFL').value.trim() : null,
    dispNotes: status !== 'Active' ? rteValue('fDispNotes') : null,
    receipt: tempReceipts.f,
    receiptName: tempReceipts.fName,
    documents: tempDocs.map(d => ({ id: d.id, name: d.name, type: d.type, data: d.data })),
    roundCount: parseInt(document.getElementById('fRoundCount').value) || 0,
    warrantyExp: document.getElementById('fWarrantyExp').value || null,
    customFields: tempCustomFields.filter(cf => cf.name && cf.value).map(cf => ({ name: cf.name, value: cf.value }))
  };
}

async function saveFirearm() {
  return withFormSaveLock('firearm', 'saveBtn', async () => {
    if (!await waitForFormAttachments('formModal', 'Firearm attachment')) return false;
    const make=document.getElementById('fMake').value.trim();
    const model=document.getElementById('fModel').value.trim();
    if(!make&&!model){showFieldError(document.getElementById('fMake'), 'Enter at least a manufacturer or model.');return false;}

    let data = collectFirearmFormRecord(editingId || generateId());
    let editResult = null;
    if (editingId) {
      editResult = await mergeRecordEdit('firearms', editingId, data);
      if (editResult.cancelled) return false;
      data = editResult.record;
    } else {
      data.maintenanceLog = [];
    }

    // Capture the rollback point only after any conflict dialog has resolved;
    // cloud updates may have arrived while that dialog was open.
    const previousDatabase = structuredClone(db);
    const previousRecord = editingId ? previousDatabase.firearms.find(f => f.id === editingId) || null : null;
    const itemName = ((data.make || '') + ' ' + (data.model || '')).trim();
    if (editingId) {
      const changes = editResult.localFields || [];
      addAuditEntry('edit', 'firearm', itemName, changes.length > 0 ? 'Changed: ' + changes.join(', ') : 'Updated', {
        collection: 'firearms', recordId: data.id, before: previousRecord, after: data
      });
      const i=db.firearms.findIndex(f=>f.id===editingId);
      if(i>-1) db.firearms[i]=data; else db.firearms.push(data);
    } else {
      addAuditEntry('create', 'firearm', itemName, '', {
        collection: 'firearms', recordId: data.id, before: null, after: data
      });
      db.firearms.push(data);
      if (pendingWishlistMoveId) {
        const source = db.wishlist.find(item => item.id === pendingWishlistMoveId);
        db.wishlist = db.wishlist.filter(item => item.id !== pendingWishlistMoveId);
        if (source) addAuditEntry('delete', 'wishlist', ((source.make || '') + ' ' + (source.model || '')).trim(), 'Moved to collection', {
          collection: 'wishlist', recordId: source.id, before: source, after: null
        });
      }
    }

    const wasEditing = editingId !== null;
    const attemptedDatabase = structuredClone(db);
    const persisted = await saveData();
    if (!persisted) {
      await keepFormOpenAfterSaveFailure(previousDatabase, attemptedDatabase, 'formModal', 'Firearm');
      if (editingId === null) saveFirearmDraftSoon();
      return false;
    }
    render();
    if (wasEditing) {
      const editOnlyImages = [..._firearmDraftOwnedImages];
      _firearmDraftOwnedImages.clear();
      await removeUnreferencedDraftImages(editOnlyImages);
    } else {
      const draftCleared = await clearFirearmDraft(undefined, { committed: true });
      if (!draftCleared) {
        const modal = document.getElementById('formModal');
        modal.dataset.draftSaveCommitted = 'true';
        modal.dataset.dirty = 'true';
        holdCommittedRecoveredForm('formModal', 'saveBtn');
        return true;
      }
    }
    if (!await resolveRecoveredFormSession('formModal')) { holdCommittedRecoveredForm('formModal', 'saveBtn'); return true; }
    closeModal();
    if (editResult && editResult.conflicts.length) toast('Firearm saved with your field-by-field conflict choices.', 'success', 6000);
    return true;
  });
}

// =====================================================
// IMAGE HANDLING
// =====================================================
function queueFirearmImage(file) {
  const session = captureAttachmentSession('formModal');
  return trackPendingVaultOperation((async () => {
    const source = await readFileAsDataURL(file);
    requireAttachmentSession(session);
    const id = generateId();
    const compressed = await compressImage(source, 1600, 0.80);
    requireAttachmentSession(session);
    imagesDb[id] = compressed;
    await idbPut(id, compressed);
    if (!attachmentSessionActive(session)) {
      delete imagesDb[id];
      try { await idbDelete(id); } catch (_) {}
      requireAttachmentSession(session);
    }
    tempImages.push(id);
    _firearmDraftOwnedImages.add(id);
    renderImageGallery();
    saveFirearmDraftSoon();
    return id;
  })()).catch(error => {
    if (error && error.code === 'STALE_ATTACHMENT_SESSION') return null;
    toast('Photo could not be added: ' + (error.message || error), 'error', 7000);
    throw error;
  });
}

function handleImageUpload(e) {
  const files = e.target.files;
  if(!files) return;
  for(let i = 0; i < files.length; i++) {
    void queueFirearmImage(files[i]).catch(() => {});
  }
  e.target.value = '';
}

function renderImageGallery() {
  const gal = document.getElementById('imgGallery');
  gal.innerHTML = tempImages.map((imgId, idx) => {
    const src = imagesDb[imgId];
    if (!src) return '';
    return `<div style="position:relative;width:60px;height:60px;">
      <button type="button" class="img-thumbnail-button" aria-label="Select photo ${idx + 1} of ${tempImages.length}" onclick="currentImageIndex=${idx}; renderImageGallery()"><img src="${src}" alt="" class="img-thumbnail ${idx===0?'active':''}"></button>
      <button type="button" class="remove-thumbnail" style="display:flex;" aria-label="Remove photo ${idx + 1}" onclick="event.stopPropagation(); removeImage(${idx})">&#215;</button>
      <button type="button" aria-label="Edit photo ${idx + 1}" style="position:absolute;bottom:0;left:0;background:var(--accent);color:#fff;border:none;font-size:0.55rem;padding:1px 4px;border-radius:2px;cursor:pointer;" onclick="event.stopPropagation();openCropModal('${imgId}')">Edit</button>
    </div>`;
  }).join('');
}

// The CSP-safe declarative action bridge cannot reach lexical `let` bindings.
// Expose only the two narrow operations it needs for generated gallery controls.
window.setVaultGalleryIndex = function setVaultGalleryIndex(index) {
  currentImageIndex = Math.max(0, Number(index) || 0);
};
window.adjustVaultGalleryIndex = function adjustVaultGalleryIndex(delta) {
  currentImageIndex = Math.max(0, currentImageIndex + (Number(delta) || 0));
};

function removeImage(idx) { tempImages.splice(idx, 1); currentImageIndex = 0; renderImageGallery(); saveFirearmDraftSoon(); }
function resetImgUpload() { document.getElementById('imgUploadArea').innerHTML='<span class="upload-text">Click to upload images (or drag &amp; drop)</span>'; }

function handleStampUpload(e) {
  const f=e.target.files[0]; if(!f) return;
  const session = captureAttachmentSession('formModal');
  void trackPendingVaultOperation((async () => {
    const data = await readFileAsDataURL(f);
    requireAttachmentSession(session);
    tempStampPdf=data; tempStampPdfName=f.name;
    showStampInUploadArea(tempStampPdf, tempStampPdfName);
    saveFirearmDraftSoon();
  })()).catch(error => { if (!error || error.code !== 'STALE_ATTACHMENT_SESSION') toast('Tax stamp could not be added: ' + (error.message || error), 'error'); });
  e.target.value='';
}

function removeStampPdf() { tempStampPdf=null; tempStampPdfName=null; resetStampUpload(); saveFirearmDraftSoon(); }
function resetStampUpload() {
  document.getElementById('stampUploadArea').innerHTML='<span class="upload-text">Click to upload approved tax stamp PDF</span>';
  const remove = document.getElementById('stampRemove'); if (remove) remove.hidden = true;
}
function showStampInUploadArea(data, name) {
  if (!data) { resetStampUpload(); return; }
  document.getElementById('stampUploadArea').innerHTML=`<span style="font-size:1.5rem;">&#128196;</span><span class="upload-text" style="color:var(--text);font-weight:600;">${esc(name || 'tax_stamp.pdf')}</span>`;
  const remove = document.getElementById('stampRemove'); if (remove) remove.hidden = false;
}

function handleReceiptUpload(e, prefix) {
  const f = e.target.files[0]; if (!f) return;
  const modalId = prefix === 'f' ? 'formModal' : prefix === 'a' ? 'ammoModal' : 'accessoryModal';
  const session = captureAttachmentSession(modalId);
  void trackPendingVaultOperation((async () => {
    const data = await readFileAsDataURL(f);
    requireAttachmentSession(session);
    tempReceipts[prefix] = data;
    tempReceipts[prefix + 'Name'] = f.name;
    showReceiptInUploadArea(prefix, tempReceipts[prefix], f.name);
    if (prefix === 'f') saveFirearmDraftSoon();
    else markModalDirty(modalId);
  })()).catch(error => { if (!error || error.code !== 'STALE_ATTACHMENT_SESSION') toast('Receipt could not be added: ' + (error.message || error), 'error'); });
  e.target.value = '';
}

function markModalDirty(modalId) {
  const modal = document.getElementById(modalId);
  if (modal && modal.classList.contains('open')) {
    modal.dataset.dirty = 'true';
    saveRecoveredFormSoon(modalId);
  }
}
function removeReceipt(prefix) {
  tempReceipts[prefix] = null;
  tempReceipts[prefix + 'Name'] = null;
  resetReceiptUpload(prefix);
  if (prefix === 'f') saveFirearmDraftSoon();
  else markModalDirty(prefix === 'a' ? 'ammoModal' : 'accessoryModal');
}

// ---- Documents (multiple per firearm) ----
function handleDocUpload(e) {
  const files = Array.from(e.target.files || []);
  files.forEach(file => {
    const session = captureAttachmentSession('formModal');
    void trackPendingVaultOperation((async () => {
      const data = await readFileAsDataURL(file);
      requireAttachmentSession(session);
      tempDocs.push({ id: generateId(), name: file.name, type: file.type, data });
      renderDocList();
      saveFirearmDraftSoon();
    })()).catch(error => { if (!error || error.code !== 'STALE_ATTACHMENT_SESSION') toast('Document could not be added: ' + (error.message || error), 'error'); });
  });
  e.target.value = '';
}
function removeDoc(id) { tempDocs = tempDocs.filter(d => d.id !== id); renderDocList(); saveFirearmDraftSoon(); }
function renderDocList() {
  const el = document.getElementById('docList');
  if (!el) return;
  if (!tempDocs.length) { el.innerHTML = ''; return; }
  el.innerHTML = tempDocs.map(d => {
    const isPdf = (d.name || '').toLowerCase().endsWith('.pdf') || d.type === 'application/pdf';
    return `<div class="doc-chip"><span class="doc-chip-icon">${isPdf ? '&#128196;' : '&#129534;'}</span>
      <span class="doc-chip-name">${esc(d.name || 'document')}</span>
      <button type="button" class="doc-chip-x" onclick="removeDoc('${d.id}')" aria-label="Remove ${escAttr(d.name || 'document')}">&times;</button></div>`;
  }).join('');
}
function resetReceiptUpload(prefix) {
  document.getElementById(prefix + 'ReceiptUploadArea').innerHTML = '<span class="upload-text">Click to upload receipt</span>';
  const remove = document.getElementById(prefix + 'ReceiptRemove'); if (remove) remove.hidden = true;
}
function showReceiptInUploadArea(prefix, data, name) {
  if (!data) { resetReceiptUpload(prefix); return; }
  const icon = (name && name.toLowerCase().endsWith('.pdf')) ? '&#128196;' : '&#129534;';
  document.getElementById(prefix + 'ReceiptUploadArea').innerHTML = `${icon} <span class="upload-text" style="color:var(--text);font-weight:600;">${esc(name || 'receipt')}</span>`;
  const remove = document.getElementById(prefix + 'ReceiptRemove'); if (remove) remove.hidden = false;
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
    void queueFirearmImage(f).catch(() => {});
  }
});

const accImgArea = document.getElementById('accImgUploadArea');
accImgArea.addEventListener('dragover', e => { e.preventDefault(); accImgArea.style.borderColor = 'var(--accent)'; });
accImgArea.addEventListener('dragleave', () => { accImgArea.style.borderColor = ''; });
accImgArea.addEventListener('drop', e => {
  e.preventDefault();
  accImgArea.style.borderColor = '';
  const files = Array.from(e.dataTransfer.files || []).filter(file => file.type.startsWith('image/'));
  files.forEach(file => { void queueAccessoryImage(file).catch(() => {}); });
});

const stampArea=document.getElementById('stampUploadArea');
stampArea.addEventListener('dragover',e=>{e.preventDefault();stampArea.style.borderColor='var(--accent)';});
stampArea.addEventListener('dragleave',()=>{stampArea.style.borderColor='';});
stampArea.addEventListener('drop',e=>{
  e.preventDefault();stampArea.style.borderColor='';
  const f=e.dataTransfer.files[0]; if(!f||f.type!=='application/pdf') return;
  const session = captureAttachmentSession('formModal');
  void trackPendingVaultOperation((async () => {
    const data = await readFileAsDataURL(f);
    requireAttachmentSession(session);
    tempStampPdf=data; tempStampPdfName=f.name;
    showStampInUploadArea(tempStampPdf, tempStampPdfName); saveFirearmDraftSoon();
  })()).catch(error => { if (!error || error.code !== 'STALE_ATTACHMENT_SESSION') toast('Tax stamp could not be added: ' + (error.message || error), 'error'); });
});

// =====================================================
// AMMUNITION
// =====================================================
function openAddAmmoModal() {
  editingAmmoId = null;
  endRecordEdit('ammo');
  beginAttachmentSession('ammoModal');
  document.getElementById('ammoModalTitle').textContent = 'Add Ammunition';
  document.getElementById('saveAmmoBtn').textContent = 'Save Ammunition';
  clearAmmoForm();
  document.getElementById('ammoModal').classList.add('open');
}

function editAmmo(id) {
  const a = db.ammo.find(x => x.id === id); if (!a) return;
  editingAmmoId = id;
  beginAttachmentSession('ammoModal');
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
  beginRecordEdit('ammo', id, collectAmmoFormRecord(id));
  document.getElementById('ammoModal').classList.add('open');
}

function clearAmmoForm() {
  ['aCaliber','aBrand','aQuantity','aPurchaseDate','aPricePerRound','aLocation','aLowStock'].forEach(id => document.getElementById(id).value='');
  document.getElementById('aNotes').innerHTML = '';
  tempReceipts.a = null; tempReceipts.aName = null; resetReceiptUpload('a');
}

function closeAmmoModal() { endAttachmentSession('ammoModal'); document.getElementById('ammoModal').classList.remove('open'); editingAmmoId = null; endRecordEdit('ammo'); }

function collectAmmoFormRecord(id) {
  return {
    id,
    caliber: document.getElementById('aCaliber').value.trim(),
    brand: document.getElementById('aBrand').value.trim(),
    quantity: document.getElementById('aQuantity').value,
    purchaseDate: document.getElementById('aPurchaseDate').value,
    pricePerRound: document.getElementById('aPricePerRound').value,
    location: document.getElementById('aLocation').value.trim(),
    lowStock: document.getElementById('aLowStock').value || 0,
    notes: rteValue('aNotes'),
    receipt: tempReceipts.a,
    receiptName: tempReceipts.aName
  };
}

async function saveAmmo() {
  return withFormSaveLock('ammo', 'saveAmmoBtn', async () => {
    if (!await waitForFormAttachments('ammoModal', 'Receipt')) return false;
    const caliber = document.getElementById('aCaliber').value.trim();
    if (!caliber) { showFieldError(document.getElementById('aCaliber'), 'Enter a caliber or gauge.'); return false; }
    let data = collectAmmoFormRecord(editingAmmoId || generateId());
    let editResult = null;
    if (editingAmmoId) {
      editResult = await mergeRecordEdit('ammo', editingAmmoId, data);
      if (editResult.cancelled) return false;
      data = editResult.record;
    }
    const previousDatabase = structuredClone(db);
    const previousRecord = editingAmmoId ? previousDatabase.ammo.find(a => a.id === editingAmmoId) || null : null;
    const itemName = (data.brand || data.caliber);
    if (editingAmmoId) {
      addAuditEntry('edit', 'ammo', itemName, '', {
        collection: 'ammo', recordId: data.id, before: previousRecord, after: data
      });
      const i = db.ammo.findIndex(a => a.id === editingAmmoId); if (i > -1) db.ammo[i] = data; else db.ammo.push(data);
    } else {
      addAuditEntry('create', 'ammo', itemName, '', {
        collection: 'ammo', recordId: data.id, before: null, after: data
      });
      db.ammo.push(data);
    }
    const attemptedDatabase = structuredClone(db);
    if (!await saveData()) { await keepFormOpenAfterSaveFailure(previousDatabase, attemptedDatabase, 'ammoModal', 'Ammunition'); return false; }
    if (!await resolveRecoveredFormSession('ammoModal')) { holdCommittedRecoveredForm('ammoModal', 'saveAmmoBtn'); return true; }
    render(); closeAmmoModal();
    if (editResult && editResult.conflicts.length) toast('Ammunition saved with your field-by-field conflict choices.', 'success', 6000);
    return true;
  });
}

async function quickAmmoAdjust(id, direction) {
  const amt = await promptDialog(direction > 0 ? 'How many rounds to add?' : 'How many rounds to subtract?', '20', { title: direction > 0 ? 'Add rounds' : 'Subtract rounds' });
  if (!amt || isNaN(parseInt(amt))) return;
  const a = db.ammo.find(x => x.id === id);
  if (!a) return;
  const before = structuredClone(a);
  const qty = Math.max(0, (parseInt(a.quantity)||0) + (parseInt(amt) * direction));
  a.quantity = String(qty);
  addAuditEntry('edit','ammo',(a.brand||a.caliber),'Quantity '+(direction>0?'+':'-')+amt+' = '+qty, {
    collection: 'ammo', recordId: a.id, before, after: a
  });
  await saveData(); render();
}

async function deleteAmmo(id) {
  if (!await confirmDialog('Delete this ammunition entry?', { title: 'Delete ammunition', okText: 'Delete', danger: true })) return;
  deleteWithUndo('ammo', id);
}

// =====================================================
// ACCESSORIES
// =====================================================
const _accessoryDraftOwnedImages = new Set();

function queueAccessoryImage(file) {
  const session = captureAttachmentSession('accessoryModal');
  return trackPendingVaultOperation((async () => {
    const source = await readFileAsDataURL(file);
    requireAttachmentSession(session);
    const id = generateId();
    const compressed = await compressImage(source, 1600, 0.80);
    requireAttachmentSession(session);
    imagesDb[id] = compressed;
    await idbPut(id, compressed);
    if (!attachmentSessionActive(session)) {
      delete imagesDb[id];
      try { await idbDelete(id); } catch (_) {}
      requireAttachmentSession(session);
    }
    tempAccessoryImages.push(id);
    _accessoryDraftOwnedImages.add(id);
    renderAccessoryImageGallery();
    markModalDirty('accessoryModal');
    return id;
  })()).catch(error => {
    if (error && error.code === 'STALE_ATTACHMENT_SESSION') return null;
    toast('Accessory photo could not be added: ' + (error.message || error), 'error', 7000);
    throw error;
  });
}

function handleAccessoryImageUpload(event) {
  Array.from(event.target.files || []).forEach(file => {
    if (file.type.startsWith('image/')) void queueAccessoryImage(file).catch(() => {});
  });
  event.target.value = '';
}

function renderAccessoryImageGallery() {
  const gallery = document.getElementById('accImgGallery');
  if (!gallery) return;
  gallery.innerHTML = tempAccessoryImages.map((imageId, index) => {
    const src = imagesDb[imageId];
    if (!src) return '';
    return `<div class="accessory-photo-thumb">
      <img src="${src}" alt="Accessory photo ${index + 1}" class="img-thumbnail">
      <button type="button" class="remove-thumbnail" aria-label="Remove accessory photo ${index + 1}" onclick="removeAccessoryImage(${index})">&#215;</button>
    </div>`;
  }).join('');
}

function removeAccessoryImage(index) {
  tempAccessoryImages.splice(index, 1);
  renderAccessoryImageGallery();
  markModalDirty('accessoryModal');
}

function openAccessoryModal(editId) {
  editingAccessoryId = editId || null;
  endRecordEdit('accessories');
  beginAttachmentSession('accessoryModal');
  _accessoryDraftOwnedImages.clear();
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
    tempAccessoryImages = Array.isArray(a.images) ? [...a.images] : [];
    renderAccessoryImageGallery();
    tempReceipts.acc = a.receipt || null; tempReceipts.accName = a.receiptName || null;
    showReceiptInUploadArea('acc', a.receipt, a.receiptName);
    beginRecordEdit('accessories', editId, collectAccessoryFormRecord(editId));
  } else { clearAccessoryForm(); }
  document.getElementById('accessoryModal').classList.add('open');
}

function closeAccessoryModal() {
  const discardedImages = [..._accessoryDraftOwnedImages];
  endAttachmentSession('accessoryModal');
  document.getElementById('accessoryModal').classList.remove('open');
  editingAccessoryId = null;
  tempAccessoryImages = [];
  _accessoryDraftOwnedImages.clear();
  renderAccessoryImageGallery();
  endRecordEdit('accessories');
  void removeUnreferencedDraftImages(discardedImages);
}

function clearAccessoryForm() {
  ['accName','accBrand','accModel','accSerial','accPrice','accDate'].forEach(id => document.getElementById(id).value = '');
  document.getElementById('accNotes').innerHTML = '';
  document.getElementById('accCategory').value = 'Optic'; document.getElementById('accCondition').value = 'New';
  document.getElementById('accFirearm').value = '';
  tempAccessoryImages = [];
  _accessoryDraftOwnedImages.clear();
  renderAccessoryImageGallery();
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

function collectAccessoryFormRecord(id) {
  return {
    id,
    name: document.getElementById('accName').value.trim(),
    category: document.getElementById('accCategory').value,
    brand: document.getElementById('accBrand').value.trim(),
    model: document.getElementById('accModel').value.trim(),
    serial: document.getElementById('accSerial').value.trim(),
    price: document.getElementById('accPrice').value,
    purchaseDate: document.getElementById('accDate').value,
    condition: document.getElementById('accCondition').value,
    firearmId: document.getElementById('accFirearm').value,
    images: [...tempAccessoryImages],
    notes: rteValue('accNotes'),
    receipt: tempReceipts.acc,
    receiptName: tempReceipts.accName
  };
}

async function saveAccessory() {
  return withFormSaveLock('accessory', 'saveAccBtn', async () => {
    if (!await waitForFormAttachments('accessoryModal', 'Photos or receipt')) return false;
    const name = document.getElementById('accName').value.trim();
    if (!name) { showFieldError(document.getElementById('accName'), 'Enter an accessory name.'); return false; }
    let data = collectAccessoryFormRecord(editingAccessoryId || generateId());
    let editResult = null;
    if (editingAccessoryId) {
      editResult = await mergeRecordEdit('accessories', editingAccessoryId, data);
      if (editResult.cancelled) return false;
      data = editResult.record;
    }
    const previousDatabase = structuredClone(db);
    const previousRecord = editingAccessoryId ? previousDatabase.accessories.find(a => a.id === editingAccessoryId) || null : null;
    if (editingAccessoryId) {
      addAuditEntry('edit', 'accessory', data.name, '', {
        collection: 'accessories', recordId: data.id, before: previousRecord, after: data
      });
      const i = db.accessories.findIndex(a => a.id === editingAccessoryId); if (i > -1) db.accessories[i] = data; else db.accessories.push(data);
    } else {
      addAuditEntry('create', 'accessory', name, '', {
        collection: 'accessories', recordId: data.id, before: null, after: data
      });
      db.accessories.push(data);
    }
    const attemptedDatabase = structuredClone(db);
    if (!await saveData()) { await keepFormOpenAfterSaveFailure(previousDatabase, attemptedDatabase, 'accessoryModal', 'Accessory'); return false; }
    if (!await resolveRecoveredFormSession('accessoryModal')) { holdCommittedRecoveredForm('accessoryModal', 'saveAccBtn'); return true; }
    const imageCleanup = [
      ..._accessoryDraftOwnedImages,
      ...((previousRecord && Array.isArray(previousRecord.images)) ? previousRecord.images : [])
    ];
    await removeUnreferencedDraftImages(imageCleanup);
    render(); closeAccessoryModal();
    if (editResult && editResult.conflicts.length) toast('Accessory saved with your field-by-field conflict choices.', 'success', 6000);
    return true;
  });
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

function accessoryFieldValue(accessory, field) {
  if (field === 'manufacturer') return (accessory.brand || 'Unknown manufacturer').trim();
  if (field === 'weapon') return accessory.firearmId ? getFirearmLabel(accessory.firearmId) : 'In storage / unassigned';
  return (accessory.name || 'Unnamed item').trim();
}

function compareAccessories(left, right, field) {
  const bySelected = accessoryFieldValue(left, field).localeCompare(
    accessoryFieldValue(right, field), undefined, { numeric: true, sensitivity: 'base' }
  );
  if (bySelected) return bySelected;
  return accessoryFieldValue(left, 'item').localeCompare(
    accessoryFieldValue(right, 'item'), undefined, { numeric: true, sensitivity: 'base' }
  );
}

function setAccessorySort(field) {
  if (!['item', 'manufacturer', 'weapon'].includes(field)) return;
  accessorySortField = field;
  saveSortPreference();
  renderAccessoriesTab();
}

function setAccessoryGroup(field) {
  if (!['none', 'item', 'manufacturer', 'weapon'].includes(field)) return;
  accessoryGroupField = field;
  saveSortPreference();
  renderAccessoriesTab();
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
  items = [...items].sort((a, b) => compareAccessories(a, b, accessorySortField));
  updatePageContext(items.length);
  const totalValue = items.reduce((s, a) => s + (parseFloat(a.price) || 0), 0);
  const selected = (value, current) => value === current ? ' selected' : '';
  let h = `<div class="accessory-toolbar">
    <div class="accessory-summary">
      <span>Accessories shown: <strong>${items.length}</strong></span>
      <span>Value shown: <strong>$${totalValue.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})}</strong></span>
    </div>
    <div class="accessory-view-controls" aria-label="Accessory organization">
      <label for="accessorySort">Sort by
        <select id="accessorySort" onchange="setAccessorySort(this.value)">
          <option value="item"${selected('item', accessorySortField)}>Item name</option>
          <option value="manufacturer"${selected('manufacturer', accessorySortField)}>Manufacturer</option>
          <option value="weapon"${selected('weapon', accessorySortField)}>Weapon system</option>
        </select>
      </label>
      <label for="accessoryGroup">Group by
        <select id="accessoryGroup" onchange="setAccessoryGroup(this.value)">
          <option value="none"${selected('none', accessoryGroupField)}>No grouping</option>
          <option value="item"${selected('item', accessoryGroupField)}>Item name</option>
          <option value="manufacturer"${selected('manufacturer', accessoryGroupField)}>Manufacturer</option>
          <option value="weapon"${selected('weapon', accessoryGroupField)}>Weapon system</option>
        </select>
      </label>
    </div>
  </div>`;
  if (items.length === 0) {
    h += db.accessories.length === 0
      ? tabEmpty('📦', 'No accessories tracked yet', 'Optics, suppressors, lights, magazines — track them and link them to builds.', '<button class="btn btn-primary" onclick="openAccessoryModal()">+ Add Accessory</button>')
      : tabEmpty('🔍', 'No accessories match your search', 'Try a different term or clear the search box.', '');
    document.getElementById('tableContainer').innerHTML = h; return;
  }
  h += '<table class="data-table accessory-table"><thead><tr><th>Photo</th><th>Name</th><th>Category</th><th>Manufacturer</th><th>Model / Part #</th><th>Weapon System</th><th>Condition</th><th>Price</th><th>Date</th><th>Receipt</th><th></th></tr></thead><tbody>';
  const renderAccessoryRow = a => {
    const firearmLabel = getFirearmLabel(a.firearmId);
    const pr = a.price ? money(a.price) : '--';
    const hasReceipt = a.receipt ? true : false;
    const photoId = Array.isArray(a.images) ? a.images[0] : null;
    const photoSrc = photoId ? (thumbCache[photoId] || imagesDb[photoId]) : null;
    const photo = photoSrc
      ? `<img class="thumb" loading="lazy" src="${photoSrc}" alt="${escAttr((a.name || 'Accessory') + ' photo')}">`
      : '<span class="thumb-placeholder" aria-hidden="true">&#10022;</span>';
    h += `<tr>
      <td>${photo}</td>
      <td style="font-weight:600;">${esc(a.name||'--')}</td>
      <td><span style="padding:2px 8px;background:var(--bg3);border-radius:4px;font-size:0.78rem;">${esc(a.category||'--')}</span></td>
      <td>${esc(a.brand||'--')}</td><td>${esc(a.model||'--')}</td>
      <td>${a.firearmId ? '<span style="color:var(--accent);font-weight:500;">' + esc(firearmLabel) + '</span>' : '<span style="color:var(--text3);">Not Assigned</span>'}</td>
      <td>${esc(a.condition||'--')}</td><td>${pr}</td><td>${fmtDate(a.purchaseDate)}</td>
      <td>${hasReceipt ? '<button class="btn btn-small btn-outline" onclick="event.stopPropagation();viewReceiptInBrowser(\''+a.id+'\',\'accessories\')">View</button> <a href="'+a.receipt+'" download="'+(a.receiptName||'receipt')+'" onclick="event.stopPropagation();" class="btn btn-small btn-file" style="text-decoration:none;display:inline-block;">DL</a>' : '<span style="color:var(--text3);">--</span>'}</td>
      <td style="text-align:right;white-space:nowrap;"><button class="btn btn-small btn-outline" data-item-id="${escAttr(a.id)}" onclick="openAccessoryModal(this.dataset.itemId)">Edit</button> <button class="btn btn-small btn-danger" onclick="event.stopPropagation(); deleteAccessory('${a.id}')">Delete</button></td>
    </tr>`;
  };
  if (accessoryGroupField === 'none') {
    items.forEach(renderAccessoryRow);
  } else {
    const groups = new Map();
    items.forEach(item => {
      const label = accessoryFieldValue(item, accessoryGroupField);
      if (!groups.has(label)) groups.set(label, []);
      groups.get(label).push(item);
    });
    [...groups.entries()]
      .sort(([left], [right]) => left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' }))
      .forEach(([label, groupItems]) => {
        const groupValue = groupItems.reduce((sum, item) => sum + (parseFloat(item.price) || 0), 0);
        h += `<tr class="accessory-group-row"><th colspan="11" scope="rowgroup">
          <span>${esc(label)}</span>
          <span>${groupItems.length} ${groupItems.length === 1 ? 'item' : 'items'} · ${money(groupValue)}</span>
        </th></tr>`;
        groupItems.forEach(renderAccessoryRow);
      });
  }
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
  return withFormSaveLock('maintenance', 'saveMaintenanceBtn', async () => {
    const firearm = db.firearms.find(f => f.id === editingMaintenanceId);
    if (!firearm) return false;
    const previousDatabase = structuredClone(db);
    const firearmId = editingMaintenanceId;
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
    addAuditEntry('create', 'maintenance', (firearm.make||'')+' '+(firearm.model||''), entry.type, {
      collection: 'firearms', recordId: firearm.id,
      before: previousDatabase.firearms.find(item => item.id === firearm.id) || null,
      after: firearm
    });
    const attemptedDatabase = structuredClone(db);
    if (!await saveData()) { await keepFormOpenAfterSaveFailure(previousDatabase, attemptedDatabase, 'maintenanceModal', 'Maintenance entry'); return false; }
    if (!await resolveRecoveredFormSession('maintenanceModal')) { holdCommittedRecoveredForm('maintenanceModal', 'saveMaintenanceBtn'); return true; }
    closeMaintenanceModal();
    openDetail(firearmId);
    return true;
  });
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
          `<button type="button" class="detail-gallery-dot ${idx === currentImageIndex ? 'active' : ''}" aria-label="Show image ${idx + 1} of ${imgs.length}" aria-pressed="${idx === currentImageIndex ? 'true' : 'false'}" onclick="currentImageIndex = ${idx}; openDetail('${id}')"></button>`
        ).join('') + '</div>';
      }
      const prevBtn = currentImageIndex > 0 ? `<button type="button" class="swipe-hint left" aria-label="Show previous image" onclick="event.stopPropagation();currentImageIndex--;openDetail('${id}')">&#8249;</button>` : '';
      const nextBtn = currentImageIndex < imgs.length-1 ? `<button type="button" class="swipe-hint right" aria-label="Show next image" onclick="event.stopPropagation();currentImageIndex++;openDetail('${id}')">&#8250;</button>` : '';
      const imageName = [f.make, f.model].filter(Boolean).join(' ') || 'firearm';
      ic.innerHTML=`<div style="position:relative;">${prevBtn}${nextBtn}${galNav}<img class="detail-img" src="${imagesDb[imgs[currentImageIndex]]}" alt="${escAttr(imageName)}" role="button" tabindex="0" aria-label="Open full-size photo of ${escAttr(imageName)}"></div>`;
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
      const open = d.data ? `<button type="button" class="doc-open" onclick="event.stopPropagation();viewDocumentInBrowser('${f.id}','${d.id}')">View</button>
        <button type="button" class="doc-open" onclick="event.stopPropagation();downloadDocument('${f.id}','${d.id}')">Download</button>`
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

function attachmentObjectURL(value, options = {}) {
  const source = String(value || '');
  const match = /^data:([^;,]+)(;base64)?,([\s\S]*)$/i.exec(source);
  if (!match) throw new Error('This attachment is not stored in a supported format.');
  const mime = match[1].toLowerCase();
  const allowed = options.pdfOnly
    ? new Set(['application/pdf'])
    : new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'image/gif']);
  if (!allowed.has(mime)) throw new Error('Only PDF and common image attachments can be opened.');
  let bytes;
  try {
    if (match[2]) {
      const decoded = atob(match[3].replace(/\s/g, ''));
      bytes = Uint8Array.from(decoded, character => character.charCodeAt(0));
    } else {
      bytes = new TextEncoder().encode(decodeURIComponent(match[3]));
    }
  } catch (_) {
    throw new Error('This attachment is damaged or incomplete.');
  }
  return URL.createObjectURL(new Blob([bytes], { type: mime }));
}

function openAttachment(value, options) {
  let objectURL;
  try {
    objectURL = attachmentObjectURL(value, options);
    const anchor = document.createElement('a');
    anchor.href = objectURL;
    anchor.target = '_blank';
    anchor.rel = 'noopener noreferrer';
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(objectURL), 60000);
  } catch (error) {
    if (objectURL) URL.revokeObjectURL(objectURL);
    toast(error.message || 'This attachment could not be opened.', 'error');
  }
}

function downloadAttachment(value, filename) {
  let objectURL;
  try {
    objectURL = attachmentObjectURL(value);
    const anchor = document.createElement('a');
    anchor.href = objectURL;
    anchor.download = String(filename || 'attachment').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_');
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(objectURL), 30000);
  } catch (error) {
    if (objectURL) URL.revokeObjectURL(objectURL);
    toast(error.message || 'This attachment could not be downloaded.', 'error');
  }
}

function viewStampPdf(id){
  const f=db.firearms.find(x=>x.id===id); if(!f||!f.stampPdf) return;
  openAttachment(f.stampPdf, { pdfOnly: true });
}

function viewReceiptInBrowser(id, type) {
  let item;
  if (type === 'firearms') item = db.firearms.find(x => x.id === id);
  else if (type === 'ammo') item = db.ammo.find(x => x.id === id);
  else if (type === 'accessories') item = db.accessories.find(x => x.id === id);
  if (!item || !item.receipt) return;
  openAttachment(item.receipt);
}

function viewDocumentInBrowser(firearmId, documentId) {
  const firearm = db.firearms.find(item => item.id === firearmId);
  const documentRecord = firearm && (firearm.documents || []).find(item => item.id === documentId);
  if (documentRecord && documentRecord.data) openAttachment(documentRecord.data);
}

function downloadDocument(firearmId, documentId) {
  const firearm = db.firearms.find(item => item.id === firearmId);
  const documentRecord = firearm && (firearm.documents || []).find(item => item.id === documentId);
  if (documentRecord && documentRecord.data) downloadAttachment(documentRecord.data, documentRecord.name || 'document');
}

// =====================================================
// INSURANCE REPORT PDF
// =====================================================
async function exportInsuranceReport() {
  if (db.firearms.length === 0) { toast('No firearms to export.'); return; }
  if (!await ensureFeatureAsset('pdf', 'PDF export')) return;
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF();
  doc.setFontSize(16); doc.text('Firearms Vault Inventory Report', 14, 15);
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
  if (!await ensureFeatureAsset('ocr', 'Serial-number scanning')) return;
  try {
    const { data: { text } } = await Tesseract.recognize(canvas, 'eng', {
      workerPath: 'vendor/tesseract/worker.min.js',
      corePath: 'vendor/tesseract',
      langPath: 'vendor/tesseract/lang',
      workerBlobURL: false,
      gzip: true
    });
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
async function exportExcel() {
  if(db.firearms.length===0){toast('No data to export.');return;}
  if (!await ensureFeatureAsset('excel', 'Excel export')) return;
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
        toImport.forEach(item=>{item.id=generateId();if(!item.tags)item.tags=[];item.notes=sanitizeRichText(item.notes);item.dispNotes=sanitizeRichText(item.dispNotes);db.firearms.push(item);});
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
function setupFirearmFormDisclosure() {
  const grid = document.querySelector('#formModal .modal-body > .form-grid');
  if (!grid || grid.dataset.disclosureReady) return;
  grid.dataset.disclosureReady = 'true';
  const wrap = (id, title, controlIds) => {
    const nodes = controlIds.map(controlId => document.getElementById(controlId)?.closest('.form-group')).filter((node, i, all) => node && all.indexOf(node) === i);
    if (!nodes.length) return;
    const details = document.createElement('details');
    details.id = id; details.className = 'form-disclosure full';
    const summary = document.createElement('summary'); summary.textContent = title;
    const inner = document.createElement('div'); inner.className = 'form-grid disclosure-grid';
    details.append(summary, inner);
    nodes[0].insertAdjacentElement('beforebegin', details);
    nodes.forEach(node => inner.appendChild(node));
  };
  wrap('firearmNotesDisclosure', 'Notes and documents', ['fNotes', 'fReceiptInput', 'docInput']);
  wrap('firearmAdvancedDisclosure', 'Maintenance and custom fields', ['fRoundCount', 'fWarrantyExp', 'customFieldsContainer']);
}
function syncFirearmDisclosure(firearm) {
  const notes = document.querySelector('#firearmNotesDisclosure');
  const advanced = document.querySelector('#firearmAdvancedDisclosure');
  if (notes) notes.open = !!(firearm && (rteShow(firearm.notes) || firearm.receipt || (firearm.documents || []).length));
  if (advanced) advanced.open = !!(firearm && ((firearm.roundCount || 0) > 0 || firearm.warrantyExp || (firearm.customFields || []).length));
}
setupFirearmFormDisclosure();

const ModalAccessibility = (() => {
  const selector = '.modal-overlay, .detail-overlay, .firstrun-overlay, #cmdk, #lightbox';
  const closeActions = {
    formModal: () => closeModal(), detailView: () => closeDetail(), ammoModal: () => closeAmmoModal(),
    accessoryModal: () => closeAccessoryModal(), maintenanceModal: () => closeMaintenanceModal(),
    backupModal: () => closeBackupModal(), cameraModal: () => closeCameraModal(),
    activityCenterModal: () => closeActivityCenter(), healthModal: () => closeCollectionHealth(),
    quickCaptureModal: () => closeQuickCaptureModal(), reportPackageModal: () => closeReportPackageModal(),
    settingsModal: () => closeSettingsModal(), passwordModal: () => closePasswordModal(),
    syncCenterModal: () => closeSyncCenter(),
    wishlistModal: () => closeWishlistModal(), dealerModal: () => closeDealerModal(),
    dealerImportModal: () => closeDealerImportModal(), cropModal: () => closeCropModal(),
    qrModal: () => closeQRModal(), shortcutsModal: () => closeShortcutsModal(),
    reportBuilderModal: () => closeReportBuilder(), remindersModal: () => closeReminders(),
    shareModal: () => closeShareModal(), cmdk: () => closeCmdK(), lightbox: () => closeLightbox()
  };
  let stack = [];
  let isolated = [];
  const returnFocus = new WeakMap();

  function isOpen(el) {
    if (!el || !el.isConnected) return false;
    if (el.id === 'cmdk' || el.id === 'lightbox' || el.id === 'firstRunPanel') return el.style.display !== 'none';
    return el.classList.contains('open');
  }
  function liveTop() {
    const open = Array.from(document.querySelectorAll(selector)).filter(isOpen);
    return open[open.length - 1] || null;
  }
  function init(el) {
    if (!el || el.dataset.a11yDialog === 'true') return;
    el.dataset.a11yDialog = 'true';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    const title = el.querySelector('h1, h2');
    if (title) {
      if (!title.id) title.id = (el.id || 'dialog') + '-title';
      title.tabIndex = -1;
      el.setAttribute('aria-labelledby', title.id);
    } else if (!el.getAttribute('aria-label')) el.setAttribute('aria-label', 'Dialog');
    el.querySelectorAll('.modal-close, .detail-close, .lightbox-close').forEach(b => {
      if (!b.getAttribute('aria-label')) b.setAttribute('aria-label', 'Close');
    });
  }
  function restoreIsolation() {
    isolated.forEach(({ el, inert, aria }) => {
      if ('inert' in el) el.inert = inert;
      if (aria == null) el.removeAttribute('aria-hidden'); else el.setAttribute('aria-hidden', aria);
    });
    isolated = [];
  }
  function isolateBehind(top) {
    restoreIsolation();
    if (!top) return;
    let child = top;
    while (child && child.parentElement) {
      const parent = child.parentElement;
      Array.from(parent.children).forEach(sibling => {
        if (sibling === child || sibling.tagName === 'SCRIPT' || sibling.tagName === 'STYLE') return;
        isolated.push({ el: sibling, inert: !!sibling.inert, aria: sibling.getAttribute('aria-hidden') });
        if ('inert' in sibling) sibling.inert = true;
        else sibling.setAttribute('aria-hidden', 'true');
      });
      child = parent;
      if (parent === document.body) break;
    }
  }
  function focusFirst(el) {
    if (!el || el.classList.contains('app-dialog')) return;
    const target = Array.from(el.querySelectorAll('[data-initial-focus], input:not([type="hidden"]):not([disabled]), select:not([disabled]), textarea:not([disabled]), [contenteditable="true"], button:not([disabled]), [tabindex="0"]')).find(control => control.offsetParent !== null);
    if (target) setTimeout(() => { if (isOpen(el)) target.focus(); }, 20);
  }
  function refresh() {
    const candidates = Array.from(document.querySelectorAll(selector));
    candidates.forEach(init);
    const next = candidates.filter(isOpen);
    next.forEach(el => {
      if (!stack.includes(el)) {
        returnFocus.set(el, document.activeElement instanceof HTMLElement ? document.activeElement : null);
        el.dataset.dirty = 'false';
        focusFirst(el);
      }
    });
    stack.forEach(el => {
      if (!next.includes(el)) {
        el.dataset.dirty = 'false';
        const opener = returnFocus.get(el);
        if (opener && opener.isConnected) setTimeout(() => opener.focus(), 0);
      }
    });
    stack = next;
    isolateBehind(stack[stack.length - 1]);
  }
  let pending = false;
  function scheduleRefresh() {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => { pending = false; refresh(); });
  }
  async function requestClose(el) {
    if (!el || el.classList.contains('app-dialog')) return false;
    if (el.dataset.saving === 'true') {
      toast('This save is still finishing. Keep the form open until it completes.', 'warning', 5000);
      focusFirst(el);
      return false;
    }
    if (el.id === 'formModal' && el.dataset.draftSaveCommitted === 'true') {
      const cleaned = await clearFirearmDraft(undefined, { committed: true });
      if (!cleaned) {
        toast('The saved item is safe, but its old draft marker still needs cleanup. Keep this tab open and try Close again.', 'error', 9000);
        focusFirst(el);
        return false;
      }
      if (!await resolveRecoveredFormSession('formModal')) {
        holdCommittedRecoveredForm('formModal', 'saveBtn');
        focusFirst(el);
        return false;
      }
      delete el.dataset.draftSaveCommitted;
      el.dataset.dirty = 'false';
      closeModal();
      return true;
    }
    if (el.id === 'formModal' && editingId === null && el.dataset.dirty === 'true' && el.dataset.recoveredForm !== 'true') {
      const draftSafe = await flushFirearmDraft();
      if (draftSafe) {
        el.dataset.dirty = 'false';
        closeModal();
        return true;
      }
    }
    if (el.dataset.dirty === 'true') {
      const discard = await confirmDialog('Discard the changes you made in this dialog?', { title: 'Unsaved form changes', okText: 'Discard', danger: true });
      if (!discard) { focusFirst(el); return false; }
      if (el.id === 'formModal' && editingId === null) {
        const discarded = await clearFirearmDraft(undefined, { discarded: true });
        if (!discarded) {
          toast('The discarded draft could not be cleared safely. Keep this form open and try again.', 'error', 9000);
          focusFirst(el);
          return false;
        }
      }
      else if (el.id === 'formModal') {
        const editOnlyImages = [..._firearmDraftOwnedImages];
        _firearmDraftOwnedImages.clear();
        await removeUnreferencedDraftImages(editOnlyImages);
      }
      if (el.dataset.recoveredForm === 'true' && !await resolveRecoveredFormSession(el.id)) {
        focusFirst(el);
        return false;
      }
    }
    el.dataset.dirty = 'false';
    const action = closeActions[el.id];
    if (!action) return false;
    action();
    return true;
  }
  document.addEventListener('input', e => {
    const el = e.target.closest && e.target.closest(selector);
    if (el && !el.classList.contains('app-dialog') && !e.target.matches('[data-no-dirty]')) {
      el.dataset.dirty = 'true';
      saveRecoveredFormSoon(el.id);
    }
  }, true);
  document.addEventListener('change', e => {
    const el = e.target.closest && e.target.closest(selector);
    if (el && !el.classList.contains('app-dialog') && !e.target.matches('[data-no-dirty]')) {
      el.dataset.dirty = 'true';
      saveRecoveredFormSoon(el.id);
    }
  }, true);
  document.addEventListener('click', e => {
    const el = e.target.closest && e.target.closest(selector);
    if (!el || el !== liveTop() || el.classList.contains('app-dialog')) return;
    const button = e.target.closest('.modal-close, .detail-close, .lightbox-close, .modal-footer button');
    const dismissButton = button && (/^(close|cancel)$/i.test(button.textContent.trim()) || button.matches('.modal-close, .detail-close, .lightbox-close'));
    if ((e.target === el || dismissButton) && (el.dataset.dirty === 'true' || el.dataset.saving === 'true')) {
      e.preventDefault(); e.stopImmediatePropagation(); requestClose(el);
    }
  }, true);
  document.addEventListener('keydown', e => {
    const top = liveTop();
    if (!top) return;
    if (e.key === 'Escape') {
      if (top.classList.contains('app-dialog')) return;
      e.preventDefault(); e.stopImmediatePropagation(); requestClose(top); return;
    }
    if (e.key !== 'Tab') return;
    const focusable = Array.from(top.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [contenteditable="true"], [tabindex]:not([tabindex="-1"])')).filter(el => el.offsetParent !== null);
    if (!focusable.length) { e.preventDefault(); top.focus(); return; }
    const first = focusable[0], last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }, true);
  const observer = new MutationObserver(scheduleRefresh);
  observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'style'] });
  refresh();
  return { refresh, requestClose };
})();
window.requestModalClose = el => ModalAccessibility.requestClose(el);

function associateFormLabels(root) {
  const scope = root && root.querySelectorAll ? root : document;
  scope.querySelectorAll('.form-group > label:not([for])').forEach(label => {
    const group = label.closest('.form-group');
    const control = group && group.querySelector('input[id], select[id], textarea[id], [contenteditable][id]');
    if (!control || label.contains(control)) return;
    if (control.hasAttribute('contenteditable')) {
      if (!label.id) label.id = control.id + '-label';
      control.setAttribute('role', 'textbox'); control.setAttribute('aria-multiline', 'true'); control.setAttribute('aria-labelledby', label.id);
    } else label.htmlFor = control.id;
  });
  scope.querySelectorAll('[contenteditable="true"][id]').forEach(el => {
    el.setAttribute('role', 'textbox'); el.setAttribute('aria-multiline', 'true');
    if (!el.getAttribute('aria-label') && !el.getAttribute('aria-labelledby')) el.setAttribute('aria-label', el.dataset.placeholder || 'Rich text');
  });
}

function enhanceInteractiveContent(root) {
  const scope = root && root.querySelectorAll ? root : document;
  associateFormLabels(scope);
  scope.querySelectorAll('.card[onclick], .card[data-vault-click], .ffl-card[onclick], .ffl-card[data-vault-click], .reminder-item[onclick], .reminder-item[data-vault-click], .dash-alert[onclick], .dash-alert[data-vault-click], .dash-highlight[onclick], .dash-highlight[data-vault-click], .backup-item[onclick], .backup-item[data-vault-click], tr[onclick], tr[data-vault-click], .detail-gallery-dot[onclick], .detail-gallery-dot[data-vault-click], .cmdk-item[onclick], .cmdk-item[data-vault-click]').forEach(el => {
    if (el.matches('button, a, input, select, textarea')) return;
    el.classList.add('keyboard-activatable'); el.setAttribute('role', 'button');
    if (!el.hasAttribute('tabindex')) el.tabIndex = 0;
  });
  scope.querySelectorAll('th[onclick], th[data-vault-click]').forEach(th => {
    th.classList.add('keyboard-activatable'); th.tabIndex = 0;
    const sorted = (th.textContent || '').includes('▲') ? 'ascending' : (th.textContent || '').includes('▼') ? 'descending' : 'none';
    th.setAttribute('aria-sort', sorted);
  });
  scope.querySelectorAll('.table-container').forEach(container => {
    container.tabIndex = 0; container.setAttribute('role', 'region');
    container.setAttribute('aria-label', 'Scrollable ' + (currentTab || 'inventory') + ' table');
  });
  scope.querySelectorAll('.card-checkbox:not([aria-label])').forEach(cb => cb.setAttribute('aria-label', 'Select item'));
  scope.querySelectorAll('img.card-img, img.detail-img').forEach(img => {
    if (img.hasAttribute('alt') && img.alt) return;
    const card = img.closest('.card, .detail-panel');
    const title = card && card.querySelector('.card-title, h2');
    img.alt = title ? 'Photo of ' + title.textContent.trim() : 'Inventory item photo';
  });
  scope.querySelectorAll('img.thumb').forEach(img => { if (!img.hasAttribute('alt')) img.alt = ''; });
  scope.querySelectorAll('.dash-card canvas').forEach(canvas => {
    const card = canvas.closest('.dash-card'); const heading = card && card.querySelector('h2, h3');
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', (heading ? heading.textContent.trim() : 'Inventory') + ' chart. The surrounding dashboard contains the same summary data.');
  });
  scope.querySelectorAll('.img-upload-area[onclick], .img-upload-area[data-vault-click]').forEach(el => {
    el.classList.add('keyboard-activatable'); el.setAttribute('role', 'button'); el.tabIndex = 0;
  });
  refreshSensitiveElements(scope);
}
document.addEventListener('keydown', e => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const target = e.target.closest && e.target.closest('.keyboard-activatable');
  if (!target || e.target.closest('button, a, input, select, textarea') && e.target !== target) return;
  e.preventDefault(); target.click();
});
let enhancePending = false;
new MutationObserver(() => {
  if (enhancePending) return;
  enhancePending = true;
  requestAnimationFrame(() => { enhancePending = false; enhanceInteractiveContent(document); });
}).observe(document.body, { subtree: true, childList: true });
enhanceInteractiveContent(document);

document.getElementById('formModal').addEventListener('click',e=>{if(e.target===document.getElementById('formModal'))closeModal();});
document.getElementById('detailView').addEventListener('click',e=>{if(e.target===document.getElementById('detailView'))closeDetail();});
document.getElementById('ammoModal').addEventListener('click',e=>{if(e.target===document.getElementById('ammoModal'))closeAmmoModal();});
document.getElementById('maintenanceModal').addEventListener('click',e=>{if(e.target===document.getElementById('maintenanceModal'))closeMaintenanceModal();});
document.getElementById('backupModal').addEventListener('click',e=>{if(e.target===document.getElementById('backupModal'))closeBackupModal();});
document.getElementById('cameraModal').addEventListener('click',e=>{if(e.target===document.getElementById('cameraModal'))closeCameraModal();});
document.getElementById('accessoryModal').addEventListener('click',e=>{if(e.target===document.getElementById('accessoryModal'))closeAccessoryModal();});
document.getElementById('settingsModal').addEventListener('click',e=>{if(e.target===document.getElementById('settingsModal'))closeSettingsModal();});
document.getElementById('syncCenterModal').addEventListener('click',e=>{if(e.target===document.getElementById('syncCenterModal'))closeSyncCenter();});
document.getElementById('missingMediaFile').addEventListener('change', handleMissingMediaFile);
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
    // ModalAccessibility closes only the topmost layer and preserves focus.
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
  endRecordEdit('wishlist');
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
    beginRecordEdit('wishlist', editId, collectWishlistFormRecord(editId));
  } else {
    ['wMake','wModel','wCaliber','wPrice','wDealer','wURL'].forEach(id => document.getElementById(id).value = '');
    document.getElementById('wNotes').innerHTML = '';
    document.getElementById('wType').value = 'Rifle';
    document.getElementById('wPriority').value = 'medium';
  }
  document.getElementById('wishlistModal').classList.add('open');
}

function closeWishlistModal() { document.getElementById('wishlistModal').classList.remove('open'); editingWishlistId = null; endRecordEdit('wishlist'); }

function collectWishlistFormRecord(id) {
  return {
    id,
    make: document.getElementById('wMake').value.trim(),
    model: document.getElementById('wModel').value.trim(),
    caliber: document.getElementById('wCaliber').value.trim(),
    type: document.getElementById('wType').value,
    price: document.getElementById('wPrice').value,
    priority: document.getElementById('wPriority').value,
    dealer: document.getElementById('wDealer').value.trim(),
    url: document.getElementById('wURL').value.trim(),
    notes: rteValue('wNotes')
  };
}

async function saveWishlistItem() {
  return withFormSaveLock('wishlist', 'saveWishlistBtn', async () => {
    const make = document.getElementById('wMake').value.trim();
    const model = document.getElementById('wModel').value.trim();
    if (!make && !model) { showFieldError(document.getElementById('wMake'), 'Enter at least a manufacturer or model.'); return false; }
    let data = collectWishlistFormRecord(editingWishlistId || generateId());
    let editResult = null;
    if (editingWishlistId) {
      editResult = await mergeRecordEdit('wishlist', editingWishlistId, data);
      if (editResult.cancelled) return false;
      data = editResult.record;
    } else {
      data.dateAdded = new Date().toISOString().slice(0,10);
    }
    const previousDatabase = structuredClone(db);
    const previousRecord = editingWishlistId ? previousDatabase.wishlist.find(item => item.id === editingWishlistId) || null : null;
    if (editingWishlistId) {
      const i = db.wishlist.findIndex(x => x.id === editingWishlistId);
      if (i > -1) db.wishlist[i] = data; else db.wishlist.push(data);
      addAuditEntry('edit', 'wishlist', (data.make || '') + ' ' + (data.model || ''), '', {
        collection: 'wishlist', recordId: data.id, before: previousRecord, after: data
      });
    } else {
      db.wishlist.push(data);
      addAuditEntry('create', 'wishlist', make + ' ' + model, '', {
        collection: 'wishlist', recordId: data.id, before: null, after: data
      });
    }
    const attemptedDatabase = structuredClone(db);
    if (!await saveData()) { await keepFormOpenAfterSaveFailure(previousDatabase, attemptedDatabase, 'wishlistModal', 'Wishlist item'); return false; }
    if (!await resolveRecoveredFormSession('wishlistModal')) { holdCommittedRecoveredForm('wishlistModal', 'saveWishlistBtn'); return true; }
    render(); closeWishlistModal();
    if (editResult && editResult.conflicts.length) toast('Wishlist item saved with your field-by-field conflict choices.', 'success', 6000);
    return true;
  });
}

async function deleteWishlistItem(id) {
  if (!await confirmDialog('Remove from wishlist?', { title: 'Remove from wishlist', okText: 'Remove', danger: true })) return;
  const w = db.wishlist.find(x => x.id === id);
  addAuditEntry('delete','wishlist', w ? (w.make+' '+w.model) : 'Unknown','', {
    collection: 'wishlist', recordId: id, before: w || null, after: null
  });
  db.wishlist = db.wishlist.filter(x => x.id !== id);
  saveData(); render();
}

async function moveWishlistToCollection(id) {
  const w = db.wishlist.find(x => x.id === id);
  if (!w) return;
  if (!await confirmDialog('Move "' + (w.make||'')+' '+(w.model||'')+'" to your collection? This will open the Add Firearm form.', { title: 'Move to collection', okText: 'Move' })) return;
  closeWishlistModal();
  await openAddModal();
  document.getElementById('fMake').value = w.make || '';
  document.getElementById('fModel').value = w.model || '';
  document.getElementById('fCaliber').value = w.caliber || '';
  document.getElementById('fType').value = w.type || 'Rifle';
  document.getElementById('fPrice').value = w.price || '';
  pendingWishlistMoveId = id;
  saveFirearmDraftSoon();
}

let _wishFilter = 'all';
const _wishPrio = (w) => (w.priority === 'high' || w.priority === 'low') ? w.priority : 'medium';
function setWishlistFilter(p) { _wishFilter = p; render(); }
// Click a priority pill to cycle High → Medium → Low.
function cycleWishlistPriority(id) {
  const w = (db.wishlist || []).find(x => x.id === id);
  if (!w) return;
  const before = structuredClone(w);
  const order = ['high', 'medium', 'low'];
  w.priority = order[(order.indexOf(_wishPrio(w)) + 1) % order.length];
  addAuditEntry('edit', 'wishlist', ((w.make || '') + ' ' + (w.model || '')).trim() || 'Wishlist item', 'Changed priority', {
    collection: 'wishlist', recordId: w.id, before, after: w
  });
  saveData(); render();
}

function renderWishlistTab() {
  document.getElementById('cardGrid').style.display = 'none';
  document.getElementById('tableContainer').style.display = 'block';
  document.getElementById('emptyState').style.display = 'none';
  const allItems = db.wishlist || [];
  const query = (document.getElementById('searchBox').value || '').trim().toLowerCase();
  const items = query ? allItems.filter(w => [w.make, w.model, w.caliber, w.type, w.dealer, w.notes]
    .some(value => String(value || '').replace(/<[^>]*>/g, ' ').toLowerCase().includes(query))) : allItems;
  updatePageContext(items.length);
  const totalTarget = items.reduce((s, w) => s + (parseFloat(w.price) || 0), 0);
  let h = '<div style="padding:16px 24px;background:var(--bg2);border-bottom:1px solid var(--border);display:flex;justify-content:space-between;font-size:0.86rem;font-weight:600;"><span>Wishlist Items: <span style="color:var(--accent);">' + items.length + '</span></span><span>Target Budget: <span style="color:var(--accent);">' + money(totalTarget) + '</span></span></div>';
  if (items.length === 0) {
    h += allItems.length
      ? tabEmpty('🔍', 'No wishlist items match your search', 'Try another make, model, caliber, or dealer.', '<button class="btn btn-outline" onclick="clearAllFilters()">Clear search</button>')
      : tabEmpty('⭐', 'Your wishlist is empty', 'Track firearms you want, set a target price and priority, then move them to your collection when you buy.', '<button class="btn btn-primary" onclick="openWishlistModal()">Add wishlist item</button>');
    document.getElementById('tableContainer').innerHTML = h;
    return;
  }

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
  updatePageContext(rows.length);

  h += '<table class="data-table"><thead><tr><th>Priority</th><th>Make</th><th>Model</th><th>Caliber</th><th>Type</th><th>Target Price</th><th>Dealer</th><th>Added</th><th></th></tr></thead><tbody>';
  rows.forEach(w => {
    const pr = w.price ? money(w.price) : '--';
    h += '<tr>';
    h += '<td><button class="wishlist-priority '+_wishPrio(w)+'" title="Click to change priority" aria-label="Priority: '+_wishPrio(w)+' (click to change)" onclick="event.stopPropagation();cycleWishlistPriority(\''+w.id+'\')">'+_wishPrio(w).toUpperCase()+'</button></td>';
    h += '<td>'+esc(w.make||'--')+'</td><td>'+esc(w.model||'--')+'</td><td>'+esc(w.caliber||'--')+'</td><td>'+esc(w.type||'--')+'</td><td>'+pr+'</td>';
    h += '<td>'+(w.url?'<a href="'+escAttr(safeHref(w.url))+'" target="_blank" rel="noopener" onclick="event.stopPropagation()" style="color:var(--accent);">'+esc(w.dealer||'Link')+'</a>':esc(w.dealer||'--'))+'</td>';
    h += '<td>'+fmtDate(w.dateAdded)+'</td>';
    h += '<td style="text-align:right;white-space:nowrap;"><button class="btn btn-small btn-outline" data-item-id="'+escAttr(w.id)+'" onclick="openWishlistModal(this.dataset.itemId)">Edit</button> <button class="btn btn-small btn-primary" onclick="event.stopPropagation();moveWishlistToCollection(\''+w.id+'\')">Buy</button> <button class="btn btn-small btn-danger" onclick="event.stopPropagation();deleteWishlistItem(\''+w.id+'\')">Delete</button></td></tr>';
    if (rteShow(w.notes)) h += '<tr class="wishlist-note-row"><td colspan="9"><div class="rte-display wishlist-note">' + w.notes + '</div></td></tr>';
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
  endRecordEdit('dealers');
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
    beginRecordEdit('dealers', editId, collectDealerFormRecord(editId));
  } else {
    ['dName','dFFL','dPhone','dEmail','dAddress','dWebsite'].forEach(id => document.getElementById(id).value = '');
    document.getElementById('dNotes').innerHTML = '';
  }
  document.getElementById('dealerModal').classList.add('open');
}

function closeDealerModal() { document.getElementById('dealerModal').classList.remove('open'); editingDealerId = null; endRecordEdit('dealers'); }

function collectDealerFormRecord(id) {
  return {
    id,
    name: document.getElementById('dName').value.trim(),
    ffl: document.getElementById('dFFL').value.trim(),
    phone: document.getElementById('dPhone').value.trim(),
    email: document.getElementById('dEmail').value.trim(),
    address: document.getElementById('dAddress').value.trim(),
    website: document.getElementById('dWebsite').value.trim(),
    notes: rteValue('dNotes')
  };
}

async function saveDealer() {
  return withFormSaveLock('dealer', 'saveDealerBtn', async () => {
    const name = document.getElementById('dName').value.trim();
    if (!name) { showFieldError(document.getElementById('dName'), 'Enter a dealer name.'); return false; }
    let data = collectDealerFormRecord(editingDealerId || generateId());
    let editResult = null;
    if (editingDealerId) {
      editResult = await mergeRecordEdit('dealers', editingDealerId, data);
      if (editResult.cancelled) return false;
      data = editResult.record;
    } else {
      data.favorite = false;
    }
    const previousDatabase = structuredClone(db);
    const previousRecord = editingDealerId ? previousDatabase.dealers.find(item => item.id === editingDealerId) || null : null;
    if (editingDealerId) {
      const i = db.dealers.findIndex(x => x.id === editingDealerId);
      if (i > -1) db.dealers[i] = data; else db.dealers.push(data);
      addAuditEntry('edit', 'dealer', data.name, '', {
        collection: 'dealers', recordId: data.id, before: previousRecord, after: data
      });
    } else {
      db.dealers.push(data);
      addAuditEntry('create', 'dealer', name, '', {
        collection: 'dealers', recordId: data.id, before: null, after: data
      });
    }
    const attemptedDatabase = structuredClone(db);
    if (!await saveData()) { await keepFormOpenAfterSaveFailure(previousDatabase, attemptedDatabase, 'dealerModal', 'Dealer'); return false; }
    if (!await resolveRecoveredFormSession('dealerModal')) { holdCommittedRecoveredForm('dealerModal', 'saveDealerBtn'); return true; }
    render(); closeDealerModal();
    if (editResult && editResult.conflicts.length) toast('Dealer saved with your field-by-field conflict choices.', 'success', 6000);
    return true;
  });
}

async function deleteDealer(id) {
  if (!await confirmDialog('Delete this dealer?', { title: 'Delete dealer', okText: 'Delete', danger: true })) return;
  const d = db.dealers.find(x => x.id === id);
  addAuditEntry('delete','dealer',d?d.name:'Unknown','', {
    collection: 'dealers', recordId: id, before: d || null, after: null
  });
  db.dealers = db.dealers.filter(x => x.id !== id); saveData(); render();
}

// Toggle a dealer's "preferred" flag; favorites sort to the top of the list.
function toggleDealerFavorite(id) {
  const d = db.dealers.find(x => x.id === id);
  if (!d) return;
  const before = structuredClone(d);
  d.favorite = !d.favorite;
  addAuditEntry('edit', 'dealer', d.name || 'Dealer', d.favorite ? 'Marked preferred' : 'Removed preferred status', {
    collection: 'dealers', recordId: d.id, before, after: d
  });
  saveData(); render();
}

// ---- Bulk import -------------------------------------------------------
// Curated Arizona starter list (public business listings). FFL license
// numbers are intentionally blank — they must be verified per-dealer via the
// ATF FFL eZ Check, so we never store an unverified number. Each dealer card
// gets a "Look up FFL #" link to find the current, authoritative number.
const AZ_FFL_DEALERS = [
  // Yuma
  { name: "Sprague's Sports", phone: "(928) 726-0022", address: "345 W 32nd St, Yuma, AZ 85364", website: "https://www.spragues.com", notes: "Gun store, indoor range & CCW classes." },
  { name: "Sportsman's Warehouse #181", phone: "(928) 615-3200", address: "1038 S Castle Dome Ave, Yuma, AZ 85365", website: "https://www.sportsmans.com", notes: "Outdoor sporting goods & firearms." },
  { name: "C-A-L Ranch Stores (Yuma)", phone: "(928) 343-7700", address: "529 W 32nd St, Yuma, AZ 85364", website: "https://www.calranch.com", notes: "Ranch & farm retailer with firearms counter." },
  { name: "Caliber Arms and Ammo", phone: "(928) 371-7019", address: "11274 S Fortuna Rd, Ste D1, Yuma, AZ 85367", website: "https://www.caliberarmsandammo.com", notes: "Local gun shop in the Foothills." },
  { name: "Hiram's Guns", phone: "(928) 955-3838", address: "801 W 32nd St, Yuma, AZ 85364", website: "", notes: "Firearms & accessories." },
  { name: "Big 5 Sporting Goods (Yuma)", phone: "(928) 726-2884", address: "505 W Catalina Dr, Yuma, AZ 85364", website: "https://www.big5sportinggoods.com", notes: "Sporting goods retailer." },
  { name: "2nd Amendment Hardware", phone: "(928) 446-1916", address: "4262 E Hwy 80, Yuma, AZ 85365", website: "", notes: "" },
  { name: "5 Shot Firearms", phone: "(928) 941-0867", address: "11640 S Glenwood Ave, Yuma, AZ 85367", website: "https://5shotfirearms.com", notes: "Family-owned gun store." },
  { name: "Blue Phantom", phone: "(928) 581-5407", address: "1209 W 18th Pl, Yuma, AZ 85364", website: "", notes: "" },
  { name: "Patcho Villa Gun Works", phone: "", address: "2405 S 27th Ave, Yuma, AZ 85364", website: "", notes: "" },
  // Phoenix metro
  { name: "Shooter's World", phone: "(602) 266-2600", address: "3828 N 28th Ave, Phoenix, AZ 85017", website: "https://www.azshootersworld.com", notes: "Firearms, indoor range & training." },
  { name: "Shooter's World (Peoria)", phone: "(623) 776-7200", address: "8966 W Cactus Rd, Peoria, AZ 85381", website: "https://www.azshootersworld.com", notes: "West-valley range & gun store." },
  { name: "Legendary Guns", phone: "", address: "5130 N 19th Ave, Phoenix, AZ 85015", website: "https://legendaryguns.com", notes: "Class III/NFA, gunsmithing, appraisals." },
  { name: "Tactical Armory", phone: "(602) 488-3607", address: "5602 E Calle Camelia, Phoenix, AZ 85018", website: "", notes: "Firearms & transfers." },
  { name: "Tombstone Tactical", phone: "(800) 606-0370", address: "10005 N Metro Pkwy E, Phoenix, AZ 85051", website: "https://tombstonetactical.com", notes: "Firearms retailer & online sales." },
  { name: "Scottsdale Gun Club", phone: "", address: "14860 N Northsight Blvd, Scottsdale, AZ 85260", website: "https://scottsdalegunclub.com", notes: "Retail & members indoor range." },
  { name: "Caswells Shooting Range", phone: "(480) 497-5141", address: "856 E Isabella Ave, Mesa, AZ 85204", website: "https://shop.caswells.com", notes: "Retail, range & training." },
  { name: "Arizona Firearms (Tempe)", phone: "(480) 968-7481", address: "1315 W University Dr, Tempe, AZ 85281", website: "https://www.arizona-firearms.com", notes: "Long-running East Valley gun shop." },
  { name: "Arizona Firearms (Chandler)", phone: "(480) 718-5132", address: "1965 S Alma School Rd, Unit 5, Chandler, AZ 85286", website: "https://www.arizona-firearms.com", notes: "East Valley gun shop." },
  { name: "AZ Guns", phone: "(480) 745-2588", address: "961 W Ray Rd, Ste 8, Chandler, AZ 85225", website: "https://azguns.com", notes: "Low FFL transfer fees, veteran discounts." },
  { name: "C2 Tactical", phone: "", address: "10000 N 90th St, Scottsdale, AZ 85258", website: "https://c2tactical.com", notes: "Range & retail (Scottsdale & Tempe)." },
  // Tucson
  { name: "Murphy's Guns & Gunsmithing", phone: "(520) 881-7074", address: "3235 N Country Club Rd, Tucson, AZ 85716", website: "https://www.murphysgunshop.com", notes: "Gun shop & gunsmithing." },
  { name: "Diamondback Shooting Sports & Police Supply", phone: "", address: "7030 E Broadway Blvd, Tucson, AZ 85710", website: "https://dbackshootingsports.com", notes: "Retail, range & police supply." },
  { name: "The Hub Tucson", phone: "(520) 274-7908", address: "1400 S Alvernon Way, Tucson, AZ 85711", website: "https://www.thehubaz.com", notes: "Gun store, indoor range & CCW training." },
  { name: "Bass Pro Shops (Tucson)", phone: "", address: "1500 E Tucson Marketplace Blvd, Tucson, AZ 85713", website: "https://www.basspro.com", notes: "Outdoor retailer with firearms." },
  { name: "SNG Tactical", phone: "", address: "3441 S Palo Verde Rd, Tucson, AZ 85713", website: "https://www.sngtactical.com", notes: "Firearms & tactical gear." },
  { name: "James410 LLC", phone: "(520) 345-7526", address: "8963 E Tanque Verde Rd, Ste 195, Tucson, AZ 85749", website: "https://james410llc.com", notes: "Firearms sales & transfers." },
  { name: "The Armament Shop", phone: "", address: "8251 E Sabino Dr, Tucson, AZ 85750", website: "", notes: "" },
  { name: "Specialized Firearms Supply", phone: "", address: "7880 E Wild Mustang Pl, Tucson, AZ 85750", website: "", notes: "" },
  { name: "520 Tactical", phone: "", address: "5051 E 29th St, Tucson, AZ 85711", website: "", notes: "" },
  { name: "C-A-L Ranch Stores (Tucson)", phone: "", address: "6363 E 22nd St, Tucson, AZ 85710", website: "https://www.calranch.com", notes: "Ranch & farm retailer with firearms counter." },
  { name: "AZ Arms and Antiques", phone: "(520) 471-3244", address: "3033 W Gymkhana Way, Tucson, AZ 85742", website: "", notes: "Firearms & antiques." },
  // Northern AZ (Flagstaff, Prescott, Verde Valley, Rim Country)
  { name: "2nd Amendment Store", phone: "(928) 266-0683", address: "2500 S Woodlands Village Blvd #25, Flagstaff, AZ 86001", website: "https://2astore.com", notes: "Firearms & sporting goods." },
  { name: "Arizona Collectibles and Firearms", phone: "(928) 310-8544", address: "9900 E Wapiti Trl, Flagstaff, AZ 86004", website: "", notes: "Firearms & collectibles." },
  { name: "C-A-L Ranch Stores (Flagstaff)", phone: "", address: "2530 N 4th St, Flagstaff, AZ 86004", website: "https://www.calranch.com", notes: "Ranch & farm retailer with firearms counter." },
  { name: "Royal Ordnance", phone: "(928) 445-1735", address: "1344 Gifford Dr, Prescott, AZ 86305", website: "", notes: "Firearms dealer." },
  { name: "Sirius Arms", phone: "(928) 275-2535", address: "1201 Iron Springs Rd #7, Prescott, AZ 86305", website: "", notes: "Firearms dealer." },
  { name: "Sport Shooters Supply", phone: "(928) 713-0457", address: "1929 Ventnor Cir, Prescott, AZ 86301", website: "", notes: "Firearms & ammo." },
  { name: "Hamilton & Son's Firearms", phone: "", address: "475 S Airpark Rd, Ste 1, Cottonwood, AZ 86326", website: "https://hamiltonfirearms.com", notes: "Verde Valley gun shop." },
  { name: "Smoke-N-Guns", phone: "(928) 634-3216", address: "322 S Main St, Cottonwood, AZ 86326", website: "https://www.smokenguns.com", notes: "Verde Valley gun shop." },
  { name: "Rim Country Guns", phone: "(928) 474-8000", address: "513 S Beeline Hwy, Payson, AZ 85541", website: "", notes: "Rim Country gun shop." },
  // Western AZ (Lake Havasu, Kingman, Bullhead City)
  { name: "Southwest Firearms", phone: "", address: "2148 McCulloch Blvd N #101, Lake Havasu City, AZ 86403", website: "https://southwestfirearm.com", notes: "Gun shop, gunsmith & CCW classes." },
  { name: "Sierra 1 Guns and Gear", phone: "", address: "3045 Daytona Ave, Lake Havasu City, AZ 86403", website: "", notes: "Firearms & gear." },
  { name: "Citadel Armory", phone: "", address: "1605 Neptune Dr, Lake Havasu City, AZ 86404", website: "", notes: "Firearms dealer." },
  { name: "The Gun Shop (Kingman)", phone: "(928) 681-4570", address: "4938 N Stockton Hill Rd, Kingman, AZ 86409", website: "", notes: "Local gun shop." },
  { name: "TAC50", phone: "", address: "2124 Hwy 95, Ste A, Bullhead City, AZ 86442", website: "https://tac50.com", notes: "Buys & sells guns, gold & silver." },
  { name: "Mohave Armory", phone: "", address: "1699 Hwy 95, Bullhead City, AZ 86442", website: "https://mohavearmoryaz.com", notes: "Full-service gun shop." },
  // Southern AZ (Sierra Vista, Casa Grande)
  { name: "Apocalypse Arms and Military Surplus", phone: "(520) 458-9133", address: "101 W Fry Blvd, Sierra Vista, AZ 85635", website: "", notes: "Firearms & military surplus." },
  { name: "King's Armory", phone: "", address: "65 S Highway 92, Suite C, Sierra Vista, AZ 85635", website: "", notes: "Firearms dealer." },
  { name: "Denny's Shooting Sports", phone: "", address: "2248 Baywood Ln, Sierra Vista, AZ 85635", website: "", notes: "Firearms & shooting sports." },
  { name: "C-A-L Ranch Stores (Sierra Vista)", phone: "", address: "673 N Highway 90, Sierra Vista, AZ 85635", website: "https://www.calranch.com", notes: "Ranch & farm retailer with firearms counter." },
  { name: "1789 Arms", phone: "(928) 307-1789", address: "206 W Caribbean Dr, Casa Grande, AZ 85122", website: "", notes: "Firearms dealer." },
  { name: "Desert Vista Gun Sales", phone: "(602) 206-3452", address: "8959 S Valley Vista Dr, Casa Grande, AZ 85193", website: "", notes: "Firearms dealer & transfers." },
  { name: "Elegant Arms", phone: "(520) 233-6971", address: "1216 E Palo Verde Dr, Casa Grande, AZ 85122", website: "", notes: "Firearms dealer." },
  // Additional towns — White Mountains, I-40 corridor, Colorado River, southeast
  { name: "Sharp Shooters", phone: "(928) 536-3555", address: "1362 E Snowflake Blvd, Snowflake, AZ 85937", website: "", notes: "Family-owned White Mountains gun shop." },
  { name: "Sportsman's Warehouse (Show Low)", phone: "", address: "4421 S White Mountain Rd, Show Low, AZ 85901", website: "https://www.sportsmans.com", notes: "Outdoor sporting goods & firearms." },
  { name: "B&B Gunsmithing", phone: "(928) 386-9053", address: "514 W Elm St, Winslow, AZ 86047", website: "", notes: "Gunsmith & firearms dealer." },
  { name: "High Country Ammunition & Firearms", phone: "(602) 751-4830", address: "2700 Scenic View Dr, Winslow, AZ 86047", website: "", notes: "Ammo & firearms." },
  { name: "Gold Pan Dan's Guns & Gold", phone: "(928) 669-3079", address: "820 S California Ave, Ste 109, Parker, AZ 85344", website: "https://goldpandansgunsandgold.com", notes: "Guns & gold on the Colorado River." },
  { name: "AZ 2nd Amendment Outfitters", phone: "(520) 397-7737", address: "1070 E Valle Vista Dr, Nogales, AZ 85621", website: "", notes: "Firearms outfitter." },
  { name: "Arizona Guns and Ammo", phone: "(928) 424-4570", address: "520 W 5th St, Safford, AZ 85546", website: "", notes: "Gun & ammo shop." },
  { name: "Taking Aim Guns and Ammo", phone: "(928) 228-8822", address: "1122 W Thatcher Blvd, Safford, AZ 85546", website: "https://takingaimgunsandammo.com", notes: "Gun & ammo shop." },
  { name: "Q's Gun & Supply", phone: "", address: "7648 S Chuckwagon, Safford, AZ 85546", website: "http://www.qgunsupply.com", notes: "Firearms & supply." }
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

async function loadAZDealers() {
  const r = mergeDealers(AZ_FFL_DEALERS);
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

// Derive a metro/area bucket from a dealer's address (and notes as a fallback).
function dealerArea(d) {
  const a = ((d.address || '') + ' ' + (d.notes || '')).toLowerCase();
  if (a.indexOf('yuma') > -1) return 'Yuma';
  if (/(phoenix|scottsdale|mesa|tempe|glendale|peoria|chandler|gilbert|surprise|avondale|goodyear|queen creek|fountain hills|cave creek|paradise valley|sun city)/.test(a)) return 'Phoenix';
  if (a.indexOf('tucson') > -1 || a.indexOf('marana') > -1 || a.indexOf('oro valley') > -1 || a.indexOf('vail') > -1 || a.indexOf('sahuarita') > -1) return 'Tucson';
  if (/(flagstaff|prescott|sedona|cottonwood|clarkdale|jerome|camp verde|payson|show low|pinetop|lakeside|snowflake|taylor|winslow|holbrook|williams|page|chino valley|dewey|humboldt)/.test(a)) return 'Northern AZ';
  if (/(lake havasu|kingman|bullhead|fort mohave|mohave valley|golden valley|parker|quartzsite)/.test(a)) return 'Western AZ';
  if (/(sierra vista|casa grande|nogales|douglas|bisbee|benson|willcox|green valley|maricopa|eloy|coolidge|globe|safford|thatcher)/.test(a)) return 'Southern AZ';
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

function setDealerSort(v) { _dealerSort = v; render(); }

// Filter the already-rendered cards in place (keeps search-box focus, no rebuild).
function applyDealerFilter() {
  const input = document.getElementById('dealerSearch') || document.getElementById('searchBox');
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
  updatePageContext(shown);
}

function renderDealersTab() {
  document.getElementById('cardGrid').style.display = 'none';
  document.getElementById('tableContainer').style.display = 'block';
  document.getElementById('emptyState').style.display = 'none';
  const allItems = db.dealers || [];
  const query = (document.getElementById('searchBox').value || '').trim().toLowerCase();
  _dealerFilterQ = query;
  const items = query ? allItems.filter(d => [d.name, d.ffl, d.address, d.city, d.state, d.phone, d.email, d.notes]
    .some(value => String(value || '').replace(/<[^>]*>/g, ' ').toLowerCase().includes(query))) : allItems;
  updatePageContext(items.length);
  let h = '<div style="padding:16px 24px;background:var(--bg2);border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;">'
    + '<span style="font-size:0.86rem;font-weight:600;">FFL Dealers: <span style="color:var(--accent);" id="dealerShownCount">' + items.length + '</span></span>'
    + '<button class="btn btn-small btn-secondary" onclick="openDealerImportModal()">⬇️ Import dealers</button>'
    + '</div>';
  if (items.length === 0) {
    h += allItems.length
      ? tabEmpty('🔍', 'No dealers match your search', 'Try another dealer name, city, FFL number, or note.', '<button class="btn btn-outline" onclick="clearAllFilters()">Clear search</button>')
      : tabEmpty('🏢', 'No dealers saved yet', 'Add your go-to FFLs, or load the built-in Arizona starter list to get going fast.', '<button class="btn btn-primary" onclick="openDealerImportModal()">Import dealers</button>');
    document.getElementById('tableContainer').innerHTML = h;
    return;
  }

  // Area counts for the filter chips
  const counts = {}; items.forEach(d => { const a = dealerArea(d); counts[a] = (counts[a] || 0) + 1; });
  if (_dealerFilterArea !== 'all' && !counts[_dealerFilterArea]) _dealerFilterArea = 'all';
  const labelFor = a => a === 'Phoenix' ? 'Phoenix Metro' : a === 'all' ? 'All' : a;
  const chip = (area, n) => '<button class="dealer-chip' + (_dealerFilterArea === area ? ' active' : '') + '" data-area="' + area + '" onclick="setDealerArea(\'' + area + '\')">' + labelFor(area) + ' <span class="dealer-chip-n">' + n + '</span></button>';
  let chips = chip('all', items.length);
  ['Yuma', 'Phoenix', 'Tucson', 'Northern AZ', 'Western AZ', 'Southern AZ', 'Other'].forEach(a => { if (counts[a]) chips += chip(a, counts[a]); });

  const sortSel = '<select class="dealer-sort" onchange="setDealerSort(this.value)" title="Sort dealers">'
    + [['fav', 'Preferred first'], ['name', 'Name (A–Z)'], ['region', 'Region']].map(o =>
        '<option value="' + o[0] + '"' + (_dealerSort === o[0] ? ' selected' : '') + '>' + o[1] + '</option>').join('')
    + '</select>';
  h += '<div class="dealer-filterbar">'
    + '<div class="dealer-chips">' + chips + '</div>'
    + sortSel + '</div>';

  h += '<div id="dealerGrid" style="padding:16px 24px;display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,300px),1fr));gap:12px;">';
  const regionRank = { 'Yuma': 0, 'Phoenix': 1, 'Tucson': 2, 'Northern AZ': 3, 'Western AZ': 4, 'Southern AZ': 5, 'Other': 6 };
  const byName = (a, b) => (a.name || '').localeCompare(b.name || '');
  const ordered = [...items];
  if (_dealerSort === 'name') ordered.sort(byName);
  else if (_dealerSort === 'region') ordered.sort((a, b) => ((regionRank[dealerArea(a)] ?? 9) - (regionRank[dealerArea(b)] ?? 9)) || byName(a, b));
  else ordered.sort((a, b) => (b.favorite ? 1 : 0) - (a.favorite ? 1 : 0)); // 'fav' (default): preferred first
  ordered.forEach(d => {
    const area = dealerArea(d);
    const notesText = (d.notes || '').replace(/<[^>]*>/g, ' '); // strip rich-text tags for search
    const text = ((d.name || '') + ' ' + (d.address || '') + ' ' + (d.phone || '') + ' ' + (d.email || '') + ' ' + notesText + ' ' + (d.ffl || '')).toLowerCase();
    h += '<div class="ffl-card' + (d.favorite ? ' is-fav' : '') + '" data-area="' + area + '" data-text="' + escAttr(text) + '">';
    h += '<span class="ffl-area-badge">' + esc(labelFor(area)) + '</span>';
    h += '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;"><h4>' + esc(d.name) + '</h4>'
      + '<div style="display:flex;gap:4px;align-items:center;flex-shrink:0;">'
      + '<button class="btn btn-small btn-outline" data-item-id="' + escAttr(d.id) + '" onclick="openDealerModal(this.dataset.itemId)">Edit</button>'
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
  saveFirearmDraftSoon();
}

function removeCustomField(idx) { tempCustomFields.splice(idx, 1); renderCustomFields(); saveFirearmDraftSoon(); }

window.updateCustomFieldValue = function updateCustomFieldValue(index, field, value) {
  if (!tempCustomFields[index] || !['name', 'value'].includes(field)) return;
  tempCustomFields[index][field] = String(value == null ? '' : value);
  saveFirearmDraftSoon();
};

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
  const session = captureAttachmentSession('formModal');
  const canvas = document.getElementById('cropCanvas');
  const newData = canvas.toDataURL('image/jpeg', 0.9);
  requireAttachmentSession(session);
  const originalId = cropImageId;
  const replacementId = generateId();
  imagesDb[replacementId] = newData;
  await idbPut(replacementId, newData);
  if (!attachmentSessionActive(session)) {
    delete imagesDb[replacementId];
    try { await idbDelete(replacementId); } catch (_) {}
    return;
  }
  tempImages = tempImages.map(id => id === originalId ? replacementId : id);
  _firearmDraftOwnedImages.add(originalId);
  _firearmDraftOwnedImages.add(replacementId);
  closeCropModal();
  renderImageGallery();
  saveFirearmDraftSoon();
}

// =====================================================
// QR CODE GENERATION
// =====================================================
let currentQRFirearmId = null;
let currentQRInstance = null;

async function generateQR(firearmId) {
  const f = db.firearms.find(x => x.id === firearmId);
  if (!f) return;
  if (!await ensureFeatureAsset('qr', 'QR code generation')) return;
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
  const w = window.open('', '_blank', 'noopener=false');
  if (!w) { toast('Allow pop-ups to print this QR code.', 'warning'); return; }
  const doc = w.document;
  doc.title = 'QR Code';
  doc.body.replaceChildren();
  doc.body.style.textAlign = 'center';
  doc.body.style.padding = '40px';
  doc.body.style.fontFamily = 'sans-serif';
  const heading = doc.createElement('h2');
  heading.textContent = f ? `${f.make || ''} ${f.model || ''}`.trim() || 'Firearm' : 'Firearm';
  const serial = doc.createElement('p');
  serial.textContent = `Serial: ${f ? f.serial || 'N/A' : 'N/A'}`;
  const image = doc.createElement('img');
  image.src = dataUrl; image.alt = 'Inventory QR code'; image.width = 250; image.height = 250;
  const printButton = doc.createElement('button');
  printButton.type = 'button'; printButton.textContent = 'Print';
  printButton.addEventListener('click', () => w.print());
  doc.body.append(heading, serial, image, doc.createElement('br'), doc.createElement('br'), printButton);
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
        firearms.forEach(f => { f.notes = sanitizeRichText(f.notes); db.firearms.push(f); });
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
  addAuditEntry('create','firearm',(clone.make||'')+' '+(clone.model||''),'Duplicated from an existing record', {
    collection: 'firearms', recordId: clone.id, before: null, after: clone
  });
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

async function generateCustomReport() {
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

  if (!await ensureFeatureAsset(format === 'excel' ? 'excel' : 'pdf', format === 'excel' ? 'Excel report export' : 'PDF report export')) return;

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
async function exportATFBoundBook() {
  if (!await ensureFeatureAsset('pdf', 'Bound book PDF export')) return;
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
  return runCompatibilityWrite(() => new Promise((resolve, reject) => {
    const tx = stateStore.transaction(STATE_IDB_STORE, 'readwrite');
    const store = tx.objectStore(STATE_IDB_STORE);
    const req = store.put(value, key);
    req.onsuccess = () => resolve();
    req.onerror = (e) => reject(e);
  }));
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

function stateDelete(key) {
  return runCompatibilityWrite(() => new Promise((resolve, reject) => {
    const tx = stateStore.transaction(STATE_IDB_STORE, 'readwrite');
    const req = tx.objectStore(STATE_IDB_STORE).delete(key);
    req.onsuccess = () => resolve();
    req.onerror = (event) => reject(event);
  }));
}

async function saveToLocalStorage() {
  hasUnsavedChanges = true;
  let compatibilitySaved = false;
  try {
    // Keep the compatibility cache for the current account. CloudSync locks it
    // to the authenticated uid and clears it on account changes/sign-out.
    const saveObj = Object.assign({}, db);
    delete saveObj.backups;
    await statePut('db', saveObj);
    compatibilitySaved = true;
    console.log('Auto-saved to IndexedDB');
    setSaveStatus((window.CloudSync && CloudSync.ready) ? 'saving' : 'local');
  } catch (e) {
    console.warn('IndexedDB state save failed:', e.message);
    toast('Could not save changes on this device. The app will still try the cloud save: ' + e.message, 'error', 8000);
  }
  // Persist a uid-scoped outbox immediately. Awaiting this is what guarantees
  // that closing the page after an edit does not need a routine warning.
  if (window.CloudSync && CloudSync.ready) {
    const scheduled = CloudSync.schedulePush();
    const queued = scheduled && scheduled.persisted ? await scheduled.persisted : await CloudSync._queuePromise;
    if (queued && queued.ok) {
      hasUnsavedChanges = false;
      setSaveStatus(navigator.onLine ? 'saving' : 'local');
      return true;
    }
    if (queued && queued.localSafe) {
      // The exact snapshot (including its retry record) is durable in the
      // independent recovery database. It is therefore safe to finish the
      // form save instead of rolling it back and later resurrecting it from
      // that recovery queue. Startup promotes this entry back into the primary
      // queue; the warning remains until cloud sync catches up.
      hasUnsavedChanges = false;
      setSaveStatus('local', 'Saved on this device - cloud queue needs retry');
      return true;
    }
  } else if (compatibilitySaved) {
    // Local-only edition: the IndexedDB write is the durable destination.
    hasUnsavedChanges = false;
    setSaveStatus('local');
    return true;
  }
  return false;
}

async function loadFromLocalStorage() {
  try {
    const data = await stateGet('db');
    if (!data) return false;
    if (!Array.isArray(data.firearms) || !Array.isArray(data.ammo) || !Array.isArray(data.accessories)) return false;
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
      view: currentView,
      accessorySort: accessorySortField,
      accessoryGroup: accessoryGroupField
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
    if (['item', 'manufacturer', 'weapon'].includes(pref.accessorySort)) accessorySortField = pref.accessorySort;
    if (['none', 'item', 'manufacturer', 'weapon'].includes(pref.accessoryGroup)) accessoryGroupField = pref.accessoryGroup;
    if (pref.view) { currentView = pref.view; setView(currentView); }
  } catch(e) {}
}

// =====================================================
// UNSAVED CHANGES WARNING
// =====================================================
function hasOpenDirtyForm() {
  return !!document.querySelector('.modal-overlay.open[data-dirty="true"]:not(.app-dialog)');
}
let suppressUnsavedUnloadWarning = false;
window.hasOpenDirtyForm = hasOpenDirtyForm;
window.allowForcedPageTeardown = function () { suppressUnsavedUnloadWarning = true; };
window.addEventListener('beforeunload', (e) => {
  if (!suppressUnsavedUnloadWarning && (hasUnsavedChanges || hasOpenDirtyForm())) {
    e.preventDefault();
    e.returnValue = 'Your latest change has not been saved on this device or in the cloud yet.';
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
  addAuditEntry('delete', type, name, '', {
    collection, recordId: item.id, before: item, after: null
  });
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
  addAuditEntry('create', undoData.type, (undoData.item.make||undoData.item.name||undoData.item.brand||'Item'), 'Undo delete', {
    collection: undoData.collection, recordId: undoData.item.id, before: null, after: undoData.item
  });
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
  const changed = [];
  bulkSelected.forEach(id => {
    const f = db.firearms.find(x => x.id === id);
    if (f) {
      if (!f.tags) f.tags = [];
      if (!f.tags.includes(tag)) {
        const before = structuredClone(f);
        f.tags.push(tag);
        changed.push({ before, after: f });
      }
    }
  });
  changed.forEach(({ before, after }) => addAuditEntry('edit', 'firearm', ((after.make || '') + ' ' + (after.model || '')).trim() || 'Firearm', 'Bulk tag added: ' + tag, {
    collection: 'firearms', recordId: after.id, before, after
  }));
  document.getElementById('bulkTagInput').value = '';
  await saveData();
  clearBulkSelection();
}

async function bulkRemoveTag() {
  const tag = document.getElementById('bulkTagInput').value.trim();
  if (!tag) { toast('Enter a tag name to remove.'); return; }
  const changed = [];
  bulkSelected.forEach(id => {
    const f = db.firearms.find(x => x.id === id);
    if (f && f.tags) {
      const idx = f.tags.indexOf(tag);
      if (idx > -1) {
        const before = structuredClone(f);
        f.tags.splice(idx, 1);
        changed.push({ before, after: f });
      }
    }
  });
  changed.forEach(({ before, after }) => addAuditEntry('edit', 'firearm', ((after.make || '') + ' ' + (after.model || '')).trim() || 'Firearm', 'Bulk tag removed: ' + tag, {
    collection: 'firearms', recordId: after.id, before, after
  }));
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
      dots[currentImageIndex].click();
    } else if (diff < 0 && currentImageIndex < dots.length - 1) {
      currentImageIndex++;
      dots[currentImageIndex].click();
    }
  }, { passive: true });
}

// Manual backup now opens the single Data & Backups surface. Routine autosave
// remains silent; explicit recovery operations provide their own feedback.
function manualBackup() { openBackupModal(); }

function downloadBlobFile(value, filename, type) {
  const blob = new Blob([value], { type: type || 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function downloadRecoveryBackup(encrypted) {
  if (!window.VaultDataSafety || !window.CloudSync || !CloudSync.uid) {
    toast('The recovery system is unavailable until you are signed in.', 'error');
    return;
  }
  const password = document.getElementById('backupPassword').value;
  const confirmPassword = document.getElementById('backupPasswordConfirm').value;
  if (encrypted) {
    if (password.length < 12) { toast('Use a backup password with at least 12 characters.', 'error'); return; }
    if (password !== confirmPassword) { toast('Backup passwords do not match.', 'error'); return; }
  } else {
    const approved = await confirmDialog('Download this backup without password encryption? Anyone who gets the file can read its contents.', {
      title: 'Unencrypted backup', okText: 'Download unencrypted', danger: true
    });
    if (!approved) return;
  }

  const actionButtons = Array.from(document.querySelectorAll('#backupModal .backup-actions button'));
  actionButtons.forEach(button => { button.disabled = true; });
  try {
    const readiness = await ensureReferencedMediaReady({ retry: true });
    if (!readiness.ok) {
      warnIncompleteMedia(readiness, 'Full backup', { force: true });
      return;
    }
    const referencedImages = getReferencedFirearmImages();
    const fullCopy = Object.assign({}, db, { images: referencedImages });
    delete fullCopy.backups;
    await VaultDataSafety.createBackup(CloudSync.uid, db, 'manual-download', { mediaCount: readiness.keys.length });
    const envelope = await VaultDataSafety.exportEnvelope(CloudSync.uid, fullCopy, encrypted ? password : null);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    downloadBlobFile(JSON.stringify(envelope, null, 2), 'firearms-vault-' + timestamp + (encrypted ? '.fvbackup' : '.json'));
    document.getElementById('backupPassword').value = '';
    document.getElementById('backupPasswordConfirm').value = '';
    addAuditEntry('create', 'system', 'Full Recovery Backup', encrypted ? 'Downloaded encrypted recovery backup' : 'Downloaded unencrypted recovery backup');
    await saveToLocalStorage();
    toast(encrypted ? 'Encrypted recovery backup downloaded.' : 'Unencrypted recovery backup downloaded.', 'success');
    await openBackupModal();
  } catch (error) {
    toast('Backup failed: ' + error.message, 'error', 9000);
  } finally {
    actionButtons.forEach(button => { button.disabled = false; });
  }
}

async function restoreDownloadedBackup() {
  const input = document.getElementById('recoveryBackupFile');
  const file = input.files && input.files[0];
  if (!file) { toast('Choose a backup file first.', 'error'); return; }
  if (!window.VaultDataSafety || !window.CloudSync) { toast('The recovery system is unavailable.', 'error'); return; }
  try {
    let parsed = JSON.parse(await file.text());
    if (parsed && parsed.format === 'firearms-vault-backup') {
      parsed = (await VaultDataSafety.importEnvelope(parsed, document.getElementById('backupPassword').value)).data;
    } else if (window.VaultSecurity) {
      parsed = VaultSecurity.normalizeDatabase(parsed, { regenerateInvalidIds: true, allowUnknownTopLevel: true }).data;
    }
    const approved = await confirmDialog('This verified backup will replace the current collection. A recovery point will be kept first.', {
      title: 'Restore full backup', okText: 'Verify and restore', danger: true
    });
    if (!approved) return;

    await VaultDataSafety.createBackup(CloudSync.uid, db, 'before-file-restore', { mediaCount: Object.keys(getReferencedFirearmImages()).length });
    const normalizedFile = new File([JSON.stringify(parsed)], 'verified-backup.json', { type: 'application/json' });
    const result = await CloudSync.restoreFromFile(normalizedFile);
    input.value = '';
    document.getElementById('backupPassword').value = '';
    document.getElementById('backupPasswordConfirm').value = '';
    closeBackupModal();
    setSaveStatus(result.cloud && result.cloud.ok ? 'saved' : 'local', result.cloud && result.cloud.ok ? 'Backup restored and synced' : 'Backup restored on this device');
    toast(result.cloud && result.cloud.ok ? 'Backup restored and synced.' : 'Backup restored locally; cloud sync will retry.', 'success', 8000);
  } catch (error) {
    toast('Restore failed: ' + error.message, 'error', 10000);
  }
}
window.downloadRecoveryBackup = downloadRecoveryBackup;
window.restoreDownloadedBackup = restoreDownloadedBackup;

// Save all data to a JSON file on demand
async function saveToFile() {
  try {
    const readiness = await ensureReferencedMediaReady({ retry: true });
    if (!readiness.ok) {
      warnIncompleteMedia(readiness, 'File export', { force: true });
      return;
    }
    if (fileHandle) {
      await writeToDisk({ manual: true, readiness });
      return;
    }
    if ('showSaveFilePicker' in window) {
      fileHandle = await window.showSaveFilePicker({
        suggestedName: 'firearms_database.json',
          types: [{ description: 'JSON Database', accept: { 'application/json': ['.json'] } }]
      });
      const wrote = await writeToDisk({ manual: true, readiness });
      if (!wrote) return;
      hasUnsavedChanges = false;
      document.getElementById('statusDot').className = 'file-status-dot connected';
      document.getElementById('fileStatusText').textContent = 'Connected:';
      document.getElementById('fileStatusName').textContent = fileHandle.name;
    } else {
      const saveObj = Object.assign({}, db, { images: getReferencedFirearmImages() });
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
  let cloudLoad = null;
  if (window.CloudSync && CloudSync.uid) {
    try {
      cloudLoad = await CloudSync.pull();
    } catch (error) {
      console.warn('Cloud pull failed unexpectedly; using the safest available device copy.', error);
      const local = await CloudSync.loadCachedIntoMemory().catch(() => ({ ok: false }));
      const offline = navigator.onLine === false;
      const text = local.ok
        ? (offline ? 'Offline - safe on this device' : 'Cloud unavailable - safe on this device')
        : 'Changes not safe - no device copy is available';
      CloudSync.ready = true;
      CloudSync.setStatus(text, local.ok ? 'warning' : 'error', local.ok ? (offline ? 'offline' : 'local') : 'failed');
      cloudLoad = { ok: !!local.ok, status: local.ok ? 'device-copy' : 'unavailable', localSafe: !!local.ok, error };
      CloudSync.emit(local.ok ? 'local-safe' : 'failed', Object.assign({ operation: 'pull' }, cloudLoad));
    }
  }
  normalizeRichTextData();
  normalizeInternalIds();

  // Show all UI elements immediately - no file picker needed
  const usingDeviceCopy = cloudLoad && (cloudLoad.localSafe || cloudLoad.status === 'offline-local' || cloudLoad.status === 'device-copy');
  document.getElementById('statusDot').className = 'file-status-dot ' + (usingDeviceCopy ? 'local' : (cloudLoad && !cloudLoad.ok ? 'disconnected' : 'connected'));
  document.getElementById('fileStatusText').textContent = usingDeviceCopy
    ? 'Using safe device copy'
    : (cloudLoad && !cloudLoad.ok ? 'Cloud unavailable' : 'Cloud account connected');
  document.getElementById('fileStatusName').textContent = db.firearms.length + ' firearms loaded';

  document.getElementById('backupBtn').style.display = 'inline-block';
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
  setPrivacyMode(privacyMode);
  buildThumbnails(); // background: speed up card/table rendering
  hasUnsavedChanges = false; // reset after initial load
}
window.bootApp = bootApp;
