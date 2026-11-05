// The source types a reader is handed: one value built from a list, in its order, that cannot
// change after it is built. A page or job of a type the value lacks reads as unknown, and two values
// built from different lists answer each from its own list.
import { describe, expect, it } from 'vitest';
import { roleOf } from '../../src/core/job-role.js';
import { SourceDeclarations } from '../../src/core/source-registry.js';
import { sourceRegistry } from '../../src/plugins/index.js';
import { fakeDefinition } from '../support/fake-source-plugin.js';

const fake = fakeDefinition('fake', 'fake-net');
const fake2 = fakeDefinition('fake2', 'fake2-net');

describe('source declarations', () => {
  it('keeps the list order and looks types up by ID', () => {
    const declarations = new SourceDeclarations([fake2, fake]);
    expect(declarations.list.map((declaration) => declaration.id)).toEqual(['fake2', 'fake']);
    expect(declarations.get('fake')).toBe(fake);
    expect(declarations.get('other')).toBeUndefined();
    expect(declarations.jobKind('fake', 'check')).toBe('fake.feed');
    expect(declarations.jobKind('other', 'check')).toBeNull();
  });

  it('is not built from an empty list or a type listed twice', () => {
    expect(() => new SourceDeclarations([])).toThrow('No source types are given');
    expect(() => new SourceDeclarations([fake, fake])).toThrow('Source type fake is given twice');
  });

  it('does not change after it is built', () => {
    const list = [fake];
    const declarations = new SourceDeclarations(list);
    list.push(fake2);
    expect(declarations.list.map((declaration) => declaration.id)).toEqual(['fake']);
    expect(() => (declarations.list as unknown[]).push(fake2)).toThrow(TypeError);
    expect(Object.isFrozen(declarations)).toBe(true);
  });

  it('answers from its own list beside a value of another list', () => {
    const one = new SourceDeclarations([fake]);
    const other = new SourceDeclarations([fake2]);
    expect(roleOf(one, { kind: 'fake.feed' })).toBe('check');
    expect(roleOf(other, { kind: 'fake.feed' })).toBeNull();
    expect(roleOf(other, { kind: 'fake2.feed' })).toBe('check');
  });

  it('as a registry, holds the definitions, the schedule file and a subscription exchange of its own types, and does not change', () => {
    const one = sourceRegistry([fake]);
    const both = sourceRegistry([fake2, fake]);
    expect(one.require('fake')).toBe(fake);
    expect(() => one.require('fake2')).toThrow('Source type fake2 is not registered');
    expect(one.exchange.files().map((file) => file.type)).toEqual(['fake']);
    expect(both.exchange.files().map((file) => file.type)).toEqual(['fake2', 'fake']);
    expect(Object.isFrozen(one)).toBe(true);
    expect(() => (one.definitions as unknown[]).push(fake2)).toThrow(TypeError);
  });
});
