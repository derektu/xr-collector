import { describe, expect, it } from 'vitest';
import { agentConnectionFile } from '../../src/runtime/agent-discovery.js';

describe('Agent discovery connection file', () => {
  it('uses the stable macOS application data location for a packaged production app', () => {
    expect(agentConnectionFile({
      platform: 'darwin', isPackaged: true, hasExplicitProfile: false,
      profilePath: '/Users/test/Library/Application Support/xr-collector',
      appDataPath: '/Users/test/Library/Application Support',
    })).toBe('/Users/test/Library/Application Support/XR Collector/agent-connection.json');
  });

  it('uses LocalAppData for a packaged production app on Windows', () => {
    expect(agentConnectionFile({
      platform: 'win32', isPackaged: true, hasExplicitProfile: false,
      profilePath: String.raw`C:\Users\test\AppData\Roaming\XR Collector`,
      appDataPath: String.raw`C:\Users\test\AppData\Roaming`,
      localAppDataPath: String.raw`C:\Users\test\AppData\Local`,
    })).toBe(String.raw`C:\Users\test\AppData\Local\XR Collector\agent-connection.json`);
  });

  it('keeps explicit and unpackaged development profiles isolated from production discovery', () => {
    const common = {
      platform: 'darwin' as const,
      appDataPath: '/Users/test/Library/Application Support',
    };
    const explicit = agentConnectionFile({
      ...common, profilePath: '/tmp/isolated-profile',
      isPackaged: true, hasExplicitProfile: true,
    });
    const productionProfile = '/Users/test/Library/Application Support/XR Collector';
    const development = agentConnectionFile({
      ...common, profilePath: productionProfile,
      isPackaged: false, hasExplicitProfile: false,
    });
    const production = agentConnectionFile({
      ...common, profilePath: productionProfile,
      isPackaged: true, hasExplicitProfile: false,
    });
    expect(explicit).toBe('/tmp/isolated-profile/agent-connection.json');
    expect(development)
      .toBe('/Users/test/Library/Application Support/XR Collector/agent-connection.development.json');
    expect(explicit).not.toBe(production);
    expect(development).not.toBe(production);
  });

  it('fails clearly when Windows cannot resolve its documented production entrypoint', () => {
    expect(() => agentConnectionFile({
      platform: 'win32', isPackaged: true, hasExplicitProfile: false,
      profilePath: 'profile', appDataPath: 'roaming',
    })).toThrow('LOCALAPPDATA');
  });
});
