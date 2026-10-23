import { Fragment } from 'react';
import { settingFieldError, settingsErrors } from '../core/collection-settings.js';
import { sourceDeclaration } from '../core/source-registry.js';
import type { SourceSettingField, SubscriptionSettings } from '../core/types.js';

/** A typed number as a number when it is all digits; anything else stays text, which no number field accepts. */
function typedNumber(text: string): string | number {
  const trimmed = text.trim();
  return /^[0-9]+$/u.test(trimmed) ? Number(trimmed) : text;
}

/**
 * The collection settings of one subscription as a check interval row and a sentence saying what
 * every check collects. Inputs, limits and labels come from the source type's declared fields, and
 * the sentence's words from its subscription declaration; a type without a sentence shows each
 * range field in a row with its own label. `value` may hold what the user typed into a number
 * field even when it is invalid; each invalid field shows why under the fields, and the parent
 * checks the same fields with `settingsErrors` before it saves.
 */
export function CollectionSettingsFields({ idPrefix, type, fields, value, onChange, disabled = false }: {
  idPrefix: string;
  /** The source type whose settings these are. */
  type: string | null;
  fields: SourceSettingField[];
  value: SubscriptionSettings;
  onChange: (patch: Partial<SubscriptionSettings>) => void;
  disabled?: boolean;
}) {
  const field = (key: string) => fields.find((candidate) => candidate.key === key);
  const errorId = (key: string) => `${idPrefix}-${key}-error`;
  const control = (key: string, attributes: { id?: string; 'aria-label'?: string }) => {
    const declared = field(key);
    if (!declared) return null;
    if (declared.input === 'number') {
      const invalid = settingFieldError(declared, value[key]) !== null;
      return <span className="setting-number">
        <input {...attributes} type="text" inputMode="numeric" autoComplete="off" value={String(value[key] ?? '')} disabled={disabled}
          aria-invalid={invalid || undefined} aria-describedby={invalid ? errorId(key) : undefined} data-testid={`${idPrefix}-${key}`}
          onChange={(event) => onChange({ [key]: typedNumber(event.target.value) } as Partial<SubscriptionSettings>)} />
        <span>{declared.unit}</span>
      </span>;
    }
    return <select {...attributes} value={String(value[key])} disabled={disabled} data-testid={`${idPrefix}-${key}`}
      onChange={(event) => {
        const option = declared.options.find((candidate) => String(candidate.value) === event.target.value);
        if (option) onChange({ [key]: option.value } as Partial<SubscriptionSettings>);
      }}>
      {declared.options.map((option) => <option key={String(option.value)} value={String(option.value)}>{option.label}</option>)}
    </select>;
  };
  const interval = field('intervalMinutes');
  const sentence = type ? sourceDeclaration(type)?.subscription?.sentence : undefined;
  const rangeFields = fields.filter((candidate) => candidate.key !== 'intervalMinutes');
  const errors = settingsErrors(fields, value);
  return <div className="collection-settings">
    {interval ? <div className="policy-row">
      <label htmlFor={`${idPrefix}-interval`}>{interval.label}</label>
      {control('intervalMinutes', { id: `${idPrefix}-interval` })}
    </div> : null}
    {sentence ? <div className="policy-row">
      <span>每次檢查</span>
      <span className="policy-sentence">
        {sentence.map((part, index) => typeof part === 'string'
          ? <span key={index}>{part}</span>
          : <Fragment key={index}>{control(part.field, { 'aria-label': field(part.field)?.label ?? part.field })}</Fragment>)}
      </span>
    </div> : rangeFields.map((candidate) => <div className="policy-row" key={candidate.key}>
      <label htmlFor={`${idPrefix}-${candidate.key}`}>{candidate.label}</label>
      {control(candidate.key, { id: `${idPrefix}-${candidate.key}` })}
    </div>)}
    {errors.map((error) => <p key={error.key} id={errorId(error.key)} className="setting-error" role="alert"
      data-testid={`${idPrefix}-${error.key}-error`}>{error.message}</p>)}
  </div>;
}
