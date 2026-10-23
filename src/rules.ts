import { matchGlob } from './glob.js';
import { isTestFile } from './imports.js';
import type { ArchitectureModel, Config, ImportRef, Severity, Violation } from './types.js';

type RuleId = 'cycles' | 'undeclared-dependency' | 'unused-dependency' | 'layers' | 'forbidden';

export const RULES: { id: RuleId; severity: Severity; description: string }[] = [
  { id: 'cycles', severity: 'error', description: 'Workspace packages that depend on each other in a cycle.' },
  { id: 'undeclared-dependency', severity: 'error', description: 'A package imports another workspace package without listing it in package.json.' },
  { id: 'unused-dependency', severity: 'warning', description: 'A workspace package is listed in package.json but never imported.' },
  { id: 'layers', severity: 'error', description: 'A package depends on a package in a higher layer.' },
  { id: 'forbidden', severity: 'error', description: 'An import matches a forbidden rule from the config.' },
];

export function checkRules(model: ArchitectureModel, config: Config = {}): Violation[] {
  const out: Violation[] = [];
  const severity = (id: RuleId) => config.rules?.[id] ?? RULES.find((r) => r.id === id)!.severity;
  const firstImport = (from: string, to: string) =>
    model.imports.find((i) => i.package === to && packageOfFile(model, i.from) === from && !isTestFile(i.from)) ??
    model.imports.find((i) => i.package === to && packageOfFile(model, i.from) === from);
  const runtimeEdges = model.edges.filter((e) => e.imports > 0 && !e.testOnly);

  if (severity('cycles') !== 'off') {
    for (const cycle of findCycles(model.containers.map((c) => c.name), runtimeEdges)) {
      const at = firstImport(cycle[0]!, cycle[1 % cycle.length]!);
      out.push({
        rule: 'cycles',
        severity: severity('cycles') as Severity,
        message: `Dependency cycle: ${[...cycle, cycle[0]].join(' -> ')}.`,
        file: at?.from,
        line: at?.line,
        from: cycle[0],
        to: cycle[1 % cycle.length],
      });
    }
  }

  if (severity('undeclared-dependency') !== 'off') {
    for (const e of model.edges.filter((x) => x.imports > 0 && !x.declared)) {
      const at = firstImport(e.from, e.to);
      out.push({
        rule: 'undeclared-dependency',
        severity: severity('undeclared-dependency') as Severity,
        message: `${e.from} imports ${e.to} but does not list it in package.json.`,
        file: at?.from,
        line: at?.line,
        from: e.from,
        to: e.to,
      });
    }
  }

  if (severity('unused-dependency') !== 'off') {
    for (const e of model.edges.filter((x) => x.imports === 0 && x.declared)) {
      const dir = model.containers.find((c) => c.name === e.from)!.dir;
      out.push({
        rule: 'unused-dependency',
        severity: severity('unused-dependency') as Severity,
        message: `${e.from} lists ${e.to} in package.json but never imports it.`,
        file: dir === '.' ? 'package.json' : `${dir}/package.json`,
        from: e.from,
        to: e.to,
      });
    }
  }

  if (config.layers?.length && severity('layers') !== 'off') {
    const layerOf = (name: string): number => {
      const dir = model.containers.find((c) => c.name === name)?.dir ?? '';
      return config.layers!.findIndex((l) => l.packages.some((g) => matchGlob(g, name) || matchGlob(g, dir)));
    };
    for (const e of runtimeEdges) {
      const a = layerOf(e.from);
      const b = layerOf(e.to);
      if (a < 0 || b < 0 || b >= a) continue;
      const at = firstImport(e.from, e.to);
      out.push({
        rule: 'layers',
        severity: severity('layers') as Severity,
        message: `${e.from} (layer ${config.layers[a]!.name}) depends on ${e.to} (layer ${config.layers[b]!.name}), which is above it.`,
        file: at?.from,
        line: at?.line,
        from: e.from,
        to: e.to,
      });
    }
  }

  if (config.forbidden?.length && severity('forbidden') !== 'off') {
    const seen = new Set<string>();
    for (const imp of model.imports) {
      const targets = targetsOf(model, imp);
      if (!targets.length) continue;
      const fromPkg = packageOfFile(model, imp.from) ?? '';
      for (const rule of config.forbidden) {
        const fromMatch = matchGlob(rule.from, imp.from) || matchGlob(rule.from, fromPkg);
        if (!fromMatch || !targets.some((t) => matchGlob(rule.to, t))) continue;
        const key = `${imp.from}:${rule.from}:${rule.to}:${imp.package ?? imp.file}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          rule: 'forbidden',
          severity: severity('forbidden') as Severity,
          message: `Imports '${imp.specifier}'${rule.reason ? `: ${rule.reason}` : ` (forbidden: ${rule.from} -> ${rule.to})`}.`,
          file: imp.from,
          line: imp.line,
          from: fromPkg,
          to: imp.package ?? fromPkg,
          target: imp.package ?? imp.file ?? imp.external,
        });
      }
    }
  }

  return out.sort((a, b) => (a.file ?? '').localeCompare(b.file ?? '') || (a.line ?? 0) - (b.line ?? 0) || a.rule.localeCompare(b.rule));
}

/** Paths and names an import can be matched against in forbidden rules. */
function targetsOf(model: ArchitectureModel, imp: ImportRef): string[] {
  const out: string[] = [];
  if (imp.file) out.push(imp.file);
  if (imp.package) {
    const dir = model.containers.find((c) => c.name === imp.package)?.dir;
    out.push(imp.package);
    if (dir) out.push(dir, `${dir}/`);
  }
  if (imp.external) out.push(imp.external);
  return out;
}

function packageOfFile(model: ArchitectureModel, file: string): string | undefined {
  return model.fileOwners[file];
}

/** One representative cycle per strongly connected component. */
export function findCycles(nodes: string[], edges: { from: string; to: string }[]): string[][] {
  const adj = new Map<string, string[]>();
  for (const e of edges) adj.set(e.from, [...(adj.get(e.from) ?? []), e.to]);
  let index = 0;
  const idx = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const on = new Set<string>();
  const comps: string[][] = [];
  const strong = (v: string) => {
    idx.set(v, index);
    low.set(v, index++);
    stack.push(v);
    on.add(v);
    for (const w of adj.get(v) ?? []) {
      if (!idx.has(w)) {
        strong(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (on.has(w)) low.set(v, Math.min(low.get(v)!, idx.get(w)!));
    }
    if (low.get(v) === idx.get(v)) {
      const comp: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        on.delete(w);
        comp.push(w);
      } while (w !== v);
      comps.push(comp);
    }
  };
  for (const n of nodes) if (!idx.has(n)) strong(n);

  const cycles: string[][] = [];
  for (const comp of comps) {
    if (comp.length < 2) continue;
    const set = new Set(comp);
    // Walk inside the component from its first node until we come back.
    const start = [...comp].sort()[0]!;
    const path = [start];
    const visited = new Set([start]);
    const dfs = (v: string): boolean => {
      for (const w of (adj.get(v) ?? []).filter((x) => set.has(x)).sort()) {
        if (w === start) return true;
        if (visited.has(w)) continue;
        visited.add(w);
        path.push(w);
        if (dfs(w)) return true;
        path.pop();
      }
      return false;
    };
    if (dfs(start)) cycles.push(path);
  }
  return cycles.sort((a, b) => a[0]!.localeCompare(b[0]!));
}
