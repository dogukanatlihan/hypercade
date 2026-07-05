// Namespaced localStorage per game — bests, per-game options, plinko save.

export class GameStorage {
  constructor(private readonly ns: string) {}

  get<T>(key: string, fallback: T): T {
    try {
      const raw = localStorage.getItem(`hypercade:${this.ns}:${key}`);
      return raw === null ? fallback : (JSON.parse(raw) as T);
    } catch {
      return fallback;
    }
  }

  set<T>(key: string, value: T): void {
    try {
      localStorage.setItem(`hypercade:${this.ns}:${key}`, JSON.stringify(value));
    } catch {
      // quota/blocked — value stays session-local
    }
  }

  remove(key: string): void {
    try {
      localStorage.removeItem(`hypercade:${this.ns}:${key}`);
    } catch {
      // ignore
    }
  }
}
