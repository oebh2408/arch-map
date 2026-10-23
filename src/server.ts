import { readdirSync, statSync, watch, type FSWatcher } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join, relative } from 'node:path';
import { loadConfig } from './config.js';
import { buildModel } from './model.js';
import { checkRules } from './rules.js';
import type { ArchitectureModel, Config, Violation } from './types.js';
import { cmpId, componentsView, containersView, contextView, GRAPH_CSS, GRAPH_SCRIPT, layout, packagesView, pkgId, violationHtml, type LaidOut } from './viewer.js';

export interface AppOptions {
  /** Repository root. */
  root: string;
  /** Config file; defaults to arch-map.config.json in the root. */
  config?: string;
  /** Watch the repository and rebuild on changes. Default true. */
  watch?: boolean;
}

export interface ArchMapApp {
  handler: (req: IncomingMessage, res: ServerResponse) => void;
  /** Rebuilds the model; returns true when the result changed. */
  rebuild: () => boolean;
  close: () => void;
}

interface Snapshot {
  model: ArchitectureModel;
  config: Config;
  violations: Violation[];
  key: string;
}

const IGNORED = /(^|[\\/])(node_modules|\.git|dist|build|coverage|\.next|\.turbo)([\\/]|$)/;

/**
 * The `serve` web app: a node:http handler with the page and a small JSON API. The model is rebuilt when
 * files in the repository change, and open pages are told through server-sent events.
 */
export function createArchMapApp(options: AppOptions): ArchMapApp {
  let snap: Snapshot | undefined;
  let error: string | undefined;
  let version = 0;
  const views = new Map<string, LaidOut>();
  const clients = new Set<ServerResponse>();

  const rebuild = (): boolean => {
    try {
      const config = loadConfig(options.root, options.config);
      const model = buildModel(options.root, config);
      const violations = checkRules(model, config);
      const key = JSON.stringify([{ ...model, root: undefined }, config, violations]);
      const changed = key !== snap?.key || error !== undefined;
      snap = { model, config, violations, key };
      error = undefined;
      if (!changed) return false;
    } catch (err) {
      const message = (err as Error).message;
      if (message === error) return false;
      error = message;
    }
    version++;
    views.clear();
    for (const c of clients) c.write(`event: change\ndata: ${version}\n\n`);
    return true;
  };
  rebuild();

  // Rebuild shortly after the last change. Recursive fs.watch is not available everywhere
  // (Linux before Node 20), so fall back to polling the modification times.
  let pending: NodeJS.Timeout | undefined;
  const schedule = () => {
    clearTimeout(pending);
    pending = setTimeout(rebuild, 250);
  };
  let watcher: FSWatcher | undefined;
  let poll: NodeJS.Timeout | undefined;
  if (options.watch !== false) {
    try {
      watcher = watch(options.root, { recursive: true }, (_event, file) => {
        if (file && IGNORED.test(String(file))) return;
        schedule();
      });
    } catch {
      let last = stamp(options.root);
      poll = setInterval(() => {
        const next = stamp(options.root);
        if (next !== last) {
          last = next;
          schedule();
        }
      }, 2000);
      poll.unref();
    }
  }
  const heartbeat = setInterval(() => {
    for (const c of clients) c.write(': ping\n\n');
  }, 25_000);
  heartbeat.unref();

  const view = (name: string, pkg?: string): LaidOut | undefined => {
    if (!snap) return undefined;
    const key = `${name}:${pkg ?? ''}`;
    const cached = views.get(key);
    if (cached) return cached;
    const { model, config, violations } = snap;
    const spec =
      name === 'context'
        ? contextView(model, config, violations)
        : name === 'containers'
          ? containersView(model, config, violations)
          : name === 'packages'
            ? packagesView(model, config, violations)
            : name === 'components' && pkg && model.containers.some((c) => c.name === pkg)
              ? componentsView(model, pkg, violations)
              : undefined;
    if (!spec) return undefined;
    const laid = layout(spec);
    views.set(key, laid);
    return laid;
  };

  const summary = () => {
    if (!snap) return { version, error };
    const { model, violations } = snap;
    const errors = violations.filter((v) => v.severity === 'error').length;
    return {
      version,
      error,
      name: model.name,
      root: relative(process.cwd(), options.root) || '.',
      counts: {
        packages: model.containers.length,
        dependencies: model.edges.filter((e) => e.imports > 0).length,
        externals: model.externals.length,
        errors,
        warnings: violations.length - errors,
      },
      containers: model.containers.map((c) => ({ ...c, id: pkgId(c.name), folders: model.components.filter((x) => x.package === c.name).length })),
      externals: model.externals.map((e) => ({ ...e, usedBy: model.containers.filter((c) => c.externals.includes(e.id)).map((c) => c.name) })),
      violations: violations.map((v) => {
        // Forbidden imports are about folders, so they open in the component view of the importing package.
        const pkg = v.rule === 'forbidden' && v.file ? model.fileOwners[v.file] : undefined;
        const component = pkg && v.file ? model.fileComponents[v.file] : undefined;
        return {
          ...v,
          html: violationHtml(v),
          target: pkg && component ? { page: 'components', pkg, node: cmpId(pkg, component) } : { page: 'packages', node: v.from ? pkgId(v.from) : undefined, edgeTo: v.to && v.to !== v.from ? pkgId(v.to) : undefined },
        };
      }),
    };
  };

  const handler = (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (!isLocalHost(req.headers.host)) return send(res, 403, 'text/plain', 'Forbidden');
    if (req.method !== 'GET') return send(res, 405, 'text/plain', 'Method not allowed');
    if (url.pathname === '/') return send(res, 200, 'text/html; charset=utf-8', APP_PAGE);
    if (url.pathname === '/api/model') return json(res, summary());
    if (url.pathname === '/api/view') {
      const laid = view(url.searchParams.get('name') ?? '', url.searchParams.get('pkg') ?? undefined);
      return laid ? json(res, laid) : json(res, { error: 'Not found' }, 404);
    }
    if (url.pathname === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write(`event: hello\ndata: ${version}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    send(res, 404, 'text/plain', 'Not found');
  };

  return {
    handler,
    rebuild,
    close: () => {
      watcher?.close();
      if (poll) clearInterval(poll);
      clearTimeout(pending);
      clearInterval(heartbeat);
      for (const c of clients) c.end();
      clients.clear();
    },
  };
}

/** Starts the web app and resolves once it is listening. */
export function serve(options: AppOptions & { port?: number; host?: string }): Promise<Server> {
  const app = createArchMapApp(options);
  const server = createServer(app.handler);
  server.on('close', app.close);
  return new Promise((done, fail) => {
    server.once('error', fail);
    server.listen(options.port ?? 4200, options.host ?? '127.0.0.1', () => done(server));
  });
}

/** Latest modification time under the root, for the polling fallback. */
function stamp(root: string): string {
  let latest = 0;
  let count = 0;
  const walk = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (IGNORED.test(full)) continue;
      if (e.isDirectory()) walk(full);
      else {
        count++;
        try {
          latest = Math.max(latest, statSync(full).mtimeMs);
        } catch {
          // removed while walking
        }
      }
    }
  };
  walk(root);
  return `${count}:${latest}`;
}

/** Refuses requests whose Host is not a loopback name, so another site cannot reach the app through DNS rebinding. */
function isLocalHost(host: string | undefined): boolean {
  if (!host) return false;
  const name = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  return name === 'localhost' || name === '127.0.0.1' || name === '::1' || process.env.ARCH_MAP_ALLOW_HOST === name;
}

function send(res: ServerResponse, status: number, type: string, body: string): void {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(body);
}

function json(res: ServerResponse, body: unknown, status = 200): void {
  send(res, status, 'application/json; charset=utf-8', JSON.stringify(body));
}

const APP_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>arch-map</title>
<link rel="icon" href="data:,">
<style>
${GRAPH_CSS}
body { display: grid; grid-template-rows: auto 1fr; height: 100vh; overflow: hidden; }
a { color: inherit; text-decoration: none; }
.top { display: flex; align-items: center; gap: 16px; padding: 10px 16px; border-bottom: 1px solid var(--line); background: var(--panel); min-width: 0; }
.brand { font-weight: 650; letter-spacing: -.01em; white-space: nowrap; }
.brand span { color: var(--muted); font-weight: 400; }
.root { color: var(--muted); font-size: 12.5px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.live { margin-left: auto; display: flex; align-items: center; gap: 7px; color: var(--muted); font-size: 12px; white-space: nowrap; }
.live i { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); }
.live.on i { background: #22a06b; box-shadow: 0 0 0 3px color-mix(in srgb, #22a06b 25%, transparent); }
.app { display: grid; grid-template-columns: 260px 1fr; min-height: 0; }
.side { border-right: 1px solid var(--line); background: var(--panel); overflow: auto; padding: 6px; }
.side .item { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; padding: 7px 10px; border-radius: 8px; margin-bottom: 1px; font-size: 13.5px; }
.side .item:hover { background: var(--hover); }
.side .item.active { background: var(--hover); box-shadow: inset 3px 0 0 var(--accent); }
.side .item .n { color: var(--muted); font-size: 11.5px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; white-space: nowrap; }
.side .item .t { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.side .heading { padding: 14px 10px 4px; font-size: 11px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: .05em; }
.side .err { color: var(--error); } .side .warn { color: var(--warning); }
#view { min-width: 0; min-height: 0; display: flex; flex-direction: column; }
.bar { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 18px; padding: 10px 16px; border-bottom: 1px solid var(--line); background: var(--panel); }
.bar h1 { margin: 0; font-size: 16px; font-weight: 600; }
.bar .meta { color: var(--muted); font-size: 12.5px; }
.bar .tools { margin-left: auto; display: flex; gap: 6px; }
.legend { position: absolute; left: 12px; bottom: 12px; display: flex; flex-wrap: wrap; gap: 14px; color: var(--muted); font-size: 12px; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 6px 10px; pointer-events: none; }
.legend span { display: inline-flex; align-items: center; gap: 6px; }
.legend i { width: 22px; height: 0; border-top: 2px solid var(--edge); }
.legend i.v { border-color: var(--error); } .legend i.w { border-top: 2px dashed var(--warning); } .legend i.d { border-top: 2px dashed var(--weak); } .legend i.x { border-top: 2px dotted var(--ext-edge); }
.split { flex: 1; display: grid; grid-template-columns: 1fr 380px; min-height: 0; }
.page { flex: 1; overflow: auto; padding: 20px 24px 40px; }
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; margin-bottom: 24px; max-width: 980px; }
.card { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px; }
.card b { display: block; font-size: 24px; font-weight: 600; }
.card span { color: var(--muted); font-size: 12.5px; }
.card.error b { color: var(--error); } .card.warning b { color: var(--warning); }
h2.title { font-size: 18px; font-weight: 600; margin: 0 0 4px; }
h3.title { font-size: 14px; font-weight: 600; margin: 26px 0 10px; }
p.lead { color: var(--muted); margin: 0 0 18px; }
table { width: 100%; border-collapse: collapse; background: var(--panel); border: 1px solid var(--line); border-radius: 10px; overflow: hidden; font-size: 13px; }
th { text-align: left; font-size: 11.5px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; padding: 9px 12px; border-bottom: 1px solid var(--line); }
td { padding: 9px 12px; border-bottom: 1px solid var(--line); vertical-align: top; }
tr:last-child td { border-bottom: 0; }
tbody tr[data-href] { cursor: pointer; } tbody tr[data-href]:hover td { background: var(--hover); }
td.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; white-space: nowrap; }
.lvl { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
.lvl-error { color: var(--error); } .lvl-warning { color: var(--warning); }
.kind { display: inline-flex; align-items: center; gap: 7px; white-space: nowrap; }
.kind:before { content: ""; width: 4px; height: 14px; border-radius: 2px; background: var(--library); }
.kind.web:before { background: var(--web); } .kind.api:before { background: var(--api); } .kind.worker:before { background: var(--worker); } .kind.cli:before { background: var(--cli); }
.filters { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 12px; }
.filters button.on { border-color: var(--text); }
.notice { margin: 16px; padding: 12px 14px; border: 1px solid var(--error); border-radius: 10px; background: var(--panel); }
.notice b { color: var(--error); }
@media (max-width: 900px) {
  .app { grid-template-columns: 1fr; grid-template-rows: auto 1fr; }
  .side { border-right: 0; border-bottom: 1px solid var(--line); max-height: 30vh; }
  .split { grid-template-columns: 1fr; grid-template-rows: 55vh auto; overflow: auto; }
  .panel { border-left: 0; border-top: 1px solid var(--line); }
}
</style>
</head>
<body>
<header class="top">
  <div class="brand">arch<span>-map</span></div>
  <div class="root" id="root"></div>
  <div class="counts" id="totals"></div>
  <div class="live" id="live"><i></i><span>connecting</span></div>
</header>
<div class="app">
  <nav class="side" id="nav"></nav>
  <main id="view"></main>
</div>
<script>
${GRAPH_SCRIPT}
(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const plural = (n, w) => n + ' ' + w + (n === 1 ? '' : 's');
  const KIND = { web: 'web app', api: 'API', worker: 'worker', cli: 'CLI', library: 'library' };
  const VIEWS = {
    context: { title: 'System context', lead: 'C4 level 1: the system, the people who use it and the external systems it talks to.' },
    containers: { title: 'Containers', lead: 'C4 level 2: the deployable packages and the external systems each one reaches, directly or through a library.' },
    packages: { title: 'Packages', lead: 'Every workspace package and its dependencies, grouped by layer.' },
    components: { title: 'Components', lead: 'C4 level 3: folders inside the package, the imports between them and what they use outside it.' },
  };
  let state = null, graph = null, current = null, rule = '';

  const href = (page, params) => '#/' + page + (params && Object.keys(params).length ? '?' + new URLSearchParams(params) : '');
  const route = () => {
    const [path, query] = location.hash.replace(/^#\\/?/, '').split('?');
    const p = new URLSearchParams(query || '');
    return { page: path || 'overview', pkg: p.get('pkg') || undefined, node: p.get('node') || undefined, edgeTo: p.get('edge') || undefined };
  };

  const renderTop = () => {
    $('root').textContent = state.root || '';
    const c = state.counts;
    $('totals').innerHTML = c ? '<span class="count count-error">' + plural(c.errors, 'error') + '</span><span class="count count-warning">' + plural(c.warnings, 'warning') + '</span>' : '';
  };

  const renderNav = () => {
    const r = route();
    const item = (page, label, n, params, extra) => {
      const active = r.page === page && (!params || !params.pkg || params.pkg === r.pkg);
      return '<a class="item' + (active ? ' active' : '') + '" href="' + href(page, params) + '"><span class="t">' + esc(label) + '</span>' + (n !== undefined ? '<span class="n' + (extra || '') + '">' + n + '</span>' : '') + '</a>';
    };
    const c = state.counts;
    $('nav').innerHTML = !c ? '' :
      item('overview', 'Overview') +
      '<div class="heading">Diagrams</div>' +
      item('context', 'System context') +
      item('containers', 'Containers', state.containers.filter((x) => x.kind !== 'library').length) +
      item('packages', 'Packages', c.packages) +
      '<div class="heading">Components</div>' +
      state.containers.map((x) => item('components', x.name, x.folders, { pkg: x.name })).join('') +
      '<div class="heading">Rules</div>' +
      item('violations', 'Violations', c.errors + c.warnings, undefined, c.errors ? ' err' : c.warnings ? ' warn' : '');
  };

  const unmount = () => { if (graph) { graph.destroy(); graph = null; } current = null; };

  const go = (page, params) => { location.hash = href(page, params); };
  const navigate = (page, node) => {
    if (page === 'components' && node && node.startsWith('cmp:')) {
      const rest = node.slice(4);
      const pkg = state.containers.map((c) => c.name).sort((a, b) => b.length - a.length).find((n) => rest.startsWith(n + ':'));
      return go('components', { pkg, node });
    }
    if (page) return go(page, node ? { node } : {});
    // A node that is not in this view: packages and external systems live in the package view.
    go('packages', { node });
  };

  const showView = async (name, r, fromChange) => {
    const res = await fetch('api/view?name=' + name + (r.pkg ? '&pkg=' + encodeURIComponent(r.pkg) : ''));
    if (!res.ok) { unmount(); $('view').innerHTML = '<div class="notice"><b>Not found</b> ' + esc(r.pkg || name) + '</div>'; return; }
    const laid = await res.json();
    const same = fromChange && current && current.key === name + ':' + (r.pkg || '');
    const previous = same && graph ? graph.view() : undefined;
    const selected = same && graph ? graph.selected() : undefined;
    if (graph) graph.destroy();
    const info = VIEWS[name];
    const pkg = r.pkg && state.containers.find((c) => c.name === r.pkg);
    $('view').innerHTML =
      '<div class="bar"><div><h1>' + esc(laid.title) + '</h1><div class="meta">' + esc(info.lead) + (pkg ? ' <code>' + esc(pkg.dir) + '</code>' : '') + '</div></div>' +
      '<div class="tools"><button id="zoom-out" aria-label="Zoom out">−</button><button id="zoom-in" aria-label="Zoom in">+</button><button id="fit">Fit</button></div></div>' +
      '<div class="split"><div class="canvas" id="canvas">' + laid.svg +
      '<div class="legend">' + (name === 'context' || name === 'containers' ? '' : '<span><i class="v"></i>breaks a rule</span><span><i class="w"></i>warning</span><span><i class="d"></i>unused or tests only</span>') + (name === 'packages' ? '' : '<span><i class="x"></i>external system</span>') + '</div></div>' +
      '<aside class="panel"><section id="details"><h2>Details</h2><p class="empty">Select a box to see what it depends on and what depends on it.</p></section></aside></div>';
    current = { key: name + ':' + (r.pkg || '') };
    graph = mountGraph({
      canvas: $('canvas'), details: $('details'), data: laid, view: previous, maxFit: 1.5,
      onNavigate: navigate,
      onSelect: (id) => { const params = { ...(r.pkg ? { pkg: r.pkg } : {}), ...(id ? { node: id } : {}) }; history.replaceState(null, '', href(name, params)); },
    });
    $('fit').onclick = graph.fit;
    $('zoom-in').onclick = () => graph.zoom(1.25);
    $('zoom-out').onclick = () => graph.zoom(0.8);
    if (selected) graph.select(selected);
    else if (r.node) graph.select(r.node, { edgeTo: r.edgeTo });
  };

  const showOverview = () => {
    unmount();
    const c = state.counts;
    $('view').innerHTML = '<div class="page">' +
      '<h2 class="title">' + esc(state.name) + '</h2><p class="lead">Built from the workspace packages and their imports in ' + esc(state.root) + '. It is rebuilt when files change.</p>' +
      '<div class="cards">' +
      [[c.packages, 'packages'], [c.dependencies, 'dependencies'], [c.externals, 'external systems']].map(([n, l]) => '<div class="card"><b>' + n + '</b><span>' + l + '</span></div>').join('') +
      '<div class="card error"><b>' + c.errors + '</b><span>' + (c.errors === 1 ? 'error' : 'errors') + '</span></div>' +
      '<div class="card warning"><b>' + c.warnings + '</b><span>' + (c.warnings === 1 ? 'warning' : 'warnings') + '</span></div></div>' +
      '<h3 class="title">Packages</h3><table><thead><tr><th>Package</th><th>Kind</th><th>Technology</th><th>Path</th><th>Description</th></tr></thead><tbody>' +
      state.containers.map((x) => '<tr data-href="' + href('packages', { node: x.id }) + '"><td>' + esc(x.name) + '</td><td><span class="kind ' + x.kind + '">' + KIND[x.kind] + '</span></td><td>' + esc(x.technology) + '</td><td class="mono">' + esc(x.dir) + '</td><td>' + esc(x.description || '') + '</td></tr>').join('') +
      '</tbody></table>' +
      (state.externals.length ? '<h3 class="title">External systems</h3><table><thead><tr><th>System</th><th>Kind</th><th>Detected from</th><th>Used directly by</th></tr></thead><tbody>' +
        state.externals.map((e) => '<tr data-href="' + href('packages', { node: 'ext:' + e.id }) + '"><td>' + esc(e.name) + '</td><td>' + esc(e.kind) + '</td><td class="mono">' + e.via.map(esc).join(', ') + '</td><td>' + e.usedBy.map(esc).join(', ') + '</td></tr>').join('') +
        '</tbody></table>' : '') +
      '</div>';
    bindRows();
  };

  const showViolations = () => {
    unmount();
    const rules = [...new Set(state.violations.map((v) => v.rule))].sort();
    const shown = state.violations.filter((v) => !rule || v.rule === rule);
    $('view').innerHTML = '<div class="page"><h2 class="title">Violations</h2><p class="lead">Rules come from arch-map.config.json. Click a row to see it in the diagram.</p>' +
      '<div class="filters">' + ['', ...rules].map((x) => '<button data-rule="' + esc(x) + '" class="' + (rule === x ? 'on' : '') + '">' + esc(x || 'All') + '</button>').join('') + '</div>' +
      (shown.length ? '<table><thead><tr><th>Severity</th><th>Rule</th><th>Where</th><th>Message</th></tr></thead><tbody>' +
        shown.map((v) => {
          const t = v.target, params = { ...(t.pkg ? { pkg: t.pkg } : {}), ...(t.node ? { node: t.node } : {}), ...(t.edgeTo ? { edge: t.edgeTo } : {}) };
          return '<tr data-href="' + href(t.page, params) + '"><td class="lvl lvl-' + v.severity + '">' + v.severity + '</td><td class="mono">' + esc(v.rule) + '</td><td class="mono">' + esc((v.file || '') + (v.line ? ':' + v.line : '')) + '</td><td>' + esc(v.message) + '</td></tr>';
        }).join('') + '</tbody></table>'
        : '<p class="empty">No violations.</p>') + '</div>';
    $('view').querySelectorAll('[data-rule]').forEach((b) => { b.onclick = () => { rule = b.dataset.rule; showViolations(); }; });
    bindRows();
  };

  const bindRows = () => $('view').querySelectorAll('tr[data-href]').forEach((tr) => { tr.onclick = () => { location.hash = tr.dataset.href; }; });

  const render = (fromChange) => {
    renderTop();
    renderNav();
    if (state.error) {
      unmount();
      $('view').innerHTML = '<div class="notice"><b>Cannot build the model</b><br>' + esc(state.error) + '</div>' + ($('view').innerHTML || '');
      if (!state.counts) return;
    }
    const r = route();
    if (VIEWS[r.page]) return showView(r.page, r, fromChange);
    if (r.page === 'violations') return showViolations();
    showOverview();
  };

  const load = async (fromChange) => {
    state = await (await fetch('api/model')).json();
    await render(fromChange);
  };

  window.addEventListener('hashchange', () => {
    const r = route();
    // Selecting a box rewrites the hash without a reload; only react when the view changes.
    if (VIEWS[r.page] && current && current.key === r.page + ':' + (r.pkg || '')) {
      if (r.node && graph && r.node !== graph.selected()) graph.select(r.node, { center: true, edgeTo: r.edgeTo });
      return;
    }
    render(false);
  });

  const connect = () => {
    const live = $('live');
    const events = new EventSource('api/events');
    let seen = null;
    events.addEventListener('hello', (e) => { live.className = 'live on'; live.lastChild.textContent = 'watching for changes'; if (seen !== null && e.data !== seen) load(true); seen = e.data; });
    events.addEventListener('change', (e) => { seen = e.data; load(true); });
    events.onerror = () => { live.className = 'live'; live.lastChild.textContent = 'disconnected, retrying'; };
  };

  load(false).then(connect);
})();
</script>
</body>
</html>
`;
