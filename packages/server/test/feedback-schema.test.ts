import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { feedbackSubmitSchema } from '@propanes/shared';

describe('feedbackSubmitSchema', () => {
  it('normalizes null and empty optional widget fields', () => {
    const parsed = feedbackSubmitSchema.safeParse({
      type: null,
      title: null,
      description: 'Widget report',
      data: null,
      context: null,
      sourceUrl: '',
      userAgent: null,
      viewport: null,
      sessionId: null,
      userId: null,
      tags: null,
      appId: null,
      launcherId: null,
      agentEndpointId: null,
      permissionProfile: null,
    });

    assert.equal(parsed.success, true);
    if (!parsed.success) return;
    assert.equal(parsed.data.type, 'manual');
    assert.equal(parsed.data.title, '');
    assert.equal(parsed.data.description, 'Widget report');
    assert.equal(parsed.data.sourceUrl, undefined);
    assert.equal(parsed.data.userId, undefined);
    assert.equal(parsed.data.tags, undefined);
  });

  it('still rejects invalid non-null optional widget fields', () => {
    const parsed = feedbackSubmitSchema.safeParse({
      description: 'Widget report',
      sourceUrl: 'not a url',
    });

    assert.equal(parsed.success, false);
  });
});
