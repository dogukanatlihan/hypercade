// Anonymous profiles, WebCrypto port of server/auth.ts.
// Token = 256-bit random -> base64url (opaque bearer). SHA-256 hash at rest.
// All async: D1 + crypto.subtle are promise-based.

import type { Env } from './env';

export interface Profile {
  id: string;
  nickname: string;
  settings: string;
}

function base64url(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function createProfile(env: Env): Promise<{ profileId: string; token: string }> {
  const token = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const id = `p_${crypto.randomUUID()}`;
  const now = Date.now();
  // Profile + its progress row are created together (match server/auth.ts).
  // Batched so both land or neither does.
  await env.DB.batch([
    env.DB
      .prepare('INSERT INTO profiles (id, token_hash, nickname, settings, created_at, last_seen) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(id, await hashToken(token), '', '{}', now, now),
    env.DB.prepare('INSERT INTO progress (profile_id) VALUES (?)').bind(id),
  ]);
  return { profileId: id, token };
}

export async function authenticate(env: Env, authorization: string | undefined): Promise<Profile | null> {
  if (!authorization?.startsWith('Bearer ')) return null;
  const token = authorization.slice(7).trim();
  if (token.length < 32) return null;
  const row = await env.DB
    .prepare('SELECT id, nickname, settings FROM profiles WHERE token_hash = ?')
    .bind(await hashToken(token))
    .first<Profile>();
  if (!row) return null;
  await env.DB.prepare('UPDATE profiles SET last_seen = ? WHERE id = ?').bind(Date.now(), row.id).run();
  return row;
}
