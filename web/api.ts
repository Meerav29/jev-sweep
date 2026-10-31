import type { BatchView, Dest, Settings, SessionSummary, SetupStatus } from '../shared/types';

/** Throws an Error carrying the server's `error` message on any non-2xx answer. */
async function request<T>(method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method };
  if (method !== 'GET') {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(body ?? {});
  }
  const res = await fetch(path, init);
  const text = await res.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = undefined;
  }
  if (!res.ok) {
    const msg = data && typeof data === 'object' && 'error' in data ? String((data as { error: unknown }).error) : '';
    throw new Error(msg || `Request failed (${res.status})`);
  }
  return data as T;
}

const batch = (id: string) => `/api/batches/${encodeURIComponent(id)}`;

export const api = {
  setup: () => request<SetupStatus>('GET', '/api/setup'),
  labels: () => request<string[]>('GET', '/api/labels'),
  settings: () => request<Settings>('GET', '/api/settings'),
  saveSettings: (patch: Partial<Settings>) => request<Settings>('PUT', '/api/settings', patch),
  sessions: () => request<SessionSummary[]>('GET', '/api/sessions'),
  startSession: () => request<{ sessionId: string; batchId: string }>('POST', '/api/sessions', {}),
  nextBatch: (sessionId: string) =>
    request<{ batchId: string }>('POST', `/api/sessions/${encodeURIComponent(sessionId)}/batches`, {}),
  batch: (id: string) => request<BatchView>('GET', batch(id)),
  resume: (id: string) => request<BatchView>('POST', `${batch(id)}/resume`, {}),
  pause: (id: string) => request<{ ok: true }>('POST', `${batch(id)}/pause`, {}),
  continue: (id: string) => request<{ ok: true }>('POST', `${batch(id)}/continue`, {}),
  resolve: (id: string, threadId: string, dest: Dest, star?: boolean) =>
    request<{ ok: true }>('POST', `${batch(id)}/resolve`, star === undefined ? { threadId, dest } : { threadId, dest, star }),
  jump: (id: string, threadId: string) => request<{ ok: true }>('POST', `${batch(id)}/jump`, { threadId }),
  move: (id: string, threadId: string, dest: Dest) => request<{ ok: true }>('POST', `${batch(id)}/move`, { threadId, dest }),
  apply: (id: string) => request<unknown>('POST', `${batch(id)}/apply`, {}),
  discard: (id: string) => request<{ ok: true }>('POST', `${batch(id)}/discard`, {}),
};
