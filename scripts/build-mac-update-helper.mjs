#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { mkdir, chmod } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
if (process.platform !== 'darwin') throw new Error('The macOS update helper must be compiled on the local Mac.');
if (args.length > 2 || (args.length && args[0] !== '--output')) throw new Error('Usage: node scripts/build-mac-update-helper.mjs [--output <absolute-or-relative-file>]');
const output = path.resolve(root, args[1] ?? 'resources/bin/mac/xr-mac-update-helper');
await mkdir(path.dirname(output), { recursive: true });
const result = spawnSync('/usr/bin/xcrun', ['swiftc', '-swift-version', '5', '-O', '-target', 'arm64-apple-macos12.0', path.join(root, 'src/electron/mac-update-helper.swift'), '-o', output], { cwd: root, stdio: 'inherit' });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
await chmod(output, 0o755);
console.log(`macOS arm64 update helper: ${output}`);
