import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildModel, checkRules, findCycles, loadConfig } from '../src/index.js';
import { globToRegExp, matchGlob } from '../src/glob.js';

const shop = join(dirname(fileURLToPath(import.meta.url)), '../examples/shop');
const config = loadConfig(shop);
const model = buildModel(shop, config);

/** Write a throwaway repository from a map of path to content. */
function fixture(files: Record<string, string | object>): string {
  const root = mkdtempSync(join(tmpdir(), 'arch-map-'));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), typeof content === 'string' ? content : JSON.stringify(content));
  }
  return root;
}

describe('glob', () => {
  it('matches single and double stars', () => {
    expect(matchGlob('apps/*', 'apps/web')).toBe(true);
    expect(matchGlob('apps/*', 'apps/web/src')).toBe(false);
    expect(matchGlob('apps/web/**', 'apps/web/src/app/page.tsx')).toBe(true);
    expect(matchGlob('packages/db/**', 'packages/db/')).toBe(true);
    expect(matchGlob('**/*.test.ts', 'apps/api/test/a.test.ts')).toBe(true);
    expect(globToRegExp('a.b').test('axb')).toBe(false);
  });
});

describe('model of the example monorepo', () => {
  it('finds packages and classifies them', () => {
    const kinds = Object.fromEntries(model.containers.map((c) => [c.name, `${c.kind} ${c.technology}`]));
    expect(kinds).toEqual({
      '@shop/api': 'api Fastify',
      '@shop/web': 'web Next.js',
      '@shop/worker': 'worker Node.js',
      '@shop/config': 'library TypeScript',
      '@shop/db': 'library TypeScript',
      '@shop/domain': 'library TypeScript',
      '@shop/ui': 'library React components',
    });
    expect(model.name).toBe('Shop');
  });

  it('detects external systems from dependencies and imports', () => {
    expect(model.externals.map((e) => `${e.name} (${e.via.join(',')})`)).toEqual(['Email (SMTP) (nodemailer)', 'PostgreSQL (pg)', 'Redis (bullmq)', 'Stripe (stripe)']);
    expect(model.containers.find((c) => c.name === '@shop/db')!.externals).toEqual(['postgresql']);
  });

  it('builds package edges with declared, test-only and unused flags', () => {
    const edge = (from: string, to: string) => model.edges.find((e) => e.from === from && e.to === to);
    expect(edge('@shop/api', '@shop/db')).toMatchObject({ declared: true, testOnly: false });
    expect(edge('@shop/web', '@shop/db')).toMatchObject({ declared: false, imports: 1 });
    expect(edge('@shop/worker', '@shop/ui')).toMatchObject({ declared: true, imports: 0 });
    expect(edge('@shop/api', '@shop/domain')!.imports).toBe(2); // one from src, one from test
  });

  it('groups files into components by folder', () => {
    const api = model.components.filter((c) => c.package === '@shop/api').map((c) => `${c.id}:${c.files}`);
    expect(api).toEqual(['src:1', 'src/plugins:1', 'src/routes:2', 'src/services:2']);
    const edges = model.componentEdges.filter((e) => e.package === '@shop/api').map((e) => `${e.from}->${e.to}`);
    expect(edges).toEqual(['src->src/plugins', 'src->src/routes', 'src/routes->src/services']);
    expect(model.components.find((c) => c.id === 'src/services' && c.package === '@shop/api')!.externals).toEqual(['stripe']);
  });
});

describe('rules', () => {
  it('reports the problems planted in the example', () => {
    const violations = checkRules(model, config);
    expect(violations.map((v) => `${v.rule} ${v.file}:${v.line ?? ''}`)).toEqual([
      'forbidden apps/api/src/routes/payments.ts:2',
      'forbidden apps/web/src/app/orders/page.tsx:1',
      'undeclared-dependency apps/web/src/app/orders/page.tsx:1',
      'unused-dependency apps/worker/package.json:',
      'cycles packages/db/src/orders.ts:1',
      'layers packages/domain/src/order.ts:1',
    ]);
  });

  it('rules can be turned off or downgraded', () => {
    const violations = checkRules(model, { ...config, rules: { forbidden: 'off', cycles: 'warning' } });
    expect(violations.some((v) => v.rule === 'forbidden')).toBe(false);
    expect(violations.find((v) => v.rule === 'cycles')!.severity).toBe('warning');
  });

  it('findCycles returns one path per cycle', () => {
    const edges = [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'c' },
      { from: 'c', to: 'a' },
      { from: 'c', to: 'd' },
      { from: 'x', to: 'y' },
      { from: 'y', to: 'x' },
    ];
    expect(findCycles(['a', 'b', 'c', 'd', 'x', 'y'], edges)).toEqual([
      ['a', 'b', 'c'],
      ['x', 'y'],
    ]);
  });

  it('rejects invalid config', () => {
    const root = fixture({ 'package.json': { name: 'x' }, 'arch-map.config.json': { rules: { nope: 'off' } } });
    expect(() => loadConfig(root)).toThrow(/unknown rule 'nope'/);
  });
});

describe('workspaces', () => {
  it('reads pnpm-workspace.yaml and tsconfig path aliases', () => {
    const root = fixture({
      'package.json': { name: 'mono' },
      'pnpm-workspace.yaml': 'packages:\n  - "libs/*"\n  - "services/*"\n',
      'tsconfig.base.json': '{ "compilerOptions": { "baseUrl": ".", "paths": { "@lib/*": ["libs/*/src/index.ts"] } } } // comments are allowed',
      'libs/core/package.json': { name: '@mono/core' },
      'libs/core/src/index.ts': 'export const x = 1;\n',
      'services/billing/package.json': { name: '@mono/billing', scripts: { start: 'node .' }, dependencies: { express: '^5', ioredis: '^5' } },
      'services/billing/src/main.ts': "import express from 'express';\nimport { x } from '@lib/core';\nimport Redis from 'ioredis';\nimport './routes.js';\n",
      'services/billing/src/routes.ts': "import { readFileSync } from 'node:fs';\nexport {};\n",
    });
    const m = buildModel(root);
    expect(m.containers.map((c) => `${c.name} ${c.kind} ${c.technology}`)).toEqual(['@mono/core library TypeScript', '@mono/billing api Express']);
    expect(m.edges).toEqual([{ from: '@mono/billing', to: '@mono/core', imports: 1, declared: false, testOnly: false }]);
    expect(m.externals.map((e) => e.name)).toEqual(['Redis']);
    // `./routes.js` resolves to routes.ts
    expect(m.imports.find((i) => i.specifier === './routes.js')?.file).toBe('services/billing/src/routes.ts');
  });

  it('treats a repository without workspaces as one package', () => {
    const root = fixture({
      'package.json': { name: 'solo', bin: { solo: 'dist/cli.js' } },
      'src/cli.ts': "import { run } from './commands/run';\nrun();\n",
      'src/commands/run.ts': 'export const run = () => {};\n',
    });
    const m = buildModel(root);
    expect(m.containers).toMatchObject([{ name: 'solo', kind: 'cli', dir: '.' }]);
    expect(m.componentEdges).toEqual([{ package: 'solo', from: 'src', to: 'src/commands', imports: 1 }]);
  });
});
