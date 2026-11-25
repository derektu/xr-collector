import { describe, expect, it } from 'vitest';
import { maskSecrets, protectSecret, redact } from '../../../src/shared/lib/redact.js';

describe('redact', () => {
  it('protectSecret ignores a secret shorter than eight characters, which would mask ordinary words', () => {
    protectSecret('archive');
    protectSecret('archives');

    expect(maskSecrets('archive')).toBe('archive');
    expect(maskSecrets('archives')).toBe('[已遮蔽]');
  });

  it('protectSecret refuses a secret JSON would escape, since masking serialized JSON could not find it', () => {
    expect(() => protectSecret('quote"inside-secret')).toThrow();
    expect(() => protectSecret('back\\slash-secret')).toThrow();
  });

  it('maskSecrets keeps masking a replaced secret, since older text can still carry it', () => {
    protectSecret('first-agent-token');
    protectSecret('second-agent-token');

    expect(maskSecrets('old log: first-agent-token')).toBe('old log: [已遮蔽]');
  });

  it("redact keeps a credential's label, so the reader sees what was masked", () => {
    expect(redact('Authorization: Bearer abc.def-123')).toBe('Authorization: [已遮蔽]');
    expect(redact('Cookie: sid=abc123')).toBe('Cookie: [已遮蔽]');
    expect(redact('https://example.com/feed?key=s3cr3t&page=2')).toBe('https://example.com/feed?key=[已遮蔽]&page=2');
  });
});
