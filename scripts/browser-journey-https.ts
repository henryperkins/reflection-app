/** TLS transport for cross-engine signed-in UI tests only, never a deployed server.
 * WebKit does not send Secure cookies on HTTP loopback. Keep cookie security intact;
 * map only the two known local origins to the synthetic Worker's canonical origin.
 * This is not hosted-origin, Safari or cross-engine WebAuthn qualification.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const upstream = 'http://localhost:8787';
const origin = 'https://localhost:8843';
const directory = mkdtempSync(join(tmpdir(), 'reflection-journey-tls-'));
const key = join(directory, 'key.pem');
const cert = join(directory, 'cert.pem');
execFileSync(
  'openssl',
  [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-days',
    '1',
    '-subj',
    '/CN=localhost',
    '-addext',
    'subjectAltName=DNS:localhost,IP:127.0.0.1',
    '-keyout',
    key,
    '-out',
    cert,
  ],
  { stdio: 'ignore' },
);
const server = createServer(
  { key: readFileSync(key), cert: readFileSync(cert) },
  (incoming, outgoing) => {
    const headers = { ...incoming.headers, host: new URL(upstream).host };
    if (headers.origin === origin) headers.origin = upstream;
    if (headers.referer?.startsWith(`${origin}/`))
      headers.referer = headers.referer.replace(origin, upstream);
    const proxy = request(
      new URL(incoming.url ?? '/', upstream),
      { method: incoming.method, headers },
      (response) => {
        outgoing.writeHead(response.statusCode ?? 502, response.headers);
        response.pipe(outgoing);
      },
    );
    proxy.on('error', () => {
      outgoing.writeHead(503);
      outgoing.end('Synthetic test server unavailable');
    });
    incoming.pipe(proxy);
  },
);
server.listen(8843, '127.0.0.1');
const stop = () => {
  server.closeAllConnections();
  server.close(() => process.exit());
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
process.once('exit', () => rmSync(directory, { recursive: true, force: true }));
