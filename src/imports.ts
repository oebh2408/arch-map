import { builtinModules } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { posix, join } from 'node:path';
import ts from 'typescript';
import type { ImportRef, WorkspacePackage } from './types.js';
import type { Workspace } from './workspace.js';

const EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
const BUILTINS = new Set(builtinModules);

interface PathAlias {
  prefix: string;
  wildcard: boolean;
  targets: string[];
}

/** Read every source file and resolve its imports to files, workspace packages or third-party packages. */
export function scanImports(workspace: Workspace): ImportRef[] {
  const owners = new Map<string, WorkspacePackage>();
  for (const p of workspace.packages) for (const f of p.files) owners.set(f, p);
  const files = new Set(owners.keys());
  const byName = new Map(workspace.packages.map((p) => [p.name, p]));
  const aliases = readPathAliases(workspace.root);
  const out: ImportRef[] = [];

  for (const pkg of workspace.packages) {
    for (const file of pkg.files) {
      const text = readFileSync(join(workspace.root, file), 'utf8');
      const info = ts.preProcessFile(text, true, true);
      for (const ref of info.importedFiles) {
        const spec = ref.fileName;
        const line = lineOf(text, ref.pos);
        const resolved = resolve(spec, file, pkg, files, owners, byName, aliases);
        if (resolved) out.push({ from: file, specifier: spec, line, ...resolved });
      }
    }
  }
  return out;
}

function resolve(
  spec: string,
  from: string,
  pkg: WorkspacePackage,
  files: Set<string>,
  owners: Map<string, WorkspacePackage>,
  byName: Map<string, WorkspacePackage>,
  aliases: PathAlias[],
): Pick<ImportRef, 'file' | 'package' | 'external'> | undefined {
  if (spec.startsWith('.') || spec.startsWith('/')) {
    const target = resolveFile(posix.normalize(posix.join(posix.dirname(from), spec)), files);
    if (!target) return undefined; // assets, generated files
    const owner = owners.get(target);
    return owner && owner !== pkg ? { file: target, package: owner.name } : { file: target };
  }
  if (spec.startsWith('node:') || BUILTINS.has(spec.split('/')[0]!)) return undefined;

  for (const alias of aliases) {
    const match = alias.wildcard ? spec.startsWith(alias.prefix) : spec === alias.prefix;
    if (!match) continue;
    const rest = alias.wildcard ? spec.slice(alias.prefix.length) : '';
    for (const t of alias.targets) {
      const target = resolveFile(posix.normalize(t.replace('*', rest)), files);
      if (!target) continue;
      const owner = owners.get(target);
      return owner && owner !== pkg ? { file: target, package: owner.name } : { file: target };
    }
  }

  const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]!;
  if (byName.has(name)) return name === pkg.name ? undefined : { package: name };
  return { external: name };
}

function resolveFile(base: string, files: Set<string>): string | undefined {
  const stripped = base.replace(/\.(?:[cm]?js|jsx)$/, '');
  const candidates = [base, ...EXTENSIONS.map((e) => stripped + e), ...EXTENSIONS.map((e) => `${base}/index${e}`)];
  return candidates.find((c) => files.has(c));
}

function readPathAliases(root: string): PathAlias[] {
  for (const name of ['tsconfig.base.json', 'tsconfig.json']) {
    const path = join(root, name);
    if (!existsSync(path)) continue;
    const { config } = ts.readConfigFile(path, (p) => readFileSync(p, 'utf8'));
    const options = (config?.compilerOptions ?? {}) as { baseUrl?: string; paths?: Record<string, string[]> };
    if (!options.paths) continue;
    const base = options.baseUrl ?? '.';
    return Object.entries(options.paths).map(([key, targets]) => ({
      prefix: key.replace(/\*$/, ''),
      wildcard: key.endsWith('*'),
      targets: targets.map((t) => posix.normalize(posix.join(base, t))),
    }));
  }
  return [];
}

function lineOf(text: string, pos: number): number {
  let line = 1;
  for (let i = 0; i < pos && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

export const isTestFile = (file: string) => /(?:\.(?:test|spec)\.[cm]?[jt]sx?$)|(?:^|\/)(?:__tests__|test|tests)\//.test(file);
