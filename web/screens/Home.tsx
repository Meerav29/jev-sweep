import { useEffect, useState } from 'react';
import type { SessionSummary, Settings } from '../../shared/types';
import { api } from '../api';

const SIZES: Settings['batchSize'][] = [10, 20, 30, 50];
const BAR_COLORS = ['#BDBDBD', '#5D5D5D', '#292929', '#C2362B'];

interface Props {
  onSession: (batchId: string) => void;
  onPast: (batchId: string) => void;
  onFolders: () => void;
}

function SplitBar({ split, total }: { split: SessionSummary['split']; total: number }) {
  const parts = [split.archived, split.filed, split.you, split.important];
  // "you" and "important" overlap the other segments, so never let the bar claim more than the whole.
  const denom = Math.max(total, parts.reduce((a, b) => a + b, 0), 1);
  return (
    <span className="bar" aria-hidden="true">
      {parts.map((v, i) => <i key={i} style={{ width: `${(v / denom) * 100}%`, background: BAR_COLORS[i] }} />)}
    </span>
  );
}

const when = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
};

export function Home({ onSession, onPast, onFolders }: Props) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  const [error, setError] = useState<string | undefined>();
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    let live = true;
    api.settings().then((s) => live && setSettings(s)).catch((e: Error) => live && setError(e.message));
    api.sessions().then((s) => live && setSessions(s)).catch((e: Error) => live && setError(e.message));
    return () => { live = false; };
  }, []);

  const save = async (patch: Partial<Settings>) => {
    setError(undefined);
    try {
      setSettings(await api.saveSettings(patch));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const start = async () => {
    setStarting(true);
    setError(undefined);
    try {
      onSession((await api.startSession()).batchId);
    } catch (e) {
      setError((e as Error).message);
      setStarting(false);
    }
  };

  const unfinished = sessions?.find((s) => s.unfinishedBatchId)?.unfinishedBatchId;

  return (
    <main className="screen">
      <div>
        <h1>Inbox, a batch at a time</h1>
        <p className="sub">Jev sorts what it's sure about. You only see what it isn't.</p>
      </div>
      {error && <p className="err" role="alert">{error}</p>}
      <div className="start">
        <button className="btn dark" onClick={start} disabled={starting}>Start new session</button>
        {unfinished && <button className="btn" onClick={() => onSession(unfinished)}>Resume unfinished batch</button>}
        <div className="seg" role="group" aria-label="Emails per batch">
          {SIZES.map((n) => (
            <button key={n} className={settings?.batchSize === n ? 'on' : ''} aria-pressed={settings?.batchSize === n}
              disabled={!settings} onClick={() => save({ batchSize: n })}>{n}</button>
          ))}
        </div>
        <div className="hint">emails per batch · oldest unread first</div>
      </div>
      <section className="past narrow">
        <div className="lbl">Past sessions</div>
        {sessions?.length === 0 && <div className="empty">No sessions yet.</div>}
        {sessions?.map((s) => (
          <button key={s.id} className="prow" disabled={!s.lastBatchId} onClick={() => s.lastBatchId && onPast(s.lastBatchId)}>
            <span className="d">{when(s.startedAt)}</span>
            <span><b>{s.total} emails</b> · {s.batches} batch{s.batches === 1 ? '' : 'es'}</span>
            <SplitBar split={s.split} total={s.total} />
          </button>
        ))}
      </section>
      <div className="footer-links">
        <button className="btn ghost" onClick={onFolders}>Settings</button>
        <label className="toggle">
          <input type="checkbox" checked={settings?.dryRun ?? false} disabled={!settings}
            onChange={(e) => save({ dryRun: e.target.checked })} />
          Dry run (nothing changes in Gmail)
        </label>
      </div>
    </main>
  );
}
