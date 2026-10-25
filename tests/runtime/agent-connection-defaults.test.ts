import { describe, expect, it } from 'vitest';
import { AGENT_PORT_RANGE, DESKTOP_AGENT_PORT, DEVELOPMENT_AGENT_PORT } from '../../src/runtime/agent-connection-defaults.js';

describe('Agent connection defaults', () => {
  it('keeps installed and development automatic port ranges separate', () => {
    expect(AGENT_PORT_RANGE).toBe(10);
    expect(DESKTOP_AGENT_PORT).toBe(7222);
    expect(DEVELOPMENT_AGENT_PORT).toBe(7232);
    expect(DESKTOP_AGENT_PORT + AGENT_PORT_RANGE).toBeLessThanOrEqual(DEVELOPMENT_AGENT_PORT);
  });
});
