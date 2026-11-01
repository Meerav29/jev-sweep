import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { CardOption, CardSpec, Dest } from '../../shared/types';
import { reducedMotion } from '../components/flyTo';
import type { CardProps } from './registry';

/** How long a picked option stays lit while the others fold away, before the choice is sent. */
export const LOCK_IN_MS = 520;

const SYSTEM_LABELS = new Set(['INBOX', 'SPAM', 'TRASH', 'UNREAD', 'STARRED', 'IMPORTANT', 'SENT', 'DRAFT', 'CHAT']);
/** Mirrors the server's check: Gmail owns these names, so they can't be made into folders. */
export function isReservedLabel(name: string): boolean {
  const u = name.trim().toUpperCase();
  return SYSTEM_LABELS.has(u) || u.startsWith('CATEGORY_');
}

/** What a winning control is called while the card locks in, so it can be lit and the rest folded away. */
export type WinKey = `opt:${number}` | 'keep' | 'archive' | 'other' | 'reply';

/**
 * One choice per card: the first wins, everything after is ignored until the next card mounts
 * (cards are keyed by thread). A choice that fails comes back as an error on the card and unlocks it.
 */
export function useChoice(onChoose: CardProps['onChoose']) {
  const busy = useRef(false);
  const alive = useRef(true);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const [win, setWin] = useState<WinKey | null>(null);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; clearTimeout(timer.current); };
  }, []);

  const choose = useCallback((dest: Dest, opts: { star?: boolean } | undefined, key: WinKey, lockIn = false) => {
    if (busy.current) return;
    busy.current = true;
    setError(undefined);
    setWin(key);
    const send = () => {
      let result: void | Promise<void>;
      try {
        result = onChoose(dest, opts);
      } catch (e) {
        result = Promise.reject(e);
      }
      Promise.resolve(result).catch((e: unknown) => {
        if (!alive.current) return;
        busy.current = false;
        setWin(null);
        setError(e instanceof Error ? e.message : String(e));
      });
    };
    if (lockIn && !reducedMotion()) timer.current = setTimeout(send, LOCK_IN_MS);
    else send();
  }, [onChoose]);

  return { choose, win, error, busy };
}

const isTyping = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.isContentEditable || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT');

/** Keys 1–3 pick an option, unless the person is typing or holding a modifier. */
export function useOptionKeys(enabled: boolean, onKey: (i: number) => void) {
  const latest = useRef(onKey);
  latest.current = onKey;
  useEffect(() => {
    if (!enabled) return;
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || isTyping(e.target)) return;
      if (e.key === '1' || e.key === '2' || e.key === '3') {
        e.preventDefault();
        latest.current(Number(e.key) - 1);
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [enabled]);
}

export function CardHead({ card, title, context }: { card: CardSpec; title: string; context?: CardProps['context'] }) {
  return (
    <div className="q">
      <span>{title}</span>
      <span>{context ? `Batch ${context.batchNo} · #${card.n} of ${context.total}` : `#${card.n}`}</span>
    </div>
  );
}

export function Sender({ card }: { card: CardSpec }) {
  const initial = (card.fromName || card.fromAddress).trim().charAt(0).toUpperCase() || '?';
  return (
    <div className="from">
      <div className="av" aria-hidden="true">{initial}</div>
      <div><b>{card.fromName || card.fromAddress}</b><span>{card.fromAddress}</span></div>
    </div>
  );
}

export function GmailLink({ href }: { href: string }) {
  return <a className="btn ghost" href={href} target="_blank" rel="noopener noreferrer">Open in Gmail ↗</a>;
}

export function ChoiceError({ error }: { error?: string }) {
  return error ? <p className="err card-err" role="alert">Couldn't save that: {error}</p> : null;
}

export function Options({ options, win, onPick }: { options: CardOption[]; win: WinKey | null; onPick: (i: number) => void }) {
  return (
    <div className={`opts${win ? ' locked' : ''}`}>
      {options.map((o, i) => (
        <button key={o.dest} type="button" className={`opt${i === 0 ? ' top' : ''}${win === `opt:${i}` ? ' win' : ''}`}
          style={{ ['--i' as string]: i }} onClick={() => onPick(i)} tabIndex={win && win !== `opt:${i}` ? -1 : undefined}>
          <b><kbd aria-hidden="true">{i + 1}</kbd>{o.label}</b>
          <span className="pct">
            <span className="m" aria-hidden="true"><u style={{ width: `${Math.round(o.p * 100)}%` }} /></span>
            {Math.round(o.p * 100)}%
          </span>
        </button>
      ))}
    </div>
  );
}

/**
 * "Other folder…": pick any existing label, or type a new name to create it at apply time.
 * A name matching an existing label in any case means that label; Gmail's own names are refused.
 */
export function FolderCombo({ folders, disabled, onPick }: { folders: string[]; disabled: boolean; onPick: (name: string) => void }) {
  const id = useId();
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);

  const typed = text.trim();
  const reserved = typed !== '' && isReservedLabel(typed);
  const exact = folders.find((f) => f.toLowerCase() === typed.toLowerCase());
  const items = useMemo(() => {
    const q = typed.toLowerCase();
    const list: { key: string; label: string; name: string }[] = folders
      .filter((f) => f.toLowerCase().includes(q))
      .map((f) => ({ key: `f:${f}`, label: f, name: f }));
    if (typed && !exact && !reserved) list.push({ key: 'create', label: `Create “${typed}”`, name: typed });
    return list;
  }, [folders, typed, exact, reserved]);

  const pick = (name: string) => {
    if (disabled || isReservedLabel(name)) return;
    setOpen(false);
    onPick(name);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setActive((a) => Math.min(a + 1, items.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
    else if (e.key === 'Escape') setOpen(false);
    else if (e.key === 'Enter') {
      e.preventDefault();
      if (reserved) return;
      // A typed name that already exists wins over whatever is highlighted.
      if (exact) pick(exact);
      else if (open && items[active]) pick(items[active].name);
      else if (typed) pick(typed);
    }
  };

  const listId = `${id}-list`;
  const showList = open && (items.length > 0 || reserved);
  return (
    <div className="combo">
      <label className="sr-only" htmlFor={`${id}-input`}>Other folder</label>
      <input id={`${id}-input`} type="text" role="combobox" placeholder="Other folder…" autoComplete="off"
        aria-expanded={showList} aria-controls={listId} aria-autocomplete="list"
        aria-activedescendant={showList && items[active] ? `${id}-o${active}` : undefined}
        value={text} readOnly={disabled}
        onChange={(e) => { setText(e.target.value); setOpen(true); setActive(0); }}
        onFocus={() => setOpen(true)} onBlur={() => setOpen(false)} onKeyDown={onKeyDown} />
      {showList && (
        <ul className="combo-list" id={listId} role="listbox" aria-label="Folders">
          {reserved && <li className="combo-note" role="presentation">That name is reserved by Gmail</li>}
          {items.map((it, i) => (
            <li key={it.key} id={`${id}-o${i}`} role="option" aria-selected={i === active}
              className={`${i === active ? 'on' : ''}${it.key === 'create' ? ' create' : ''}`}
              // Keep focus in the input, so its blur doesn't close the list before the click lands.
              onMouseDown={(e) => e.preventDefault()} onClick={() => pick(it.name)}>
              {it.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
