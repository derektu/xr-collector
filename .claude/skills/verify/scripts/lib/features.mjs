// The feature map under ../../features/: each feature file's sub-feature IDs, the flows its
// Regression flows section names with the sub-features each asserts, and its Backlog. `flows run
// --feature` selects flows by these IDs; the consistency tests compare them with the flows' covers.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const FEATURES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'features');

/** The H2 section `title` of a feature file, up to the next H2; '' when the file has none. */
export function section(markdown, title) {
  const start = markdown.indexOf(`\n## ${title}\n`);
  if (start < 0) return '';
  const rest = markdown.slice(start + title.length + 5);
  const end = rest.indexOf('\n## ');
  return end < 0 ? rest : rest.slice(0, end);
}

/** Every `code span` of a line, in order. */
export const ticked = (text) => [...text.matchAll(/`([^`]+)`/gu)].map((match) => match[1]);

const items = (text) => text.split('\n').filter((line) => line.startsWith('- '));

/**
 * One feature file: `name` (the file name without .md), `subFeatures` (the IDs its Sub-features
 * list), `listed` (flow name → the sorted sub-feature IDs its Regression flows line names),
 * `hasBacklog` and `backlog` (the Backlog section's list items).
 */
export function parseFeature(file, markdown) {
  const subFeatures = items(section(markdown, 'Sub-features')).filter((line) => line.startsWith('- `')).map((line) => ticked(line)[0]);
  const listed = Object.fromEntries(items(section(markdown, 'Regression flows')).filter((line) => line.startsWith('- `'))
    .map((line) => { const [flow, ...ids] = ticked(line); return [flow, ids.sort()]; }));
  const backlogText = section(markdown, 'Backlog');
  return { file, name: path.basename(file, '.md'), subFeatures, listed, hasBacklog: markdown.includes('\n## Backlog\n'), backlog: items(backlogText) };
}

/** Every feature file of the map, by file name. */
export function readFeatures(dir = FEATURES_DIR) {
  return readdirSync(dir).filter((file) => file.endsWith('.md') && file !== 'README.md').sort()
    .map((file) => parseFeature(file, readMarkdown(path.join(dir, file))));
}

/** A Markdown file of the skill with LF line endings, as a Windows checkout with core.autocrlf may hold it in CRLF. */
export function readMarkdown(file) {
  return readFileSync(file, 'utf8').replace(/\r\n/gu, '\n');
}

/** The feature named `name` (with or without .md); an unknown name lists the known ones. */
export function findFeature(features, name) {
  const wanted = path.basename(name, '.md');
  const feature = features.find((candidate) => candidate.name === wanted);
  if (!feature) throw new Error(`Unknown feature ${name}; known: ${features.map((candidate) => candidate.name).join(', ')}`);
  return feature;
}
