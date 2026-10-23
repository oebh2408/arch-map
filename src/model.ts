import { posix } from 'node:path';
import { isTestFile, scanImports } from './imports.js';
import type { ArchitectureModel, Component, ComponentEdge, Config, Container, ContainerKind, ExternalSystem, PackageEdge, WorkspacePackage } from './types.js';
import { loadWorkspace } from './workspace.js';

type ExternalDef = { name: string; kind: ExternalSystem['kind'] };

/** Third-party packages that stand for a system outside the repository. */
export const KNOWN_EXTERNALS: Record<string, ExternalDef> = {
  pg: { name: 'PostgreSQL', kind: 'database' },
  postgres: { name: 'PostgreSQL', kind: 'database' },
  'pg-promise': { name: 'PostgreSQL', kind: 'database' },
  '@neondatabase/serverless': { name: 'PostgreSQL', kind: 'database' },
  mysql: { name: 'MySQL', kind: 'database' },
  mysql2: { name: 'MySQL', kind: 'database' },
  'better-sqlite3': { name: 'SQLite', kind: 'database' },
  mongodb: { name: 'MongoDB', kind: 'database' },
  mongoose: { name: 'MongoDB', kind: 'database' },
  '@prisma/client': { name: 'SQL database', kind: 'database' },
  redis: { name: 'Redis', kind: 'cache' },
  ioredis: { name: 'Redis', kind: 'cache' },
  bullmq: { name: 'Redis', kind: 'queue' },
  kafkajs: { name: 'Kafka', kind: 'queue' },
  amqplib: { name: 'RabbitMQ', kind: 'queue' },
  nats: { name: 'NATS', kind: 'queue' },
  '@aws-sdk/client-s3': { name: 'Object storage', kind: 'storage' },
  '@aws-sdk/client-sqs': { name: 'Message queue', kind: 'queue' },
  '@aws-sdk/client-dynamodb': { name: 'Key-value database', kind: 'database' },
  '@google-cloud/storage': { name: 'Object storage', kind: 'storage' },
  '@azure/storage-blob': { name: 'Object storage', kind: 'storage' },
  '@elastic/elasticsearch': { name: 'Elasticsearch', kind: 'search' },
  '@opensearch-project/opensearch': { name: 'OpenSearch', kind: 'search' },
  meilisearch: { name: 'Meilisearch', kind: 'search' },
  nodemailer: { name: 'Email (SMTP)', kind: 'email' },
  '@sendgrid/mail': { name: 'Email API', kind: 'email' },
  resend: { name: 'Email API', kind: 'email' },
  stripe: { name: 'Stripe', kind: 'api' },
  twilio: { name: 'Twilio', kind: 'api' },
  openai: { name: 'LLM API', kind: 'api' },
  '@anthropic-ai/sdk': { name: 'LLM API', kind: 'api' },
  'purecloud-platform-client-v2': { name: 'Genesys Cloud', kind: 'api' },
  '@hubspot/api-client': { name: 'HubSpot', kind: 'api' },
  '@slack/web-api': { name: 'Slack', kind: 'api' },
};

const FRAMEWORKS: { dep: string; kind: ContainerKind; technology: string }[] = [
  { dep: 'next', kind: 'web', technology: 'Next.js' },
  { dep: '@remix-run/react', kind: 'web', technology: 'Remix' },
  { dep: 'nuxt', kind: 'web', technology: 'Nuxt' },
  { dep: '@sveltejs/kit', kind: 'web', technology: 'SvelteKit' },
  { dep: 'astro', kind: 'web', technology: 'Astro' },
  { dep: '@angular/core', kind: 'web', technology: 'Angular' },
  { dep: '@nestjs/core', kind: 'api', technology: 'NestJS' },
  { dep: 'fastify', kind: 'api', technology: 'Fastify' },
  { dep: 'express', kind: 'api', technology: 'Express' },
  { dep: 'hono', kind: 'api', technology: 'Hono' },
  { dep: 'koa', kind: 'api', technology: 'Koa' },
  { dep: '@trpc/server', kind: 'api', technology: 'tRPC' },
  { dep: 'graphql-yoga', kind: 'api', technology: 'GraphQL Yoga' },
  { dep: 'vue', kind: 'web', technology: 'Vue' },
  { dep: 'svelte', kind: 'web', technology: 'Svelte' },
  { dep: 'react-dom', kind: 'web', technology: 'React' },
];

const WORKER_DEPS = ['bullmq', 'kafkajs', 'amqplib', 'node-cron', 'agenda', 'pg-boss'];

export function buildModel(root: string, config: Config = {}): ArchitectureModel {
  const workspace = loadWorkspace(root, config.ignore);
  const imports = scanImports(workspace);
  const known = { ...KNOWN_EXTERNALS, ...(config.externals ?? {}) };
  const packageOf = new Map<string, WorkspacePackage>();
  for (const p of workspace.packages) for (const f of p.files) packageOf.set(f, p);

  // ---- package edges
  const edgeMap = new Map<string, PackageEdge>();
  for (const imp of imports) {
    if (!imp.package) continue;
    const from = packageOf.get(imp.from)!;
    const key = `${from.name}->${imp.package}`;
    const edge = edgeMap.get(key) ?? { from: from.name, to: imp.package, imports: 0, declared: declares(from, imp.package), testOnly: true };
    edge.imports++;
    if (!isTestFile(imp.from)) edge.testOnly = false;
    edgeMap.set(key, edge);
  }
  const names = new Set(workspace.packages.map((p) => p.name));
  for (const p of workspace.packages) {
    for (const dep of Object.keys({ ...p.manifest.dependencies, ...p.manifest.devDependencies, ...p.manifest.peerDependencies })) {
      if (names.has(dep) && dep !== p.name && !edgeMap.has(`${p.name}->${dep}`)) {
        edgeMap.set(`${p.name}->${dep}`, { from: p.name, to: dep, imports: 0, declared: true, testOnly: false });
      }
    }
  }
  const edges = [...edgeMap.values()].sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));

  // ---- external systems used directly by each package
  const externals = new Map<string, ExternalSystem>();
  const directExternals = new Map<string, Set<string>>();
  const useExternal = (pkg: string, dep: string) => {
    const def = known[dep];
    if (!def) return;
    const id = slug(def.name);
    const system = externals.get(id) ?? { id, name: def.name, kind: def.kind, via: [] };
    if (!system.via.includes(dep)) system.via.push(dep);
    externals.set(id, system);
    const set = directExternals.get(pkg) ?? new Set();
    set.add(id);
    directExternals.set(pkg, set);
  };
  for (const p of workspace.packages) for (const dep of Object.keys(p.manifest.dependencies ?? {})) useExternal(p.name, dep);
  for (const imp of imports) if (imp.external && !isTestFile(imp.from)) useExternal(packageOf.get(imp.from)!.name, imp.external);

  // ---- containers
  const containers: Container[] = workspace.packages.map((p) => {
    const detected = detectKind(p);
    return {
      name: p.name,
      dir: p.dir || '.',
      kind: p.manifest.archMap?.kind ?? detected.kind,
      technology: p.manifest.archMap?.technology ?? detected.technology,
      description: p.manifest.archMap?.description ?? p.manifest.description,
      externals: [...(directExternals.get(p.name) ?? [])].sort(),
    };
  });

  // ---- components inside each package
  const depth = config.componentDepth ?? 1;
  const componentOf = (file: string): string => {
    const pkg = packageOf.get(file)!;
    const rel = pkg.dir ? file.slice(pkg.dir.length + 1) : file;
    const parts = posix.dirname(rel).split('/').filter((s) => s !== '.');
    const start = parts[0] === 'src' || parts[0] === 'app' || parts[0] === 'lib' ? 1 : 0;
    const keep = parts.slice(0, start + depth);
    return keep.length ? keep.join('/') : '(root)';
  };
  const components = new Map<string, Component>();
  for (const p of workspace.packages) {
    for (const f of p.files) {
      if (isTestFile(f)) continue;
      const id = componentOf(f);
      const key = `${p.name}:${id}`;
      const c = components.get(key) ?? { id, package: p.name, files: 0, externals: [] };
      c.files++;
      components.set(key, c);
    }
  }
  const componentEdges = new Map<string, ComponentEdge>();
  for (const imp of imports) {
    if (isTestFile(imp.from)) continue;
    const pkg = packageOf.get(imp.from)!.name;
    const from = componentOf(imp.from);
    const comp = components.get(`${pkg}:${from}`);
    if (imp.external && comp && known[imp.external]) {
      const id = slug(known[imp.external]!.name);
      if (!comp.externals.includes(id)) comp.externals.push(id);
    }
    if (!imp.file || imp.package) continue;
    const to = componentOf(imp.file);
    if (to === from) continue;
    const key = `${pkg}:${from}->${to}`;
    const e = componentEdges.get(key) ?? { package: pkg, from, to, imports: 0 };
    e.imports++;
    componentEdges.set(key, e);
  }

  const fileOwners: Record<string, string> = {};
  const fileComponents: Record<string, string> = {};
  for (const [file, pkg] of packageOf) {
    fileOwners[file] = pkg.name;
    fileComponents[file] = componentOf(file);
  }

  return {
    name: config.name ?? workspace.name,
    root,
    containers,
    edges,
    externals: [...externals.values()].sort((a, b) => a.name.localeCompare(b.name)),
    components: [...components.values()].sort((a, b) => a.package.localeCompare(b.package) || a.id.localeCompare(b.id)),
    componentEdges: [...componentEdges.values()].sort((a, b) => a.package.localeCompare(b.package) || a.from.localeCompare(b.from) || a.to.localeCompare(b.to)),
    imports,
    fileOwners,
    fileComponents,
  };
}

function declares(pkg: WorkspacePackage, dep: string): boolean {
  const m = pkg.manifest;
  return !!(m.dependencies?.[dep] ?? m.devDependencies?.[dep] ?? m.peerDependencies?.[dep]);
}

function detectKind(p: WorkspacePackage): { kind: ContainerKind; technology: string } {
  const deps = { ...p.manifest.dependencies, ...p.manifest.devDependencies };
  const runtime = p.manifest.dependencies ?? {};
  const isApp = !!p.manifest.scripts?.start || !!p.manifest.scripts?.dev || /^(apps?|services?)\//.test(p.dir);
  for (const f of FRAMEWORKS) {
    if (!deps[f.dep]) continue;
    // A library that depends on React is a component library, not a web app.
    if (f.kind === 'web' && !isApp) return { kind: 'library', technology: `${f.technology} components` };
    if (f.kind === 'api' && !isApp && !runtime[f.dep]) continue;
    return { kind: f.kind, technology: f.technology };
  }
  if (isApp && (WORKER_DEPS.some((d) => runtime[d]) || /worker|consumer|jobs?/i.test(p.dir))) return { kind: 'worker', technology: 'Node.js' };
  if (p.manifest.bin) return { kind: 'cli', technology: 'Node.js CLI' };
  if (isApp) return { kind: 'api', technology: 'Node.js' };
  return { kind: 'library', technology: 'TypeScript' };
}

export function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
}
