import { useId, useRef, useState } from 'react';
import { useDismiss } from './infra/dismiss.js';
import { useFloatingPosition, type Place } from './infra/floating-position.js';
import { useTimeout } from './infra/timing.js';

const LEAVE_CLOSE_MS = 180;
const CARD_MARGIN = 12;
const CARD_GAP = 6;

function cardPlace(onboarding: boolean): Place {
  return (trigger, card, viewport) => {
    const roomBelow = viewport.height - trigger.bottom - CARD_GAP - CARD_MARGIN;
    const roomAbove = trigger.top - CARD_GAP - CARD_MARGIN;
    const below = roomBelow >= card.height || roomBelow >= roomAbove;
    const top = Math.min(viewport.height - CARD_MARGIN - card.height,
      Math.max(CARD_MARGIN, below ? trigger.bottom + CARD_GAP : trigger.top - CARD_GAP - card.height));
    const preferredLeft = onboarding ? trigger.right - card.width + 10 : trigger.left - 10;
    const left = Math.min(viewport.width - CARD_MARGIN - card.width, Math.max(CARD_MARGIN, preferredLeft));
    return { top, left };
  };
}

export function AgentConnectionHelp({ onboarding = false }: { onboarding?: boolean }) {
  const [hovered, setHovered] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  const card = useRef<HTMLSpanElement>(null);
  const id = useId();
  const open = hovered || pinned;
  const enter = () => { setLeaving(false); setHovered(true); };
  const leave = () => { if (!pinned) setLeaving(true); };
  const close = () => { setLeaving(false); setPinned(false); setHovered(false); };
  useTimeout(() => { setLeaving(false); setHovered(false); }, leaving ? LEAVE_CLOSE_MS : null);
  useDismiss(open, root, close);
  useFloatingPosition(open, root, card, cardPlace(onboarding));
  return <span className={`agent-help ${onboarding ? 'onboarding-agent-help' : ''}`} ref={root}
    onMouseEnter={enter} onMouseLeave={leave}>
    <button type="button" className="agent-help-button" aria-label="AI 助理連線步驟" aria-expanded={open} aria-controls={id}
      onClick={() => setPinned((value) => { if (value) setHovered(false); return !value; })} onFocus={enter} onBlur={leave}>?</button>
    {open ? <span className="agent-help-card" id={id} role="tooltip" ref={card}>
      <strong>讓 AI 助理連線</strong>
      <ol><li>下載 Skill。</li><li>解壓縮後，把整個 <code>xr-collector-agent</code> 資料夾放到所用 Agent 的 Skill 目錄：Claude Code 使用 <code>~/.claude/skills/</code>，Codex 使用 <code>~/.agents/skills/</code>；其他 Agent 依其安裝方式操作，再開啟新的對話。</li><li>需要手動設定時，複製這台電腦的連線資料。</li><li>告訴 Agent：依照 XR Collector Skill，使用這份連線資料先檢查 health，再查詢文件。</li></ol>
      <span className="agent-help-note">下載包已包含連線資料；只有分開安裝或更新連線時才需要另外複製。</span>
    </span> : null}
  </span>;
}
