import { test, expect } from '@playwright/test';
import fs from 'node:fs';

const validToken = '123e4567-e89b-42d3-a456-426614174000';

test('strict CSP loads with no inline scripts or residual event attributes', async ({ page }) => {
  const response = await page.request.get('/index.html');
  const source = await response.text();
  const csp = source.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/i)?.[1] || '';
  const scriptDirective = csp.match(/(?:^|;)\s*script-src\s+([^;]+)/i)?.[1] || '';
  expect(scriptDirective).toContain("'self'");
  expect(scriptDirective).not.toContain("'unsafe-inline'");
  expect(scriptDirective).not.toContain('blob:');
  expect(source.match(/<script(?![^>]*\bsrc=)[^>]*>/gi) || []).toHaveLength(0);

  await page.addInitScript(() => {
    window.__cspViolations = [];
    document.addEventListener('securitypolicyviolation', event => {
      window.__cspViolations.push({ directive: event.effectiveDirective, blocked: event.blockedURI });
    });
  });
  await page.goto('/index.html');
  await expect(page.locator('#authForm')).toBeVisible();
  const result = await page.evaluate(() => ({
    eventAttributes: Array.from(document.querySelectorAll('*')).flatMap(element =>
      Array.from(element.attributes).filter(attribute => /^on/i.test(attribute.name)).map(attribute => attribute.name)
    ),
    violations: window.__cspViolations
  }));
  expect(result.eventAttributes).toEqual([]);
  expect(result.violations).toEqual([]);
});

test('declarative action bridge validates an entire sequence before side effects', async ({ page }) => {
  await page.goto('/index.html');
  await page.evaluate(() => {
    window.__actionCalls = [];
    window.toggleTheme = () => window.__actionCalls.push('theme');
    window.clearAuditTrail = () => window.__actionCalls.push('clear');
    const injected = document.createElement('button');
    injected.id = 'injectedAction';
    injected.setAttribute('onclick', "toggleTheme();clearAuditTrail();unsupportedTrailingCode");
    injected.textContent = 'Injected';
    document.body.appendChild(injected);
  });
  await expect.poll(() => page.locator('#injectedAction').getAttribute('onclick')).toBeNull();
  await page.evaluate(() => document.getElementById('injectedAction').click());
  expect(await page.evaluate(() => window.__actionCalls)).toEqual([]);

  await page.evaluate(() => {
    const safe = document.createElement('button');
    safe.id = 'safeAction'; safe.setAttribute('onclick', 'toggleTheme()'); safe.textContent = 'Safe';
    document.body.appendChild(safe);
  });
  await expect.poll(() => page.locator('#safeAction').getAttribute('onclick')).toBeNull();
  await page.evaluate(() => document.getElementById('safeAction').click());
  expect(await page.evaluate(() => window.__actionCalls)).toEqual(['theme']);
});

test('attachment previews convert allowlisted media to blob URLs and reject active content', async ({ page }) => {
  await page.goto('/index.html');
  const result = await page.evaluate(() => {
    let rejected = false;
    try { window.attachmentObjectURL('data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg=='); }
    catch (_) { rejected = true; }
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
    const objectURL = window.attachmentObjectURL(png);
    const isBlob = objectURL.startsWith('blob:');
    URL.revokeObjectURL(objectURL);
    return { rejected, isBlob };
  });
  expect(result).toEqual({ rejected: true, isBlob: true });
});

test('public share viewer renders malicious snapshots as inert text', async ({ page }) => {
  const snapshot = {
    label: '<img id="labelPwn" src=x onerror="window.__pwned=1">',
    generatedAt: new Date().toISOString(),
    totals: { firearms: '<img id="totalPwn">', value: '10', accessories: '<svg id="accessoryPwn">', rounds: '4' },
    includeSerials: true,
    firearms: [{
      make: '<img id="makePwn">', model: '" onerror="window.__pwned=2', serial: 'SAFE',
      photo: 'data:image/png;base64,AAAA" onerror="window.__pwned=3', price: 10
    }],
    accessories: [{ name: '<img id="rowPwn">', category: 'Safe' }]
  };
  await page.route('**/vendor/supabase.js', route => route.fulfill({
    contentType: 'application/javascript',
    body: `window.supabase={createClient:function(){return {rpc:async function(){return {data:${JSON.stringify(snapshot)},error:null}}}}};`
  }));
  await page.goto('/share.html#t=' + validToken);
  await expect(page.locator('.sv-card')).toBeVisible();
  expect(await page.locator('#labelPwn,#totalPwn,#accessoryPwn,#makePwn,#rowPwn').count()).toBe(0);
  expect(await page.locator('.sv-card img').count()).toBe(0);
  expect(await page.evaluate(() => window.__pwned)).toBeUndefined();
  await expect(page.locator('.sv-title')).toContainText('<img id="makePwn">');
});

test('MFA failures are visible and cancel signs out only this session', async ({ page }) => {
  await page.route('**/vendor/supabase.js', route => route.fulfill({
    contentType: 'application/javascript',
    body: `
      window.__signOutScopes=[];
      window.supabase={createClient:function(){
        var listener=null;
        var factor={id:'factor-1',status:'verified',factor_type:'totp',friendly_name:'Authenticator'};
        return {auth:{
          signInWithPassword:async function(){return {data:{session:{user:{id:'user-1',email:'owner@example.com'}}},error:null}},
          getSession:async function(){return {data:{session:null},error:null}},
          signOut:async function(options){window.__signOutScopes.push(options);if(listener)listener('SIGNED_OUT',null);return {error:null}},
          onAuthStateChange:function(callback){listener=callback;return {data:{subscription:{unsubscribe:function(){}}}}},
          mfa:{
            getAuthenticatorAssuranceLevel:async function(){return {data:{currentLevel:'aal1',nextLevel:'aal2'},error:null}},
            listFactors:async function(){return {data:{totp:[factor],phone:[],all:[factor]},error:null}},
            challenge:async function(){return {data:{id:'challenge-1'},error:null}},
            verify:async function(){return {data:null,error:{message:'invalid code'}}}
          }
        }};
      }};
    `
  }));
  await page.goto('/index.html');
  await page.locator('#authEmail').fill('owner@example.com');
  await page.locator('#authPassword').fill('correct horse battery staple');
  await page.locator('#authSubmit').click();
  await expect(page.locator('#mfaChallengeForm')).toBeVisible();
  await page.locator('#mfaChallengeCode').fill('000000');
  await page.locator('#mfaChallengeSubmit').click();
  await expect(page.locator('#mfaChallengeError')).toBeVisible();
  await expect(page.locator('#mfaChallengeError')).toContainText('invalid or expired');
  await page.locator('#mfaCancelBtn').click();
  await expect(page.locator('#authForm')).toBeVisible();
  await expect(page.locator('#authSubmit')).toBeEnabled();
  expect(await page.evaluate(() => window.__signOutScopes)).toEqual([{ scope: 'local' }]);
});

test('database hardening enforces opt-in MFA and bounded public shares', async () => {
  const sql = fs.readFileSync('supabase/migrations/20260720000002_share_safety.sql', 'utf8');
  for (const policy of ['collections_mfa_opt_in', 'collection_versions_mfa_opt_in', 'shares_mfa_opt_in', 'share_access_events_mfa_opt_in', 'media_mfa_opt_in']) {
    expect(sql).toContain(policy);
  }
  expect(sql).toMatch(/as restrictive for all to authenticated/g);
  expect(sql).toContain("auth.jwt()->>'aal'");
  expect(sql).toContain('char_length(v_code) < 12');
  expect(sql).toContain('octet_length(v_code) > 72');
  expect(sql).toContain('v_failures >= 20');
  expect(sql).toContain('revoke all on public.shares from anon, authenticated');
  expect(sql).toContain('revoke all on public.share_access_events from anon, authenticated');
  expect(sql).toMatch(/create function public\.get_shared_inventory\(share_token uuid, share_code text\)/);
  expect(sql).not.toMatch(/get_shared_inventory\(share_token uuid, share_code text default/i);
});
