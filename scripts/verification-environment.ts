import { readdirSync } from 'node:fs';

// Preserve execution plumbing (including injected proxy/CA/auth guard variables),
// while excluding application credentials and build-time VITE_* values.
const inherited = new Set([
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'TMPDIR',
  'TMP',
  'TEMP',
  'SYSTEMROOT',
  'COMSPEC',
  'PATHEXT',
  'LANG',
  'LC_ALL',
  'TZ',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'REQUESTS_CA_BUNDLE',
  'CURL_CA_BUNDLE',
]);

export function verificationEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(environment)) {
    if (inherited.has(name) || name.startsWith('CODEX_') || name.startsWith('OIC_'))
      result[name] = value;
  }
  return {
    ...result,
    CI: 'true',
    WRANGLER_SEND_METRICS: 'false',
    REFLECTION_NETWORK: 'deny',
    CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false',
  };
}

export function assertNoLocalSecrets(root: string): void {
  const forbidden = readdirSync(root).filter(
    (name) =>
      (name === '.env' ||
        name.startsWith('.env.') ||
        name === '.dev.vars' ||
        name.startsWith('.dev.vars.')) &&
      name !== '.env.example' &&
      name !== '.dev.vars.example',
  );
  if (forbidden.length)
    throw new Error(
      'Synthetic verification requires a checkout without local dotenv/dev-vars files; their contents were not read',
    );
}
