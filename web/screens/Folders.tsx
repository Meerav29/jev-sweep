import { useEffect, useState } from 'react';
import type { Folder } from '../../shared/types';
import { api } from '../api';

const MANY = 15;

/**
 * Labels from Gmail merged with what was saved. A first visit (nothing saved) starts with every label on.
 * Saved folders whose label has since gone are dropped: Jev can't file into a label that no longer exists.
 */
export function mergeFolders(labels: string[], saved: Folder[]): Folder[] {
  if (saved.length === 0) return labels.map((name) => ({ name, enabled: true }));
  const byName = new Map(saved.map((f) => [f.name, f]));
  return labels.map((name) => byName.get(name) ?? { name, enabled: false });
}

export function Folders({ onDone }: { onDone: () => void }) {
  const [folders, setFolders] = useState<Folder[] | null>(null);
  const [error, setError] = useState<string | undefined>();
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let live = true;
    Promise.all([api.labels(), api.settings()])
      .then(([labels, s]) => live && setFolders(mergeFolders(labels, s.folders)))
      .catch((e: Error) => live && setError(e.message));
    return () => { live = false; };
  }, []);

  const patch = (name: string, change: Partial<Folder>) =>
    setFolders((fs) => fs && fs.map((f) => (f.name === name ? { ...f, ...change } : f)));

  const save = async () => {
    if (!folders) return;
    setSaving(true);
    setError(undefined);
    try {
      await api.saveSettings({
        folders: folders.map((f) => {
          const out: Folder = { name: f.name, enabled: f.enabled };
          if (f.description?.trim()) out.description = f.description.trim();
          return out;
        }),
      });
      onDone();
    } catch (e) {
      setError((e as Error).message);
      setSaving(false);
    }
  };

  const enabled = folders?.filter((f) => f.enabled).length ?? 0;

  return (
    <main className="screen">
      <div>
        <h1>Folders</h1>
        <p className="sub">Jev may file mail into the labels you tick.</p>
      </div>
      {error && <p className="err" role="alert">{error}</p>}
      {folders?.length === 0 && <p className="hint">No labels found in Gmail yet. Create one there, then come back.</p>}
      {folders && folders.length > 0 && (
        <section className="narrow">
          {enabled > MANY && <p className="hint" style={{ marginBottom: 8 }}>Fewer folders make Jev more confident</p>}
          <ul className="flist">
            {folders.map((f) => (
              <li key={f.name} className="frow">
                <input type="checkbox" id={`f-${f.name}`} checked={f.enabled} onChange={(e) => patch(f.name, { enabled: e.target.checked })} />
                <label htmlFor={`f-${f.name}`}>{f.name}</label>
                <input type="text" placeholder="Optional description, e.g. receipts and invoices" aria-label={`Description for ${f.name}`}
                  value={f.description ?? ''} disabled={!f.enabled} onChange={(e) => patch(f.name, { description: e.target.value })} />
              </li>
            ))}
          </ul>
        </section>
      )}
      <div className="row">
        <button className="btn ghost" onClick={onDone}>Cancel</button>
        <button className="btn dark" onClick={save} disabled={!folders || saving}>Save folders</button>
      </div>
    </main>
  );
}
