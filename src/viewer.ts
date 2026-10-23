import dagre from '@dagrejs/dagre';
import { transitiveExternals, verb } from './diagrams.js';
import { matchGlob } from './glob.js';
import { isTestFile } from './imports.js';
import type { ArchitectureModel, Config, Container, Violation } from './types.js';

/** A node in one of the interactive views. */
export interface ViewNode {
  id: string;
  label: string;
  detail?: string;
  /** CSS classes: `kind-web`, `external`, `person`, `system`, `component`... */
  cls: string;
  pill?: boolean;
  width?: number;
  badge?: { count: number; severity: 'error' | 'warning' };
}

export interface ViewEdge {
  from: string;
  to: string;
  kind: 'dep' | 'weak' | 'external' | 'violation' | 'warning' | 'uses';
  label?: string;
}

export interface ViewGroup {
  title: string;
  members: string[];
  cls?: string;
}

/** Everything needed to draw one view and fill its side panel. */
export interface View {
  title: string;
  nodes: ViewNode[];
  edges: ViewEdge[];
  groups: ViewGroup[];
  /** Side panel HTML per node id. Links use `data-go="<node id>"`. */
  details: Record<string, string>;
  rankdir?: 'TB' | 'LR';
}

export interface LaidOut {
  title: string;
  svg: string;
  details: Record<string, string>;
}

const NODE_W = 220;
const NODE_H = 50;
const KIND_LABEL = { web: 'web app', api: 'API', worker: 'worker', cli: 'CLI', library: 'library' } as const;

export const pkgId = (name: string) => `pkg:${name}`;
export const extId = (id: string) => `ext:${id}`;
export const cmpId = (pkg: string, cmp: string) => `cmp:${pkg}:${cmp}`;

// ---------------------------------------------------------------- views

/** Every workspace package and its dependencies, grouped by layer. External systems are listed in the side panel. */
export function packagesView(model: ArchitectureModel, config: Config = {}, violations: Violation[] = []): View {
  const bad = new Map<string, Violation[]>();
  for (const v of violations) {
    if (!v.from || !v.to || v.from === v.to) continue;
    bad.set(`${v.from}->${v.to}`, [...(bad.get(`${v.from}->${v.to}`) ?? []), v]);
  }
  const edges: ViewEdge[] = model.edges.map((e) => {
    const found = bad.get(`${e.from}->${e.to}`);
    const weak = e.imports === 0 || e.testOnly;
    return {
      from: pkgId(e.from),
      to: pkgId(e.to),
      kind: found ? (found.some((v) => v.severity === 'error') ? 'violation' : 'warning') : weak ? 'weak' : 'dep',
      label: found ? [...new Set(found.map((v) => v.rule))].join(', ') : e.imports === 0 ? 'unused' : e.testOnly ? 'tests' : undefined,
    };
  });
  const groups: ViewGroup[] = groupPackages(model, config).map((g) => ({ title: g.name, members: g.members.map((c) => pkgId(c.name)) }));

  return {
    title: 'Packages',
    nodes: model.containers.map((c) => packageNode(c, violations)),
    edges,
    groups,
    details: { ...packageDetails(model, config, violations), ...externalDetails(model) },
  };
}

/** C4 level 1: the system, its users and the external systems it talks to. */
export function contextView(model: ArchitectureModel, config: Config = {}, violations: Violation[] = []): View {
  const users = hasUsers(model.containers);
  const nodes: ViewNode[] = [];
  const edges: ViewEdge[] = [];
  if (users) nodes.push(userNode());
  const errors = violations.filter((v) => v.severity === 'error').length;
  nodes.push({ id: 'system', label: model.name, detail: 'software system', cls: 'system', width: 260, badge: violations.length ? { count: violations.length, severity: errors ? 'error' : 'warning' } : undefined });
  nodes.push(...model.externals.map(externalNode));
  if (users) edges.push({ from: 'user', to: 'system', kind: 'uses', label: 'Uses' });
  for (const e of model.externals) edges.push({ from: 'system', to: extId(e.id), kind: 'external', label: verb(e) });
  const deployables = model.containers.filter((c) => c.kind !== 'library');
  return {
    title: 'System context',
    nodes,
    edges,
    groups: [],
    details: {
      user: userDetails(model),
      system: panel('Software system', [['Name', esc(model.name)], ['Packages', String(model.containers.length)], ['Deployable', String(deployables.length)]]) +
        refs('Containers', deployables.map((c) => ({ id: pkgId(c.name), name: c.name, note: `${KIND_LABEL[c.kind]} · ${c.technology}` })), 'containers') +
        refs('External systems', model.externals.map((e) => ({ id: extId(e.id), name: e.name, note: e.kind }))) +
        violationList(violations),
      ...externalDetails(model),
    },
  };
}

/** C4 level 2: deployable packages and the external systems each one reaches, directly or through a library. */
export function containersView(model: ArchitectureModel, config: Config = {}, violations: Violation[] = []): View {
  const deployables = model.containers.filter((c) => c.kind !== 'library');
  const shown = deployables.length ? deployables : model.containers;
  const reach = transitiveExternals(model);
  const used = new Set(shown.flatMap((c) => [...(reach.get(c.name)?.keys() ?? [])]));
  const externals = model.externals.filter((e) => used.has(e.id));
  const nodes: ViewNode[] = [];
  const edges: ViewEdge[] = [];
  const users = hasUsers(shown);
  if (users) nodes.push(userNode());
  nodes.push(...shown.map((c) => ({ ...packageNode(c, violations), detail: c.technology, label: c.name })));
  nodes.push(...externals.map(externalNode));
  const fronts = shown.filter((c) => c.kind === 'web' || c.kind === 'cli');
  for (const c of fronts) edges.push({ from: 'user', to: pkgId(c.name), kind: 'uses', label: 'Uses' });
  if (!fronts.length && users) for (const c of shown.filter((x) => x.kind === 'api')) edges.push({ from: 'user', to: pkgId(c.name), kind: 'uses', label: 'Calls' });
  for (const c of shown) {
    for (const [ext, via] of reach.get(c.name) ?? []) {
      const system = model.externals.find((x) => x.id === ext)!;
      edges.push({ from: pkgId(c.name), to: extId(ext), kind: 'external', label: via ? `${verb(system)} via ${via}` : verb(system) });
    }
  }
  const all = packageDetails(model, config, violations);
  return {
    title: 'Containers',
    nodes,
    edges,
    groups: [
      { title: model.name, members: shown.map((c) => pkgId(c.name)) },
      ...(externals.length ? [{ title: 'External systems', members: externals.map((e) => extId(e.id)), cls: 'group-external' }] : []),
    ],
    details: { user: userDetails(model), ...Object.fromEntries(shown.map((c) => [pkgId(c.name), all[pkgId(c.name)]!])), ...externalDetails(model) },
  };
}

/** C4 level 3: folders inside one package, the imports between them, and what each folder uses outside the package. */
export function componentsView(model: ArchitectureModel, pkg: string, violations: Violation[] = []): View {
  const components = model.components.filter((c) => c.package === pkg);
  const forbidden = violations.filter((v) => v.rule === 'forbidden' && v.file && model.fileOwners[v.file] === pkg);
  const files = (cmp: string) => Object.keys(model.fileComponents).filter((f) => model.fileOwners[f] === pkg && model.fileComponents[f] === cmp && !isTestFile(f)).sort();
  const nodes: ViewNode[] = components.map((c) => {
    const own = forbidden.filter((v) => model.fileComponents[v.file!] === c.id);
    return { id: cmpId(pkg, c.id), label: c.id, detail: `${c.files} file${c.files === 1 ? '' : 's'}`, cls: 'component', badge: own.length ? { count: own.length, severity: 'error' } : undefined };
  });
  const edges: ViewEdge[] = [];
  const outside = new Set<string>();
  const exts = new Set<string>();

  for (const e of model.componentEdges.filter((x) => x.package === pkg)) {
    const violation = forbidden.some((v) => model.fileComponents[v.file!] === e.from && v.target && model.fileOwners[v.target] === pkg && model.fileComponents[v.target] === e.to);
    edges.push({ from: cmpId(pkg, e.from), to: cmpId(pkg, e.to), kind: violation ? 'violation' : 'dep', label: violation ? 'forbidden' : `${e.imports}` });
  }
  for (const c of components) {
    const targets = new Map<string, number>();
    for (const i of model.imports) {
      if (!i.package || model.fileOwners[i.from] !== pkg || model.fileComponents[i.from] !== c.id || isTestFile(i.from)) continue;
      targets.set(i.package, (targets.get(i.package) ?? 0) + 1);
    }
    for (const [t, n] of [...targets].sort()) {
      outside.add(t);
      const violation = forbidden.some((v) => model.fileComponents[v.file!] === c.id && v.target === t);
      edges.push({ from: cmpId(pkg, c.id), to: pkgId(t), kind: violation ? 'violation' : 'dep', label: violation ? 'forbidden' : `${n}` });
    }
    for (const ext of c.externals) {
      exts.add(ext);
      edges.push({ from: cmpId(pkg, c.id), to: extId(ext), kind: 'external' });
    }
  }
  const container = model.containers.find((c) => c.name === pkg);
  const others = model.containers.filter((c) => outside.has(c.name));
  nodes.push(...others.map((c) => ({ id: pkgId(c.name), label: c.name, detail: `${KIND_LABEL[c.kind]} · ${c.technology}`, cls: `kind-${c.kind}` })));
  const externals = model.externals.filter((e) => exts.has(e.id));
  nodes.push(...externals.map(externalNode));

  const details: Record<string, string> = {};
  for (const c of components) {
    const id = cmpId(pkg, c.id);
    const out = edges.filter((e) => e.from === id && e.kind !== 'external');
    const into = edges.filter((e) => e.to === id);
    const own = forbidden.filter((v) => model.fileComponents[v.file!] === c.id);
    details[id] = panel('Folder', [['Package', esc(pkg)], ['Folder', `<code>${esc(c.id)}</code>`], ['Files', String(c.files)]]) +
      refs('Imports from', out.map((e) => ({ id: e.to, name: nameOf(e.to), note: e.kind === 'violation' ? 'forbidden' : `${e.label} import${e.label === '1' ? '' : 's'}` }))) +
      refs('Imported by', into.map((e) => ({ id: e.from, name: nameOf(e.from), note: `${e.label} import${e.label === '1' ? '' : 's'}` }))) +
      refs('External systems', c.externals.map((x) => ({ id: extId(x), name: model.externals.find((e) => e.id === x)?.name ?? x }))) +
      list('Files', files(c.id).map((f) => `<code>${esc(f)}</code>`)) +
      violationList(own);
  }
  const all = { ...packageDetails(model, {}, violations), ...externalDetails(model) };
  for (const n of nodes) if (!details[n.id] && all[n.id]) details[n.id] = all[n.id]!;

  return {
    title: `Components of ${pkg}`,
    nodes,
    edges,
    groups: [
      { title: container ? `${pkg} · ${container.dir}` : pkg, members: components.map((c) => cmpId(pkg, c.id)) },
      ...(others.length ? [{ title: 'Workspace packages', members: others.map((c) => pkgId(c.name)) }] : []),
      ...(externals.length ? [{ title: 'External systems', members: externals.map((e) => extId(e.id)), cls: 'group-external' }] : []),
    ],
    details,
    rankdir: 'LR',
  };

  function nameOf(id: string): string {
    if (id.startsWith('cmp:')) return id.slice(`cmp:${pkg}:`.length);
    return id.slice(4);
  }
}

// ---------------------------------------------------------------- layout

/** Lays out a view with dagre and draws it as SVG. */
export function layout(view: View): LaidOut {
  const g = new dagre.graphlib.Graph({ compound: true, multigraph: true });
  g.setGraph({ rankdir: view.rankdir ?? 'TB', nodesep: 30, ranksep: view.rankdir === 'LR' ? 80 : 56, edgesep: 14, marginx: 40, marginy: 40 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of view.nodes) g.setNode(n.id, { width: n.width ?? (n.pill ? NODE_W - 40 : NODE_W), height: n.pill ? NODE_H - 6 : NODE_H });
  view.groups.forEach((group, i) => {
    if (!group.members.length) return;
    g.setNode(`group:${i}`, { paddingTop: 30, paddingBottom: 14, paddingLeft: 14, paddingRight: 14 });
    for (const m of group.members) g.setParent(m, `group:${i}`);
  });
  view.edges.forEach((e, i) => {
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

  view.groups.forEach((group, i) => {
    const c = g.node(`group:${i}`) as Placed | undefined;
    if (!c) return;
    grow(c);
    const x = c.x - c.width / 2;
    const y = c.y - c.height / 2;
    parts.push(`<g class="group ${group.cls ?? 'group-layer'}"><rect x="${x}" y="${y}" width="${c.width}" height="${c.height}" rx="12"/><text x="${x + 14}" y="${y + 19}">${esc(group.title)}</text></g>`);
  });

  view.edges.forEach((e, i) => {
    const placed = g.edge({ v: e.from, w: e.to, name: `e${i}` }) as { points: { x: number; y: number }[]; x?: number; y?: number };
    if (!placed?.points?.length) return;
    parts.push(`<g class="edge edge-${e.kind}" data-from="${esc(e.from)}" data-to="${esc(e.to)}"><path d="${curve(placed.points)}" marker-end="url(#arrow-${e.kind})"/>`);
    if (e.label && placed.x !== undefined && placed.y !== undefined) {
      const w = e.label.length * 6.6 + 12;
      parts.push(`<g class="edge-label"><rect x="${placed.x - w / 2}" y="${placed.y - 9}" width="${w}" height="18" rx="9"/><text x="${placed.x}" y="${placed.y + 4}">${esc(e.label)}</text></g>`);
    }
    parts.push('</g>');
  });

  for (const n of view.nodes) {
    const p = g.node(n.id) as Placed;
    grow(p);
    const x = p.x - p.width / 2;
    const y = p.y - p.height / 2;
    const badge = n.badge
      ? `<g class="badge badge-${n.badge.severity}"><circle cx="${x + p.width - 4}" cy="${y + 4}" r="9"/><text x="${x + p.width - 4}" y="${y + 8}">${n.badge.count}</text></g>`
      : '';
    const classes = `node ${n.cls}${n.badge ? ` has-${n.badge.severity}` : ''}`;
    if (n.pill) {
      parts.push(`<g class="${classes}" data-id="${esc(n.id)}" tabindex="0">
<rect class="box" x="${x}" y="${y}" width="${p.width}" height="${p.height}" rx="${p.height / 2}"/>
<text class="label" x="${p.x}" y="${y + 19}" text-anchor="middle">${esc(truncate(n.label, 24))}</text>
<text class="detail" x="${p.x}" y="${y + 35}" text-anchor="middle">${esc(n.detail ?? '')}</text>
${badge}
</g>`);
    } else {
      parts.push(`<g class="${classes}" data-id="${esc(n.id)}" tabindex="0">
<rect class="box" x="${x}" y="${y}" width="${p.width}" height="${p.height}" rx="8"/>
<rect class="bar" x="${x}" y="${y}" width="5" height="${p.height}" rx="2"/>
<text class="label" x="${x + 16}" y="${y + 21}">${esc(truncate(n.label, Math.floor((p.width - 24) / 7.6)))}</text>
<text class="detail" x="${x + 16}" y="${y + 38}">${esc(truncate(n.detail ?? '', Math.floor((p.width - 24) / 6.7)))}</text>
${badge}
</g>`);
    }
  }

  const w = Math.ceil(maxX);
  const h = Math.ceil(maxY);
  const markers = ['dep', 'weak', 'external', 'violation', 'warning', 'uses']
    .map((k) => `<marker id="arrow-${k}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="marker-${k}" d="M0,0 L10,5 L0,10 z"/></marker>`)
    .join('');
  return {
    title: view.title,
    svg: `<svg class="diagram" xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><defs>${markers}</defs>\n${parts.join('\n')}\n</svg>`,
    details: view.details,
  };
}

interface Placed {
  x: number;
  y: number;
  width: number;
  height: number;
}

// ---------------------------------------------------------------- nodes and side panel

function packageNode(c: Container, violations: Violation[]): ViewNode {
  const own = violations.filter((v) => v.from === c.name);
  return {
    id: pkgId(c.name),
    label: c.name,
    detail: `${KIND_LABEL[c.kind]} · ${c.technology}`,
    cls: `kind-${c.kind}`,
    badge: own.length ? { count: own.length, severity: own.some((v) => v.severity === 'error') ? 'error' : 'warning' } : undefined,
  };
}

function externalNode(e: ArchitectureModel['externals'][number]): ViewNode {
  return { id: extId(e.id), label: e.name, detail: e.kind, cls: 'external', pill: true };
}

function userNode(): ViewNode {
  return { id: 'user', label: 'User', detail: 'person', cls: 'person', pill: true };
}

function hasUsers(list: Container[]): boolean {
  return list.some((c) => c.kind === 'web' || c.kind === 'cli' || c.kind === 'api');
}

function packageDetails(model: ArchitectureModel, config: Config, violations: Violation[]): Record<string, string> {
  const reach = transitiveExternals(model);
  const groups = groupPackages(model, config);
  const externalName = (id: string) => model.externals.find((x) => x.id === id)?.name ?? id;
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const out: Record<string, string> = {};
  for (const c of model.containers) {
    const layer = groups.find((g) => g.members.includes(c))?.name;
    out[pkgId(c.name)] =
      panel('Package', [
        ['Name', esc(c.name)],
        ['Path', `<code>${esc(c.dir)}</code>`],
        ['Kind', `${KIND_LABEL[c.kind]} · ${esc(c.technology)}`],
        ...(layer ? [['Group', esc(layer)] as [string, string]] : []),
        ...(c.description ? [['About', esc(c.description)] as [string, string]] : []),
      ]) +
      refs('Depends on', model.edges.filter((e) => e.from === c.name).map((e) => ({
        id: pkgId(e.to),
        name: e.to,
        note: e.imports === 0 ? 'declared, not imported' : plural(e.imports, 'import') + (e.testOnly ? ', tests only' : '') + (e.declared ? '' : ', not declared'),
      }))) +
      refs('Used by', model.edges.filter((e) => e.to === c.name).map((e) => ({
        id: pkgId(e.from),
        name: e.from,
        note: e.imports === 0 ? 'declared, not imported' : plural(e.imports, 'import') + (e.testOnly ? ', tests only' : ''),
      }))) +
      refs('External systems', [...(reach.get(c.name) ?? [])].map(([id, via]) => ({ id: extId(id), name: externalName(id), note: via ? `via ${via}` : 'direct' }))) +
      refs('Folders', model.components.filter((x) => x.package === c.name).map((x) => ({ id: cmpId(c.name, x.id), name: x.id, note: plural(x.files, 'file') })), 'components') +
      violationList(violations.filter((v) => v.from === c.name));
  }
  return out;
}

function externalDetails(model: ArchitectureModel): Record<string, string> {
  const reach = transitiveExternals(model);
  return Object.fromEntries(
    model.externals.map((e) => [
      extId(e.id),
      panel('External system', [['Name', esc(e.name)], ['Kind', esc(e.kind)], ['Found from', e.via.map((v) => `<code>${esc(v)}</code>`).join(', ')]]) +
        refs('Used directly by', model.containers.filter((c) => c.externals.includes(e.id)).map((c) => ({ id: pkgId(c.name), name: c.name }))) +
        refs('Reached through a library by', model.containers.filter((c) => !c.externals.includes(e.id) && reach.get(c.name)?.has(e.id)).map((c) => ({ id: pkgId(c.name), name: c.name, note: `via ${reach.get(c.name)!.get(e.id)}` }))),
    ]),
  );
}

function userDetails(model: ArchitectureModel): string {
  const fronts = model.containers.filter((c) => c.kind === 'web' || c.kind === 'cli' || c.kind === 'api');
  return panel('Person', [['Name', 'User']]) + refs('Uses', fronts.map((c) => ({ id: pkgId(c.name), name: c.name, note: KIND_LABEL[c.kind] })), 'containers');
}

function panel(title: string, rows: [string, string][]): string {
  return `<h2>${esc(title)}</h2><dl>${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('')}</dl>`;
}

/** A list of links to other nodes. `view` names the view the target lives in when it is not the current one. */
function refs(title: string, items: { id: string; name: string; note?: string }[], view?: string): string {
  if (!items.length) return '';
  return `<h3>${esc(title)}</h3><ul class="refs">${items
    .map((i) => `<li><a data-go="${esc(i.id)}"${view ? ` data-view="${view}"` : ''}>${esc(i.name)}</a>${i.note ? `<span class="note">${esc(i.note)}</span>` : ''}</li>`)
    .join('')}</ul>`;
}

function list(title: string, items: string[]): string {
  return items.length ? `<h3>${esc(title)}</h3><ul class="refs">${items.map((i) => `<li>${i}</li>`).join('')}</ul>` : '';
}

export function violationHtml(v: Violation): string {
  return `<span class="rule">${esc(v.rule)}</span><br>${esc(v.message)}${v.file ? `<span class="where">${esc(v.file)}${v.line ? `:${v.line}` : ''}</span>` : ''}`;
}

function violationList(list: Violation[]): string {
  return list.length ? `<h3>Violations</h3>${list.map((v) => `<p class="violation sev-${v.severity}">${violationHtml(v)}</p>`).join('')}` : '';
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

export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------- page

/** A self-contained HTML page with the package graph, details per package and the rule violations. No network access is needed to open it. */
export function renderViewer(model: ArchitectureModel, config: Config = {}, violations: Violation[] = []): string {
  const view = layout(packagesView(model, config, violations));
  const errors = violations.filter((v) => v.severity === 'error').length;
  const deps = model.edges.filter((e) => e.imports > 0).length;
  const data = { details: view.details, violations: violations.map((v) => ({ html: violationHtml(v), severity: v.severity, node: v.from ? pkgId(v.from) : undefined, edgeTo: v.to && v.to !== v.from ? pkgId(v.to) : undefined })) };
  return PAGE.replace('{{TITLE}}', () => esc(model.name))
    .replace('{{NAME}}', () => esc(model.name))
    .replace('{{META}}', () => esc(`${model.containers.length} packages · ${deps} dependencies · ${model.externals.length} external systems`))
    .replace('{{COUNTS}}', () => countsHtml(errors, violations.length - errors))
    .replace('{{SVG}}', () => view.svg)
    .replace('{{DATA}}', () => JSON.stringify(data).replace(/</g, '\\u003c'));
}

export function countsHtml(errors: number, warnings: number): string {
  return `<span class="count count-error">${errors} error${errors === 1 ? '' : 's'}</span><span class="count count-warning">${warnings} warning${warnings === 1 ? '' : 's'}</span>`;
}

/** Colours, diagram and side panel styles shared by the static page and the `serve` app. */
export const GRAPH_CSS = `
:root {
  --bg: #f6f7f9; --panel: #ffffff; --line: #dfe3e8; --text: #1b1f24; --muted: #5f6b7a; --hover: #eef1f5;
  --node: #ffffff; --group: #eef1f5; --group-ext: #f1f1f1; --edge: #8a96a6; --weak: #b3bcc8; --ext-edge: #a7a7a7;
  --error: #d1343b; --warning: #c77700; --accent: #2f6fd6;
  --web: #2f6fd6; --api: #1f8a70; --worker: #7a5af5; --cli: #c77700; --library: #8a96a6; --component: #0e8fb3;
  --person: #1b1f24; --system: #2f6fd6;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0f1216; --panel: #161a20; --line: #2a313b; --text: #e6e9ee; --muted: #93a0b1; --hover: #1c2129;
    --node: #1c2129; --group: #141920; --group-ext: #171a1f; --edge: #6b7787; --weak: #48525f; --ext-edge: #56606c;
    --error: #ff6b6b; --warning: #f0a83a; --accent: #6aa1ff;
    --web: #6aa1ff; --api: #3cc3a0; --worker: #a08cff; --cli: #f0a83a; --library: #6b7787; --component: #3bbbe0;
    --person: #e6e9ee; --system: #6aa1ff;
  }
}
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; background: var(--bg); color: var(--text); font: 14px/1.45 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
button, .button { display: inline-block; font: inherit; font-size: 13px; text-decoration: none; color: var(--text); background: var(--panel); border: 1px solid var(--line); border-radius: 7px; padding: 4px 10px; cursor: pointer; }
button:hover, .button:hover { border-color: var(--muted); }
code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
.counts { display: flex; gap: 8px; flex-wrap: wrap; }
.count { font-size: 12px; padding: 2px 9px; border-radius: 99px; border: 1px solid var(--line); white-space: nowrap; }
.count-error { color: var(--error); } .count-warning { color: var(--warning); }
.canvas { position: relative; overflow: hidden; cursor: grab; touch-action: none; }
.canvas.dragging { cursor: grabbing; }
.canvas svg { position: absolute; left: 0; top: 0; transform-origin: 0 0; }
.panel { border-left: 1px solid var(--line); background: var(--panel); overflow: auto; }
.panel section { padding: 14px 16px; border-bottom: 1px solid var(--line); }
.panel h2 { margin: 0 0 10px; font-size: 12px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; }
.panel h3 { margin: 14px 0 6px; font-size: 12px; font-weight: 600; color: var(--muted); }
.violation { display: block; width: 100%; text-align: left; padding: 8px 10px; margin: 0 0 6px; border-radius: 8px; border: 1px solid var(--line); background: transparent; }
.violation .rule { font-size: 11.5px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.violation.sev-error .rule { color: var(--error); } .violation.sev-warning .rule { color: var(--warning); }
.violation .where { display: block; color: var(--muted); font-size: 11.5px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; overflow-wrap: anywhere; }
.empty { color: var(--muted); }
dl { margin: 0; display: grid; grid-template-columns: 90px 1fr; gap: 4px 10px; font-size: 13px; }
dt { color: var(--muted); }
dd { margin: 0; overflow-wrap: anywhere; }
ul.refs { list-style: none; margin: 0; padding: 0; font-size: 13px; }
ul.refs li { display: flex; gap: 8px; align-items: baseline; padding: 2px 0; min-width: 0; }
ul.refs a { color: var(--accent); text-decoration: none; cursor: pointer; overflow-wrap: anywhere; }
ul.refs a:hover { text-decoration: underline; }
ul.refs .note { margin-left: auto; color: var(--muted); font-size: 12px; white-space: nowrap; }
.group rect { fill: var(--group); stroke: var(--line); }
.group-external rect { fill: var(--group-ext); stroke-dasharray: 5 4; }
.group text { fill: var(--muted); font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .05em; }
.edge path { fill: none; stroke: var(--edge); stroke-width: 1.4; transition: opacity .15s; }
.edge-weak path { stroke: var(--weak); stroke-dasharray: 5 4; }
.edge-external path { stroke: var(--ext-edge); stroke-dasharray: 2 3; }
.edge-uses path { stroke: var(--muted); }
.edge-violation path { stroke: var(--error); stroke-width: 2; }
.edge-warning path { stroke: var(--warning); stroke-width: 2; stroke-dasharray: 5 4; }
.edge-label rect { fill: var(--bg); stroke: var(--line); }
.edge-label text { fill: var(--muted); font-size: 11px; text-anchor: middle; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.edge-violation .edge-label text { fill: var(--error); } .edge-warning .edge-label text { fill: var(--warning); }
.node { cursor: pointer; transition: opacity .15s; }
.node .box { fill: var(--node); stroke: var(--line); }
.node:hover .box, .node:focus .box { stroke: var(--muted); }
.node.selected .box { stroke: var(--text); stroke-width: 2; }
.node.has-error .box { stroke: var(--error); } .node.has-warning .box { stroke: var(--warning); }
.node .label { fill: var(--text); font-size: 12.5px; font-weight: 600; }
.node .detail { fill: var(--muted); font-size: 11px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.node.external .box { fill: var(--group-ext); stroke: var(--ext-edge); }
.node.person .box { fill: var(--person); stroke: var(--person); } .node.person .label { fill: var(--bg); } .node.person .detail { fill: var(--bg); opacity: .7; }
.node.system .box { fill: var(--system); stroke: var(--system); } .node.system .label { fill: #fff; } .node.system .detail { fill: #fff; opacity: .75; } .node.system .bar { fill: none; }
.node:focus { outline: none; }
.kind-web .bar { fill: var(--web); } .kind-api .bar { fill: var(--api); } .kind-worker .bar { fill: var(--worker); }
.kind-cli .bar { fill: var(--cli); } .kind-library .bar { fill: var(--library); } .component .bar { fill: var(--component); }
.badge circle { stroke: var(--panel); stroke-width: 2; }
.badge text { fill: #fff; font-size: 10.5px; font-weight: 700; text-anchor: middle; }
.badge-error circle { fill: var(--error); } .badge-warning circle { fill: var(--warning); }
.marker-dep { fill: var(--edge); } .marker-weak { fill: var(--weak); } .marker-external { fill: var(--ext-edge); } .marker-uses { fill: var(--muted); }
.marker-violation { fill: var(--error); } .marker-warning { fill: var(--warning); }
svg.focus .node:not(.related), svg.focus .edge:not(.related) { opacity: .18; }
`;

/**
 * Defines `mountGraph(opts)`: pan and zoom, selecting a node (its edges and neighbours stay lit, the rest fades)
 * and the details panel. Returns `{ fit, zoom, select, clear, view, destroy }`.
 */
export const GRAPH_SCRIPT = String.raw`
function mountGraph(opts) {
  const { canvas, details: detailsEl, data } = opts;
  const svg = canvas.querySelector('svg');
  const W = svg.width.baseVal.value, H = svg.height.baseVal.value;
  const ac = new AbortController();
  const on = (el, ev, fn, o) => el.addEventListener(ev, fn, { signal: ac.signal, ...(o || {}) });
  let scale = 1, tx = 0, ty = 0, selected = null;
  const apply = () => { svg.style.transform = 'translate(' + tx + 'px,' + ty + 'px) scale(' + scale + ')'; };
  const fit = () => {
    const r = canvas.getBoundingClientRect();
    scale = Math.min(r.width / W, r.height / H, opts.maxFit || 1);
    tx = (r.width - W * scale) / 2; ty = Math.max(0, (r.height - H * scale) / 2);
    apply();
  };
  const zoomAt = (factor, cx, cy) => {
    const next = Math.min(3, Math.max(0.15, scale * factor));
    tx = cx - (cx - tx) * (next / scale); ty = cy - (cy - ty) * (next / scale); scale = next; apply();
  };
  const zoom = (factor) => { const r = canvas.getBoundingClientRect(); zoomAt(factor, r.width / 2, r.height / 2); };
  on(canvas, 'wheel', (e) => {
    e.preventDefault();
    const r = canvas.getBoundingClientRect();
    zoomAt(e.deltaY < 0 ? 1.12 : 1 / 1.12, e.clientX - r.left, e.clientY - r.top);
  }, { passive: false });
  let drag = null, moved = false;
  on(canvas, 'pointerdown', (e) => { if (e.target.closest('.node')) return; drag = { x: e.clientX - tx, y: e.clientY - ty }; moved = false; canvas.classList.add('dragging'); canvas.setPointerCapture(e.pointerId); });
  on(canvas, 'pointermove', (e) => { if (!drag) return; moved = true; tx = e.clientX - drag.x; ty = e.clientY - drag.y; apply(); });
  on(canvas, 'pointerup', (e) => { if (drag && !moved && !e.target.closest('.node')) clear(); drag = null; canvas.classList.remove('dragging'); });

  const nodeEl = (id) => svg.querySelector('.node[data-id="' + CSS.escape(id) + '"]');
  const intro = detailsEl.innerHTML;
  const clear = () => {
    selected = null;
    svg.classList.remove('focus');
    svg.querySelectorAll('.selected, .related').forEach((n) => n.classList.remove('selected', 'related'));
    detailsEl.innerHTML = intro;
    if (opts.onSelect) opts.onSelect(null);
  };
  const center = (el) => {
    const box = el.getBBox(), r = canvas.getBoundingClientRect();
    scale = Math.max(scale, 0.8);
    tx = r.width / 2 - (box.x + box.width / 2) * scale; ty = r.height / 2 - (box.y + box.height / 2) * scale; apply();
  };
  const select = (id, o = {}) => {
    const el = nodeEl(id);
    if (!el) return false;
    selected = id;
    svg.classList.add('focus');
    svg.querySelectorAll('.selected, .related').forEach((n) => n.classList.remove('selected', 'related'));
    el.classList.add('selected', 'related');
    svg.querySelectorAll('.edge').forEach((e) => {
      const hit = o.edgeTo ? e.dataset.from === id && e.dataset.to === o.edgeTo : e.dataset.from === id || e.dataset.to === id;
      if (!hit) return;
      e.classList.add('related');
      const other = nodeEl(e.dataset.from === id ? e.dataset.to : e.dataset.from);
      if (other) other.classList.add('related');
    });
    detailsEl.innerHTML = data.details[id] || intro;
    detailsEl.querySelectorAll('[data-go]').forEach((a) => {
      // Links into another view only work in the app; on the static page they are plain text.
      if (a.dataset.view && !opts.onNavigate) { a.replaceWith(document.createTextNode(a.textContent)); return; }
      a.onclick = () => {
        if (a.dataset.view && opts.onNavigate) return opts.onNavigate(a.dataset.view, a.dataset.go);
        if (!select(a.dataset.go, { center: true }) && opts.onNavigate) opts.onNavigate(null, a.dataset.go);
      };
    });
    if (o.center) center(el);
    if (opts.onSelect) opts.onSelect(id);
    return true;
  };
  svg.querySelectorAll('.node').forEach((n) => {
    on(n, 'click', () => select(n.dataset.id));
    on(n, 'keydown', (e) => { if (e.key === 'Enter') select(n.dataset.id); });
  });
  on(document, 'keydown', (e) => { if (e.key === 'Escape') clear(); });
  on(window, 'resize', fit);
  if (opts.view) { scale = opts.view.scale; tx = opts.view.tx; ty = opts.view.ty; apply(); } else fit();
  return { fit, zoom, select, clear, selected: () => selected, view: () => ({ scale, tx, ty }), destroy: () => ac.abort() };
}
`;

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{{TITLE}} · arch-map</title>
<style>
${GRAPH_CSS}
header { display: flex; flex-wrap: wrap; align-items: center; gap: 12px 20px; padding: 12px 16px; border-bottom: 1px solid var(--line); background: var(--panel); }
header h1 { margin: 0; font-size: 16px; font-weight: 600; }
header .meta { color: var(--muted); font-size: 12.5px; }
.tools { margin-left: auto; display: flex; gap: 6px; }
main { display: grid; grid-template-columns: 1fr 380px; height: calc(100% - 57px); }
@media (max-width: 800px) {
  main { grid-template-columns: 1fr; grid-template-rows: 60vh auto; height: auto; }
  .panel { border-left: 0; border-top: 1px solid var(--line); }
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
  <div class="canvas" id="canvas">{{SVG}}</div>
  <aside class="panel">
    <section id="details"><h2>Details</h2><p class="empty">Select a package to see what it depends on, what depends on it and the external systems it reaches.</p></section>
    <section><h2>Violations</h2><div id="violations"></div></section>
  </aside>
</main>
<script type="application/json" id="data">{{DATA}}</script>
<script>
${GRAPH_SCRIPT}
(() => {
  const data = JSON.parse(document.getElementById('data').textContent);
  const graph = mountGraph({ canvas: document.getElementById('canvas'), details: document.getElementById('details'), data });
  document.getElementById('fit').onclick = graph.fit;
  document.getElementById('zoom-in').onclick = () => graph.zoom(1.25);
  document.getElementById('zoom-out').onclick = () => graph.zoom(0.8);
  const list = document.getElementById('violations');
  if (!data.violations.length) list.innerHTML = '<p class="empty">No violations.</p>';
  data.violations.forEach((v) => {
    const b = document.createElement('button');
    b.className = 'violation sev-' + v.severity;
    b.innerHTML = v.html;
    b.onclick = () => { if (v.node) graph.select(v.node, { center: true, edgeTo: v.edgeTo }); };
    list.appendChild(b);
  });
})();
</script>
</body>
</html>
`;
