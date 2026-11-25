/*
 * SPDX-License-Identifier: MIT
 */
/// <reference types="node" />
// External: Windows reserves these device names, with or without an extension.
// https://learn.microsoft.com/en-us/windows/win32/fileio/naming-a-file#naming-conventions
export const RESERVED = ['con', 'prn', 'aux', 'nul'];

// prettier-ignore
export const MATRIX = [1,0, 0,1];
