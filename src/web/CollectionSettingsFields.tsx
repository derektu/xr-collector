import type { CollectionPolicy, SourceSettingField } from '../core/types.js';

/**
 * The collection settings of one subscription as a check interval row and a backfill sentence.
 * Options and labels come from the source type's declared fields; `backfillLabel` names when the
 * backfill applies, such as the first collection or a resume.
 */
export function CollectionSettingsFields({ idPrefix, fields, value, onChange, backfillLabel, backfillLead, disabled = false }: {
  idPrefix: string;
  fields: SourceSettingField[];
  value: CollectionPolicy;
  onChange: (patch: Partial<CollectionPolicy>) => void;
  backfillLabel: string;
  backfillLead: string;
  disabled?: boolean;
}) {
  const field = (key: keyof CollectionPolicy) => fields.find((candidate) => candidate.key === key);
  const select = (key: keyof CollectionPolicy, attributes: { id?: string; 'aria-label'?: string }) => {
    const declared = field(key);
    if (!declared) return null;
    return <select {...attributes} value={String(value[key])} disabled={disabled} data-testid={`${idPrefix}-${key}`}
      onChange={(event) => {
        const option = declared.options.find((candidate) => String(candidate.value) === event.target.value);
        if (option) onChange({ [key]: option.value } as Partial<CollectionPolicy>);
      }}>
      {declared.options.map((option) => <option key={String(option.value)} value={String(option.value)}>{option.label}</option>)}
    </select>;
  };
  const interval = field('intervalMinutes');
  return <div className="collection-settings">
    {interval ? <div className="policy-row">
      <label htmlFor={`${idPrefix}-interval`}>{interval.label}</label>
      {select('intervalMinutes', { id: `${idPrefix}-interval` })}
    </div> : null}
    <div className="policy-row">
      <span>{backfillLabel}</span>
      <span className="policy-sentence">
        <span>{backfillLead}</span>
        {select('backfillWindow', { 'aria-label': `${backfillLabel}時間範圍` })}
        <span>內最新的</span>
        {select('backfillMaxItems', { 'aria-label': `${backfillLabel}數量` })}
      </span>
    </div>
  </div>;
}
