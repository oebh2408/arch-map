#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { loadConfig } from './config.js';
import { renderMarkdown } from './markdown.js';
import { buildModel } from './model.js';
import { checkRules, RULES } from './rules.js';
import { renderStructurizr } from './structurizr.js';
import { serve } from './server.js';
import { renderViewer } from './viewer.js';
import type { Violation } from './types.js';

const USAGE = `Usage:
  arch-map generate [--out docs/architecture.md] [--format markdown|structurizr|json]
  arch-map check [--format text|github|json] [--up-to-date docs/architecture.md]
  arch-map view [--out architecture.html]
  arch-map serve [--port 4200]
  arch-map rules

Options:
  --root <dir>      Repository root (default: current directory)
  --config <file>   Config file (default: arch-map.config.json in the root)
  --port <n>        Port for serve (default 4200). It listens on 127.0.0.1 only.
`;

function parseArgs(argv: string[]) {
  const flags: Record<string, string> = {};
  let command: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=', 2) as [string, string | undefined];
      flags[k] = v ?? (argv[i + 1] && !argv[i + 1]!.startsWith('--') ? argv[++i]! : 'true');
    } else if (!command) command = a;
  }
  return { command, flags };
}

function main(argv: string[]): number {
  const { command, flags } = parseArgs(argv);
  if (!command || command === 'help' || flags.help) {
    process.stdout.write(USAGE);
    return command ? 0 : 2;
  }
  if (command === 'rules') {
    for (const r of RULES) process.stdout.write(`${r.id.padEnd(22)} ${r.severity.padEnd(8)} ${r.description}\n`);
    return 0;
  }

  const root = resolve(flags.root ?? '.');
  if (command === 'serve') {
    void serve({ root, config: flags.config ? resolve(flags.config) : undefined, port: flags.port ? Number(flags.port) : undefined })
      .then((server) => {
        const address = server.address();
        const port = typeof address === 'object' && address ? address.port : flags.port;
        process.stdout.write(`arch-map on http://localhost:${port}, watching ${relative(process.cwd(), root) || '.'}. Ctrl+C to stop.\n`);
      })
      .catch((err: Error) => {
        process.stderr.write(`arch-map: ${err.message}\n`);
        process.exitCode = 2;
      });
    return 0;
  }
  const config = loadConfig(root, flags.config ? resolve(flags.config) : undefined);
  const model = buildModel(root, config);
  const violations = checkRules(model, config);

  if (command === 'generate') {
    const format = flags.format ?? 'markdown';
    const text =
      format === 'markdown'
        ? renderMarkdown(model, config, violations)
        : format === 'structurizr'
          ? renderStructurizr(model)
          : format === 'json'
            ? JSON.stringify({ ...model, root: undefined, violations }, null, 2) + '\n'
            : fail(`Unknown format '${format}'.`);
    const out = flags.out ?? (format === 'markdown' ? 'docs/architecture.md' : undefined);
    if (!out || out === '-') {
      process.stdout.write(text);
    } else {
      const path = resolve(root, out);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text);
      process.stdout.write(`Wrote ${out}: ${model.containers.length} packages, ${model.externals.length} external systems, ${violations.length} violation${violations.length === 1 ? '' : 's'}.\n`);
    }
    return 0;
  }

  if (command === 'check') {
    process.stdout.write(formatViolations(violations, flags.format ?? 'text'));
    let code = violations.some((v) => v.severity === 'error') ? 1 : 0;
    if (flags['up-to-date']) {
      const path = resolve(root, flags['up-to-date']);
      const expected = renderMarkdown(model, config, violations);
      const actual = existsSync(path) ? readFileSync(path, 'utf8') : '';
      if (actual !== expected) {
        process.stdout.write(`${flags['up-to-date']} is out of date. Run \`arch-map generate --out ${flags['up-to-date']}\` and commit the result.\n`);
        code = 1;
      }
    }
    return code;
  }

  if (command === 'view') {
    const out = resolve(flags.out ?? 'architecture.html');
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, renderViewer(model, config, violations));
    process.stdout.write(`Wrote ${flags.out ?? 'architecture.html'}: ${model.containers.length} packages, ${violations.length} violation${violations.length === 1 ? '' : 's'}. Open it in a browser.\n`);
    return 0;
  }

  return fail(`Unknown command '${command}'.\n\n${USAGE}`);
}

function formatViolations(violations: Violation[], format: string): string {
  if (format === 'json') return JSON.stringify(violations, null, 2) + '\n';
  if (format === 'github') {
    return violations
      .map((v) => `::${v.severity} ${v.file ? `file=${v.file}${v.line ? `,line=${v.line}` : ''},` : ''}title=${v.rule}::${v.message}`)
      .join('\n') + (violations.length ? '\n' : '');
  }
  if (!violations.length) return 'No violations.\n';
  const lines: string[] = [];
  const byFile = new Map<string, Violation[]>();
  for (const v of violations) byFile.set(v.file ?? '(no file)', [...(byFile.get(v.file ?? '(no file)') ?? []), v]);
  for (const [file, list] of byFile) {
    lines.push(file);
    for (const v of list) lines.push(`  ${String(v.line ?? '').padEnd(5)} ${v.severity.padEnd(8)} ${v.message}  ${v.rule}`);
    lines.push('');
  }
  const errors = violations.filter((v) => v.severity === 'error').length;
  lines.push(`${errors} error${errors === 1 ? '' : 's'}, ${violations.length - errors} warning${violations.length - errors === 1 ? '' : 's'}`);
  return lines.join('\n') + '\n';
}

function fail(message: string): never {
  throw new Error(message);
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (err) {
  process.stderr.write(`arch-map: ${(err as Error).message}\n`);
  process.exitCode = 2;
}
