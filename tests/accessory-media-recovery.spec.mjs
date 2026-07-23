import { test, expect } from '@playwright/test';

// Exercises accessory media through the complete independent-recovery path.
test.use({ serviceWorkers: 'block' });

async function mockSignedOutSupabase(page) {
  await page.route('**/vendor/supabase.js', route => route.fulfill({
    contentType: 'application/javascript',
    body: `window.supabase={createClient:function(){return {auth:{getSession:async function(){return {data:{session:null},error:null}},onAuthStateChange:function(){return {data:{subscription:{unsubscribe:function(){}}}}}}}}};`
  }));
}

test('weekly backup embeds accessory photos and fails closed when one is unavailable', async ({ page }) => {
  await mockSignedOutSupabase(page);
  await page.goto('/index.html');
  const result = await page.evaluate(async () => {
    const uid = 'backup-accessory-user';
    const photoId = 'accessory-photo-1';
    const photoData = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB';
    const files = new Map();
    const metadata = new Map();
    let artifactKey = null;

    const fileHandle = name => ({
      async createWritable() {
        let pending = '';
        return {
          async write(value) { pending = String(value); },
          async close() { files.set(name, pending); },
          async abort() { pending = ''; }
        };
      },
      async getFile() {
        if (!files.has(name)) {
          const error = new Error('Not found');
          error.name = 'NotFoundError';
          throw error;
        }
        const text = files.get(name);
        return { size: new Blob([text]).size, async text() { return text; } };
      }
    });
    const directoryHandle = {
      kind: 'directory',
      name: 'Backup Test',
      async queryPermission() { return 'granted'; },
      async requestPermission() { return 'granted'; },
      async getFileHandle(name, options) {
        if (!files.has(name) && !(options && options.create)) {
          const error = new Error('Not found');
          error.name = 'NotFoundError';
          throw error;
        }
        return fileHandle(name);
      },
      async removeEntry(name) { files.delete(name); }
    };

    const originalSafety = window.VaultDataSafety;
    window.VaultDataSafety = Object.assign({}, originalSafety, {
      async getMetadata(user, name) { return metadata.get(user + ':' + name) || null; },
      async putMetadata(user, name, value) { metadata.set(user + ':' + name, value); return value; },
      async deleteMetadata(user, name) { metadata.delete(user + ':' + name); },
      async provisionArtifactKey() { artifactKey = { ready: true }; return artifactKey; },
      async getArtifactKey() { return artifactKey; },
      async deleteArtifactKey() { artifactKey = null; },
      async encryptArtifact(user, namespace, value, options) {
        return {
          encrypted: true,
          accountTag: options.accountTag,
          artifactType: options.artifactType,
          metadata: options.metadata,
          payload: value
        };
      },
      async decryptArtifact(envelope) { return { value: envelope.payload }; }
    });
    window.waitForActiveFormSave = async () => ({ ok: true });
    window.flushPendingVaultOperations = async () => true;
    window.ensureReferencedMediaReady = async () => ({ ok: true, missing: [] });

    CloudSync.uid = uid;
    db = {
      version: 3,
      encrypted: false,
      firearms: [],
      ammo: [],
      accessories: [{
        id: 'backup-accessory',
        name: 'Backup Optic',
        brand: 'Example Optics',
        images: [photoId],
        receipt: null
      }],
      wishlist: [],
      dealers: [],
      auditTrail: [],
      valueHistory: [],
      backups: [],
      settings: {}
    };
    imagesDb = { [photoId]: photoData };

    const first = await IndependentBackupVault.setup({
      uid,
      password: 'correct horse battery staple',
      confirmPassword: 'correct horse battery staple',
      directoryHandle,
      retention: 4,
      runInitial: true
    });
    const firstFiles = [...files.entries()];
    const envelope = JSON.parse(firstFiles[0][1]);
    const restored = envelope.payload.data;

    db.accessories[0].images = ['missing-accessory-photo'];
    imagesDb = {};
    const second = await IndependentBackupVault.runNow({ uid, manual: true, force: true });

    return {
      first: { ok: first.ok, mediaCount: first.verified && first.verified.mediaCount },
      embeddedPhoto: restored.images && restored.images[photoId],
      restoredReferences: restored.accessories[0].images,
      second: { ok: second.ok, status: second.status, message: second.message },
      filesAfterFailure: files.size
    };
  });

  expect(result.first).toEqual({ ok: true, mediaCount: 1 });
  expect(result.embeddedPhoto).toMatch(/^data:image\/png;base64,/);
  expect(result.restoredReferences).toEqual(['accessory-photo-1']);
  expect(result.second.ok).toBe(false);
  expect(result.second.status).toBe('failed');
  expect(result.second.message).toMatch(/accessory photo is unavailable/i);
  expect(result.filesAfterFailure).toBe(1);
});
