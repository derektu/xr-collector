import { useRef } from 'react';
import { radioIndexForKey } from './app-shell.js';

type GroupName = { label: string; labelledBy?: never } | { labelledBy: string; label?: never };

export function SegmentedChoice<V extends string | number>({ options, value, onChange, label, labelledBy, disabled = false, testId }: {
  options: ReadonlyArray<{ value: V; label: string }>;
  value: V;
  onChange: (value: V) => void;
  disabled?: boolean;
  testId?: string;
} & GroupName) {
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);
  const current = options.findIndex((option) => option.value === value);
  return <div className="segmented" role="radiogroup" aria-label={label} aria-labelledby={labelledBy} data-testid={testId} data-value={String(value)} onKeyDown={(event) => {
    const next = radioIndexForKey(event.key, current, options.length);
    if (next === null || disabled) return;
    event.preventDefault();
    onChange(options[next]!.value);
    buttons.current[next]?.focus();
  }}>
    {options.map((option, index) => <button key={String(option.value)} ref={(element) => { buttons.current[index] = element; }} type="button" role="radio"
      aria-checked={option.value === value} tabIndex={option.value === value ? 0 : -1} className={option.value === value ? 'active' : undefined}
      disabled={disabled} onClick={() => onChange(option.value)} data-value={String(option.value)}>{option.label}</button>)}
  </div>;
}
