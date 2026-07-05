// /tech — how it's built. The portfolio centerpiece; honest about integrity.

import type { Page } from '../router';

export const techPage: Page = (root) => {
  const page = document.createElement('div');
  page.className = 'page';
  page.innerHTML = `
    <div class="hero">
      <h1>How it's <em>built</em></h1>
      <p>Twelve games, two physics engines, one shim pattern — no game framework, no faked physics.</p>
    </div>
    <div class="panel">
      <h2>Two engines, one architecture</h2>
      <p style="line-height:1.7">Every game runs on real rigid-body simulation: the 2D games on <strong>Box2D v3</strong>, the 3D games on
      <strong>Box3D</strong> — Erin Catto's brand-new 3D engine, here in the browser months after its first release.
      Both are C libraries compiled to WebAssembly behind two deliberately mirrored ~700-line C shims
      (<code>w2_*</code> / <code>w3_*</code>): integer slot handles with generation checks, flat <code>Float32Array</code>
      state buffers read straight out of WASM memory, one <code>Step()</code> call per frame, zero per-body FFI.
      Contact, sensor and impact-force events cross the boundary the same way — as flat buffers.</p>
    </div>
    <div class="panel">
      <h2>Numbers</h2>
      <div class="setting-row"><span>Box2D v3 .wasm</span><strong>209 KB</strong></div>
      <div class="setting-row"><span>Box3D .wasm</span><strong>474 KB</strong></div>
      <div class="setting-row"><span>500-body stress, avg step (desktop)</span><strong>~0.3 ms per engine</strong></div>
      <div class="setting-row"><span>Determinism (same seed + inputs, same binary)</span><strong>bit-identical — both engines</strong></div>
      <div class="setting-row"><span>Fixed tick</span><strong>60 Hz accumulator, interpolated render</strong></div>
    </div>
    <div class="panel">
      <h2>The stack</h2>
      <p style="line-height:1.7">TypeScript strict everywhere. The shell is a hand-rolled History-API router — no framework.
      2D games render on Canvas 2D; 3D games use three.js in its own lazy chunk. Each game is an isolated chunk behind a
      shared SDK contract: <code>init / start(seed) / step(1/60) / render(alpha) / dispose</code>. All randomness flows
      through a seeded PCG32 — which is what makes future daily-challenge seeds free. The backend is Fastify + SQLite
      (WAL), serving anonymous profiles, score submission and leaderboards.</p>
    </div>
    <div class="panel">
      <h2>Integrity, honestly</h2>
      <p style="line-height:1.7">Scores are client-computed; a motivated attacker can forge requests, and we don't pretend otherwise.
      v1 ships plausibility caps (max score/sec, absolute caps, stats-vs-score coherence), rate limits, and quarantine
      instead of deletion — false positives stay recoverable. Both engines measured deterministic for same-binary replay,
      so input-trace re-simulation is the documented post-v1 path.</p>
    </div>
    <div class="panel">
      <h2>The home screen is choreography, not physics</h2>
      <p style="line-height:1.7">The living particle field behind the library is a <strong>GPGPU noise-and-attractor
      simulation</strong> — real math (curl noise + per-game attractor programs advanced on the GPU in float textures),
      but <em>not</em> the game physics engines. Loading Box2D/Box3D WASM just to decorate a menu would burn time-to-interactive
      for nothing, so we don't: the games are physics-true, the menu is choreography. Each game's tile performs its
      motion-verb — pulse, accrete, coalesce, devour — so the field is legible without ever faking a rigid body. It loads
      only after first paint, only on capable devices, and pauses the moment you look away. Reduced-motion or an incapable
      GPU gets the plain grid, which is the source of truth either way.</p>
    </div>
    <div class="panel">
      <h2>Findings log</h2>
      <p style="line-height:1.7">Box3D is v0.1 and we log what we hit: its default collision filter category is
      <em>all bits</em> (Box2D's is <code>1</code>) — runtime masking silently no-ops unless both sides carry explicit
      categories. Box2D v3's mouse joint pins the body point at the <em>initial</em> target, so drags must grab first,
      then move. Details in <code>docs/ENGINE-NOTES.md</code> in the repo.</p>
    </div>
  `;
  root.appendChild(page);
};
