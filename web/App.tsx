import { useCallback, useEffect, useState } from 'react';
import type { SetupStatus } from '../shared/types';
import { api } from './api';
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

/** A session lives in the hash, so reloading mid-batch comes back to the same screen. */
function routeFromHash(): Route {
  const m = /^#\/session\/(.+)$/.exec(window.location.hash);
  return m ? { name: 'session', batchId: decodeURIComponent(m[1]) } : { name: 'home' };
}

export function App() {
  const [route, setRoute] = useState<Route>(routeFromHash);

  useEffect(() => {
    const hash = route.name === 'session' ? `#/session/${encodeURIComponent(route.batchId)}` : '';
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
  if (route.name === 'session') {
    return (
      <Session batchId={route.batchId} onBack={home}
        onReviewing={(batchId) => setRoute({ name: 'board', batchId, readOnly: false })} />
    );
  }
  if (route.name === 'board') {
    // The board arrives in the next task; this keeps the route reachable.
    return (
      <main className="screen">
        <p className="sub">Board {route.batchId} is coming soon.</p>
        <button className="btn" onClick={home}>Back</button>
      </main>
    );
  }
  if (!complete(setup)) {
    return <Setup status={setup} authError={authError} onFolders={() => setRoute({ name: 'folders' })} onRecheck={refresh} />;
  }
  return (
    <Home
      onSession={(batchId) => setRoute({ name: 'session', batchId })}
      onPast={(batchId) => setRoute({ name: 'board', batchId, readOnly: true })}
      onFolders={() => setRoute({ name: 'folders' })}
    />
  );
}
