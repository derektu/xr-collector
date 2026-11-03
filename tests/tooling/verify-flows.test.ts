// Guards the developer, not the user.
// The recorded regression flows of the verify skill and the feature map that names them: the E2E
// workflow finds every flow without a second fixed list, and each feature file names exactly the
// flows covering it, so picking flows by feature never leaves one out.
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FEATURES_DIR, findFeature, readFeatures, readMarkdown } from '../../.claude/skills/verify/scripts/lib/features.mjs';
import { listFlows, selectFlows } from '../../.claude/skills/verify/scripts/lib/flows.mjs';

const flows = await listFlows();
const features = readFeatures();
const names = (selected: typeof flows) => selected.map((flow) => flow.name);

describe('recorded flows', () => {
  it('runs every flow that is not Desktop in the Web set, and names flows strictly', () => {
    expect(names(selectFlows(flows, { layer: 'web' }))).toEqual(names(flows.filter((flow) => !flow.desktop)));
    expect(names(selectFlows(flows, { layer: 'desktop' })).sort()).toEqual(['notification-clicks', 'tray', 'vault-actions']);
    expect(() => selectFlows(flows, { names: ['missing'], layer: 'web' })).toThrow(/Unknown flow missing/u);
  });

  it('runs with a window on screen only the Desktop flows that name scenarios needing it', () => {
    expect(names(selectFlows(flows, { visible: true })).sort()).toEqual(['notification-clicks', 'tray']);
    expect(() => selectFlows(flows, { layer: 'web', visible: true })).toThrow(/--visible runs Desktop flows/u);
    for (const flow of flows) expect(flow.visibleScenarios.length === 0 || flow.desktop, flow.name).toBe(true);
  });

  it('picks the flows covering a feature file, named with or without .md', () => {
    const subscriptions = findFeature(features, 'subscriptions.md');
    expect(names(selectFlows(flows, { feature: subscriptions }))).toEqual(Object.keys(subscriptions.listed).sort());
    expect(() => findFeature(features, 'missing')).toThrow(/Unknown feature missing; known: .*subscriptions/u);
  });
});

describe('feature map and recorded flows', () => {
  it('lets every flow cover only sub-features the feature map defines', () => {
    const known = features.flatMap((feature) => feature.subFeatures);
    for (const flow of flows) expect(flow.covers.filter((id: string) => !known.includes(id)), flow.name).toEqual([]);
  });

  it('lists in each feature file exactly the flows covering it, with only that file\'s sub-features each asserts', () => {
    for (const feature of features) {
      const expected = Object.fromEntries(flows
        .map((flow) => [flow.name, flow.covers.filter((id: string) => feature.subFeatures.includes(id)).sort()] as const)
        .filter(([, ids]) => ids.length > 0));
      expect(feature.listed, feature.file).toEqual(expected);
    }
  });

  it('lists every feature file in the map\'s table with the flows its Regression flows names', () => {
    const readme = readMarkdown(path.join(FEATURES_DIR, 'README.md'));
    const rows = Object.fromEntries(readme.split('\n').map((line) => line.match(/^\| [^|]+ \| \[([^\]]+\.md)\]\([^)]+\) \|[^|]+\| (.+) \|$/u))
      .filter((match): match is RegExpMatchArray => match !== null)
      .map((match) => [match[1], [...match[2].matchAll(/`([^`]+)`/gu)].map((code) => code[1]).sort()]));
    expect(Object.keys(rows).sort()).toEqual(features.map((feature) => feature.file).sort());
    for (const feature of features) expect(rows[feature.file], feature.file).toEqual(Object.keys(feature.listed).sort());
  });
});
