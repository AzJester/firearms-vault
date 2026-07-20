// =====================================================
// Auth gate — login screen, session restore, first-run import, sign out.
// Loaded last, after app.js (bootApp) and cloud-sync.js (CloudSync).
// =====================================================
(function () {
  const sb = window.sbClient;
  const overlay = document.getElementById('authOverlay');
  const appRoot = document.getElementById('appRoot');
  const form = document.getElementById('authForm');
  const emailEl = document.getElementById('authEmail');
  const pwEl = document.getElementById('authPassword');
  const errEl = document.getElementById('authError');
  const submitBtn = document.getElementById('authSubmit');
  const mfaForm = document.getElementById('mfaChallengeForm');
  const mfaCode = document.getElementById('mfaChallengeCode');
  const mfaSubmit = document.getElementById('mfaChallengeSubmit');
  const mfaErrEl = document.getElementById('mfaChallengeError');
  let booted = false;
  let activeUserId = null;
  let pendingMfa = null;
  let enrollmentFactorId = null;
  let ignoreNextSignedOut = false;
  let passwordRecoveryMode = false;

  function showError(msg) {
    errEl.textContent = msg || '';
    errEl.style.display = msg ? 'block' : 'none';
  }
  function showMfaError(msg) {
    if (!mfaErrEl) return;
    mfaErrEl.textContent = msg || '';
    mfaErrEl.style.display = msg ? 'block' : 'none';
  }

  // Turn a Supabase/network error into a readable sentence (never "{}").
  function prettyError(error) {
    if (!error) return 'Sign in failed. Please try again.';
    let m = (error.message || error.error_description || error.msg || '').trim();
    if (m === '{}' || m === '[object Object]') m = '';
    const status = error.status;
    const code = (error.code || error.error || '').toString();
    if (/invalid login credentials/i.test(m) || code === 'invalid_credentials')
      return 'Incorrect email or password.';
    if (/email not confirmed/i.test(m))
      return 'This email has not been confirmed yet.';
    if (/failed to fetch|networkerror|load failed|fetch/i.test(m))
      return "Can't reach the server — check your internet connection and try again.";
    if (m) return m;
    return 'Sign in failed' + (status ? ' (error ' + status + ')' : '') + '. Please try again.';
  }
  function busy(on) {
    submitBtn.disabled = on;
    submitBtn.textContent = on ? 'Signing in…' : 'Sign In';
  }

  async function beginMfaChallengeIfRequired(session) {
    if (!sb.auth.mfa) return false;
    const assurance = await sb.auth.mfa.getAuthenticatorAssuranceLevel();
    if (assurance.error) throw assurance.error;
    const level = assurance.data || {};
    if (level.nextLevel !== 'aal2' || level.currentLevel === 'aal2') return false;

    const factors = await sb.auth.mfa.listFactors();
    if (factors.error) throw factors.error;
    const factorData = factors.data || {};
    const available = factorData.all || [...(factorData.totp || []), ...(factorData.phone || [])];
    const factor = available.find(item => item.status === 'verified');
    if (!factor) throw new Error('A second factor is required, but no supported verified factor is available. Use account recovery or contact the administrator.');
    const challenge = await sb.auth.mfa.challenge({ factorId: factor.id });
    if (challenge.error) throw challenge.error;
    pendingMfa = { session, factorId: factor.id, challengeId: challenge.data.id };
    form.style.display = 'none';
    mfaForm.style.display = 'block';
    overlay.style.display = 'flex';
    appRoot.style.display = 'none';
    mfaCode.value = '';
    showMfaError('');
    busy(false);
    setTimeout(() => mfaCode.focus(), 0);
    return true;
  }

  if (mfaForm) {
    mfaForm.addEventListener('submit', async event => {
      event.preventDefault();
      if (!pendingMfa) return;
      const code = mfaCode.value.trim();
      if (!/^\d{6}$/.test(code)) { showError('Enter the six-digit authenticator code.'); return; }
      mfaSubmit.disabled = true;
      mfaSubmit.textContent = 'Verifying…';
      try {
        const verified = await sb.auth.mfa.verify({
          factorId: pendingMfa.factorId,
          challengeId: pendingMfa.challengeId,
          code
        });
        if (verified.error) throw verified.error;
        const sessionResult = await sb.auth.getSession();
        if (sessionResult.error || !sessionResult.data.session) throw sessionResult.error || new Error('The verified session is unavailable.');
        pendingMfa = null;
        mfaForm.style.display = 'none';
        form.style.display = 'block';
        showError('');
        showMfaError('');
        await startApp(sessionResult.data.session);
      } catch (error) {
        showMfaError(/invalid|expired/i.test(error.message || '') ? 'That code is invalid or expired. Try the current code.' : prettyError(error));
        try {
          const replacement = await sb.auth.mfa.challenge({ factorId: pendingMfa.factorId });
          if (!replacement.error) pendingMfa.challengeId = replacement.data.id;
        } catch (_) {}
      } finally {
        mfaSubmit.disabled = false;
        mfaSubmit.textContent = 'Verify and open vault';
      }
    });
  }

  const mfaCancel = document.getElementById('mfaCancelBtn');
  if (mfaCancel) mfaCancel.addEventListener('click', async () => {
    pendingMfa = null;
    ignoreNextSignedOut = true;
    await sb.auth.signOut({ scope: 'local' }).catch(() => {});
    mfaForm.style.display = 'none';
    form.style.display = 'block';
    showError('');
    showMfaError('');
    busy(false);
    emailEl.focus();
  });

  async function startApp(session) {
    if (!session || !session.user || !session.user.id) throw new Error('The signed-in session is missing its user id.');
    if (booted && activeUserId === session.user.id) {
      overlay.style.display = 'none';
      appRoot.style.display = '';
      busy(false);
      return;
    }
    const activation = await CloudSync.activateUser(session.user.id);
    if (!activation.ok) {
      overlay.style.display = 'flex';
      appRoot.style.display = 'none';
      throw new Error('This account could not be opened safely: ' + activation.error.message);
    }
    activeUserId = session.user.id;
    overlay.style.display = 'none';
    appRoot.style.display = '';
    busy(false);
    document.getElementById('authedEmail').textContent = session.user.email || '';
    const se = document.getElementById('settingsEmail'); if (se) se.textContent = session.user.email || '';
    if (!booted) {
      booted = true;
      await window.bootApp();          // loads local cache + pulls from cloud + renders
      maybeOfferImport();
    }
  }

  // If there is no cloud data yet AND nothing locally, offer a one-time import.
  function maybeOfferImport() {
    const empty = (db.firearms.length + db.ammo.length + db.accessories.length) === 0;
    if (!CloudSync.hasCloudData && empty) {
      document.getElementById('firstRunPanel').style.display = 'flex';
    }
  }

  // ---- login form ----
  if (form) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      showError('');
      busy(true);
      try {
        const { data, error } = await sb.auth.signInWithPassword({
          email: emailEl.value.trim(),
          password: pwEl.value
        });
        if (error) { showError(prettyError(error)); busy(false); return; }
        if (!await beginMfaChallengeIfRequired(data.session)) await startApp(data.session);
      } catch (err) {
        showError(prettyError(err));
        busy(false);
      }
    });
  }

  // ---- first-run import wiring ----
  const importInput = document.getElementById('firstRunFile');
  if (importInput) {
    importInput.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const status = document.getElementById('firstRunStatus');
      status.textContent = 'Reading file…';
      try {
        const res = await CloudSync.restoreFromFile(file);
        status.textContent = '';
        document.getElementById('firstRunPanel').style.display = 'none';
        const suffix = res.cloud && res.cloud.ok
          ? 'The restored copy is saved in the cloud.'
          : 'The restored copy is safe on this device and will retry cloud sync.';
        toast('Imported ' + res.firearms + ' firearms, ' + res.ammo + ' ammo, ' +
              res.accessories + ' accessories, ' + res.images + ' photos.\n' + suffix, 'success');
      } catch (err) {
        status.textContent = 'Import failed: ' + err.message;
      }
      e.target.value = '';
    });
  }
  const skipBtn = document.getElementById('firstRunSkip');
  if (skipBtn) skipBtn.addEventListener('click', () => {
    document.getElementById('firstRunPanel').style.display = 'none';
  });

  // ---- "Restore from File" toolbar button (full replace, works any time) ----
  const restoreInput = document.getElementById('restoreFile');
  if (restoreInput) {
    restoreInput.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      e.target.value = '';
      if (!file) return;
      const okRestore = (typeof confirmDialog === 'function')
        ? await confirmDialog('Replace your ENTIRE current collection with the contents of "' + file.name + '"? This overwrites what is in the cloud now. (Tip: use "Save to File" first if you want a safety copy.)', { title: 'Restore from file', okText: 'Replace everything', danger: true })
        : confirm('Replace your ENTIRE current collection with the contents of "' + file.name + '"?');
      if (!okRestore) return;
      try {
        if (window.toast) toast('Restoring from backup and verifying cloud storage…', 'info', 6000);
        const res = await CloudSync.restoreFromFile(file);
        const suffix = res.cloud && res.cloud.ok
          ? 'The restored copy is saved in the cloud.'
          : 'The restored copy is safe on this device and will retry cloud sync.';
        const msg = 'Restored ' + res.firearms + ' firearms, ' + res.ammo + ' ammo, ' +
                    res.accessories + ' accessories, ' + res.images + ' photos.\n' + suffix;
        toast(msg, 'success', 6000);
      } catch (err) {
        if (window.toast) toast('Restore failed: ' + err.message, 'error', 8000);
        else toast('Restore failed: ' + err.message);
      }
    });
  }

  // ---- forgot password (login screen) ----
  const forgotBtn = document.getElementById('forgotBtn');
  if (forgotBtn) forgotBtn.addEventListener('click', async () => {
    const email = (emailEl.value || '').trim();
    if (!email) { showError('Enter your email above first, then tap "Forgot password?".'); return; }
    try {
      const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.href });
      if (error) { showError(prettyError(error)); return; }
      showError('');
      if (window.toast) toast('If an account exists for ' + email + ', a password-reset email has been sent. Check spam too.', 'success', 7000);
    } catch (e) { showError(prettyError(e)); }
  });

  // ---- change password (Settings → Cloud Account) ----
  window.changeCloudPassword = async function () {
    const current = document.getElementById('acctCurrentPassword');
    const pw = document.getElementById('acctNewPassword');
    const cf = document.getElementById('acctConfirmPassword');
    const oldPassword = (current && current.value) || '';
    const a = (pw && pw.value) || '', b = (cf && cf.value) || '';
    if (!passwordRecoveryMode && !oldPassword) { toast('Enter your current password first.', 'error'); return; }
    if (a.length < 12) { toast('Password must be at least 12 characters.', 'error'); return; }
    if (a !== b) { toast('Passwords do not match.', 'error'); return; }
    try {
      const attributes = { password: a };
      if (oldPassword) attributes.current_password = oldPassword;
      const { error } = await sb.auth.updateUser(attributes);
      if (error) { toast('Could not change password: ' + (error.message || 'error'), 'error'); return; }
      if (current) current.value = '';
      pw.value = ''; cf.value = '';
      passwordRecoveryMode = false;
      toast('Password changed. Use it next time you sign in.', 'success');
    } catch (e) { toast('Could not change password: ' + (e.message || e), 'error'); }
  };

  function clearMfaEnrollmentUI() {
    enrollmentFactorId = null;
    const panel = document.getElementById('mfaEnrollmentPanel');
    const image = document.getElementById('mfaQrImage');
    const secret = document.getElementById('mfaSecret');
    const code = document.getElementById('mfaEnrollCode');
    if (panel) panel.style.display = 'none';
    if (image) image.removeAttribute('src');
    if (secret) secret.textContent = '';
    if (code) code.value = '';
  }

  window.refreshMfaSettings = async function () {
    const status = document.getElementById('mfaStatus');
    const enroll = document.getElementById('mfaEnrollBtn');
    const list = document.getElementById('mfaFactorList');
    if (!status || !enroll || !list || !sb.auth.mfa) return;
    enroll.disabled = true;
    list.replaceChildren();
    try {
      const result = await sb.auth.mfa.listFactors();
      if (result.error) throw result.error;
      const data = result.data || {};
      const factors = data.all || [...(data.totp || []), ...(data.phone || [])];
      const verified = factors.filter(item => item.status === 'verified');
      status.textContent = verified.length
        ? `${verified.length} verified second factor${verified.length === 1 ? ' is' : 's are'} protecting this account.`
        : 'Add an authenticator to require a six-digit code when signing in.';
      factors.forEach((factor, index) => {
        const row = document.createElement('div'); row.className = 'mfa-factor-row';
        const description = document.createElement('span');
        const type = factor.factor_type === 'phone' ? 'Phone' : 'Authenticator';
        description.textContent = `${factor.friendly_name || type + ' ' + (index + 1)} · ${factor.status || 'unknown'}`;
        const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'btn btn-small btn-danger';
        remove.textContent = factor.status === 'verified' ? 'Remove' : 'Discard setup';
        remove.addEventListener('click', () => window.removeMfaFactor(factor.id, factor.status));
        row.append(description, remove); list.appendChild(row);
      });
      enroll.disabled = Boolean(enrollmentFactorId);
    } catch (error) {
      status.textContent = 'Authenticator status could not be loaded. Refresh before changing this setting.';
      enroll.disabled = true;
    }
  };

  window.beginMfaEnrollment = async function () {
    const enroll = document.getElementById('mfaEnrollBtn');
    if (enrollmentFactorId || !sb.auth.mfa) return;
    if (enroll) enroll.disabled = true;
    try {
      // An unfinished TOTP enrollment cannot be resumed because its secret is
      // intentionally not returned again. Remove stale drafts before starting.
      const listed = await sb.auth.mfa.listFactors();
      if (listed.error) throw listed.error;
      const data = listed.data || {};
      const factors = data.all || [...(data.totp || []), ...(data.phone || [])];
      for (const factor of factors.filter(item => item.status !== 'verified' && item.factor_type !== 'phone')) {
        const removed = await sb.auth.mfa.unenroll({ factorId: factor.id });
        if (removed.error) throw removed.error;
      }
      const result = await sb.auth.mfa.enroll({ factorType: 'totp', friendlyName: 'Firearms Vault' });
      if (result.error) throw result.error;
      const qrCode = String(result.data && result.data.totp && result.data.totp.qr_code || '');
      if (!qrCode.startsWith('data:image/svg+xml')) throw new Error('The enrollment QR code was not returned safely.');
      enrollmentFactorId = result.data.id;
      document.getElementById('mfaQrImage').src = qrCode;
      document.getElementById('mfaSecret').textContent = result.data.totp.secret;
      document.getElementById('mfaEnrollmentPanel').style.display = 'block';
      document.getElementById('mfaEnrollCode').value = '';
      document.getElementById('mfaEnrollCode').focus();
    } catch (error) {
      clearMfaEnrollmentUI();
      if (enroll) enroll.disabled = false;
      toast('Authenticator setup failed: ' + prettyError(error), 'error', 9000);
    }
  };

  window.cancelMfaEnrollment = async function (options) {
    const opts = options || {};
    const factorId = enrollmentFactorId;
    clearMfaEnrollmentUI();
    if (factorId) {
      const result = await sb.auth.mfa.unenroll({ factorId });
      if (result.error && !opts.silent) toast('The unfinished setup could not be discarded: ' + prettyError(result.error), 'error');
    }
    await window.refreshMfaSettings();
  };

  window.verifyMfaEnrollment = async function () {
    const code = document.getElementById('mfaEnrollCode').value.trim();
    if (!enrollmentFactorId || !/^\d{6}$/.test(code)) { toast('Enter the six-digit code from your authenticator.', 'error'); return; }
    const factorId = enrollmentFactorId;
    try {
      const challenge = await sb.auth.mfa.challenge({ factorId });
      if (challenge.error) throw challenge.error;
      const verified = await sb.auth.mfa.verify({ factorId, challengeId: challenge.data.id, code });
      if (verified.error) throw verified.error;
      clearMfaEnrollmentUI();
      toast('Two-step verification is enabled. Other sessions may need to sign in again.', 'success', 8000);
      await window.refreshMfaSettings();
    } catch (error) {
      toast('Authenticator verification failed: ' + prettyError(error), 'error', 9000);
    }
  };

  window.removeMfaFactor = async function (factorId, status) {
    if (!factorId) return;
    const approved = status !== 'verified' || ((typeof confirmDialog === 'function')
      ? await confirmDialog('Remove this second factor from the account?', { title: 'Remove authenticator', okText: 'Remove', danger: true })
      : confirm('Remove this second factor?'));
    if (!approved) return;
    const result = await sb.auth.mfa.unenroll({ factorId });
    if (result.error) { toast('Could not remove authenticator: ' + prettyError(result.error), 'error'); return; }
    await sb.auth.refreshSession().catch(() => {});
    toast(status === 'verified' ? 'Second factor removed.' : 'Unfinished setup discarded.', 'success');
    await window.refreshMfaSettings();
  };

  // ---- sign out (exposed for the toolbar button) ----
  window.Auth = {
    async signOut() {
      const okSignOut = (typeof confirmDialog === 'function')
        ? await confirmDialog('Sign out of this device? Pending changes will be secured locally or in the cloud first.', { title: 'Sign out', okText: 'Sign out' })
        : confirm('Sign out of this device? Pending changes will be secured locally or in the cloud first.');
      if (!okSignOut) return { ok: false, status: 'cancelled' };

      const safety = await CloudSync.prepareForSignOut();
      if (!safety.ok) {
        const message = 'Sign out was stopped because your latest changes could not be saved on this device or in the cloud. Keep this page open and retry.';
        if (window.toast) toast(message, 'error', 9000);
        else showError(message);
        return { ok: false, status: 'unsafe', safety };
      }

      const runtimeSafe = await CloudSync.clearRuntimeCaches();
      if (!runtimeSafe.ok) {
        const message = 'Sign out was stopped because this browser could not clear its compatibility cache safely. Close other vault tabs and retry.';
        if (window.toast) toast(message, 'error', 9000);
        return { ok: false, status: 'runtime-cleanup-failed', failures: runtimeSafe.failures };
      }

      ignoreNextSignedOut = true;
      const { error } = await sb.auth.signOut({ scope: 'local' });
      if (error) {
        ignoreNextSignedOut = false;
        const message = 'Could not sign out: ' + prettyError(error);
        if (window.toast) toast(message, 'error', 8000);
        else showError(message);
        return { ok: false, status: 'auth-error', error };
      }
      const cleared = await CloudSync.deactivateUser({ clearRuntime: false });
      if (!cleared.ok) console.warn('Signed out, but a compatibility cache could not be cleared.', cleared.failures);
      location.reload();
      return { ok: true, status: safety.cloudSafe ? 'cloud-safe' : 'local-safe' };
    },

    // Regular sign-out keeps the user-scoped outbox for safety. This explicit
    // operation removes it only after the cloud has confirmed the latest copy.
    async forgetThisDevice() {
      const safety = await CloudSync.prepareForSignOut();
      if (!safety.cloudSafe) return { ok: false, status: 'cloud-save-required', safety };
      const uid = activeUserId;
      const failures = [];
      if (uid) {
        const attempt = async (label, operation) => {
          try { await operation(); } catch (error) { failures.push({ label, error }); }
        };
        await attempt('pending sync data', () => CloudSync.storeDelete('outbox', uid));
        await attempt('cached collection', () => CloudSync.storeDelete('cache', uid));
        let media = [];
        await attempt('media index', async () => { media = await CloudSync.getUserMedia(uid); });
        for (const item of media) await attempt('cached media', () => CloudSync.storeDelete('media', item.id));
        if (window.VaultDataSafety) await attempt('recovery records', () => window.VaultDataSafety.clearState(uid));

        await attempt('cleanup verification', async () => {
          const [outbox, cache, remainingMedia] = await Promise.all([
            CloudSync.storeGet('outbox', uid), CloudSync.storeGet('cache', uid), CloudSync.getUserMedia(uid)
          ]);
          const safetyState = window.VaultDataSafety ? await window.VaultDataSafety.getState(uid) : null;
          const safetyOutbox = window.VaultDataSafety ? await window.VaultDataSafety.listOutbox(uid) : [];
          const backups = window.VaultDataSafety ? await window.VaultDataSafety.listBackups(uid) : [];
          if (outbox || cache || remainingMedia.length || safetyState || safetyOutbox.length || backups.length) {
            throw new Error('User-scoped records remain after deletion.');
          }
        });
      }
      if (failures.length) return { ok: false, status: 'local-cleanup-incomplete', failures };

      const runtimeSafe = await CloudSync.clearRuntimeCaches();
      if (!runtimeSafe.ok) return { ok: false, status: 'runtime-cleanup-incomplete', failures: runtimeSafe.failures };

      ignoreNextSignedOut = true;
      const { error } = await sb.auth.signOut({ scope: 'local' });
      if (error) { ignoreNextSignedOut = false; return { ok: false, status: 'auth-error', error }; }
      const deactivated = await CloudSync.deactivateUser({ clearRuntime: false });
      if (!deactivated.ok) {
        appRoot.style.display = 'none';
        overlay.style.display = 'flex';
        return { ok: false, status: 'runtime-cleanup-incomplete', failures: deactivated.failures };
      }
      location.reload();
      return { ok: true, status: 'forgotten' };
    }
  };

  window.forgetThisDevice = async function () {
    const approved = (typeof confirmDialog === 'function')
      ? await confirmDialog('Remove this account\'s collection, media cache, and pending changes from this browser after confirming the latest cloud save?', {
          title: 'Forget this device', okText: 'Save, sign out, and forget', danger: true
        })
      : confirm('Save, sign out, and remove this account from this browser?');
    if (!approved) return;
    const result = await window.Auth.forgetThisDevice();
    if (!result.ok) {
      const message = result.status === 'cloud-save-required'
        ? 'This device was not cleared because the latest copy has not reached the cloud yet. Reconnect and retry.'
        : result.status === 'local-cleanup-incomplete' || result.status === 'runtime-cleanup-incomplete'
          ? 'Local cleanup was incomplete, so the app did not claim this device was forgotten. Sign in again if needed, close other vault tabs, and retry.'
          : 'This device could not be cleared safely.';
      if (window.toast) toast(message, 'error', 9000);
    }
  };

  if (sb.auth.onAuthStateChange) {
    sb.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_OUT') {
        if (ignoreNextSignedOut) { ignoreNextSignedOut = false; return; }
        appRoot.style.display = 'none';
        overlay.style.display = 'flex';
        pendingMfa = null;
        clearMfaEnrollmentUI();
        setTimeout(async () => {
          await CloudSync.deactivateUser({ clearRuntime: true }).catch(() => {});
          location.reload();
        }, 0);
      } else if (event === 'PASSWORD_RECOVERY' && session) {
        passwordRecoveryMode = true;
        setTimeout(async () => {
          try {
            await startApp(session);
            if (typeof openSettingsModal === 'function') openSettingsModal();
            const current = document.getElementById('acctCurrentPassword');
            if (current) current.placeholder = 'Not required for this recovery session';
            toast('Choose a new password to finish account recovery.', 'info', 9000);
          } catch (error) { showError(prettyError(error)); }
        }, 0);
      }
    });
  }

  // ---- on load: resume an existing session if present ----
  (async function () {
    try {
      const { data: { session } } = await sb.auth.getSession();
      if (session) {
        if (!await beginMfaChallengeIfRequired(session)) await startApp(session);
      }
      else { overlay.style.display = 'flex'; }
    } catch (e) {
      showError(prettyError(e));
      overlay.style.display = 'flex';
    }
  })();
})();
