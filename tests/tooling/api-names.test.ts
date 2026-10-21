import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// The HTTP API names subscriptions, not channels, and serves every source type on the same routes
// (B-T4). The product code that builds requests and responses and the Agent Skill use only those
// names. The YouTube plugin keeps its own vocabulary inside `src/plugins/youtube`, and stored names
// (the subscription file, job kinds, event types and job records) are data, not API names.

const ROOTS = ['src', 'skills'];
const EXEMPT = ['src/plugins/youtube/'];
/** Type-specific routes, channel-named fields and error codes of the HTTP API. */
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

/**
 * Object keys of the request and response bodies. The server, the web client and the source
 * catalog build the wire objects, so none of them writes a `channel`, `channels` or
 * `channelId` key; the stored job record keeps `channelId` and is mapped where it is read.
 */
const WIRE_KEY_ROOTS = ['src/server/', 'src/web/', 'src/sources/'];
const WIRE_KEY = /\bchannel(?:s|Id)?\s*:/u;

function filesUnder(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.posix.join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(file) : [file];
  });
}

const files = ROOTS.flatMap(filesUnder)
  .filter((file) => /\.(?:ts|tsx|md)$/u.test(file) && !EXEMPT.some((prefix) => file.startsWith(prefix)));

describe('API names in the code and the Skill (B-T4)', () => {
  it('reads the server, web client and Skill files', () => {
    expect(files).toEqual(expect.arrayContaining(['src/server/app.ts', 'src/web/api-client.ts', 'src/sources/source-types.ts', 'skills/xr-collector-agent/SKILL.md']));
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
