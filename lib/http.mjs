import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { RequestError } from './manager.mjs';

const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/dashboard.js', ['dashboard.js', 'text/javascript; charset=utf-8']],
  ['/dashboard.css', ['dashboard.css', 'text/css; charset=utf-8']],
  ['/mark.svg', ['mark.svg', 'image/svg+xml']],
].map(([url, [file, type]]) => [url, { type, body: readFileSync(new URL(`../public/${file}`, import.meta.url)) }]));

async function readRegistration(req) {
  if (req.headers['content-type']?.split(';')[0] !== 'application/json') {
    throw new RequestError(415, 'Send registration details as JSON.');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 32768) throw new RequestError(413, 'Registration is too large.');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new RequestError(400, 'Invalid JSON.'); }
}

function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify(value));
}

export async function serve(manager, port, pairing) {
  const startedAt = Date.now();
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'self'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    try {
      const address = server.address();
      if (!address) {
        res.setHeader('Connection', 'close');
        throw new RequestError(503, 'The process manager is shutting down.');
      }
      const host = `127.0.0.1:${address.port}`;
      if (req.headers.host !== host || (req.headers.origin && req.headers.origin !== `http://${host}`)) {
        throw new RequestError(403, 'Only the local dashboard origin is allowed.');
      }
      const url = new URL(req.url, `http://${host}`);
      const asset = assets.get(url.pathname);
      if (asset && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': asset.type }).end(asset.body);
        return;
      }
      if (!url.pathname.startsWith('/api/')) throw new RequestError(404, 'Not found.');
      const site = req.headers['sec-fetch-site'];
      if (site && site !== 'same-origin' && site !== 'none') {
        throw new RequestError(403, 'Only the local dashboard origin is allowed.');
      }
      const authorization = req.headers.authorization ?? '';
      if (req.method === 'POST' && url.pathname === '/api/pair') {
        const session = pairing.redeem(/^Pair ([a-f0-9]{64})$/.exec(authorization)?.[1]);
        if (!session) throw new RequestError(401, 'Pairing link expired or already used. Restart with npm start -- --pair.');
        return json(res, 200, { session });
      }
      if (!pairing.accepts(/^Bearer ([a-f0-9]{64})$/.exec(authorization)?.[1])) {
        throw new RequestError(401, 'This browser is not paired. Use the pairing page from the manager terminal.');
      }
      if (url.pathname === '/api/apps') {
        if (req.method === 'GET') return json(res, 200, { startedAt, ...manager.overview() });
        if (req.method === 'POST') return json(res, 201, manager.add(await readRegistration(req)));
      }
      const match = /^\/api\/apps\/([\da-f-]{36})(?:\/(start|stop|restart|logs))?$/.exec(url.pathname);
      if (match) {
        const [, id, action] = match;
        if (req.method === 'PUT' && !action) {
          return json(res, 200, manager.update(id, await readRegistration(req)));
        }
        if (req.method === 'GET' && action === 'logs') {
          const after = Number(url.searchParams.get('after') ?? 0);
          if (!Number.isSafeInteger(after) || after < 0) throw new RequestError(400, 'Invalid log cursor.');
          return json(res, 200, { logs: manager.logs(id, after) });
        }
        if (req.method === 'DELETE' && !action) {
          await manager.act(id, 'delete');
          return res.writeHead(204).end();
        }
        if (req.method === 'POST' && ['start', 'stop', 'restart'].includes(action)) {
          return json(res, 200, await manager.act(id, action));
        }
      }
      throw new RequestError(404, 'Unknown endpoint or method.');
    } catch (error) {
      if (!(error instanceof RequestError)) console.error(error);
      json(res, error instanceof RequestError ? error.status : 500,
        { error: error instanceof RequestError ? error.message : 'Operation failed. Check the manager terminal for details.' });
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url,
    async close() {
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      await manager.shutdown();
    },
  };
}
