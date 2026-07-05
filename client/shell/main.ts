// HYPERCADE shell boot — nav + router. No framework by design (TECH-BRIEF §5).

import './styles.css';
import { Router } from './router';
import { libraryPage } from './pages/library';
import { playPage } from './pages/play';
import { settingsPage } from './pages/settings';
import { journeyPage } from './pages/journey';
import { profilePage } from './pages/profile';
import { boardsPage } from './pages/boards';
import { techPage } from './pages/tech';
import { settings, applyPalette } from '@sdk/settings';
import { progress } from './progress';
import { startSyncLoop, syncProfile } from './api';

applyPalette(settings.get().palette);
document.documentElement.dataset['reducedMotion'] = String(settings.get().reducedMotion);

const app = document.getElementById('app')!;
const navEl = document.createElement('nav');
navEl.className = 'nav';
const outlet = document.createElement('div');
outlet.style.display = 'contents';
app.append(navEl, outlet);

function renderNav(): void {
  const meta = settings.get().metaEnabled;
  const path = location.pathname;
  const link = (href: string, label: string): string =>
    `<a class="nav-link ${path === href ? 'active' : ''}" data-link href="${href}">${label}</a>`;
  navEl.innerHTML = `
    <a class="nav-logo" data-link href="/">HYPER<em>CADE</em></a>
    <span class="nav-spacer"></span>
    ${meta ? link('/journey', 'Journey') : ''}
    ${link('/tech', 'Tech')}
    ${meta ? link('/profile', 'Profile') : ''}
    ${link('/settings', '⚙')}
    ${meta ? `<span class="nav-chip">★ ${progress.totalStars()}</span>` : ''}
  `;
  // the play route is fullscreen — hide nav there
  navEl.style.display = path.startsWith('/play/') ? 'none' : '';
}

const router = new Router(outlet)
  .add('/', libraryPage)
  .add('/play/:gameId', playPage)
  .add('/journey', journeyPage)
  .add('/profile', profilePage)
  .add('/boards/:gameId', boardsPage)
  .add('/tech', techPage)
  .add('/settings', settingsPage)
  .fallback(libraryPage);

const origRender = router.render.bind(router);
router.render = (): void => {
  origRender();
  renderNav();
};

settings.changed.on('change', renderNav);
progress.changed.on('change', () => {
  renderNav();
  void import('./api').then((m) => m.syncPending());
});
startSyncLoop();
settings.changed.on('change', () => void syncProfile());

// iOS Safari: block pinch & double-tap zoom (games are tap-heavy)
document.addEventListener('gesturestart', (e) => e.preventDefault());
let lastTouchEnd = 0;
document.addEventListener(
  'touchend',
  (e) => {
    const t = Date.now();
    if (t - lastTouchEnd < 320) e.preventDefault();
    lastTouchEnd = t;
  },
  { passive: false },
);

router.render();
