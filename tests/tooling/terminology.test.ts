import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/** Words the UI, server messages and the Skill must not use. */
const BANNED = ['來源', '追蹤中', '自動收集', '背景收集中', '訂閱時間', '活動'];

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(target);
    return /\.(ts|tsx|cts|html)$/u.test(entry.name) ? [target] : [];
  }));
  return files.flat();
}

describe('terminology (N75-T11)', () => {
  it('keeps retired words out of the UI, server messages and the Agent Skill', async () => {
    const files = [...await sourceFiles(path.resolve('src')), path.resolve('skills/xr-collector-agent/SKILL.md')];
    const found: string[] = [];
    for (const file of files) {
      const lines = (await readFile(file, 'utf8')).split('\n');
      lines.forEach((line, index) => {
        for (const word of BANNED) if (line.includes(word)) found.push(`${path.relative(process.cwd(), file)}:${index + 1} ${word}`);
      });
    }
    expect(found).toEqual([]);
  });
});
