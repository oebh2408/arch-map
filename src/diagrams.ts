import { matchGlob } from './glob.js';
import { isTestFile } from './imports.js';
import type { ArchitectureModel, Config, Container, ExternalSystem, Violation } from './types.js';

const STYLES = [
  'classDef person fill:#08427b,stroke:#052e56,color:#fff',
  'classDef system fill:#1168bd,stroke:#0b4884,color:#fff',
  'classDef container fill:#438dd5,stroke:#2e6295,color:#fff',
  'classDef library fill:#85bbf0,stroke:#5d82a8,color:#000',
  'classDef component fill:#85bbf0,stroke:#5d82a8,color:#000',
  'classDef external fill:#999999,stroke:#6b6b6b,color:#fff',
];

const VIOLATION_STYLE = 'stroke:#d1343b,stroke-width:2px,color:#d1343b';

class Flowchart {
  private lines: string[] = [];
  private edgeCount = 0;
  private styled: number[] = [];
  private groups: string[] = [];

  constructor(direction: 'TB' | 'LR') {
    this.lines.push(`flowchart ${direction}`);
  }

  raw(line: string, indent = 1): void {
    this.lines.push(`${'  '.repeat(indent)}${line}`);
  }

  subgraph(groupId: string, label: string, indent = 1): void {
    this.raw(`subgraph ${groupId} ["${esc(label)}"]`, indent);
    this.groups.push(groupId);
  }

  edge(from: string, to: string, label?: string, opts: { dashed?: boolean; violation?: boolean; indent?: number } = {}): void {
    const arrow = opts.dashed ? '-.->' : '-->';
    const text = label ? `|${quote(label)}|` : '';
    this.raw(`${from} ${arrow}${text} ${to}`, opts.indent ?? 1);
    if (opts.violation) this.styled.push(this.edgeCount);
    this.edgeCount++;
  }

  toString(): string {
    const out = [...this.lines, ...STYLES.map((s) => `  ${s}`), ...this.groups.map((g) => `  style ${g} fill:none,stroke:#888888,stroke-dasharray:5 4`)];
    if (this.styled.length) out.push(`  linkStyle ${this.styled.join(',')} ${VIOLATION_STYLE}`);
    return out.join('\n');
  }
}

const isDeployable = (c: Container) => c.kind !== 'library';

/** Level 1: the system, its users and the external systems it talks to. */
export function contextDiagram(model: ArchitectureModel): string {
  const f = new Flowchart('TB');
  const hasUi = model.containers.some((c) => c.kind === 'web' || c.kind === 'cli');
  const hasApi = model.containers.some((c) => c.kind === 'api');
  if (hasUi || hasApi) f.raw(`user(["<b>User</b><br/>Person"]):::person`);
  f.raw(`system["<b>${esc(model.name)}</b><br/>Software system"]:::system`);
  for (const e of model.externals) f.raw(externalNode(e));
  if (hasUi || hasApi) f.edge('user', 'system', 'Uses');
  for (const e of model.externals) f.edge('system', id('ext', e.id), verb(e));
  return f.toString();
}

/** Level 2: deployable packages inside the system and what each one talks to. */
export function containerDiagram(model: ArchitectureModel): string {
  const f = new Flowchart('TB');
  const deployables = model.containers.filter(isDeployable);
  const shown = deployables.length ? deployables : model.containers;
  const reach = transitiveExternals(model);

  if (shown.some((c) => c.kind === 'web' || c.kind === 'cli' || c.kind === 'api')) f.raw(`user(["<b>User</b><br/>Person"]):::person`);
  f.subgraph('system', model.name);
  for (const c of shown) f.raw(`${id('pkg', c.name)}["<b>${esc(c.name)}</b><br/>[${esc(c.technology)}]${c.description ? `<br/>${esc(c.description)}` : ''}"]:::container`, 2);
  f.raw('end');
  const used = new Set(shown.flatMap((c) => [...(reach.get(c.name)?.keys() ?? [])]));
  for (const e of model.externals.filter((x) => used.has(x.id))) f.raw(externalNode(e));

  for (const c of shown.filter((x) => x.kind === 'web' || x.kind === 'cli')) f.edge('user', id('pkg', c.name), 'Uses');
  if (!shown.some((x) => x.kind === 'web' || x.kind === 'cli')) for (const c of shown.filter((x) => x.kind === 'api')) f.edge('user', id('pkg', c.name), 'Calls');
  for (const c of shown) {
    for (const [ext, via] of reach.get(c.name) ?? []) {
      const system = model.externals.find((x) => x.id === ext)!;
      f.edge(id('pkg', c.name), id('ext', ext), via ? `${verb(system)} via ${via}` : verb(system));
    }
  }
  return f.toString();
}

/** Every workspace package and its dependencies, grouped by layer when layers are configured. */
export function packageDiagram(model: ArchitectureModel, config: Config = {}, violations: Violation[] = []): string {
  const f = new Flowchart('TB');
  const node = (c: Container) => `${id('pkg', c.name)}["<b>${esc(c.name)}</b><br/>${esc(c.dir)}"]:::${isDeployable(c) ? 'container' : 'library'}`;
  const placed = new Set<string>();

  if (config.layers?.length) {
    config.layers.forEach((layer, i) => {
      const members = model.containers.filter((c) => !placed.has(c.name) && layer.packages.some((g) => matchGlob(g, c.name) || matchGlob(g, c.dir)));
      if (!members.length) return;
      f.subgraph(`layer_${i}`, layer.name);
      for (const c of members) {
        f.raw(node(c), 2);
        placed.add(c.name);
      }
      f.raw('end');
    });
  } else {
    const groups: [string, Container[]][] = [
      ['Applications', model.containers.filter(isDeployable)],
      ['Libraries', model.containers.filter((c) => !isDeployable(c))],
    ];
    groups.forEach(([name, members], i) => {
      if (!members.length) return;
      f.subgraph(`group_${i}`, name);
      for (const c of members) {
        f.raw(node(c), 2);
        placed.add(c.name);
      }
      f.raw('end');
    });
  }
  for (const c of model.containers.filter((x) => !placed.has(x.name))) f.raw(node(c));

  const bad = new Map<string, string>();
  for (const v of violations) if (v.from && v.to && v.rule !== 'forbidden') bad.set(`${v.from}->${v.to}`, v.rule);
  for (const e of model.edges) {
    const rule = bad.get(`${e.from}->${e.to}`);
    const label = rule ?? (e.imports === 0 ? 'unused' : e.testOnly ? 'tests' : undefined);
    f.edge(id('pkg', e.from), id('pkg', e.to), label, { dashed: e.imports === 0 || e.testOnly, violation: !!rule });
  }
  return f.toString();
}

/** Level 3: folders inside one package and the imports between them. */
export function componentDiagram(model: ArchitectureModel, pkg: string, violations: Violation[] = []): string {
  const f = new Flowchart('LR');
  const components = model.components.filter((c) => c.package === pkg);
  f.subgraph('container', pkg);
  for (const c of components) f.raw(`${id('cmp', c.id)}["<b>${esc(c.id)}</b><br/>${c.files} file${c.files === 1 ? '' : 's'}"]:::component`, 2);
  f.raw('end');

  const deps = model.edges.filter((e) => e.from === pkg && e.imports > 0 && !e.testOnly);
  for (const d of deps) f.raw(`${id('pkg', d.to)}["<b>${esc(d.to)}</b>"]:::library`);
  const exts = new Set(components.flatMap((c) => c.externals));
  for (const e of model.externals.filter((x) => exts.has(x.id))) f.raw(externalNode(e));

  const forbidden = violations.filter((v) => v.rule === 'forbidden' && v.file && model.fileOwners[v.file] === pkg);
  const isForbidden = (fromComponent: string, target: string) =>
    forbidden.some((v) => model.fileComponents[v.file!] === fromComponent && (v.target === target || model.fileComponents[v.target ?? ''] === target));
  for (const e of model.componentEdges.filter((x) => x.package === pkg)) {
    const violation = forbidden.some((v) => model.fileComponents[v.file!] === e.from && v.target && model.fileOwners[v.target] === pkg && model.fileComponents[v.target] === e.to);
    f.edge(id('cmp', e.from), id('cmp', e.to), violation ? 'forbidden' : undefined, { violation });
  }
  for (const c of components) {
    const targets = new Set(
      model.imports
        .filter((i) => i.package && model.fileOwners[i.from] === pkg && model.fileComponents[i.from] === c.id && !isTestFile(i.from))
        .map((i) => i.package!),
    );
    for (const t of [...targets].sort()) {
      const violation = isForbidden(c.id, t);
      f.edge(id('cmp', c.id), id('pkg', t), violation ? 'forbidden' : undefined, { violation });
    }
    for (const ext of c.externals) f.edge(id('cmp', c.id), id('ext', ext));
  }
  return f.toString();
}

/** For each package, the external systems it reaches directly or through its dependencies, with the first package on the path. */
export function transitiveExternals(model: ArchitectureModel): Map<string, Map<string, string | undefined>> {
  const deps = new Map<string, string[]>();
  for (const e of model.edges) if (e.imports > 0 && !e.testOnly) deps.set(e.from, [...(deps.get(e.from) ?? []), e.to]);
  const result = new Map<string, Map<string, string | undefined>>();
  for (const c of model.containers) {
    const found = new Map<string, string | undefined>();
    for (const ext of c.externals) found.set(ext, undefined);
    const seen = new Set([c.name]);
    const queue: [string, string][] = (deps.get(c.name) ?? []).map((d) => [d, d]);
    while (queue.length) {
      const [pkg, via] = queue.shift()!;
      if (seen.has(pkg)) continue;
      seen.add(pkg);
      for (const ext of model.containers.find((x) => x.name === pkg)?.externals ?? []) if (!found.has(ext)) found.set(ext, via);
      for (const d of deps.get(pkg) ?? []) queue.push([d, via]);
    }
    result.set(c.name, found);
  }
  return result;
}

function externalNode(e: ExternalSystem): string {
  const open = e.kind === 'database' || e.kind === 'cache' ? '[(' : e.kind === 'queue' ? '[/' : '[';
  const close = e.kind === 'database' || e.kind === 'cache' ? ')]' : e.kind === 'queue' ? '/]' : ']';
  return `${id('ext', e.id)}${open}"<b>${esc(e.name)}</b><br/>${e.kind}"${close}:::external`;
}

export function verb(e: ExternalSystem): string {
  switch (e.kind) {
    case 'database':
      return 'Reads and writes';
    case 'cache':
      return 'Caches in';
    case 'queue':
      return 'Sends and receives messages';
    case 'storage':
      return 'Stores files in';
    case 'email':
      return 'Sends email through';
    case 'search':
      return 'Indexes and searches';
    default:
      return 'Calls';
  }
}

export function id(prefix: string, name: string): string {
  return `${prefix}_${name.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '')}`;
}

function esc(s: string): string {
  return s.replace(/"/g, '#quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function quote(s: string): string {
  return `"${esc(s)}"`;
}
