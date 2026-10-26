import test from 'node:test';
import assert from 'node:assert/strict';
import { auditResume, resumeRequestContext, requiresResumeClientRefresh } from '../src/resume-audit.js';

test('resume audit only records bounded whitelisted request metadata', () => {
  const context = resumeRequestContext(new Headers({
    authorization: 'Bearer secret-token', cookie: 'secret-cookie',
    referer: 'https://user:password@example.com/admin/?token=secret#private',
    origin: 'https://example.com',
    'x-propanes-resume-source': 'conversation.submit-prompt',
    'x-propanes-client-id': 'page-123',
    'x-propanes-resume-page': '/sessions?token=secret',
    'user-agent': 'x'.repeat(1000), 'x-forwarded-for': '192.0.2.1',
  }), { id: 'actor', role: 'admin' }, '127.0.0.1');
  assert.equal(context.referer, 'https://example.com');
  assert.equal(context.actorId, 'actor');
  assert.equal(context.peerAddress, '127.0.0.1');
  assert.equal(context.source, 'conversation.submit-prompt');
  assert.equal(context.page, null);
  assert.equal(context.userAgent?.length, 512);
  assert.doesNotMatch(JSON.stringify(context), /secret|password/);
});

test('resume audit correlates the request and child session without prompt text', async () => {
  const lines: string[] = [];
  await auditResume('parent', 'codex', true, undefined, async () => ({ sessionId: 'child' }), (line) => lines.push(line));
  const [request, created] = lines.map((line) => JSON.parse(line.slice('[resume-audit] '.length)));
  assert.equal(request.event, 'requested');
  assert.equal(created.event, 'created');
  assert.equal(request.requestId, created.requestId);
  assert.equal(created.sessionId, 'child');
  assert.equal(created.parentSessionId, 'parent');
  assert.equal(request.transport, 'internal');
  assert.ok(request.caller.length);
});

test('failed resumes are logged and retain their original error', async () => {
  const lines: string[] = [];
  const error = new Error('secret upstream response');
  await assert.rejects(auditResume('parent', null, false, undefined, async () => { throw error; }, (line) => lines.push(line)), (caught) => caught === error);
  assert.match(lines[1], /"event":"failed"/);
  assert.doesNotMatch(lines.join(''), /secret upstream/);
});

test('legacy implicit-submit browser sources must refresh, while explicit and API callers remain supported', () => {
  for (const source of ['terminal.resume', 'terminal.interrupt', 'conversation.submit-prompt']) {
    assert.equal(requiresResumeClientRefresh(source), true);
  }
  for (const source of [null, 'admin.resume-action', 'terminal.resume.click.trusted', 'conversation.submit-prompt.click.trusted']) {
    assert.equal(requiresResumeClientRefresh(source), false);
  }
});
