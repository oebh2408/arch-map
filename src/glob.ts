import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const IGNORED_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'coverage', '.next', '.turbo', '.cache']);

/** Convert a glob with `*`, `**` and `?` to a regular expression over posix paths. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        const slash = glob[i + 2] === '/';
        re += slash ? '(?:.*/)?' : '.*';
        i += slash ? 2 : 1;
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

export function matchGlob(glob: string, path: string): boolean {
  return globToRegExp(glob).test(path);
}

export const matchAny = (globs: string[], path: string) => globs.some((g) => matchGlob(g, path));

/** Directories under `root` (relative posix paths) that match one of the patterns. */
export function expandDirectories(root: string, patterns: string[]): string[] {
  const include = patterns.filter((p) => !p.startsWith('!')).map((p) => p.replace(/\/+$/, ''));
  const exclude = patterns.filter((p) => p.startsWith('!')).map((p) => p.slice(1).replace(/\/+$/, ''));
  const found = new Set<string>();
  const maxDepth = Math.max(1, ...include.map((p) => (p.includes('**') ? 6 : p.split('/').length)));

  const walk = (rel: string, depth: number) => {
    if (depth > maxDepth) return;
    let entries: string[];
    try {
      entries = readdirSync(join(root, rel));
    } catch {
      return;
    }
    for (const name of entries) {
      if (IGNORED_DIRS.has(name) || name.startsWith('.')) continue;
      const child = rel ? `${rel}/${name}` : name;
      if (!statSync(join(root, child)).isDirectory()) continue;
      if (matchAny(include, child) && !matchAny(exclude, child)) found.add(child);
      walk(child, depth + 1);
    }
  };
  walk('', 1);
  return [...found].sort();
}

/** Source files under a directory, relative to it. */
export function listSourceFiles(dir: string, extensions = /\.(?:[cm]?[jt]sx?)$/): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    let entries: string[];
    try {
      entries = readdirSync(join(dir, rel));
    } catch {
      return;
    }
    for (const name of entries.sort()) {
      if (IGNORED_DIRS.has(name) || name.startsWith('.')) continue;
      const child = rel ? `${rel}/${name}` : name;
      const st = statSync(join(dir, child));
      if (st.isDirectory()) {
        // a nested package is its own workspace member
        if (rel && hasManifest(join(dir, child))) continue;
        walk(child);
      } else if (extensions.test(name) && !name.endsWith('.d.ts')) out.push(child);
    }
  };
  walk('');
  return out;
}

function hasManifest(dir: string): boolean {
  try {
    return statSync(join(dir, 'package.json')).isFile();
  } catch {
    return false;
  }
}
