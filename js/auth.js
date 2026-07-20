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
  let booted = false;

  function showError(msg) {
    errEl.textContent = msg || '';
    errEl.style.display = msg ? 'block' : 'none';
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

  async function startApp(session) {
    CloudSync.uid = session.user.id;
    overlay.style.display = 'none';
    appRoot.style.display = '';
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
        await startApp(data.session);
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
        toast('Imported ' + res.firearms + ' firearms, ' + res.ammo + ' ammo, ' +
              res.accessories + ' accessories, ' + res.images + ' photos.\n' +
              'Photos are uploading to the cloud in the background.', 'success');
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
        if (window.toast) toast('Restoring from backup… uploading photos in the background.', 'info', 6000);
        const res = await CloudSync.restoreFromFile(file);
        const msg = 'Restored ' + res.firearms + ' firearms, ' + res.ammo + ' ammo, ' +
                    res.accessories + ' accessories, ' + res.images + ' photos.\n' +
                    'Photos are uploading to the cloud — watch the status pill.';
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
    const pw = document.getElementById('acctNewPassword');
    const cf = document.getElementById('acctConfirmPassword');
    const a = (pw && pw.value) || '', b = (cf && cf.value) || '';
    if (a.length < 6) { toast('Password must be at least 6 characters.', 'error'); return; }
    if (a !== b) { toast('Passwords do not match.', 'error'); return; }
    try {
      const { error } = await sb.auth.updateUser({ password: a });
      if (error) { toast('Could not change password: ' + (error.message || 'error'), 'error'); return; }
      pw.value = ''; cf.value = '';
      toast('Password changed. Use it next time you sign in.', 'success');
    } catch (e) { toast('Could not change password: ' + (e.message || e), 'error'); }
  };

  // ---- sign out (exposed for the toolbar button) ----
  window.Auth = {
    async signOut() {
      const okSignOut = (typeof confirmDialog === 'function')
        ? await confirmDialog('Sign out of this device? Your data stays safe in the cloud.', { title: 'Sign out', okText: 'Sign out' })
        : confirm('Sign out of this device? Your data stays safe in the cloud.');
      if (!okSignOut) return;
      try { if (CloudSync.ready) await CloudSync.syncNow(); } catch (_) {}
      await sb.auth.signOut();
      location.reload();
    }
  };

  // ---- on load: resume an existing session if present ----
  (async function () {
    try {
      const { data: { session } } = await sb.auth.getSession();
      if (session) { await startApp(session); }
      else { overlay.style.display = 'flex'; }
    } catch (e) {
      overlay.style.display = 'flex';
    }
  })();
})();
