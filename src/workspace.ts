import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { expandDirectories, listSourceFiles, matchAny } from './glob.js';
import type { PackageManifest, WorkspacePackage } from './types.js';

export interface Workspace {
  root: string;
  name: string;
  packages: WorkspacePackage[];
}

/**
 * Find the packages of a repository: npm, yarn and bun `workspaces`, `pnpm-workspace.yaml`,
 * or the root package alone when there are no workspaces.
 */
export function loadWorkspace(root: string, ignore: string[] = []): Workspace {
  const rootManifest = readManifest(join(root, 'package.json'));
  if (!rootManifest) throw new Error(`No package.json found in ${root}.`);

  let patterns: string[] = [];
  const ws = rootManifest.workspaces;
  if (Array.isArray(ws)) patterns = ws;
  else if (ws && Array.isArray(ws.packages)) patterns = ws.packages;
  const pnpm = join(root, 'pnpm-workspace.yaml');
  if (!patterns.length && existsSync(pnpm)) {
    const doc = parseYaml(readFileSync(pnpm, 'utf8')) as { packages?: string[] } | null;
    patterns = doc?.packages ?? [];
  }

  const dirs = patterns.length ? expandDirectories(root, patterns).filter((d) => existsSync(join(root, d, 'package.json'))) : [''];
  const packages: WorkspacePackage[] = [];
  for (const dir of dirs) {
    const manifest = readManifest(join(root, dir, 'package.json'));
    if (!manifest || manifest.archMap?.ignore) continue;
    const files = listSourceFiles(join(root, dir))
      .map((f) => (dir ? `${dir}/${f}` : f))
      .filter((f) => !matchAny(ignore, f));
    packages.push({ name: manifest.name ?? (dir || 'root'), dir, manifest, files });
  }

  return { root, name: rootManifest.name ?? 'system', packages };
}

function readManifest(path: string): PackageManifest | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as PackageManifest;
  } catch (err) {
    throw new Error(`Could not parse ${path}: ${(err as Error).message}`);
  }
}
