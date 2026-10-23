import dagre from '@dagrejs/dagre';
import { matchGlob } from './glob.js';
import { transitiveExternals } from './diagrams.js';
import type { ArchitectureModel, Config, Container, Violation } from './types.js';

const NODE_W = 220;
const NODE_H = 50;

interface Placed {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface ViewEdge {
  from: string;
  to: string;
  kind: 'dep' | 'weak' | 'external' | 'violation' | 'warning';
  label?: string;
}

const KIND_LABEL = { web: 'web app', api: 'API', worker: 'worker', cli: 'CLI', library: 'library' } as const;

/** A self-contained HTML page with the package graph, details per package and the rule violations. No network access is needed to open it. */
export function renderViewer(model: ArchitectureModel, config: Config = {}, violations: Violation[] = []): string {
  const groups = groupPackages(model, config);
  const nodeId = (name: string) => `pkg:${name}`;
  const extId = (id: string) => `ext:${id}`;

  const bad = new Map<string, Violation[]>();
  for (const v of violations) {
    if (!v.from || !v.to || v.from === v.to) continue;
    const key = `${v.from}->${v.to}`;
    bad.set(key, [...(bad.get(key) ?? []), v]);
  }

  const edges: ViewEdge[] = [];
  for (const e of model.edges) {
    const found = bad.get(`${e.from}->${e.to}`);
    const weak = e.imports === 0 || e.testOnly;
    edges.push({
      from: nodeId(e.from),
      to: nodeId(e.to),
      kind: found ? (found.some((v) => v.severity === 'error') ? 'violation' : 'warning') : weak ? 'weak' : 'dep',
      label: found ? [...new Set(found.map((v) => v.rule))].join(', ') : e.imports === 0 ? 'unused' : e.testOnly ? 'tests' : undefined,
    });
  }
  for (const c of model.containers) for (const ext of c.externals) edges.push({ from: nodeId(c.name), to: extId(ext), kind: 'external' });

  const g = new dagre.graphlib.Graph({ compound: true, multigraph: true });
  g.setGraph({ rankdir: 'TB', nodesep: 30, ranksep: 56, edgesep: 14, marginx: 40, marginy: 40 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const c of model.containers) g.setNode(nodeId(c.name), { width: NODE_W, height: NODE_H });
  for (const e of model.externals) g.setNode(extId(e.id), { width: NODE_W - 40, height: NODE_H - 6 });
  groups.forEach((group, i) => {
    g.setNode(`group:${i}`, { paddingTop: 30, paddingBottom: 14, paddingLeft: 14, paddingRight: 14 });
    for (const m of group.members) g.setParent(nodeId(m.name), `group:${i}`);
  });
  if (model.externals.length) {
    g.setNode('group:ext', { paddingTop: 30, paddingBottom: 14, paddingLeft: 14, paddingRight: 14 });
    for (const e of model.externals) g.setParent(extId(e.id), 'group:ext');
  }
  edges.forEach((e, i) => {
    const label = e.label ?? '';
    g.setEdge(e.from, e.to, { label, width: label ? label.length * 6.6 + 12 : 0, height: label ? 16 : 0, labelpos: 'c' }, `e${i}`);
  });
  dagre.layout(g);

  const parts: string[] = [];
  let maxX = 0;
  let maxY = 0;
  const grow = (p: Placed) => {
    maxX = Math.max(maxX, p.x + p.width / 2 + 40);
    maxY = Math.max(maxY, p.y + p.height / 2 + 40);
  };

  const groupBox = (key: string, title: string, cls: string) => {
    const c = g.node(key) as Placed | undefined;
    if (!c) return;
    grow(c);
    const x = c.x - c.width / 2;
    const y = c.y - c.height / 2;
    parts.push(`<g class="group ${cls}"><rect x="${x}" y="${y}" width="${c.width}" height="${c.height}" rx="12"/><text x="${x + 14}" y="${y + 19}">${esc(title)}</text></g>`);
  };
  groups.forEach((group, i) => groupBox(`group:${i}`, group.name, 'group-layer'));
  if (model.externals.length) groupBox('group:ext', 'External systems', 'group-external');

  edges.forEach((e, i) => {
    const placed = g.edge({ v: e.from, w: e.to, name: `e${i}` }) as { points: { x: number; y: number }[]; x?: number; y?: number };
    if (!placed?.points?.length) return;
    parts.push(`<g class="edge edge-${e.kind}" data-from="${esc(e.from)}" data-to="${esc(e.to)}"><path d="${curve(placed.points)}" marker-end="url(#arrow-${e.kind})"/>`);
    if (e.label && placed.x !== undefined && placed.y !== undefined) {
      const w = e.label.length * 6.6 + 12;
      parts.push(`<g class="edge-label"><rect x="${placed.x - w / 2}" y="${placed.y - 9}" width="${w}" height="18" rx="9"/><text x="${placed.x}" y="${placed.y + 4}">${esc(e.label)}</text></g>`);
    }
    parts.push('</g>');
  });

  const ownViolations = (name: string) => violations.filter((v) => v.from === name);
  for (const c of model.containers) {
    const p = g.node(nodeId(c.name)) as Placed;
    grow(p);
    const x = p.x - p.width / 2;
    const y = p.y - p.height / 2;
    const own = ownViolations(c.name);
    const worst = own.some((v) => v.severity === 'error') ? 'error' : own.length ? 'warning' : '';
    const badge = own.length
      ? `<g class="badge badge-${worst}"><circle cx="${x + p.width - 4}" cy="${y + 4}" r="9"/><text x="${x + p.width - 4}" y="${y + 8}">${own.length}</text></g>`
      : '';
    parts.push(`<g class="node kind-${c.kind}${worst ? ` has-${worst}` : ''}" data-id="${esc(nodeId(c.name))}" tabindex="0">
<rect class="box" x="${x}" y="${y}" width="${p.width}" height="${p.height}" rx="8"/>
<rect class="bar" x="${x}" y="${y}" width="5" height="${p.height}" rx="2"/>
<text class="label" x="${x + 16}" y="${y + 21}">${esc(truncate(c.name, 28))}</text>
<text class="detail" x="${x + 16}" y="${y + 38}">${esc(truncate(`${KIND_LABEL[c.kind]} · ${c.technology}`, 30))}</text>
${badge}
</g>`);
  }
  for (const e of model.externals) {
    const p = g.node(extId(e.id)) as Placed;
    grow(p);
    const x = p.x - p.width / 2;
    const y = p.y - p.height / 2;
    parts.push(`<g class="node external" data-id="${esc(extId(e.id))}" tabindex="0">
<rect class="box" x="${x}" y="${y}" width="${p.width}" height="${p.height}" rx="${p.height / 2}"/>
<text class="label" x="${p.x}" y="${y + 19}" text-anchor="middle">${esc(truncate(e.name, 24))}</text>
<text class="detail" x="${p.x}" y="${y + 35}" text-anchor="middle">${esc(e.kind)}</text>
</g>`);
  }

  // Everything the side panel shows, keyed by node id.
  const reach = transitiveExternals(model);
  const externalName = (id: string) => model.externals.find((x) => x.id === id)?.name ?? id;
  const details: Record<string, unknown> = {};
  for (const c of model.containers) {
    details[nodeId(c.name)] = {
      type: 'package',
      name: c.name,
      dir: c.dir,
      kind: KIND_LABEL[c.kind],
      technology: c.technology,
      description: c.description,
      layer: groups.find((gr) => gr.members.includes(c))?.name,
      dependsOn: model.edges.filter((e) => e.from === c.name).map((e) => ({ id: nodeId(e.to), name: e.to, imports: e.imports, declared: e.declared, testOnly: e.testOnly })),
      usedBy: model.edges.filter((e) => e.to === c.name).map((e) => ({ id: nodeId(e.from), name: e.from, imports: e.imports, testOnly: e.testOnly })),
      externals: [...(reach.get(c.name) ?? [])].map(([id, via]) => ({ id: extId(id), name: externalName(id), via })),
      components: model.components.filter((x) => x.package === c.name).map((x) => ({ name: x.id, files: x.files })),
    };
  }
  for (const e of model.externals) {
    details[extId(e.id)] = {
      type: 'external',
      name: e.name,
      kind: e.kind,
      detectedFrom: e.via,
      usedBy: model.containers.filter((c) => c.externals.includes(e.id)).map((c) => ({ id: nodeId(c.name), name: c.name })),
    };
  }
  const data = {
    details,
    violations: violations.map((v) => ({ ...v, node: v.from ? nodeId(v.from) : undefined, edgeTo: v.to && v.to !== v.from ? nodeId(v.to) : undefined })),
  };

  const errors = violations.filter((v) => v.severity === 'error').length;
  const warnings = violations.length - errors;
  const deps = model.edges.filter((e) => e.imports > 0).length;
  return PAGE.replace('{{TITLE}}', () => esc(model.name))
    .replace('{{NAME}}', () => esc(model.name))
    .replace('{{META}}', () => esc(`${model.containers.length} packages · ${deps} dependencies · ${model.externals.length} external systems`))
    .replace('{{COUNTS}}', () => `<span class="count count-error">${errors} error${errors === 1 ? '' : 's'}</span><span class="count count-warning">${warnings} warning${warnings === 1 ? '' : 's'}</span>`)
    .replaceAll('{{WIDTH}}', () => String(Math.ceil(maxX)))
    .replaceAll('{{HEIGHT}}', () => String(Math.ceil(maxY)))
    .replace('{{SVG}}', () => parts.join('\n'))
    .replace('{{DATA}}', () => JSON.stringify(data).replace(/</g, '\\u003c'));
}

/** Layers from the config, or applications and libraries when there are none. */
function groupPackages(model: ArchitectureModel, config: Config): { name: string; members: Container[] }[] {
  const placed = new Set<string>();
  const out: { name: string; members: Container[] }[] = [];
  const add = (name: string, members: Container[]) => {
    const fresh = members.filter((c) => !placed.has(c.name));
    for (const c of fresh) placed.add(c.name);
    if (fresh.length) out.push({ name, members: fresh });
  };
  if (config.layers?.length) {
    for (const layer of config.layers) add(layer.name, model.containers.filter((c) => layer.packages.some((g) => matchGlob(g, c.name) || matchGlob(g, c.dir))));
    add('Other', model.containers);
  } else {
    add('Applications', model.containers.filter((c) => c.kind !== 'library'));
    add('Libraries', model.containers);
  }
  return out;
}

/** Smooth path through dagre's edge points. */
function curve(points: { x: number; y: number }[]): string {
  const [first, ...rest] = points;
  if (!first) return '';
  if (rest.length === 0) return `M${first.x},${first.y}`;
  let d = `M${r(first.x)},${r(first.y)}`;
  for (let i = 0; i < rest.length - 1; i++) {
    const c = rest[i]!;
    const next = rest[i + 1]!;
    d += ` Q${r(c.x)},${r(c.y)} ${r((c.x + next.x) / 2)},${r((c.y + next.y) / 2)}`;
  }
  const last = rest[rest.length - 1]!;
  d += ` L${r(last.x)},${r(last.y)}`;
  return d;
}

const r = (n: number) => Math.round(n * 10) / 10;

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{{TITLE}} · arch-map</title>
<style>
:root {
  --bg: #f6f7f9; --panel: #ffffff; --line: #dfe3e8; --text: #1b1f24; --muted: #5f6b7a;
  --node: #ffffff; --group: #eef1f5; --group-ext: #f1f1f1; --edge: #8a96a6; --weak: #b3bcc8; --ext-edge: #a7a7a7;
  --error: #d1343b; --warning: #c77700; --accent: #2f6fd6;
  --web: #2f6fd6; --api: #1f8a70; --worker: #7a5af5; --cli: #c77700; --library: #8a96a6;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0f1216; --panel: #161a20; --line: #2a313b; --text: #e6e9ee; --muted: #93a0b1;
    --node: #1c2129; --group: #141920; --group-ext: #171a1f; --edge: #6b7787; --weak: #48525f; --ext-edge: #56606c;
    --error: #ff6b6b; --warning: #f0a83a; --accent: #6aa1ff;
    --web: #6aa1ff; --api: #3cc3a0; --worker: #a08cff; --cli: #f0a83a; --library: #6b7787;
  }
}
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; background: var(--bg); color: var(--text); font: 14px/1.45 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
header { display: flex; flex-wrap: wrap; align-items: center; gap: 12px 20px; padding: 12px 16px; border-bottom: 1px solid var(--line); background: var(--panel); }
header h1 { margin: 0; font-size: 16px; font-weight: 600; }
header .meta { color: var(--muted); font-size: 12.5px; }
.counts { display: flex; gap: 8px; }
.count { font-size: 12px; padding: 2px 9px; border-radius: 99px; border: 1px solid var(--line); }
.count-error { color: var(--error); } .count-warning { color: var(--warning); }
.tools { margin-left: auto; display: flex; gap: 6px; }
button { font: inherit; font-size: 13px; color: var(--text); background: var(--panel); border: 1px solid var(--line); border-radius: 7px; padding: 4px 10px; cursor: pointer; }
button:hover { border-color: var(--muted); }
main { display: grid; grid-template-columns: 1fr 380px; height: calc(100% - 57px); }
#canvas { position: relative; overflow: hidden; cursor: grab; touch-action: none; }
#canvas.dragging { cursor: grabbing; }
svg { position: absolute; left: 0; top: 0; transform-origin: 0 0; }
aside { border-left: 1px solid var(--line); background: var(--panel); overflow: auto; }
aside section { padding: 14px 16px; border-bottom: 1px solid var(--line); }
aside h2 { margin: 0 0 10px; font-size: 12px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; }
aside h3 { margin: 14px 0 6px; font-size: 12px; font-weight: 600; color: var(--muted); }
.violation { display: block; width: 100%; text-align: left; padding: 8px 10px; margin-bottom: 6px; border-radius: 8px; border: 1px solid var(--line); background: transparent; }
.violation .rule { font-size: 11.5px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.violation.sev-error .rule { color: var(--error); } .violation.sev-warning .rule { color: var(--warning); }
.violation .where { display: block; color: var(--muted); font-size: 11.5px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; overflow-wrap: anywhere; }
.empty { color: var(--muted); }
dl { margin: 0; display: grid; grid-template-columns: 90px 1fr; gap: 4px 10px; font-size: 13px; }
dt { color: var(--muted); }
dd { margin: 0; overflow-wrap: anywhere; }
ul.refs { list-style: none; margin: 0; padding: 0; font-size: 13px; }
ul.refs li { display: flex; gap: 8px; align-items: baseline; padding: 2px 0; }
ul.refs a { color: var(--accent); text-decoration: none; cursor: pointer; }
ul.refs a:hover { text-decoration: underline; }
ul.refs .note { margin-left: auto; color: var(--muted); font-size: 12px; white-space: nowrap; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
.group rect { fill: var(--group); stroke: var(--line); }
.group-external rect { fill: var(--group-ext); stroke-dasharray: 5 4; }
.group text { fill: var(--muted); font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .05em; }
.edge path { fill: none; stroke: var(--edge); stroke-width: 1.4; transition: opacity .15s; }
.edge-weak path { stroke: var(--weak); stroke-dasharray: 5 4; }
.edge-external path { stroke: var(--ext-edge); stroke-dasharray: 2 3; }
.edge-violation path { stroke: var(--error); stroke-width: 2; }
.edge-warning path { stroke: var(--warning); stroke-width: 2; stroke-dasharray: 5 4; }
.edge-warning .edge-label text { fill: var(--warning); }
.edge-label rect { fill: var(--bg); stroke: var(--line); }
.edge-label text { fill: var(--muted); font-size: 11px; text-anchor: middle; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.edge-violation .edge-label text { fill: var(--error); }
.node { cursor: pointer; transition: opacity .15s; }
.node .box { fill: var(--node); stroke: var(--line); }
.node:hover .box, .node:focus .box { stroke: var(--muted); }
.node.selected .box { stroke: var(--text); stroke-width: 2; }
.node.has-error .box { stroke: var(--error); } .node.has-warning .box { stroke: var(--warning); }
.node .label { fill: var(--text); font-size: 12.5px; font-weight: 600; }
.node .detail { fill: var(--muted); font-size: 11px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.node.external .box { fill: var(--group-ext); stroke: var(--ext-edge); }
.node:focus { outline: none; }
.kind-web .bar { fill: var(--web); } .kind-api .bar { fill: var(--api); } .kind-worker .bar { fill: var(--worker); }
.kind-cli .bar { fill: var(--cli); } .kind-library .bar { fill: var(--library); }
.badge circle { stroke: var(--panel); stroke-width: 2; }
.badge text { fill: #fff; font-size: 10.5px; font-weight: 700; text-anchor: middle; }
.badge-error circle { fill: var(--error); } .badge-warning circle { fill: var(--warning); }
.marker-dep { fill: var(--edge); } .marker-weak { fill: var(--weak); } .marker-external { fill: var(--ext-edge); } .marker-violation { fill: var(--error); } .marker-warning { fill: var(--warning); }
svg.focus .node:not(.related), svg.focus .edge:not(.related) { opacity: .18; }
@media (max-width: 800px) {
  main { grid-template-columns: 1fr; grid-template-rows: 60vh auto; height: auto; }
  aside { border-left: 0; border-top: 1px solid var(--line); }
  .tools { margin-left: 0; }
}
</style>
</head>
<body>
<header>
  <div><h1>{{NAME}}</h1><div class="meta">{{META}}</div></div>
  <div class="counts">{{COUNTS}}</div>
  <div class="tools"><button id="zoom-out" aria-label="Zoom out">−</button><button id="zoom-in" aria-label="Zoom in">+</button><button id="fit">Fit</button></div>
</header>
<main>
  <div id="canvas">
    <svg id="diagram" xmlns="http://www.w3.org/2000/svg" width="{{WIDTH}}" height="{{HEIGHT}}" viewBox="0 0 {{WIDTH}} {{HEIGHT}}">
      <defs>
${['dep', 'weak', 'external', 'violation', 'warning'].map((k) => `        <marker id="arrow-${k}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="marker-${k}" d="M0,0 L10,5 L0,10 z"/></marker>`).join('\n')}
      </defs>
      {{SVG}}
    </svg>
  </div>
  <aside>
    <section id="details"><h2>Details</h2><p class="empty">Select a package to see what it depends on, what depends on it and the external systems it reaches.</p></section>
    <section><h2>Violations</h2><div id="violations"></div></section>
  </aside>
</main>
<script type="application/json" id="data">{{DATA}}</script>
<script>
(() => {
  const data = JSON.parse(document.getElementById('data').textContent);
  const canvas = document.getElementById('canvas');
  const svg = document.getElementById('diagram');
  const W = svg.width.baseVal.value, H = svg.height.baseVal.value;
  let scale = 1, tx = 0, ty = 0;
  const apply = () => { svg.style.transform = 'translate(' + tx + 'px,' + ty + 'px) scale(' + scale + ')'; };
  const fit = () => {
    const r = canvas.getBoundingClientRect();
    scale = Math.min(r.width / W, r.height / H, 1);
    tx = (r.width - W * scale) / 2; ty = Math.max(0, (r.height - H * scale) / 2);
    apply();
  };
  const zoomAt = (factor, cx, cy) => {
    const next = Math.min(3, Math.max(0.15, scale * factor));
    tx = cx - (cx - tx) * (next / scale); ty = cy - (cy - ty) * (next / scale); scale = next; apply();
  };
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const r = canvas.getBoundingClientRect();
    zoomAt(e.deltaY < 0 ? 1.12 : 1 / 1.12, e.clientX - r.left, e.clientY - r.top);
  }, { passive: false });
  let drag = null, moved = false;
  canvas.addEventListener('pointerdown', (e) => { if (e.target.closest('.node')) return; drag = { x: e.clientX - tx, y: e.clientY - ty }; moved = false; canvas.classList.add('dragging'); canvas.setPointerCapture(e.pointerId); });
  canvas.addEventListener('pointermove', (e) => { if (!drag) return; moved = true; tx = e.clientX - drag.x; ty = e.clientY - drag.y; apply(); });
  canvas.addEventListener('pointerup', (e) => { if (drag && !moved && !e.target.closest('.node')) clear(); drag = null; canvas.classList.remove('dragging'); });
  document.getElementById('fit').onclick = fit;
  document.getElementById('zoom-in').onclick = () => { const r = canvas.getBoundingClientRect(); zoomAt(1.25, r.width / 2, r.height / 2); };
  document.getElementById('zoom-out').onclick = () => { const r = canvas.getBoundingClientRect(); zoomAt(0.8, r.width / 2, r.height / 2); };

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const nodeEl = (id) => document.querySelector('.node[data-id="' + CSS.escape(id) + '"]');
  const detailsEl = document.getElementById('details');
  const intro = detailsEl.innerHTML;
  const ref = (item, note) => '<li><a data-go="' + esc(item.id) + '">' + esc(item.name) + '</a>' + (note ? '<span class="note">' + esc(note) + '</span>' : '') + '</li>';
  const refs = (title, items, note) => items.length ? '<h3>' + title + '</h3><ul class="refs">' + items.map((i) => ref(i, note(i))).join('') + '</ul>' : '';
  const plural = (n, w) => n + ' ' + w + (n === 1 ? '' : 's');
  const violationHtml = (v) => '<span class="rule">' + esc(v.rule) + '</span><br>' + esc(v.message) + (v.file ? '<span class="where">' + esc(v.file) + (v.line ? ':' + v.line : '') + '</span>' : '');

  const clear = () => {
    svg.classList.remove('focus');
    document.querySelectorAll('.selected, .related').forEach((n) => n.classList.remove('selected', 'related'));
    detailsEl.innerHTML = intro;
  };

  const highlight = (id, edgeTo) => {
    svg.classList.add('focus');
    document.querySelectorAll('.selected, .related').forEach((n) => n.classList.remove('selected', 'related'));
    const el = nodeEl(id);
    el.classList.add('selected', 'related');
    document.querySelectorAll('.edge').forEach((e) => {
      const hit = edgeTo ? e.dataset.from === id && e.dataset.to === edgeTo : e.dataset.from === id || e.dataset.to === id;
      if (!hit) return;
      e.classList.add('related');
      nodeEl(e.dataset.from === id ? e.dataset.to : e.dataset.from)?.classList.add('related');
    });
    return el;
  };

  const center = (el) => {
    const box = el.getBBox(), r = canvas.getBoundingClientRect();
    scale = Math.max(scale, 0.8);
    tx = r.width / 2 - (box.x + box.width / 2) * scale; ty = r.height / 2 - (box.y + box.height / 2) * scale; apply();
  };

  const select = (id, opts = {}) => {
    const d = data.details[id];
    if (!d) return;
    const el = highlight(id, opts.edgeTo);
    if (d.type === 'package') {
      const own = data.violations.filter((v) => v.node === id);
      detailsEl.innerHTML = '<h2>Package</h2><dl>' +
        '<dt>Name</dt><dd>' + esc(d.name) + '</dd>' +
        '<dt>Path</dt><dd><code>' + esc(d.dir) + '</code></dd>' +
        '<dt>Kind</dt><dd>' + esc(d.kind) + ' · ' + esc(d.technology) + '</dd>' +
        (d.layer ? '<dt>Group</dt><dd>' + esc(d.layer) + '</dd>' : '') +
        (d.description ? '<dt>About</dt><dd>' + esc(d.description) + '</dd>' : '') + '</dl>' +
        refs('Depends on', d.dependsOn, (x) => x.imports === 0 ? 'declared, not imported' : plural(x.imports, 'import') + (x.testOnly ? ', tests only' : '') + (x.declared ? '' : ', not declared')) +
        refs('Used by', d.usedBy, (x) => x.imports === 0 ? 'declared, not imported' : plural(x.imports, 'import') + (x.testOnly ? ', tests only' : '')) +
        refs('External systems', d.externals, (x) => x.via ? 'via ' + x.via : 'direct') +
        (d.components.length ? '<h3>Folders</h3><ul class="refs">' + d.components.map((c) => '<li><code>' + esc(c.name) + '</code><span class="note">' + plural(c.files, 'file') + '</span></li>').join('') + '</ul>' : '') +
        (own.length ? '<h3>Violations</h3>' + own.map((v) => '<p class="violation sev-' + v.severity + '">' + violationHtml(v) + '</p>').join('') : '');
    } else {
      detailsEl.innerHTML = '<h2>External system</h2><dl>' +
        '<dt>Name</dt><dd>' + esc(d.name) + '</dd>' +
        '<dt>Kind</dt><dd>' + esc(d.kind) + '</dd>' +
        '<dt>Found from</dt><dd>' + d.detectedFrom.map((x) => '<code>' + esc(x) + '</code>').join(', ') + '</dd></dl>' +
        refs('Used directly by', d.usedBy, () => '');
    }
    detailsEl.querySelectorAll('[data-go]').forEach((a) => { a.onclick = () => select(a.dataset.go, { center: true }); });
    if (opts.center) center(el);
  };

  document.querySelectorAll('.node').forEach((n) => {
    n.addEventListener('click', () => select(n.dataset.id));
    n.addEventListener('keydown', (e) => { if (e.key === 'Enter') select(n.dataset.id); });
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') clear(); });

  const list = document.getElementById('violations');
  if (!data.violations.length) list.innerHTML = '<p class="empty">No violations.</p>';
  data.violations.forEach((v) => {
    const b = document.createElement('button');
    b.className = 'violation sev-' + v.severity;
    b.innerHTML = violationHtml(v);
    b.onclick = () => { if (v.node) select(v.node, { center: true, edgeTo: v.edgeTo }); };
    list.appendChild(b);
  });
  window.addEventListener('resize', fit);
  fit();
})();
</script>
</body>
</html>
`;
