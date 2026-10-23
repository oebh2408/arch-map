import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from './types.js';

export const CONFIG_FILES = ['arch-map.config.json', '.arch-map.json'];

export function loadConfig(root: string, path?: string): Config {
  const file = path ?? CONFIG_FILES.map((f) => join(root, f)).find((f) => existsSync(f));
  if (!file) return {};
  try {
    const config = JSON.parse(readFileSync(file, 'utf8')) as Config;
    validate(config, file);
    return config;
  } catch (err) {
    throw new Error(`Invalid config ${file}: ${(err as Error).message}`);
  }
}

function validate(config: Config, file: string): void {
  for (const layer of config.layers ?? []) {
    if (!layer.name || !Array.isArray(layer.packages)) throw new Error(`each layer needs a name and a packages list (${file})`);
  }
  for (const rule of config.forbidden ?? []) {
    if (!rule.from || !rule.to) throw new Error(`each forbidden rule needs from and to (${file})`);
  }
  const ids = ['cycles', 'undeclared-dependency', 'unused-dependency', 'layers', 'forbidden'];
  for (const key of Object.keys(config.rules ?? {})) if (!ids.includes(key)) throw new Error(`unknown rule '${key}'`);
}
