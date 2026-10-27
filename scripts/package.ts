import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { projectRoot } from './schemas.ts';
import { checkRelease } from './release.ts';

const roots = new Set(['src', 'tests', 'checks', 'scripts', 'docs', 'content', 'qualification']);
const rootFiles = new Set([
  '.node-version',
  '.npmrc',
  'package.json',
  'package-lock.json',
  'README.md',
  'LICENSE',
  'LICENSE.md',
  '.gitignore',
  'index.html',
  'tsconfig.json',
  'biome.json',
  'playwright.config.ts',
  'vite.config.ts',
  'vitest.domain.config.ts',
  'vitest.db.config.ts',
  'wrangler.jsonc',
  'wrangler.identity.jsonc',
]);
const excluded = new Set([
  '.git',
  '.wrangler',
  '.superpowers',
  'node_modules',
  '__pycache__',
  'dist',
]);
const reports = ['verify.json', 'domain-tests.json', 'db-tests.json', 'browser-tests.json'];
export const publicEvaluationFiles = new Set(['corpus.json', 'manifest.json', 'README.md']);

export function packageApplication(
  root: string,
  output: string,
  mode: 'local-snapshot' | 'completed-milestone',
) {
  root = resolve(root);
  output = resolve(output);
  if (output === root || output.startsWith(root + sep))
    throw new Error('Place delivery ZIP outside the application checkout');
  if (existsSync(output) || existsSync(`${output}.sha256`))
    throw new Error('Delivery path already exists');
  const release = checkRelease(root);
  if (mode === 'completed-milestone' && !release.milestone2Complete)
    throw new Error(`Milestone 2 remains open: ${release.outstanding.join('; ')}`);
  const paths: string[] = [];
  const visit = (relative: string) => {
    for (const name of readdirSync(join(root, relative)).sort()) {
      if (
        excluded.has(name) ||
        name.startsWith('.env') ||
        name.startsWith('.dev.vars') ||
        /\.(?:db|sqlite3?|pem|key|p12|pfx|log|zip|pyc)$/i.test(name)
      )
        continue;
      if (!relative && !roots.has(name) && !rootFiles.has(name) && name !== 'evaluation') continue;
      if (relative === 'evaluation' && !publicEvaluationFiles.has(name)) continue;
      const path = join(relative, name);
      const stat = lstatSync(join(root, path));
      if (stat.isSymbolicLink()) throw new Error(`Delivery rejects symlinks: ${path}`);
      if (stat.isDirectory()) visit(path);
      else if (stat.isFile()) paths.push(path);
    }
  };
  visit('');
  for (const report of reports) {
    const path = `artifacts/${report}`;
    if (existsSync(join(root, path))) {
      if (!lstatSync(join(root, path)).isFile())
        throw new Error('Invalid verification evidence file');
      paths.push(path);
    }
  }
  const manifest = {
    format: 'reflection-delivery.v1',
    mode,
    deploymentAllowed: false,
    milestone2Complete: release.milestone2Complete,
    sourceDigest: JSON.parse(readFileSync(join(root, 'artifacts/verify.json'), 'utf8'))
      .sourceDigest as string,
    outstanding: release.outstanding,
    files: paths.sort().map((path) => ({
      path,
      sha256: createHash('sha256')
        .update(readFileSync(join(root, path)))
        .digest('hex'),
    })),
  };
  const python = `import sys,json,zipfile,hashlib,os
root,output=sys.argv[1:]
manifest=json.load(sys.stdin)
with zipfile.ZipFile(output, 'x', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as z:
 for item in manifest['files']:
  path=item['path']
  with open(os.path.join(root,path),'rb') as f: data=f.read()
  if hashlib.sha256(data).hexdigest()!=item['sha256']: raise RuntimeError('Source changed during packaging')
  info=zipfile.ZipInfo('reflection-app/'+path,(2020,1,1,0,0,0)); info.external_attr=0o100644<<16; info.compress_type=zipfile.ZIP_DEFLATED
  z.writestr(info,data)
 info=zipfile.ZipInfo('reflection-app/artifacts/DELIVERY.json',(2020,1,1,0,0,0)); info.external_attr=0o100644<<16; info.compress_type=zipfile.ZIP_DEFLATED
 z.writestr(info,json.dumps(manifest,sort_keys=True,indent=2)+'\\n')
with zipfile.ZipFile(output) as z:
 if z.testzip() is not None: raise RuntimeError('Archive integrity failed')
`;
  const result = spawnSync('python3', ['-c', python, root, output], {
    input: JSON.stringify(manifest),
    encoding: 'utf8',
  });
  if (result.status !== 0) throw new Error(`ZIP creation failed: ${result.stderr}`);
  const sha256 = createHash('sha256').update(readFileSync(output)).digest('hex');
  writeFileSync(`${output}.sha256`, `${sha256}  ${basename(output)}\n`, { flag: 'wx' });
  return {
    path: output,
    sha256,
    files: manifest.files.length,
    mode,
    milestone2Complete: release.milestone2Complete,
    deploymentAllowed: false,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [flag, output, root = projectRoot, extra] = process.argv.slice(2);
  if (!output || extra || !['--local-snapshot', '--completed-milestone'].includes(flag ?? ''))
    throw new Error(
      'Usage: npm run package -- --local-snapshot|--completed-milestone /absolute/output.zip [source-root]',
    );
  console.log(
    JSON.stringify(
      packageApplication(
        root,
        output,
        flag === '--completed-milestone' ? 'completed-milestone' : 'local-snapshot',
      ),
    ),
  );
}
