import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildModel, checkRules, containerDiagram, loadConfig, renderMarkdown, renderStructurizr, renderViewer } from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const shop = join(here, '../examples/shop');
const config = loadConfig(shop);
const model = buildModel(shop, config);
const violations = checkRules(model, config);

describe('markdown', () => {
  it('is deterministic and matches the committed example', () => {
    const doc = renderMarkdown(model, config, violations);
    expect(renderMarkdown(buildModel(shop, config), config, violations)).toBe(doc);
    expect(readFileSync(join(shop, 'docs/architecture.md'), 'utf8')).toBe(doc);
  });

  it('attributes external systems reached through libraries', () => {
    const diagram = containerDiagram(model);
    expect(diagram).toContain('pkg_shop_api -->|"Reads and writes via @shop/db"| ext_postgresql');
    expect(diagram).toContain('pkg_shop_api -->|"Calls"| ext_stripe');
    expect(diagram).not.toContain('pkg_shop_db['); // libraries stay out of the container view
  });

  it('marks violating edges red', () => {
    const doc = renderMarkdown(model, config, violations);
    expect(doc).toMatch(/pkg_shop_domain -->\|"layers"\| pkg_shop_db/);
    expect(doc).toMatch(/linkStyle [\d,]+ stroke:#d1343b/);
  });
});

describe('structurizr', () => {
  it('declares people, containers, components and external systems', () => {
    const dsl = renderStructurizr(model);
    expect(dsl).toContain('user = person "User"');
    expect(dsl).toContain('pkg_shop_api = container "@shop/api" "Orders, payments and catalog API" "Fastify" {');
    expect(dsl).toContain('ext_postgresql = softwareSystem "PostgreSQL" "database" {');
    expect(dsl).toContain('pkg_shop_db -> ext_postgresql "Uses"');
    expect(dsl).toContain('component pkg_shop_api "Components-shop_api" {');
  });
});

const cli = join(here, '../dist/cli.js');

describe.skipIf(!existsSync(cli))('cli', () => {
  const run = (args: string[], cwd: string) => spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8' });

  it('check exits 1 on errors and prints GitHub annotations', () => {
    const res = run(['check', '--format', 'github'], shop);
    expect(res.status).toBe(1);
    expect(res.stdout).toContain('::error file=packages/domain/src/order.ts,line=1,title=layers::');
  });

  it('check --up-to-date detects a stale document', () => {
    const root = mkdtempSync(join(tmpdir(), 'arch-map-cli-'));
    cpSync(shop, root, { recursive: true });
    writeFileSync(join(root, 'arch-map.config.json'), JSON.stringify({ ...config, rules: { forbidden: 'off', cycles: 'off', layers: 'off', 'undeclared-dependency': 'off', 'unused-dependency': 'off' } }));
    expect(run(['check', '--up-to-date', 'docs/architecture.md'], root).status).toBe(1);
    expect(run(['generate'], root).status).toBe(0);
    const res = run(['check', '--up-to-date', 'docs/architecture.md'], root);
    expect(res.stdout).toBe('No violations.\n');
    expect(res.status).toBe(0);
  });
});

describe('viewer', () => {
  it('writes a self-contained page with every package and violation', () => {
    const html = renderViewer(model, config, violations);
    expect(html).not.toMatch(/<script[^>]+src=|<link[^>]+href=/);
    for (const c of model.containers) expect(html).toContain(`data-id="pkg:${c.name}"`);
    expect(html).toContain('class="edge edge-violation" data-from="pkg:@shop/domain" data-to="pkg:@shop/db"');
    const data = JSON.parse(html.match(/<script type="application\/json" id="data">(.*?)<\/script>/s)![1]!);
    expect(data.violations).toHaveLength(violations.length);
    expect(data.details['pkg:@shop/api']).toContain('PostgreSQL');
  });
});
