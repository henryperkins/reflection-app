import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, relative, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { renderHostedConfig } from '../src/worker/runtime/config.ts';

export function renderConfiguration(input: string, output: string) {
  if (resolve(input) === resolve(output)) throw new Error('Use a separate configuration output');
  const manifest: unknown = JSON.parse(readFileSync(resolve(input), 'utf8'));
  const config = renderHostedConfig(manifest);
  const root = fileURLToPath(new URL('..', import.meta.url));
  const portable = (path: string) =>
    relative(dirname(resolve(output)), resolve(root, path))
      .split('\\')
      .join('/');
  config.main = portable(config.main);
  config.assets.directory = portable(config.assets.directory);
  for (const database of config.d1_databases)
    database.migrations_dir = portable(database.migrations_dir);
  writeFileSync(resolve(output), JSON.stringify(config, null, 2) + '\n', { flag: 'wx' });
  return {
    mode: JSON.parse(config.vars.RUNTIME_MANIFEST).mode,
    output: resolve(output),
    deployed: false,
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [flag, input, outputFlag, output, extra] = process.argv.slice(2);
  if (flag !== '--manifest' || outputFlag !== '--output' || !input || !output || extra)
    throw new Error(
      'Usage: node --import tsx scripts/render-hosted-config.ts --manifest manifest.json --output wrangler.hosted.json',
    );
  try {
    console.log(JSON.stringify(renderConfiguration(input, output)));
  } catch {
    console.error('Hosted configuration could not be rendered; input contents were not displayed.');
    process.exitCode = 1;
  }
}
