// Broken, the installed App and a development run on one machine take each other's Agent port.
import { describe, expect, it } from 'vitest';
import { AGENT_PORT_RANGE, DESKTOP_AGENT_PORT, DEVELOPMENT_AGENT_PORT } from '../../../src/app/runtime/agent-connection-defaults.js';

describe('Agent connection defaults', () => {
  it('keeps installed and development automatic port ranges separate', () => {
    const [lower, upper] = [DESKTOP_AGENT_PORT, DEVELOPMENT_AGENT_PORT].sort((a, b) => a - b);
    expect(lower! + AGENT_PORT_RANGE).toBeLessThanOrEqual(upper!);
  });
});
