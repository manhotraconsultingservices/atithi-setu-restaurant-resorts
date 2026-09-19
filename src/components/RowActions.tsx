// One Actions design for every record table (Restaurant invoices, PMS guest
// bills, Event bookings, Wellness invoices).
//
//   • The most-used actions show inline as same-size icon buttons, each with a
//     tooltip and an aria-label (the label is the accessible name).
//   • Everything else folds into a "…" menu, listed as icon + label, with
//     destructive actions (cancel, delete) last and in red.
//   • An action can be disabled with a reason, which becomes its tooltip.
//
// The menu is portalled to <body> and fixed-positioned from its button. Inside
// the table, later rows (sticky action cells, animated or blurred cards) painted
// over it and hid its first entries; a transformed ancestor also re-anchors a
// fixed element. At the body it sits above everything. It closes on outside
// click, Escape and scroll.
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { MoreHorizontal } from 'lucide-react';

export type RowActionTone = 'default' | 'primary' | 'success' | 'danger';

export interface RowAction {
  key: string;
  label: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
  onClick: () => void;
  /** Show as an inline icon button (true) or inside the "…" menu (false). */
  inline?: boolean;
  tone?: RowActionTone;
  /** Omit the action entirely (no permission, not applicable). */
  hidden?: boolean;
  disabled?: boolean;
  /** Shown as the tooltip when disabled, e.g. "Nothing is due on this bill". */
  reason?: string;
  /** A small dot on the icon, e.g. GST details already on file. */
  marked?: boolean;
}

const INLINE_TONE: Record<RowActionTone, string> = {
  default: 'text-[#6b5d52] hover:bg-[#faf7f2] hover:text-[#1a1208] border-[#e8dccf]',
  primary: 'text-brand hover:bg-brand/10 border-brand/25',
  success: 'text-emerald-700 hover:bg-emerald-50 border-emerald-200',
  danger: 'text-red-700 hover:bg-red-50 border-red-200',
};
const MENU_TONE: Record<RowActionTone, string> = {
  default: 'text-[#3d3128] hover:bg-[#faf7f2]',
  primary: 'text-brand hover:bg-brand/10',
  success: 'text-emerald-700 hover:bg-emerald-50',
  danger: 'text-red-700 hover:bg-red-50',
};

export function RowActions({ actions, moreLabel = 'More actions', align = 'end' }: {
  actions: RowAction[];
  moreLabel?: string;
  align?: 'start' | 'end';
}) {
  const visible = actions.filter(a => !a.hidden);
  let inline = visible.filter(a => a.inline);
  let menu = visible.filter(a => !a.inline);
  // A menu holding a single action saves no space: show it inline instead.
  if (menu.length === 1 && menu[0].tone !== 'danger') { inline = [...inline, menu[0]]; menu = []; }
  // Destructive actions go last in the menu.
  menu = [...menu.filter(a => a.tone !== 'danger'), ...menu.filter(a => a.tone === 'danger')];

  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!open || !btnRef.current) return;
    const r = btnRef.current.getBoundingClientRect();
    const w = menuRef.current?.offsetWidth || 200;
    const h = menuRef.current?.offsetHeight || 0;
    let left = align === 'end' ? r.right - w : r.left;
    left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
    let top = r.bottom + 4;
    if (h && top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 4);
    setPos({ top, left });
  }, [open, align]);

  useEffect(() => {
    if (!open) return;
    const outside = (e: Event) => {
      const t = e.target as Node;
      if (menuRef.current?.contains(t) || btnRef.current?.contains(t)) return;
      setOpen(false);
    };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); btnRef.current?.focus(); } };
    const away = () => setOpen(false);
    document.addEventListener('mousedown', outside);
    document.addEventListener('keydown', key);
    window.addEventListener('scroll', away, true);
    window.addEventListener('resize', away);
    return () => {
      document.removeEventListener('mousedown', outside);
      document.removeEventListener('keydown', key);
      window.removeEventListener('scroll', away, true);
      window.removeEventListener('resize', away);
    };
  }, [open]);

  return (
    <div className={`flex items-center gap-1 ${align === 'end' ? 'justify-end' : ''}`}>
      {inline.map(a => {
        const Icon = a.icon;
        const tip = a.disabled && a.reason ? a.reason : a.label;
        return (
          <button
            key={a.key}
            type="button"
            onClick={a.onClick}
            disabled={a.disabled}
            title={tip}
            aria-label={a.label}
            className={`relative w-8 h-8 shrink-0 rounded-lg border bg-white flex items-center justify-center transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-white ${INLINE_TONE[a.tone || 'default']}`}
          >
            <Icon size={15} />
            {a.marked && <span className="absolute top-1 right-1 w-1.5 h-1.5 rounded-full bg-emerald-500" aria-hidden="true" />}
          </button>
        );
      })}
      {menu.length > 0 && (
        <>
          <button
            ref={btnRef}
            type="button"
            onClick={() => setOpen(o => !o)}
            aria-haspopup="menu"
            aria-expanded={open}
            aria-label={moreLabel}
            title={moreLabel}
            className={`w-8 h-8 shrink-0 rounded-lg border bg-white flex items-center justify-center transition-colors ${open ? 'bg-[#faf7f2] text-[#1a1208] border-brand/30' : INLINE_TONE.default}`}
          >
            <MoreHorizontal size={16} />
          </button>
          {open && typeof document !== 'undefined' && createPortal(
            <div
              ref={menuRef}
              role="menu"
              style={{ position: 'fixed', top: pos?.top ?? -9999, left: pos?.left ?? -9999, zIndex: 1000 }}
              className="min-w-[200px] bg-white border border-[#e8dccf] rounded-xl shadow-lg py-1.5"
            >
              {menu.map((a, i) => {
                const Icon = a.icon;
                const firstDanger = a.tone === 'danger' && (i === 0 || menu[i - 1].tone !== 'danger');
                return (
                  <React.Fragment key={a.key}>
                    {firstDanger && i > 0 && <div className="my-1 border-t border-[#f0e9df]" role="separator" />}
                    <button
                      type="button"
                      role="menuitem"
                      disabled={a.disabled}
                      title={a.disabled && a.reason ? a.reason : undefined}
                      onClick={() => { setOpen(false); a.onClick(); }}
                      className={`w-full flex items-center gap-2.5 px-3 py-2 text-[13px] font-medium text-left transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${MENU_TONE[a.tone || 'default']}`}
                    >
                      <Icon size={15} className="shrink-0" />
                      <span className="flex-1">{a.label}</span>
                      {a.marked && <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" aria-hidden="true" />}
                    </button>
                  </React.Fragment>
                );
              })}
            </div>,
            document.body,
          )}
        </>
      )}
    </div>
  );
}
