import assert from 'node:assert/strict';
import { test } from 'node:test';
import { attachmentBlock, classifyAttachment, downloaderFromToken, SlackFileAccessError, safeName } from '../src/attachments';

test('attachments are classified by type and size, and Slack-native content is skipped', () => {
  const base = { id: 'F', url_private_download: 'https://files.slack.test/F' };
  assert.deepEqual(classifyAttachment({ ...base, mimetype: 'image/png', size: 10 }), { kind: 'image' });
  assert.deepEqual(classifyAttachment({ ...base, mimetype: 'image/svg+xml', size: 10 }), { kind: 'file' });
  assert.deepEqual(classifyAttachment({ ...base, mimetype: 'application/pdf', size: 10 }), { kind: 'file' });
  assert.equal(classifyAttachment({ ...base, mimetype: 'image/png', size: 30 * 1024 * 1024 }).kind, 'skip');
  assert.equal(classifyAttachment({ id: 'P', mimetype: 'application/vnd.slack-docs' }).kind, 'skip');
  assert.equal(classifyAttachment({ ...base, mode: 'tombstone' }).kind, 'skip');
});

test('the downloader sends the bot token, detects the sign-in page, and never leaks it in errors', async () => {
  const calls: { url: string; auth: string | null }[] = [];
  const respond = (body: string | Uint8Array, init: ResponseInit) => async (url: string | URL | Request, reqInit?: RequestInit) => {
    calls.push({ url: String(url), auth: new Headers(reqInit?.headers).get('Authorization') });
    return new Response(body as any, init);
  };
  const ok = downloaderFromToken('xoxb-fixture-secret', respond(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'image/png' } }));
  const got = await ok.download({ id: 'F1', name: 'a.png', mimetype: 'image/png', url_private_download: 'https://files.slack.test/F1' });
  assert.deepEqual([...got.bytes], [1, 2, 3]);
  assert.equal(got.mime, 'image/png');
  assert.equal(calls[0].auth, 'Bearer xoxb-fixture-secret');

  const login = downloaderFromToken('xoxb-fixture-secret', respond('<html>sign in</html>', { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } }));
  await assert.rejects(login.download({ id: 'F2', url_private: 'https://files.slack.test/F2' }), (err: unknown) => {
    assert.ok(err instanceof SlackFileAccessError && err.code === 'missing_scope');
    assert.doesNotMatch(String(err), /xoxb-fixture-secret/);
    return true;
  });

  const gone = downloaderFromToken('t', respond('', { status: 404 }));
  await assert.rejects(gone.download({ id: 'F3', url_private: 'https://files.slack.test/F3' }), /file not found/);
});

test('prompt blocks mirror the admin composer wording in both layouts', () => {
  const items = [
    { kind: 'image' as const, name: 'a.png', path: '/tmp/a.png', url: 'https://p/api/v1/screenshots/1' },
    { kind: 'file' as const, name: 'b.txt', path: '/tmp/b.txt', url: 'https://p/api/v1/uploads/2' },
  ];
  assert.equal(attachmentBlock(items, true), 'Attached screenshots: /tmp/a.png (GET https://p/api/v1/screenshots/1) · Attached files: /tmp/b.txt (download: https://p/api/v1/uploads/2)');
  assert.equal(attachmentBlock(items, false), [
    'Attached screenshots (GET to fetch PNG):', '- https://p/api/v1/screenshots/1',
    'Local tmp paths (if agent is on the server host):', '- /tmp/a.png', '',
    'Attached files (read from these local paths if you are on the server host):', '- /tmp/b.txt (download: https://p/api/v1/uploads/2)',
  ].join('\n'));
  assert.equal(attachmentBlock([], true), '');
});

test('file names are sanitised before they become upload names', () => {
  assert.equal(safeName('../../etc/passwd'), '.._.._etc_passwd'.replace(/^\.+/, ''));
  assert.equal(safeName('  '), 'attachment');
  assert.equal(safeName('report Q3.pdf'), 'report Q3.pdf');
});
