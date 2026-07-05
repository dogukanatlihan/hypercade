# HYPERCADE

Twelve perfected hyper-casual mini-games on **real physics** — Box2D v3 (7 games)
and **Box3D** (5 games), both compiled to WebAssembly behind mirrored C shims —
wrapped in an optional gamified journey and served by one Node process.

The product spec lives in `docs/`: [PRD](docs/PRD.md) · [MECHANICS](docs/MECHANICS.md)
· [GAMIFICATION](docs/GAMIFICATION.md) · [TECH-BRIEF](docs/TECH-BRIEF.md) ·
[ENGINE-NOTES](docs/ENGINE-NOTES.md) (findings log).

## Quickstart

```bash
npm install
npm run wasm      # build both engines (needs emsdk; ~1 min)
npm run dev       # Vite client on :5173
npm run dev:server # Fastify API on :8787 (client proxies /api)
```

Production: `npm run build` then `npm start` — one process serves API + `dist/`.
Or `docker compose up` (run `npm run wasm` first; the toolchain stays out of the image).

## Verification gates

| Command | Gate |
|---|---|
| `npm run harness` | shim conformance (51 checks) + determinism audit, both engines |
| `npm test` | `/shared` scoring/XP/streak/badge math (client & server import the same module) |
| `npm run typecheck` | TS strict across client/server/shared |
| `npm run smoke` | Playwright: every game loads, paints, plays, restarts, zero console errors |
| `npm run budgets` | size-limit on the built bundles (TECH-BRIEF §8) |

## Layout

```
/client   Vite app — shell (no framework), SDK (loop/input/audio/rng/hud), 12 games
/server   Fastify — anon profiles, run submission + server-side meta, leaderboards
/shared   single source of truth: scoring, stars, XP, badges, plausibility caps
/wasm     shim2d.c + shim3d.c + vendored engines + build script + harness
/docs     the spec + the honesty log
```

`Box3DTestApp/` is the frozen BOXSTACK reference implementation — read-only.

## License

MIT — see [LICENSE](LICENSE). Vendored Box2D and Box3D are MIT (Erin Catto); their license files ship under `wasm/vendor/`.
