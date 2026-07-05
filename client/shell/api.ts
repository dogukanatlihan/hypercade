// Server sync layer — offline-tolerant by design (TECH-BRIEF §5): every run
// lands in the local pending queue first; this drains it whenever the API is
// reachable. No server = fully playable, silently local.

import type { RunSubmission } from '@shared/types';
import { progress } from './progress';
import { settings } from '@sdk/settings';

const TOKEN_KEY = 'hypercade:token';

let syncing = false;

function token(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

async function mintProfile(): Promise<string | null> {
  try {
    const res = await fetch('/api/profiles', { method: 'POST' });
    if (!res.ok) return null;
    const data = (await res.json()) as { profileId: string; token: string };
    localStorage.setItem(TOKEN_KEY, data.token);
    return data.token;
  } catch {
    return null;
  }
}

async function authHeader(): Promise<Record<string, string> | null> {
  const t = token() ?? (await mintProfile());
  return t ? { Authorization: `Bearer ${t}` } : null;
}

/** Drain the pending run queue. Safe to call anytime; no-ops offline. */
export async function syncPending(): Promise<void> {
  if (syncing) return;
  const runs = progress.takePendingRuns();
  if (runs.length === 0) return;
  syncing = true;
  try {
    const headers = await authHeader();
    if (!headers) return;
    const res = await fetch('/api/progress/sync', {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ runs: runs.slice(0, 200) }),
    });
    if (!res.ok) return;
    const data = (await res.json()) as { results: { runId: string }[] };
    progress.clearPending(data.results.map((r) => r.runId));
  } catch {
    // offline — queue survives for next time
  } finally {
    syncing = false;
  }
}

/** Push profile fields the server cares about (nickname, meta toggle). */
export async function syncProfile(): Promise<void> {
  try {
    const headers = await authHeader();
    if (!headers) return;
    const s = settings.get();
    await fetch('/api/profiles/me', {
      method: 'PATCH',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ ...(s.nickname.length >= 2 ? { nickname: s.nickname } : {}), metaEnabled: s.metaEnabled }),
    });
  } catch {
    // offline
  }
}

export function startSyncLoop(): void {
  void syncPending();
  window.addEventListener('online', () => void syncPending());
  window.setInterval(() => void syncPending(), 45_000);
}

export async function authorizedFetch(path: string): Promise<Response | null> {
  try {
    const headers = (await authHeader()) ?? {};
    return await fetch(path, { headers });
  } catch {
    return null;
  }
}
