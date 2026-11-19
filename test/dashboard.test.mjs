import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ProcessManager } from '../lib/manager.mjs';
import { serve } from '../lib/http.mjs';
import { BrowserPairing } from '../lib/pairing.mjs';

async function fixture(t) {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'orchestrator-test-'));
  const root = path.join(tmp, 'apps');
  const data = path.join(tmp, 'state');
  mkdirSync(root);
  copyFileSync(new URL('../apps/example/server.cjs', import.meta.url), path.join(root, 'server.cjs'));
  let manager = new ProcessManager(root, data);
  let pairing = new BrowserPairing(data);
  let dashboard = await serve(manager, 0, pairing);
  t.after(async () => {
    try { await dashboard.close(); } finally { rmSync(tmp, { recursive: true, force: true }); }
  });
  const pair = code => fetch(`${dashboard.url}/api/pair`, {
    method: 'POST', headers: { authorization: `Pair ${code}` },
  });
  const response = await pair(pairing.invite());
  assert.equal(response.status, 200);
  const { session } = await response.json();
  return {
    root, data, get url() { return dashboard.url; },
    invite: () => pairing.invite(), pair,
    async relaunch() {
      await dashboard.close();
      manager = new ProcessManager(root, data);
      pairing = new BrowserPairing(data);
      dashboard = await serve(manager, 0, pairing);
    },
    async api(route = '', method = 'GET', body, expected = 200, headers = {}) {
      const response = await fetch(`${dashboard.url}/api/apps${route}`, {
        method, headers: { 'content-type': 'application/json', authorization: `Bearer ${session}`, ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const value = response.status === 204 ? null : await response.json();
      assert.equal(response.status, expected, JSON.stringify(value));
      return value;
    },
  };
}

async function until(read) {
  const limit = Date.now() + 5000;
  while (Date.now() < limit) {
    const result = await read();
    if (result) return result;
    await delay(30);
  }
  assert.fail('Timed out waiting for the application.');
}

const example = { name: 'Example', command: 'cd . && node "server.cjs"', url: 'http://localhost:3000/home' };
async function register(f) {
  return f.api('', 'POST', example, 201);
}

test('register, run, read logs, restart, stop and delete a real Node server', async t => {
  const f = await fixture(t);
  const app = await register(f);
  assert.equal(app.status, 'stopped');
  const route = `/${app.id}`;
  const started = await f.api(`${route}/start`, 'POST');
  assert.equal(started.status, 'running');
  const logs = async () => (await f.api(`${route}/logs`)).logs;
  const address = async pid => until(async () => {
    const lines = await logs();
    const start = lines.findLast(l => l.stream === 'system' && l.text.includes(`process ${pid}.`));
    return start && lines.find(l => l.seq > start.seq && l.stream === 'stdout')?.text.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
  });
  const initialUrl = await address(started.pid);
  assert.equal(await (await fetch(initialUrl)).text(), 'Hello from Orchestrator!\n');
  await until(async () => (await logs()).some(l => l.text === 'GET /'));
  await f.api(`${route}/start`, 'POST', undefined, 409);

  const next = await f.api(`${route}/restart`, 'POST');
  assert.notEqual(started.pid, next.pid);
  const nextUrl = await address(next.pid);
  assert.equal((await fetch(nextUrl)).status, 200);
  const stopped = await f.api(`${route}/stop`, 'POST');
  assert.equal(stopped.status, 'stopped');
  assert.equal(stopped.pid, null);
  await assert.rejects(fetch(nextUrl));

  const again = await f.api(`${route}/start`, 'POST');
  const lastUrl = await address(again.pid);
  await f.api(route, 'DELETE', undefined, 204);
  assert.deepEqual((await f.api()).apps, []);
  await assert.rejects(fetch(lastUrl));
  assert.ok(existsSync(path.join(f.root, 'server.cjs')));
  await f.relaunch();
  assert.deepEqual((await f.api()).apps, []);
});

test('shutdown stops children and reload restores registrations, not PIDs', async t => {
  const f = await fixture(t);
  const app = await register(f);
  await f.api(`/${app.id}/start`, 'POST');
  const url = await until(async () => (await f.api(`/${app.id}/logs`)).logs
    .find(l => l.stream === 'stdout')?.text.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0]);
  await f.relaunch();
  await assert.rejects(fetch(url));
  assert.deepEqual((await f.api()).apps, [app]);
});

test('editing a stopped app preserves its identity and logs, persists, and uses the new launch settings', async t => {
  const f = await fixture(t);
  const app = await register(f);
  const route = `/${app.id}`;
  const cwd = path.join(f.root, 'new project');
  mkdirSync(cwd);
  writeFileSync(path.join(cwd, 'changed.cjs'), "console.log('edited app launched');");
  const before = (await f.api(`${route}/logs`)).logs;
  const changes = { name: 'Updated', cwd: 'new project', command: 'node changed.cjs', url: '' };
  const saved = await f.api(route, 'PUT', changes);
  assert.deepEqual(saved, { ...app, ...changes, cwd: realpathSync(cwd) });
  assert.deepEqual((await f.api(`${route}/logs`)).logs.slice(0, before.length), before);
  await f.relaunch();
  assert.deepEqual((await f.api()).apps, [saved]);
  await f.api(`${route}/start`, 'POST');
  await until(async () => (await f.api(`${route}/logs`)).logs.some(l => l.stream === 'stdout' && l.text === 'edited app launched'));
});

test('running, conflicting, invalid and unpaired edits leave the registration unchanged', async t => {
  const f = await fixture(t);
  const app = await register(f);
  const route = `/${app.id}`;
  const changes = { ...example, name: 'Renamed' };
  await f.api(route, 'PUT', changes, 401, { authorization: '' });
  await f.api(route, 'PUT', { ...changes, url: 'file:///local' }, 400);
  const other = await f.api('', 'POST', { name: 'Other', command: 'node another.cjs' }, 201);
  await f.api(route, 'PUT', { ...changes, command: other.command }, 409);
  assert.deepEqual((await f.api()).apps, [app, other]);
  const running = await f.api(`${route}/start`, 'POST');
  await f.api(route, 'PUT', changes, 409);
  assert.deepEqual((await f.api()).apps[0], running);
  await f.api(`${route}/stop`, 'POST');
  assert.equal((await f.api(route, 'PUT', changes)).name, 'Renamed');
});

test('a crashing app exposes stderr and its exit code without unbounded log history', async t => {
  const f = await fixture(t);
  writeFileSync(path.join(f.root, 'crash.mjs'),
    `console.log(Array.from({ length: 300 }, (_, i) => 'line ' + i).join('\\n'));\nconsole.error('test failure');\nprocess.exitCode = 7;`);
  const { id, url } = await f.api('', 'POST', { name: 'Crash', command: 'node crash.mjs' }, 201);
  assert.equal(url, '');
  await f.api(`/${id}/start`, 'POST');
  const app = await until(async () => (await f.api()).apps.find(a => a.status === 'failed'));
  assert.equal(app.lastExit.code, 7);
  const { logs } = await f.api(`/${id}/logs`);
  assert.equal(logs.length, 250);
  assert.ok(logs.some(l => l.stream === 'stderr' && l.text === 'test failure'));
  assert.ok(logs.some(l => l.stream === 'stdout' && l.text === 'line 299'));
  assert.deepEqual((await f.api(`/${id}/logs?after=${logs.at(-2).seq}`)).logs, logs.slice(-1));
});

test('the same command can run in separate saved working directories', async t => {
  const f = await fixture(t);
  const dirs = [path.join(f.root, 'service one'), path.join(path.dirname(f.root), 'service two')];
  const command = 'node report.cjs';
  const apps = [];
  for (const [i, dir] of dirs.entries()) {
    mkdirSync(dir);
    writeFileSync(path.join(dir, 'report.cjs'), 'console.log(process.cwd());');
    const app = await f.api('', 'POST', { name: `Service ${i}`, command, cwd: i ? dir : 'service one' }, 201);
    assert.equal(app.cwd, realpathSync(dir));
    apps.push(app);
  }
  await f.api('', 'POST', { ...apps[0], cwd: dirs[0] }, 409);

  for (const action of ['start', 'restart']) {
    if (action === 'restart') await f.relaunch();
    for (const app of apps) {
      await f.api(`/${app.id}/${action}`, 'POST');
      await until(async () => (await f.api(`/${app.id}/logs`)).logs.some(l =>
        l.stream === 'stdout' && path.relative(app.cwd, l.text) === ''));
    }
  }
});

test('a missing or non-directory working path is not accepted or silently replaced at launch', async t => {
  const f = await fixture(t);
  for (const cwd of [' ', 'absent', 'server.cjs']) await f.api('', 'POST', { ...example, cwd }, 400);
  const dir = path.join(f.root, 'temporary-service');
  mkdirSync(dir);
  const app = await f.api('', 'POST', { ...example, cwd: dir }, 201);
  rmSync(dir, { recursive: true });
  await f.relaunch();
  await f.api(`/${app.id}/start`, 'POST', undefined, 400);
  assert.equal((await f.api()).apps[0].pid, null);
});

test('commands and URLs are validated and other origins cannot register apps', async t => {
  const f = await fixture(t);
  assert.deepEqual((await f.api()).apps, []);
  await f.api('', 'POST', example, 403, { origin: 'https://other.invalid' });
  await f.api('', 'POST', example, 403, { 'sec-fetch-site': 'cross-site' });
  for (const invalid of [{ name: '' }, { command: ' ' }, { command: 'a\nb' }, { url: '/relative' }, { url: 'file:///tmp/app' }]) {
    await f.api('', 'POST', { ...example, ...invalid }, 400);
  }
  const app = await register(f);
  assert.equal(app.url, example.url);
  assert.equal(app.command, example.command);
  assert.deepEqual((await f.api()).apps, [app]);
  await f.api('', 'POST', example, 409);
});

test('API access requires pairing; invitations are one-use and replacement invalidates the old browser', async t => {
  const f = await fixture(t);
  const unpaired = { authorization: '' };
  await f.api('', 'GET', undefined, 401, unpaired);
  await f.api('', 'POST', example, 401, unpaired);
  const app = await register(f);
  await f.api(`/${app.id}/start`, 'POST', undefined, 401, unpaired);
  await f.api(`/${app.id}/logs`, 'GET', undefined, 401, unpaired);
  assert.equal((await f.pair('invalid')).status, 401);
  const code = f.invite();
  const replacement = await f.pair(code);
  assert.equal(replacement.status, 200);
  assert.equal((await f.pair(code)).status, 401);
  const { session } = await replacement.json();
  await f.relaunch();
  await f.api('', 'GET', undefined, 401);
  const state = await f.api('', 'GET', undefined, 200, { authorization: `Bearer ${session}` });
  assert.deepEqual(state.apps, [app]);
});

test('editing metadata on a legacy registration preserves its direct entry-file launch', async t => {
  const f = await fixture(t);
  const id = '00000000-0000-4000-8000-000000000001';
  mkdirSync(path.join(f.root, 'nested'));
  copyFileSync(path.join(f.root, 'server.cjs'), path.join(f.root, 'nested', 'server.cjs'));
  writeFileSync(path.join(f.data, 'applications.json'), JSON.stringify([{ id, name: 'Legacy', entry: 'nested/server.cjs' }]));
  await f.relaunch();
  const [app] = (await f.api()).apps;
  assert.equal(app.command, 'node "server.cjs"');
  assert.equal(app.url, '');
  const saved = await f.api(`/${id}`, 'PUT', { ...app, name: 'Renamed legacy app', url: 'https://example.test/' });
  await f.relaunch();
  assert.deepEqual((await f.api()).apps, [saved]);
  await f.api(`/${id}/start`, 'POST');
  await until(async () => (await f.api(`/${id}/logs`)).logs.some(l => l.text.includes('Example server listening')));
  await f.api(`/${id}/stop`, 'POST');
});
