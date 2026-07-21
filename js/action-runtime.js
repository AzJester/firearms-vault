// CSP-safe compatibility bridge for legacy declarative event attributes.
// It removes inline handler attributes and binds equivalent listeners without
// eval/new Function. Only explicitly approved application actions can run.
(function initVaultActions(global) {
  'use strict';

  const EVENTS = ['click', 'change', 'input', 'keydown', 'mousedown', 'mouseenter'];
  const ALLOWED = new Set([
    'addCustomField', 'applyCrop', 'applyDataQualityCleanup', 'beginMfaEnrollment',
    'applyDealerFilter', 'bulkAddTag', 'bulkRemoveTag', 'cancelMfaEnrollment', 'captureSnapshot', 'changeCloudPassword',
    'checkDuplicateSerial', 'cleanUnusedMedia', 'clearAllFilters', 'clearAuditTrail', 'clearBulkSelection',
    'clearOneFilter', 'closeAccessoryModal', 'closeAmmoModal', 'closeBackupModal',
    'closeCameraModal', 'closeCmdK', 'closeCropModal', 'closeDealerImportModal',
    'closeDealerModal', 'closeDetail', 'closeLightbox', 'closeMaintenanceModal',
    'closeModal', 'closePasswordModal', 'closeQRModal', 'closeReminders',
    'closeReportBuilder', 'closeSettingsModal', 'closeShareModal', 'closeShortcutsModal', 'closeSyncCenter',
    'closeWishlistModal', 'cmdkExec', 'cmdkHover', 'cmdkRender', 'copyShareLink', 'createShare',
    'ctxAdd', 'cycleWishlistPriority', 'deleteAccessory', 'deleteAmmo', 'deleteDealer',
    'deleteWishlistItem', 'downloadDocument', 'downloadQR', 'downloadRecoveryBackup', 'editAmmo',
    'exportATFBoundBook', 'exportExcel', 'exportJSON', 'flipImage', 'forgetThisDevice',
    'generateCustomReport', 'handleCSVImport', 'handleDocUpload', 'handleImageUpload',
    'handleImport', 'handlePasswordSubmit', 'handleReceiptUpload', 'handleStampUpload',
    'handleTagKey', 'importCSV', 'importDealersFromText', 'importJSON', 'loadAZDealers',
    'moveWishlistToCollection', 'openAccessoryModal', 'openAddAmmoModal', 'openAddModal',
    'openBackupFromSyncCenter', 'openBackupModal', 'openCameraModal', 'openCmdK', 'openCropModal',
    'openDealerImportModal', 'openDealerModal', 'openDetail', 'openMaintenanceModal',
    'openReminders', 'openReportBuilder', 'openSettingsModal', 'openShareModal', 'openSyncCenter',
    'openWishlistModal', 'pickDispDealer', 'printInventory', 'printQR',
    'quickAmmoAdjust', 'reminderGo', 'removeCustomField', 'removeDoc', 'removeEncryption', 'requestPersistentStorage',
    'removeImage', 'removeMfaFactor', 'removeReceipt', 'removeStampPdf', 'removeTag',
    'render', 'renderImageGallery', 'resolveSyncChanges', 'restoreDownloadedBackup', 'retrySyncFromCenter', 'revokeShare', 'rotateImage', 'rteCmd', 'rteLink',
    'runDataQualityCheck', 'runDataSafetyCheck', 'saveAccessory', 'saveAmmo', 'saveDealer',
    'saveFirearm', 'saveMaintenanceEntry', 'saveToFile', 'saveWishlistItem',
    'searchScannedSerial', 'selectBackup', 'selectTagSuggestion', 'setDashRange',
    'setDealerArea', 'setDealerSort', 'setEncryption', 'setPrivacyMode', 'setView', 'setWishlistFilter',
    'showShortcutsHelp', 'showTagSuggestions', 'sortTable', 'toggleBulkSelect',
    'toggleDashboardAnalytics', 'toggleDealerFavorite', 'toggleFilters', 'toggleNFAFields', 'togglePrivacyMode',
    'toggleTheme', 'undoDelete', 'verifyMfaEnrollment', 'viewDocumentInBrowser',
    'viewReceiptInBrowser', 'viewStampPdf', 'window.print', 'Auth.signOut', 'CloudSync.syncNow'
  ]);

  function splitTopLevel(source, delimiter) {
    const pieces = [];
    let start = 0, quote = '', escaped = false, depth = 0;
    for (let index = 0; index < source.length; index++) {
      const char = source[index];
      if (escaped) { escaped = false; continue; }
      if (char === '\\') { escaped = true; continue; }
      if (quote) { if (char === quote) quote = ''; continue; }
      if (char === '"' || char === "'") { quote = char; continue; }
      if ('({['.includes(char)) depth++;
      else if (')}]'.includes(char)) depth = Math.max(0, depth - 1);
      else if (char === delimiter && depth === 0) { pieces.push(source.slice(start, index)); start = index + 1; }
    }
    pieces.push(source.slice(start));
    return pieces.map(piece => piece.trim()).filter(Boolean);
  }

  function parseValue(token, event, element) {
    const value = token.trim();
    if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))) {
      return value.slice(1, -1).replace(/\\(['"\\])/g, '$1');
    }
    if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
    if (value === 'true') return true;
    if (value === 'false') return false;
    if (value === 'null') return null;
    if (value === 'event') return event;
    if (value === 'this.checked') return Boolean(element.checked);
    if (value === 'this.value') return element.value;
    const datasetValue = /^this\.dataset\.([A-Za-z_$][\w$]*)$/.exec(value);
    if (datasetValue) return String(element.dataset[datasetValue[1]] || '');
    throw new Error('Unsupported action value: ' + value);
  }

  function resolveAction(name) {
    if (!ALLOWED.has(name)) return null;
    return name.split('.').reduce((value, part) => value && value[part], global);
  }

  function invoke(name, argumentSource, event, element, validateOnly) {
    const action = resolveAction(name);
    if (typeof action !== 'function') throw new Error('Action is unavailable: ' + name);
    const args = argumentSource.trim() ? splitTopLevel(argumentSource, ',').map(value => parseValue(value, event, element)) : [];
    if (validateOnly) return;
    const context = name.includes('.') ? name.split('.').slice(0, -1).reduce((value, part) => value && value[part], global) : global;
    const result = action.apply(context, args);
    if (result && typeof result.catch === 'function') result.catch(error => {
      console.error('Action failed:', name, error);
      if (global.toast) global.toast('Action failed: ' + (error.message || error), 'error');
    });
  }

  function executeStatement(statement, event, element, validateOnly, actionNames) {
    const code = statement.trim().replace(/;$/, '');
    if (!code) return;
    const conditional = /^if\s*\(\s*event\.target\s*===\s*this\s*\)\s*([\s\S]+)$/.exec(code);
    if (conditional) {
      if (validateOnly) executeStatement(conditional[1], event, element, true, actionNames);
      else if (event.target === element) executeCode(conditional[1], event, element);
      return;
    }
    if (code === 'event.stopPropagation()') { if (!validateOnly) event.stopPropagation(); return; }
    if (code === 'event.preventDefault()') { if (!validateOnly) event.preventDefault(); return; }
    const documentAction = /^document\.getElementById\((['"])([^'"]+)\1\)\.(click|focus)\(\)$/.exec(code);
    if (documentAction) { if (!validateOnly) { const target = document.getElementById(documentAction[2]); if (target) target[documentAction[3]](); } return; }
    const gallerySet = /^currentImageIndex\s*=\s*(\d+)$/.exec(code);
    if (gallerySet) { if (typeof global.setVaultGalleryIndex !== 'function') throw new Error('Gallery action is unavailable.'); if (!validateOnly) global.setVaultGalleryIndex(Number(gallerySet[1])); return; }
    if (code === 'currentImageIndex++' || code === 'currentImageIndex--') {
      if (typeof global.adjustVaultGalleryIndex !== 'function') throw new Error('Gallery action is unavailable.');
      if (!validateOnly) global.adjustVaultGalleryIndex(code.endsWith('++') ? 1 : -1);
      return;
    }
    const customField = /^tempCustomFields\[(\d+)\]\.(name|value)\s*=\s*this\.value$/.exec(code);
    if (customField) { if (typeof global.updateCustomFieldValue !== 'function') throw new Error('Custom-field action is unavailable.'); if (!validateOnly) global.updateCustomFieldValue(Number(customField[1]), customField[2], element.value); return; }
    const delayedSelect = /^setTimeout\(function\(\)\{var s=document\.getElementById\((['"])([^'"]+)\1\);\s*if\(s\)\s*s\.value=(['"])([^'"]*)\3;?\},\s*(\d+)\)$/.exec(code);
    if (delayedSelect) {
      if (!validateOnly) setTimeout(() => { const target = document.getElementById(delayedSelect[2]); if (target) target.value = delayedSelect[4]; }, Number(delayedSelect[5]));
      return;
    }
    const call = /^([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?)\(([\s\S]*)\)$/.exec(code);
    if (call) { invoke(call[1], call[2], event, element, validateOnly); if (validateOnly) actionNames.push(call[1]); return; }
    throw new Error('Unsupported declarative action: ' + code);
  }

  function executeCode(code, event, element) {
    try {
      const statements = splitTopLevel(code, ';');
      const actions = [];
      // Validate the complete sequence before invoking anything. This prevents
      // a malformed trailing statement from leaving earlier side effects.
      statements.forEach(statement => executeStatement(statement, event, element, true, actions));
      const signature = actions.join('>');
      const approvedSequences = new Set(['closeDetail>openAccessoryModal', 'openMaintenanceModal>closeDetail']);
      if (actions.length > 1 && !approvedSequences.has(signature)) {
        throw new Error('Multiple application actions are not allowed in this control.');
      }
      statements.forEach(statement => executeStatement(statement, event, element, false, []));
    }
    catch (error) {
      console.error(error);
      if (global.toast) global.toast('A control could not run safely. Refresh and try again.', 'error');
    }
  }

  function bind(element) {
    if (!element || element.nodeType !== 1) return;
    Array.from(element.attributes || []).forEach(attribute => {
      if (!attribute.name.startsWith('on')) return;
      const eventName = attribute.name.slice(2).toLowerCase();
      const code = attribute.value;
      element.removeAttribute(attribute.name);
      if (!EVENTS.includes(eventName)) return;
      element.setAttribute('data-vault-' + eventName, '');
      element.addEventListener(eventName, event => executeCode(code, event, element));
    });
  }

  function scan(root) {
    bind(root);
    if (root && root.querySelectorAll) root.querySelectorAll('*').forEach(bind);
  }

  scan(document.documentElement);
  new MutationObserver(records => records.forEach(record => record.addedNodes.forEach(scan)))
    .observe(document.documentElement, { childList: true, subtree: true });
  global.VaultActions = Object.freeze({ scan });
})(window);
