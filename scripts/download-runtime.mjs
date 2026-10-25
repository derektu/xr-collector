#!/usr/bin/env node
import { prepareRuntimeDependencies } from './runtime-dependencies.mjs';

const target = process.argv[2] === 'mac'
  ? 'darwin-arm64'
  : process.argv[2] === 'win'
    ? 'win32-x64'
    : null;

if (!target) {
  console.error('Usage: node scripts/download-runtime.mjs <mac|win>');
  process.exitCode = 1;
} else {
  await prepareRuntimeDependencies({ target });
}
