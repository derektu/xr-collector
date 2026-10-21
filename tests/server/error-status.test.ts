import { describe, expect, it } from 'vitest';
import { registerSourceDefinitions } from '../../src/core/source-registry.js';
import { errorStatus } from '../../src/server/app.js';
import { FAKE } from '../support/fake-source-plugin.js';

registerSourceDefinitions([FAKE]);

describe('the HTTP status of an error code', () => {
  it('takes the core\'s own codes from the core and other codes from the source type that declares them', () => {
    expect(errorStatus('vault_busy')).toBe(409);
    expect(errorStatus('rate_limited')).toBe(503);
    expect(errorStatus('no_subtitles')).toBe(422);
    expect(errorStatus('video_unavailable')).toBe(422);
    expect(errorStatus('feed_gone')).toBe(410);
    expect(errorStatus('nobody_declares_this')).toBe(500);
  });
});
