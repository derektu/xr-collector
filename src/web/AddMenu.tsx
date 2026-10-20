import { useEffect, useRef, useState } from 'react';
import { menuIndexForKey, unsupportedText, type AddMenuItem, type AddMode } from './add-menu.js';
import { Icon } from './icons.js';

/**
 * A button that opens its add menu right below it. Supported items open their add dialog through
 * `onChoose`; the others open a dialog saying they are not supported yet. Escape, a click outside
 * and choosing an item close the menu; focus returns to the button whenever the menu or the
 * unsupported dialog closes from the keyboard or a dialog button.
 */
export function AddMenu({ label, items, onChoose, primary, align = 'end', testId }: {
  label: string;
  items: readonly AddMenuItem[];
  onChoose: (mode: AddMode) => void;
  primary?: boolean;
  /** Which edge of the button the menu lines up with. */
  align?: 'start' | 'end';
  testId: string;
}) {
  const [open, setOpen] = useState(false);
  const [unsupported, setUnsupported] = useState<AddMenuItem | null>(null);
  const anchor = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const entries = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    if (!open) return undefined;
    entries.current[0]?.focus();
    const outside = (event: Event) => { if (!anchor.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', outside);
    return () => document.removeEventListener('mousedown', outside);
  }, [open]);

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
      onClick={() => setOpen((value) => !value)}
      onKeyDown={(event) => { if (event.key === 'ArrowDown' && !open) { event.preventDefault(); setOpen(true); } }} data-testid={testId}><Icon name="plus" size={15} />{label}</button>
    {open ? <div className="menu" role="menu" aria-label={label} data-testid={`${testId}-menu`} onKeyDown={(event) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return; }
      if (event.key === 'Tab') { event.preventDefault(); close(); return; }
      const current = entries.current.findIndex((entry) => entry === document.activeElement);
      const next = menuIndexForKey(event.key, current, items.length);
      if (next === null) return;
      event.preventDefault();
      entries.current[next]?.focus();
    }}>
      {items.map((item, index) => <button key={item.id} ref={(element) => { entries.current[index] = element; }} type="button" role="menuitem"
        tabIndex={-1} onClick={() => choose(item)} data-testid={`add-item-${item.id}`}>
        <span>{item.label}</span>{item.mode ? null : <span className="menu-tag">尚未支援</span>}
      </button>)}
    </div> : null}
    {unsupported ? <UnsupportedDialog item={unsupported} onClose={() => { setUnsupported(null); button.current?.focus(); }} /> : null}
  </div>;
}

/** Says that an add menu item is not supported yet. */
function UnsupportedDialog({ item, onClose }: { item: AddMenuItem; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const confirm = useRef<HTMLButtonElement>(null);
  // The modal dialog closes first, so the menu button outside it can take focus back.
  const finish = () => { dialog.current?.close(); onClose(); };
  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
    confirm.current?.focus();
  }, []);
  return <dialog ref={dialog} className="confirm-dialog" aria-labelledby="unsupported-title" data-testid="unsupported-dialog"
    onCancel={(event) => { event.preventDefault(); finish(); }}>
    <h2 id="unsupported-title">{item.dialogTitle}</h2>
    <p>{unsupportedText(item)}</p>
    <div className="dialog-actions">
      <button ref={confirm} type="button" className="button primary" onClick={finish}>知道了</button>
    </div>
  </dialog>;
}
