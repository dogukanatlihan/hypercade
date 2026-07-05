// Cloudflare Worker bindings. DB = D1 (SQLite); ASSETS = static dist/ fetcher.
// D1Database / Fetcher are ambient globals from @cloudflare/workers-types
// (wired via worker/tsconfig.json), so no import is needed here.

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
}
