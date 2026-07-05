# Deploy HYPERCADE to Cloudflare (one Worker: client + API + D1)

One Cloudflare Worker serves the whole app from a permanent free domain
(`https://hypercade.<your-account>.workers.dev`):

- the static client (`dist/`, built by Vite) via the `ASSETS` binding, and
- the API (`/api/...` + `/healthz`) via Hono, backed by **D1** (Cloudflare's SQLite).

Because both live behind one origin, the client's relative `/api/...` calls work with
**zero CORS**. Live global leaderboards + cross-device sync come for free from D1.

> `worker/` (Hono router + D1 auth/meta port) is the production deploy path.
> The Node/Fastify server in `server/` is untouched and still runs for local dev
> (`npm run dev` + `npm run dev:server`). Both share the pure math in `shared/`.

---

## One-time deploy (run these in order)

All four commands are run by **you** (they need an interactive login / Cloudflare account):

```bash
# 1. Authenticate wrangler with your Cloudflare account (opens a browser).
npx wrangler login

# 2. Create the D1 database. This prints a `database_id`.
npx wrangler d1 create hypercade

# 3. Paste that database_id into wrangler.jsonc:
#      "database_id": "REPLACE_WITH_D1_ID"   ->   "database_id": "<the id from step 2>"

# 4. Create the schema on the remote D1 (applies migrations/0001_init.sql).
npx wrangler d1 migrations apply hypercade --remote

# 5. Build the client and deploy the Worker (which bundles dist/ + the API).
npm run cf:deploy
```

After step 5, wrangler prints your live URL: `https://hypercade.<account>.workers.dev`.

`npm run cf:deploy` = `npm run build && wrangler deploy` — it rebuilds `dist/` first so the
Worker always ships the current client.

### Re-deploying later

Just re-run `npm run cf:deploy`. To ship a schema change, add
`migrations/000N_*.sql` and run `npx wrangler d1 migrations apply hypercade --remote`
before deploying.

---

## Local testing (optional, no Cloudflare account needed to iterate)

```bash
# Apply the schema to a LOCAL D1 (SQLite file under .wrangler/state, no remote).
npx wrangler d1 migrations apply hypercade --local

# Run the Worker + local D1 + static assets emulator at http://localhost:8787
npm run cf:dev
```

`npm run cf:dev` = `wrangler dev`. It serves the built `dist/` + the API + a local D1, so
run `npm run build` first if the client changed.

> If `wrangler dev` fails to start the runtime, your npm client blocked the `workerd`
> postinstall (install-scripts policy). Approve it (e.g. `npm approve-scripts workerd`
> then `npm rebuild workerd`) — this only affects **local** dev; remote `wrangler deploy`
> does not need a local runtime.

---

## What was verified offline (no auth)

- `npx tsc --noEmit` (root: client/server/shared) and `npx tsc -p worker/tsconfig.json`
  (worker + shared with `@cloudflare/workers-types`) — both zero errors.
- `npx wrangler deploy --dry-run` — bundles the Worker successfully.
  Bundle size **~41.9 KiB gzip** (208.6 KiB raw); bindings `DB` (D1) + `ASSETS` resolved.
- `npm run build` — client builds to `dist/`.

## Notes

- `hono` and `@cloudflare/workers-types` are **devDependencies** on purpose: they are
  worker-only. `hono` is bundled into the Worker at deploy time by wrangler/esbuild and
  is **never** shipped in the client bundle, so the client dependency list
  (TECH-BRIEF §1) and client bundle size are unchanged.
- No `nodejs_compat` flag: the Worker uses only WebCrypto (`crypto.subtle`,
  `crypto.getRandomValues`, `crypto.randomUUID`), D1, and Hono — no Node builtins.
- Rate limiting is a best-effort per-isolate in-memory `Map` (same keys/limits as the
  Node server). A Worker runs many short-lived isolates, so this throttles a hot isolate
  rather than the account globally. No KV was added (would cost a binding + latency for a
  non-critical guard). See the `TODO` in `worker/index.ts` if strict global limits are
  ever needed.
