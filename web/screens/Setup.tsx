import type { ReactNode } from 'react';
import type { SetupStatus } from '../../shared/types';

/** README steps that fix each item. The anchors live in the README's setup section. */
const README = 'https://github.com/Meerav29/jev-sweep#';

interface Props {
  status: SetupStatus;
  authError?: boolean;
  onFolders: () => void;
  onRecheck: () => void;
}

export function Setup({ status, authError, onFolders, onRecheck }: Props) {
  const items: { key: string; ok: boolean; title: string; hint: string; fix: ReactNode }[] = [
    {
      key: 'typesafe', ok: status.typesafe, title: 'TypeSafe key found', hint: 'TYPESAFE_API_KEY in .env',
      fix: <a href={`${README}typesafe`} target="_blank" rel="noreferrer">How to add it</a>,
    },
    {
      key: 'anthropic', ok: status.anthropic, title: 'Anthropic key found (optional)',
      hint: 'ANTHROPIC_API_KEY in .env. Adds the "why" line and summaries on cards',
      fix: <a href={`${README}anthropic`} target="_blank" rel="noreferrer">Optional: how to add it</a>,
    },
    {
      key: 'google', ok: status.google, title: 'Google client found', hint: 'GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env',
      fix: <a href={`${README}google`} target="_blank" rel="noreferrer">How to create one</a>,
    },
    {
      key: 'gmail', ok: status.gmailConnected, title: 'Gmail connected', hint: 'One-time sign-in; the token stays on this machine',
      fix: status.google
        ? <a className="btn dark" href="/api/auth/google">Connect Gmail</a>
        : <span className="hint">Needs the Google client first</span>,
    },
    {
      key: 'folders', ok: status.foldersChosen, title: 'Folders chosen', hint: 'Which Gmail labels Jev may file into',
      fix: <button className="btn dark" onClick={onFolders} disabled={!status.gmailConnected}>Choose folders</button>,
    },
  ];
  return (
    <main className="screen">
      <div>
        <h1>Almost ready</h1>
        <p className="sub">A few things to set up before the first session.</p>
      </div>
      {authError && <p className="err" role="alert">Gmail sign-in didn't complete. Try Connect Gmail again.</p>}
      <ul className="checklist narrow" aria-label="Setup checklist">
        {items.map((it) => (
          <li key={it.key} className={it.ok ? 'ok' : 'todo'} data-testid={`setup-${it.key}`}>
            <span className="mark" aria-hidden="true">{it.ok ? '✓' : ''}</span>
            <span className="name">{it.title}<small>{it.hint}</small></span>
            {it.ok ? <span className="hint">Done</span> : it.fix}
          </li>
        ))}
      </ul>
      <button className="btn" onClick={onRecheck}>Check again</button>
    </main>
  );
}
