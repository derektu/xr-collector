import { useRef, useState } from 'react';
import { showModalOnMount } from '../infra/dialog.js';
import { useDismiss } from '../infra/dismiss.js';
import { menuPlace, useFloatingPosition } from '../infra/floating-position.js';
import { menuIndexForKey, unsupportedText, type AddMenuItem, type AddMode } from './add-menu.js';
import { Icon } from '../shell/icons.js';

export function AddMenu({ label, items, onChoose, primary, align = 'end', disabledReason, testId }: {
  label: string;
  items: readonly AddMenuItem[];
  onChoose: (mode: AddMode) => void;
  primary?: boolean;
  align?: 'start' | 'end';
  disabledReason?: string | null;
  testId: string;
}) {
  const [open, setOpen] = useState(false);
  if (open && disabledReason) setOpen(false);
  const [unsupported, setUnsupported] = useState<AddMenuItem | null>(null);
  const anchor = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const entries = useRef<Array<HTMLButtonElement | null>>([]);
  const list = useRef<HTMLDivElement>(null);
  useFloatingPosition(open, button, list, menuPlace(align));
  useDismiss(open, anchor, () => setOpen(false));

  function close(): void {
    setOpen(false);
    button.current?.focus();
  }

  function choose(item: AddMenuItem): void {
    setOpen(false);
    if (item.mode) onChoose(item.mode);
    else setUnsupported(item);
  }

  return <div className={`menu-anchor add-menu ${align}`} ref={anchor}>
    <button ref={button} type="button" className={primary ? 'button primary' : 'button'} aria-haspopup="menu" aria-expanded={open}
      disabled={Boolean(disabledReason)} title={disabledReason ?? undefined}
      onClick={() => setOpen((value) => !value)}
      onKeyDown={(event) => { if (event.key === 'ArrowDown' && !open) { event.preventDefault(); setOpen(true); } }} data-testid={testId}><Icon name="plus" size={15} />{label}</button>
    {open ? <div ref={list} className="menu" role="menu" aria-label={label} data-testid={`${testId}-menu`} onKeyDown={(event) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return; }
      if (event.key === 'Tab') { event.preventDefault(); close(); return; }
      const current = entries.current.findIndex((entry) => entry === document.activeElement);
      const next = menuIndexForKey(event.key, current, items.length);
      if (next === null) return;
      event.preventDefault();
      entries.current[next]?.focus();
    }}>
      {items.map((item, index) => <button key={item.id} ref={(element) => { entries.current[index] = element; }} type="button" role="menuitem"
        tabIndex={-1} autoFocus={index === 0} onClick={() => choose(item)} data-testid={`add-item-${item.id}`}>
        <span>{item.label}</span>{item.mode ? null : <span className="menu-tag">尚未支援</span>}
      </button>)}
    </div> : null}
    {unsupported ? <UnsupportedDialog item={unsupported} onClosed={() => { setUnsupported(null); button.current?.focus(); }} /> : null}
  </div>;
}

function UnsupportedDialog({ item, onClosed }: { item: AddMenuItem; onClosed: () => void }) {
  // External: A modal <dialog> makes the rest of the page inert, so nothing outside it takes focus while it is open.
  // https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/dialog
  const close = (dialog: HTMLDialogElement | null) => { dialog?.close(); onClosed(); };
  return <dialog ref={showModalOnMount} className="confirm-dialog" aria-labelledby="unsupported-title" data-testid="unsupported-dialog"
    onCancel={(event) => { event.preventDefault(); close(event.currentTarget); }}>
    <h2 id="unsupported-title">{item.dialogTitle}</h2>
    <p>{unsupportedText(item)}</p>
    <div className="dialog-actions">
      <button type="button" className="button primary" onClick={(event) => close(event.currentTarget.closest('dialog'))} data-initial-focus>知道了</button>
    </div>
  </dialog>;
}
