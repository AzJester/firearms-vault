import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/index.html');
  await expect(page.locator('#authForm')).toBeVisible({ timeout: 15000 });
});

test('three-way merge combines disjoint edits and retains overlapping edits for attention', async ({ page }) => {
  const results = await page.evaluate(() => {
    const base = {
      version: 3,
      firearms: [
        { id: 'one', make: 'Original', model: 'A' },
        { id: 'two', make: 'Original', model: 'B' }
      ],
      settings: { theme: 'light' }
    };
    const local = structuredClone(base);
    local.firearms[0].make = 'Local edit';
    const remote = structuredClone(base);
    remote.firearms[1].make = 'Remote edit';

    const disjoint = CloudSync.mergeStructured(base, local, remote);
    const overlappingRemote = structuredClone(base);
    overlappingRemote.firearms[0].make = 'Different remote edit';
    const overlapping = CloudSync.mergeStructured(base, local, overlappingRemote);
    return { disjoint, overlapping };
  });

  expect(results.disjoint.ok).toBe(true);
  expect(results.disjoint.merged.firearms.find((item) => item.id === 'one').make).toBe('Local edit');
  expect(results.disjoint.merged.firearms.find((item) => item.id === 'two').make).toBe('Remote edit');
  expect(results.overlapping.ok).toBe(false);
  expect(results.overlapping.conflicts.some((path) => path.includes('firearms[one].make'))).toBe(true);
});

test('media is checksummed and uploaded before the CAS document commit', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const uid = '11111111-1111-4111-8111-111111111111';
    await openImageDB();
    await openStateDB();
    await CloudSync.activateUser(uid);

    db = {
      version: 3, encrypted: false,
      firearms: [{ id: 'firearm-one', make: 'Example', model: 'One', images: ['photo-one'], tags: [], customFields: [], maintenanceLog: [] }],
      ammo: [], accessories: [], wishlist: [], dealers: [], backups: [], settings: {}, auditTrail: [], valueHistory: []
    };
    imagesDb = { 'photo-one': 'data:text/plain;base64,aGVsbG8=' };
    CloudSync.ready = true;
    CloudSync.revision = 0;
    CloudSync.serverUpdatedAt = null;
    CloudSync.serverMediaManifest = {};
    CloudSync._lastCommittedData = {};
    CloudSync._casRpcSupported = true;

    const calls = [];
    window.sbClient = {
      storage: {
        from() {
          return {
            async upload(path, blob, options) {
              calls.push({ type: 'upload', path, size: blob.size, metadata: options.metadata });
              return { data: { path }, error: null };
            },
            async remove(paths) {
              calls.push({ type: 'remove', paths });
              return { data: [], error: null };
            }
          };
        }
      },
      async rpc(name, args) {
        calls.push({ type: 'rpc', name, args });
        return {
          data: {
            status: 'saved', revision: 1, updated_at: '2026-07-20T00:00:00.000Z',
            data: args.p_new_data, media_manifest: args.p_new_media_manifest
          },
          error: null
        };
      }
    };

    const save = await CloudSync.syncNow();
    const outbox = await CloudSync.storeGet('outbox', uid);
    return { calls, save, outbox };
  });

  const uploadIndex = result.calls.findIndex((call) => call.type === 'upload');
  const rpcIndex = result.calls.findIndex((call) => call.type === 'rpc');
  expect(uploadIndex, JSON.stringify(result, null, 2)).toBeGreaterThanOrEqual(0);
  expect(rpcIndex).toBeGreaterThan(uploadIndex);
  expect(result.calls[uploadIndex].metadata.sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(result.calls[uploadIndex].path).toContain(result.calls[uploadIndex].metadata.sha256.slice(0, 32));
  expect(result.save.ok).toBe(true);
  expect(result.outbox).toBeNull();
});

test('background media failures are reported without falsely claiming a clean sync', async ({ page }) => {
  const result = await page.evaluate(() => {
    CloudSync.hasCloudData = true;
    return {
      oneMissing: CloudSync.mediaStatusText({ failures: [{}] }),
      twoMissing: CloudSync.mediaStatusText({ failures: [{}, {}] }),
      clean: CloudSync.mediaStatusText({ failures: [] })
    };
  });
  expect(result).toEqual({
    oneMissing: 'Saved to cloud - 1 attachment needs recovery',
    twoMissing: 'Saved to cloud - 2 attachments need recovery',
    clean: 'Saved to cloud'
  });
  const source = await (await page.request.get('/js/cloud-sync.js')).text();
  expect(source).toContain('Saved to cloud - device verification needs attention');
});

test('switching accounts clears the shared compatibility caches', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const userA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const userB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    await openImageDB();
    await openStateDB();
    await CloudSync.activateUser(userA);
    await statePut('db', { firearms: [{ id: 'private-record' }] });
    await idbPut('private-photo', 'data:text/plain;base64,cHJpdmF0ZQ==');

    const changed = await CloudSync.activateUser(userB);
    const state = await stateGet('db');
    const media = await idbGet('private-photo');
    return { changed, state: state || null, media: media || null };
  });

  expect(result.changed.ok).toBe(true);
  expect(result.changed.changed).toBe(true);
  expect(result.state).toBeNull();
  expect(result.media).toBeNull();
});

const sourceSchemaTest = process.env.TEST_SITE_DIR === 'dist' ? test.skip : test;
sourceSchemaTest('Supabase migration defines revision CAS, recovery history, and a private write/delete canary', async ({ page }) => {
  const response = await page.request.get('/supabase/migrations/20260720000001_sync_safety.sql');
  expect(response.ok()).toBe(true);
  const sql = await response.text();
  expect(sql).toContain('save_collection_cas');
  expect(sql).toContain('collection_versions');
  expect(sql).toContain('media_manifest');
  expect(sql).toContain('run_health_check_canary');
  expect(sql).toContain('delete from public.health_checks');
  expect(sql).toContain('enable row level security');
  expect(sql).toContain('revoke all on function public.run_health_check_canary(text) from public');
  expect(sql).toContain('security definer');
  expect(sql).toContain('revoke insert, update, delete on public.collections from authenticated');
  expect(sql).toContain('revoke all on public.collection_versions from anon, authenticated');
  expect(sql).toContain('Complete multi-factor authentication before saving');
  expect(sql).not.toContain('grant select, insert, delete on public.collection_versions');
});

sourceSchemaTest('health monitoring accepts either empty RLS results or explicit anonymous denial', async ({ page }) => {
  const response = await page.request.get('/scripts/check-supabase-health.mjs');
  expect(response.ok()).toBe(true);
  const source = await response.text();
  expect(source).toContain('/auth/v1/settings');
  expect(source).toContain('[401, 403].includes(response.status)');
  expect(source).toContain('rows.length !== 0');
  expect(source).toContain('run_health_check_canary');
});
