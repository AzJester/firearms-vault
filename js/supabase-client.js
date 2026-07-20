// =====================================================
// Supabase client bootstrap
// Requires the supabase-js UMD bundle (loaded in index.html) and config.js.
// =====================================================
(function () {
  if (!window.supabase || !window.supabase.createClient) {
    console.error('supabase-js failed to load from the CDN.');
    return;
  }
  window.sbClient = window.supabase.createClient(
    window.SUPABASE_URL,
    window.SUPABASE_ANON_KEY,
    {
      auth: {
        persistSession: true,       // stay logged in on this device
        autoRefreshToken: true,
        detectSessionInUrl: true,
        storageKey: 'firearms-db-auth'
      }
    }
  );
})();
