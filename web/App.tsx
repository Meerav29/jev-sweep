import { useCallback, useEffect, useState } from 'react';
import type { SetupStatus } from '../shared/types';
import { api } from './api';
import { Board } from './screens/Board';
import { Folders } from './screens/Folders';
import { Home } from './screens/Home';
import { Session } from './screens/Session';
import { Setup } from './screens/Setup';
import './styles/tokens.css';
import './styles/app.css';
import './styles/motion.css';

export type Route =
  | { name: 'home' }
  | { name: 'folders' }
  | { name: 'session'; batchId: string }
  | { name: 'board'; batchId: string; readOnly: boolean };

const complete = (s: SetupStatus) => s.typesafe && s.anthropic && s.google && s.gmailConnected && s.foldersChosen;

/** Reads `?auth=error` once, then clears it so a reload doesn't show the error again. */
function takeAuthError(): boolean {
  const params = new URLSearchParams(window.location.search);
  if (params.get('auth') !== 'error') return false;
  params.delete('auth');
  const q = params.toString();
  window.history.replaceState(null, '', window.location.pathname + (q ? `?${q}` : '') + window.location.hash);
  return true;
}

/** A session, board or receipt lives in the hash, so a reload comes back to the same screen. */
function routeFromHash(): Route {
  const m = /^#\/(session|board|receipt)\/(.+)$/.exec(window.location.hash);
  if (!m) return { name: 'home' };
  let batchId: string;
  try {
    batchId = decodeURIComponent(m[2]);
  } catch {
    return { name: 'home' }; // a mangled hash is not worth an error screen
  }
  if (m[1] === 'session') return { name: 'session', batchId };
  return { name: 'board', batchId, readOnly: m[1] === 'receipt' };
}

function hashOf(route: Route): string {
  if (route.name === 'session') return `#/session/${encodeURIComponent(route.batchId)}`;
  if (route.name === 'board') return `#/${route.readOnly ? 'receipt' : 'board'}/${encodeURIComponent(route.batchId)}`;
  return '';
}

export function App() {
  const [route, setRoute] = useState<Route>(routeFromHash);

  useEffect(() => {
    const hash = hashOf(route);
    if (window.location.hash === hash) return;
    window.history.replaceState(null, '', window.location.pathname + window.location.search + hash);
  }, [route]);
  const [setup, setSetup] = useState<SetupStatus | null>(null);
  const [loadError, setLoadError] = useState<string | undefined>();
  const [authError, setAuthError] = useState(false);

  // An effect, not an initializer: StrictMode runs both twice, and only the first run may see the query string.
  useEffect(() => { if (takeAuthError()) setAuthError(true); }, []);

  const refresh = useCallback(() => {
    setLoadError(undefined);
    api.setup().then(setSetup).catch((e: Error) => setLoadError(e.message));
  }, []);
  useEffect(refresh, [refresh]);

  const home = () => { setRoute({ name: 'home' }); refresh(); };

  if (loadError) {
    return (
      <main className="screen">
        <p className="err" role="alert">Can't reach the jev-sweep server: {loadError}</p>
        <button className="btn" onClick={refresh}>Try again</button>
      </main>
    );
  }
  if (!setup) return <main className="screen"><p className="hint">Loading…</p></main>;

  if (route.name === 'folders') return <Folders onDone={home} />;
  // Setup comes before any hashed route: a reload with setup undone must not open a batch.
  if (!complete(setup)) {
    return <Setup status={setup} authError={authError} onFolders={() => setRoute({ name: 'folders' })} onRecheck={refresh} />;
  }
  if (route.name === 'session') {
    return (
      <Session batchId={route.batchId} onBack={home}
        onReviewing={(batchId) => setRoute({ name: 'board', batchId, readOnly: false })} />
    );
  }
  if (route.name === 'board') {
    return (
      <Board key={`${route.batchId}:${route.readOnly}`} batchId={route.batchId} readOnly={route.readOnly}
        onHome={home} onSession={(batchId) => setRoute({ name: 'session', batchId })} />
    );
  }
  return (
    <Home
      onSession={(batchId) => setRoute({ name: 'session', batchId })}
      onReview={(batchId) => setRoute({ name: 'board', batchId, readOnly: false })}
      onPast={(batchId) => setRoute({ name: 'board', batchId, readOnly: true })}
      onFolders={() => setRoute({ name: 'folders' })}
    />
  );
}
