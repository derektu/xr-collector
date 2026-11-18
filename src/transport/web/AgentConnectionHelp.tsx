import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';

/** A readable hover explanation that can also be pinned for keyboard and touch users. */
export function AgentConnectionHelp({ onboarding = false }: { onboarding?: boolean }) {
  const [hovered, setHovered] = useState(false);
  const [pinned, setPinned] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  const card = useRef<HTMLSpanElement>(null);
  const closeTimer = useRef<number | undefined>(undefined);
  const [placement, setPlacement] = useState<CSSProperties>({ position: 'fixed', visibility: 'hidden' });
  const id = useId();
  const open = hovered || pinned;
  const enter = () => { if (closeTimer.current !== undefined) window.clearTimeout(closeTimer.current); setHovered(true); };
  const leave = () => { if (pinned) return; closeTimer.current = window.setTimeout(() => setHovered(false), 180); };
  const close = () => { if (closeTimer.current !== undefined) window.clearTimeout(closeTimer.current); setPinned(false); setHovered(false); };
  useEffect(() => () => { if (closeTimer.current !== undefined) window.clearTimeout(closeTimer.current); }, []);
  useEffect(() => {
    if (!open) return undefined;
    const closeOutside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) close(); };
    const closeEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') close(); };
    document.addEventListener('pointerdown', closeOutside);
    document.addEventListener('keydown', closeEscape);
    return () => { document.removeEventListener('pointerdown', closeOutside); document.removeEventListener('keydown', closeEscape); };
  }, [open]);
  useLayoutEffect(() => {
    if (!open) return undefined;
    const place = () => {
      if (!root.current || !card.current) return;
      const margin = 12;
      const gap = 6;
      const trigger = root.current.getBoundingClientRect();
      const width = Math.min(360, window.innerWidth - margin * 2);
      const maxHeight = window.innerHeight - margin * 2;
      card.current.style.width = `${width}px`;
      card.current.style.maxHeight = `${maxHeight}px`;
      const height = card.current.getBoundingClientRect().height;
      const roomBelow = window.innerHeight - trigger.bottom - gap - margin;
      const roomAbove = trigger.top - gap - margin;
      const below = roomBelow >= height || roomBelow >= roomAbove;
      const top = Math.min(window.innerHeight - margin - height,
        Math.max(margin, below ? trigger.bottom + gap : trigger.top - gap - height));
      const preferredLeft = onboarding ? trigger.right - width + 10 : trigger.left - 10;
      const left = Math.min(window.innerWidth - margin - width, Math.max(margin, preferredLeft));
      setPlacement({ position: 'fixed', visibility: 'visible', top, left, right: 'auto', width, maxHeight, overflowY: 'auto' });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [onboarding, open]);
  return <span className={`agent-help ${onboarding ? 'onboarding-agent-help' : ''}`} ref={root}
    onMouseEnter={enter} onMouseLeave={leave}>
    <button type="button" className="agent-help-button" aria-label="AI 助理連線步驟" aria-expanded={open} aria-controls={id}
      onClick={() => setPinned((value) => { if (value) setHovered(false); return !value; })} onFocus={enter} onBlur={leave}>?</button>
    {open ? <span className="agent-help-card" id={id} role="tooltip" ref={card} style={placement}>
      <strong>讓 AI 助理連線</strong>
      <ol><li>下載 Skill。</li><li>解壓縮後，把整個 <code>xr-collector-agent</code> 資料夾放到所用 Agent 的 Skill 目錄：Claude Code 使用 <code>~/.claude/skills/</code>，Codex 使用 <code>~/.agents/skills/</code>；其他 Agent 依其安裝方式操作，再開啟新的對話。</li><li>需要手動設定時，複製這台電腦的連線資料。</li><li>告訴 Agent：依照 XR Collector Skill，使用這份連線資料先檢查 health，再查詢文件。</li></ol>
      <span className="agent-help-note">下載包已包含連線資料；只有分開安裝或更新連線時才需要另外複製。</span>
    </span> : null}
  </span>;
}
