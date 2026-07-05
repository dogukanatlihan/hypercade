// Tiny History-API router. Routes declare :params; pages are mount functions
// returning a cleanup. No framework — the shell is part of the tech story.

export interface RouteContext {
  params: Record<string, string>;
  navigate: (path: string) => void;
}

export type Page = (root: HTMLElement, ctx: RouteContext) => (() => void) | void;

interface Route {
  pattern: string;
  segments: string[];
  page: Page;
}

export class Router {
  private routes: Route[] = [];
  private cleanup: (() => void) | void = undefined;
  private notFound: Page | null = null;

  constructor(private readonly root: HTMLElement) {
    window.addEventListener('popstate', () => this.render());
    document.addEventListener('click', (e) => {
      const a = (e.target as HTMLElement).closest('a[data-link]');
      if (a instanceof HTMLAnchorElement && a.origin === location.origin) {
        e.preventDefault();
        this.navigate(a.pathname);
      }
    });
  }

  add(pattern: string, page: Page): this {
    this.routes.push({ pattern, segments: pattern.split('/').filter(Boolean), page });
    return this;
  }

  fallback(page: Page): this {
    this.notFound = page;
    return this;
  }

  navigate = (path: string): void => {
    if (path === location.pathname) return;
    history.pushState(null, '', path);
    this.render();
  };

  render(): void {
    const parts = location.pathname.split('/').filter(Boolean);
    for (const route of this.routes) {
      if (route.segments.length !== parts.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < parts.length; i++) {
        const seg = route.segments[i]!;
        if (seg.startsWith(':')) params[seg.slice(1)] = decodeURIComponent(parts[i]!);
        else if (seg !== parts[i]) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      this.mount(route.page, params);
      return;
    }
    if (this.notFound) this.mount(this.notFound, {});
  }

  private mount(page: Page, params: Record<string, string>): void {
    if (this.cleanup) this.cleanup();
    this.root.innerHTML = '';
    window.scrollTo(0, 0);
    this.cleanup = page(this.root, { params, navigate: this.navigate });
  }
}
