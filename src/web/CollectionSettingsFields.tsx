import { Fragment } from 'react';
import { sourceDeclaration } from '../core/source-registry.js';
import type { SourceSettingField, SubscriptionSettings } from '../core/types.js';

/**
 * The collection settings of one subscription as a check interval row and a sentence saying what
 * every check collects. Options and labels come from the source type's declared fields, and the
 * sentence's words from its subscription declaration; a type without a sentence shows each range
 * field in a row with its own label.
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
  const select = (key: string, attributes: { id?: string; 'aria-label'?: string }) => {
    const declared = field(key);
    if (!declared) return null;
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
  return <div className="collection-settings">
    {interval ? <div className="policy-row">
      <label htmlFor={`${idPrefix}-interval`}>{interval.label}</label>
      {select('intervalMinutes', { id: `${idPrefix}-interval` })}
    </div> : null}
    {sentence ? <div className="policy-row">
      <span>每次檢查</span>
      <span className="policy-sentence">
        {sentence.map((part, index) => typeof part === 'string'
          ? <span key={index}>{part}</span>
          : <Fragment key={index}>{select(part.field, { 'aria-label': field(part.field)?.label ?? part.field })}</Fragment>)}
      </span>
    </div> : rangeFields.map((candidate) => <div className="policy-row" key={candidate.key}>
      <label htmlFor={`${idPrefix}-${candidate.key}`}>{candidate.label}</label>
      {select(candidate.key, { id: `${idPrefix}-${candidate.key}` })}
    </div>)}
  </div>;
}
