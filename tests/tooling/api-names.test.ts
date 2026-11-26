// A type-specific or channel-named route, field or error code makes the API differ by source type, so an
// Agent written against the Skill misses it.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { filesUnder } from '../support/source-files.js';

const ROOTS = ['src', 'skills'];
const EXEMPT = ['src/domain/sources/youtube/'];
const API_NAMES: Array<[string, RegExp]> = [
  ['type-prefixed route', /\/api\/(?:youtube|\$\{[^}]*\})\//u],
  ['source list route', /\/api\/sources\b/u],
  ['channel route', /\/api\/[\w-]*\/?channel/u],
  ['channels route segment', /\/channels?\b/u],
  ['channel-runs route', /channel-runs/u],
  ['channel-previews route', /channel-previews/u],
  ['channelIds field', /\bchannelIds\b/u],
  ['channel error code', /\b(?:channel_not_found|channel_paused|invalid_channel)\b/u],
  ['preview channel field', /preview\.channel\b/u],
  ['channel API client call', /\bapi\.\w*Channels?\w*\(/u],
];

const WIRE_KEY_ROOTS = ['src/transport/server/', 'src/transport/web/', 'src/domain/sources/'];
const WIRE_KEY = /\bchannel(?:s|Id)?\s*:/u;

const files = ROOTS.flatMap(filesUnder)
  .filter((file) => /\.(?:ts|tsx|md)$/u.test(file) && !EXEMPT.some((prefix) => file.startsWith(prefix)));

describe('API names in the code and the Skill (B-T4)', () => {
  it('reads the server, web client and Skill files', () => {
    expect(files).toEqual(expect.arrayContaining(['src/transport/server/app.ts', 'src/transport/web/api/api-client.ts', 'src/domain/sources/source-types.ts', 'skills/xr-collector-agent/SKILL.md']));
  });

  it('names no type-specific route, channel field or channel error code', () => {
    const found = files.flatMap((file) => readFileSync(file, 'utf8').split('\n').flatMap((line, index) =>
      API_NAMES.filter(([, pattern]) => pattern.test(line)).map(([name]) => `${file}:${index + 1} ${name}: ${line.trim()}`)));
    expect(found).toEqual([]);
  });

  it('builds no wire object with a channel, channels or channelId key', () => {
    const found = files.filter((file) => WIRE_KEY_ROOTS.some((root) => file.startsWith(root))).flatMap((file) =>
      readFileSync(file, 'utf8').split('\n').flatMap((line, index) =>
        WIRE_KEY.test(line) ? [`${file}:${index + 1}: ${line.trim()}`] : []));
    expect(found).toEqual([]);
  });

  it('names the subscription of an add job and of the schedule summary subscriptionId on the wire', () => {
    const skill = readFileSync('skills/xr-collector-agent/SKILL.md', 'utf8');
    expect(skill).toContain('`result.subscriptionId`');
    expect(skill).toMatch(/`lastCheck`（[^）]*`subscriptionId`/u);
    expect(skill).not.toMatch(/`channelId`/u);
  });
});
