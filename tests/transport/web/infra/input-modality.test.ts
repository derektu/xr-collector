// Broken, focus outlines show after a mouse click or Escape, or stay hidden while the user moves by keyboard.
import { describe, expect, it } from 'vitest';
import { nextModality, type InputModality, type ModalityEvent } from '../../../../src/transport/web/infra/input-modality.js';

const pointer: ModalityEvent = { type: 'pointerdown' };
const key = (name: string): ModalityEvent => ({ type: 'keydown', key: name });

describe('nextModality', () => {
  it.each<[string, ModalityEvent, InputModality | null, InputModality | null]>([
    ['a pointer press switches to pointer', pointer, 'keyboard', 'pointer'],
    ['a pointer press keeps pointer', pointer, 'pointer', 'pointer'],
    ['a pointer press before any input sets pointer', pointer, null, 'pointer'],
    ...['Tab', 'Enter', ' '].flatMap((name) => [
      [`${JSON.stringify(name)} switches to keyboard`, key(name), 'pointer', 'keyboard'],
      [`${JSON.stringify(name)} keeps keyboard`, key(name), 'keyboard', 'keyboard'],
    ] satisfies [string, ModalityEvent, InputModality, InputModality][]),
    ['Escape after a pointer press keeps pointer, so a mouse-opened menu closed by Escape shows no outline', key('Escape'), 'pointer', 'pointer'],
    ...['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].map((name) => [
      `${name} after a pointer press keeps pointer, so arrowing through a clicked radio group shows no outline`, key(name), 'pointer', 'pointer',
    ] satisfies [string, ModalityEvent, InputModality, InputModality]),
    ['Escape keeps keyboard', key('Escape'), 'keyboard', 'keyboard'],
    ['typing a character keeps pointer, so typing into a clicked field changes nothing', key('a'), 'pointer', 'pointer'],
    ['other keys before any input leave it undecided', key('Escape'), null, null],
  ])('%s', (_rule, event, current, expected) => {
    expect(nextModality(current, event)).toBe(expected);
  });
});
