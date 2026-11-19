import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDraftImageStore, type DraftImage, type DraftImageBackend } from '../src/lib/draft-images.js';

function fakeBackend(delayMs = 0) {
  const data = new Map<string, DraftImage[]>();
  const wait = () => new Promise<void>((r) => setTimeout(r, delayMs));
  const backend: DraftImageBackend = {
    async get(key) { await wait(); return data.get(key); },
    async set(key, images) { await wait(); data.set(key, images); },
    async delete(key) { await wait(); data.delete(key); },
  };
  return { backend, data };
}
const img = (id: string): DraftImage => ({ id, name: `${id}.png`, blob: new Blob([id], { type: 'image/png' }) });
const settle = () => new Promise<void>((r) => setTimeout(r, 30));

test('images saved for a draft come back on the next load (close → reopen)', async () => {
  const store = createDraftImageStore(fakeBackend(5).backend);
  store.save('qdp-app', [img('a'), img('b')]);
  // No await: reopening immediately must not race the backend write.
  const loaded = await store.load('qdp-app');
  assert.deepEqual(loaded.map((i) => i.id), ['a', 'b']);
  assert.equal(await loaded[0].blob.text(), 'a');
  assert.deepEqual(await store.load('qdp-other'), []);
});

test('images survive a reload via the backend', async () => {
  const { backend } = fakeBackend();
  createDraftImageStore(backend).save('k', [img('a')]);
  await settle();
  const afterReload = createDraftImageStore(backend);
  assert.deepEqual((await afterReload.load('k')).map((i) => i.id), ['a']);
});

test('clear removes the draft from memory and the backend', async () => {
  const { backend, data } = fakeBackend(5);
  const store = createDraftImageStore(backend);
  store.save('k', [img('a')]);
  store.clear('k');
  assert.deepEqual(await store.load('k'), []);
  await settle();
  assert.equal(data.has('k'), false, 'slow put must not land after the delete');
});

test('a save during an in-flight load wins over the stale backend read', async () => {
  const { backend, data } = fakeBackend(10);
  data.set('k', [img('old')]);
  const store = createDraftImageStore(backend);
  const pending = store.load('k');
  store.save('k', [img('new')]);
  assert.deepEqual((await pending).map((i) => i.id), ['new']);
});

test('works without a backend and ignores backend failures / junk rows', async () => {
  const memOnly = createDraftImageStore(null);
  memOnly.save('k', [img('a')]);
  assert.equal((await memOnly.load('k')).length, 1);

  const broken: DraftImageBackend = {
    get: async () => { throw new Error('nope'); },
    set: async () => { throw new Error('nope'); },
    delete: async () => { throw new Error('nope'); },
  };
  const store = createDraftImageStore(broken);
  assert.deepEqual(await store.load('k'), []);
  store.save('k', [img('a')]);
  assert.equal((await store.load('k')).length, 1);

  const junk: DraftImageBackend = {
    get: async () => [{ id: 1 }, null, img('ok')] as any,
    set: async () => {},
    delete: async () => {},
  };
  assert.deepEqual((await createDraftImageStore(junk).load('k')).map((i) => i.id), ['ok']);
});
