// Broken, a reader treats a page or job of a type it was not handed as known, or two readers answer from each other's types.
import { describe, expect, it } from 'vitest';
import { roleOf } from '../../../src/shared/jobs/job-role.js';
import { SourceDeclarations } from '../../../src/shared/sources/source-registry.js';
import { sourceRegistry } from '../../../src/app/plugins/index.js';
import { fakeDefinition } from '../../support/fake-source-plugin.js';

const fake = fakeDefinition('fake', 'fake-net');
const fake2 = fakeDefinition('fake2', 'fake2-net');

describe('source declarations', () => {
  it('keeps the list order and looks types up by ID', () => {
    const declarations = new SourceDeclarations([fake2, fake]);
    expect(declarations.list.map((declaration) => declaration.id)).toEqual(['fake2', 'fake']);
    expect(declarations.get('fake')?.id).toBe('fake');
    expect(declarations.get('other')).toBeUndefined();
    expect(declarations.jobKind('fake', 'check')).toBe('fake.feed');
    expect(declarations.jobKind('other', 'check')).toBeNull();
  });

  it('names a type\'s subscriptions by its subscription kind, else by the type\'s label, else by its ID', () => {
    const singleOnly = { ...fake2, kinds: fake2.kinds.filter((kind) => kind.capability !== 'subscription') };
    const declarations = new SourceDeclarations([fake, singleOnly]);
    expect(declarations.subscriptionKindLabel('fake')).toBe('fake 動態');
    expect(declarations.subscriptionKindLabel('fake2')).toBe('Fake fake2');
    expect(declarations.subscriptionKindLabel('other')).toBe('other');
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
    expect(one.require('fake').id).toBe('fake');
    expect(() => one.require('fake2')).toThrow('Source type fake2 is not registered');
    expect(one.exchange.files().map((file) => file.type)).toEqual(['fake']);
    expect(both.exchange.files().map((file) => file.type)).toEqual(['fake2', 'fake']);
    expect(Object.isFrozen(one)).toBe(true);
    expect(() => (one.definitions as unknown[]).push(fake2)).toThrow(TypeError);
  });
});
