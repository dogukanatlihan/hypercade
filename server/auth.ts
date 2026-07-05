// Anonymous profiles: opaque 256-bit bearer token, SHA-256 hash at rest.

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { db } from './db.ts';

export interface Profile {
  id: string;
  nickname: string;
  settings: string;
}

const insertProfile = db.prepare(
  'INSERT INTO profiles (id, token_hash, nickname, settings, created_at, last_seen) VALUES (?, ?, ?, ?, ?, ?)',
);
const findByHash = db.prepare('SELECT id, nickname, settings FROM profiles WHERE token_hash = ?');
const touch = db.prepare('UPDATE profiles SET last_seen = ? WHERE id = ?');

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function createProfile(): { profileId: string; token: string } {
  const token = randomBytes(32).toString('base64url');
  const id = `p_${randomUUID()}`;
  const now = Date.now();
  insertProfile.run(id, hashToken(token), '', '{}', now, now);
  db.prepare('INSERT INTO progress (profile_id) VALUES (?)').run(id);
  return { profileId: id, token };
}

export function authenticate(authorization: string | undefined): Profile | null {
  if (!authorization?.startsWith('Bearer ')) return null;
  const token = authorization.slice(7).trim();
  if (token.length < 32) return null;
  const row = findByHash.get(hashToken(token)) as Profile | undefined;
  if (!row) return null;
  touch.run(Date.now(), row.id);
  return row;
}
