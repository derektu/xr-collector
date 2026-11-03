// The installed App and a development run pick their automatic Agent ports from separate ranges, so
// both run on one machine without taking each other's port.
import { describe, expect, it } from 'vitest';
import { AGENT_PORT_RANGE, DESKTOP_AGENT_PORT, DEVELOPMENT_AGENT_PORT } from '../../src/runtime/agent-connection-defaults.js';

describe('Agent connection defaults', () => {
  it('keeps installed and development automatic port ranges separate', () => {
    const [lower, upper] = [DESKTOP_AGENT_PORT, DEVELOPMENT_AGENT_PORT].sort((a, b) => a - b);
    expect(lower! + AGENT_PORT_RANGE).toBeLessThanOrEqual(upper!);
  });
});
