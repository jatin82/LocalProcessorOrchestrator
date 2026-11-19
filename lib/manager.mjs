import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import {
  existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

export class RequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const LOG_LIMIT = 250;
const isEntry = (file) => /\.(?:js|cjs|mjs)$/i.test(file);
const windows = process.platform === 'win32';
const execFileAsync = promisify(execFile);
const controlCharacters = /[\x00-\x1f\x7f-\x9f\u2028-\u202e\u2066-\u2069]/;

function appName(name) {
  if (typeof name !== 'string' || !name.trim() || name.length > 80 || controlCharacters.test(name)) {
    throw new RequestError(400, 'Enter an application name of 1 to 80 characters.');
  }
  return name.trim();
}

function directoryPath(value, root) {
  if (typeof value !== 'string' || !value.trim() || value.length > 4096 || controlCharacters.test(value)) {
    throw new RequestError(400, 'Enter a working directory.');
  }
  const dir = value.trim();
  if (windows && (/^[\\/]{2}/.test(dir) || /^[a-z]:(?![\\/])/i.test(dir))) {
    throw new RequestError(400, 'Use a local absolute path or a path relative to the applications folder.');
  }
  return path.resolve(root, dir);
}

function existingDirectory(dir) {
  try {
    const resolved = realpathSync(dir);
    if (controlCharacters.test(resolved) || (windows && resolved.startsWith('\\\\')) || !statSync(resolved).isDirectory()) {
      throw new RequestError(400, 'The working directory must be a local folder.');
    }
    return resolved;
  } catch (error) {
    if (['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'ELOOP', 'EINVAL', 'ENAMETOOLONG'].includes(error.code)) {
      throw new RequestError(400, 'The working directory does not exist or is not accessible.');
    }
    throw error;
  }
}

function appUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || rawUrl.length > 2048 || controlCharacters.test(rawUrl)) {
    throw new RequestError(400, 'Enter a valid HTTP or HTTPS URL, or leave it blank.');
  }
  if (!rawUrl.trim()) return '';
  const parsed = URL.parse(rawUrl.trim());
  if (!parsed || !['https:', 'http:'].includes(parsed.protocol) || !/^https?:\/\//i.test(rawUrl.trim()) ||
      parsed.username || parsed.password) {
    throw new RequestError(400, 'Use an absolute HTTP or HTTPS URL without embedded credentials.');
  }
  return parsed.href;
}

function registration(input, root) {
  const name = appName(input?.name);
  const command = input.command;
  if (typeof command !== 'string' || !command.trim() || command.length > 4096 || controlCharacters.test(command)) {
    throw new RequestError(400, 'Enter a single-line launch command of 1 to 4096 characters.');
  }
  const url = appUrl(input.url ?? '');
  const cwd = directoryPath(input.cwd === undefined ? '.' : input.cwd, root);
  return { name, command: command.trim(), cwd, url };
}

function legacyRegistration(input) {
  const name = appName(input.name);
  const entry = input.entry;
  if (typeof entry !== 'string' || entry.length > 512 || !isEntry(entry.trim()) ||
      /^[\\/]/.test(entry.trim()) || /[:\x00-\x1f]/.test(entry) || entry.split(/[\\/]/).includes('..')) {
    throw new RequestError(400, 'Use a relative .js, .cjs, or .mjs entry file inside the applications folder.');
  }
  return { name, entry: path.normalize(entry.trim().replaceAll('\\', '/')), url: appUrl(input.url ?? '') };
}

function runtime(config, root) {
  const cwd = config.entry ? path.dirname(path.resolve(root, config.entry)) : config.cwd;
  return { config, cwd,
    status: 'stopped', child: null, finished: null, busy: false,
    startedAt: null, lastExit: null, logs: [], sequence: 0 };
}

function launchCommand(config) {
  return config.command ?? `node "${path.basename(config.entry)}"`;
}

function snapshot(app) {
  const { id, name, url } = app.config;
  return { id, name, command: launchCommand(app.config), cwd: app.cwd, url: url ?? '',
    status: app.status, pid: app.child?.pid ?? null,
    startedAt: app.startedAt, lastExit: app.lastExit };
}

function log(app, stream, text) {
  const lines = text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n').slice(-LOG_LIMIT);
  const time = new Date().toISOString();
  for (const line of lines) {
    const message = line.length > 4096 ? `${line.slice(0, 4096)} [truncated]` : line;
    app.logs.push({ seq: ++app.sequence, time, stream, text: message });
  }
  if (app.logs.length > LOG_LIMIT) app.logs.splice(0, app.logs.length - LOG_LIMIT);
}

function contained(root, file) {
  const rel = path.relative(root, file);
  return rel && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

async function exitedWithin(promise, ms) {
  let timer;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise(resolve => { timer = setTimeout(() => resolve(false), ms); }),
    ]);
  } finally { clearTimeout(timer); }
}

// Shells can exit before the foreground server they launched.
function signalGroup(pid, signal) {
  try { process.kill(-pid, signal); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

export class ProcessManager {
  #apps = new Map();
  #registry;

  constructor(appsRoot, dataDir) {
    this.root = realpathSync(appsRoot);
    if (!statSync(this.root).isDirectory()) throw new Error('The applications root must be a directory.');
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.#registry = path.join(dataDir, 'applications.json');
    if (existsSync(this.#registry)) {
      try {
        const saved = JSON.parse(readFileSync(this.#registry, 'utf8'));
        if (!Array.isArray(saved)) throw new Error('Expected a list of applications.');
        for (const item of saved) {
          if (!/^[\da-f-]{36}$/.test(item.id) || this.#apps.has(item.id)) throw new Error('Invalid application ID.');
          const launch = item.command === undefined ? legacyRegistration(item) : registration(item, this.root);
          this.#apps.set(item.id, runtime({ id: item.id, ...launch }, this.root));
        }
      } catch (error) {
        throw new Error(`Cannot load ${this.#registry}: ${error.message}`, { cause: error });
      }
    }
  }

  #save(configs) {
    const temp = `${this.#registry}.tmp`;
    writeFileSync(temp, JSON.stringify(configs, null, 2) + '\n', { mode: 0o600 });
    renameSync(temp, this.#registry);
  }

  #resolve(entry) {
    const requested = path.resolve(this.root, entry);
    if (!contained(this.root, requested)) throw new RequestError(400, 'Entry file is outside the applications folder.');
    let file;
    try {
      file = realpathSync(requested);
      if (!contained(this.root, file) || !isEntry(file) || !statSync(file).isFile()) {
        throw new RequestError(400, 'Select a Node.js file inside the applications folder.');
      }
    } catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes(error.code)) throw new RequestError(400, `Entry file not found: ${entry}`);
      throw error;
    }
    return file;
  }

  overview() {
    return { root: this.root, apps: Array.from(this.#apps.values(), snapshot) };
  }

  #validateLaunch(input, exceptId) {
    const launch = registration(input, this.root);
    launch.cwd = existingDirectory(launch.cwd);
    for (const app of this.#apps.values()) {
      if (app.config.id !== exceptId && launchCommand(app.config) === launch.command && path.relative(app.cwd, launch.cwd) === '') {
        throw new RequestError(409, 'This command is already registered in that working directory.');
      }
    }
    return launch;
  }

  add(input) {
    const config = { id: randomUUID(), ...this.#validateLaunch(input) };
    const app = runtime(config, this.root);
    this.#save([...Array.from(this.#apps.values(), a => a.config), config]);
    this.#apps.set(config.id, app);
    log(app, 'system', 'Application registered.');
    return snapshot(app);
  }

  update(id, input) {
    const app = this.#get(id);
    if (app.busy || app.child || !['stopped', 'failed'].includes(app.status)) {
      throw new RequestError(409, 'Stop the application before editing its settings.');
    }
    const launch = this.#validateLaunch(input, id);
    const keepEntry = app.config.entry && launch.command === launchCommand(app.config) && launch.cwd === app.cwd;
    const config = keepEntry ? { ...app.config, name: launch.name, url: launch.url } : { id, ...launch };
    this.#save(Array.from(this.#apps.values(), a => a === app ? config : a.config));
    app.config = config;
    app.cwd = launch.cwd;
    log(app, 'system', 'Application settings updated.');
    return snapshot(app);
  }

  #get(id) {
    const app = this.#apps.get(id);
    if (!app) throw new RequestError(404, 'Application not found.');
    return app;
  }

  logs(id, after) { return this.#get(id).logs.filter(row => row.seq > after); }

  async #start(app) {
    if (app.child) throw new RequestError(409, 'This application is already running.');
    app.status = 'starting';
    app.lastExit = null;
    try {
      const options = { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true };
      let child;
      if (app.config.entry) {
        const file = this.#resolve(app.config.entry);
        child = spawn(process.execPath, ['--', file], { ...options, cwd: path.dirname(file) });
      } else {
        const cwd = existingDirectory(app.cwd);
        if (cwd !== app.cwd) throw new RequestError(409, 'The working directory now points elsewhere. Register the application again.');
        child = spawn(app.config.command, { ...options, cwd, shell: true, detached: !windows });
      }
      app.child = child;
      app.finished = new Promise(resolve => {
        child.once('exit', (code, signal) => {
          app.status = app.status === 'stopping' || code === 0 ? 'stopped' : 'failed';
          app.lastExit = { code, signal, time: new Date().toISOString() };
          app.child = null;
          app.startedAt = null;
          log(app, 'system', `Process exited (${signal ?? `code ${code}`}).`);
          resolve();
        });
        child.on('error', error => {
          log(app, 'system', `Process error: ${error.message}`);
          if (!child.pid) resolve();
        });
      });
      for (const stream of ['stdout', 'stderr']) {
        child[stream].setEncoding('utf8').on('data', chunk => log(app, stream, chunk));
      }
      await once(child, 'spawn');
      app.status = 'running';
      app.startedAt = new Date().toISOString();
      log(app, 'system', `Started process ${child.pid}.`);
    } catch (error) {
      app.status = 'failed';
      app.child = null;
      log(app, 'system', `Start failed: ${error.message}`);
      throw error;
    }
  }

  async #stop(app) {
    const child = app.child;
    if (!child) return;
    app.status = 'stopping';
    log(app, 'system', 'Stop requested.');
    if (app.config.entry) {
      child.kill('SIGTERM');
    } else if (windows) {
      try {
        await execFileAsync(path.join(process.env.SystemRoot, 'System32', 'taskkill.exe'),
          ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
      } catch (error) {
        if (app.child === child) throw new RequestError(503, `Could not stop the command's process tree: ${error.message}`);
      }
    } else {
      const pid = child.pid;
      signalGroup(pid, 'SIGTERM');
      const deadline = Date.now() + 4000;
      while (Date.now() < deadline && signalGroup(pid, 0)) await delay(50);
      if (signalGroup(pid, 0)) signalGroup(pid, 'SIGKILL');
    }
    if (!await exitedWithin(app.finished, 4000)) {
      log(app, 'system', 'Grace period elapsed. Forcing stop.');
      child.kill('SIGKILL');
      if (!await exitedWithin(app.finished, 4000)) {
        throw new RequestError(503, 'Process has not exited; registration was kept. Try stopping it again.');
      }
    }
  }

  async act(id, action) {
    const app = this.#get(id);
    if (app.busy) throw new RequestError(409, 'Another operation is in progress for this application.');
    app.busy = true;
    try {
      switch (action) {
        case 'start': await this.#start(app); break;
        case 'stop': await this.#stop(app); break;
        case 'restart': await this.#stop(app); await this.#start(app); break;
        case 'delete': {
          await this.#stop(app);
          this.#save([...this.#apps.values()].filter(a => a !== app).map(a => a.config));
          this.#apps.delete(id);
          break;
        }
        default: throw new RequestError(404, 'Unknown operation.');
      }
      return snapshot(app);
    } finally { app.busy = false; }
  }

  async shutdown() {
    await Promise.all([...this.#apps.values()].map(app => this.#stop(app)));
  }
}
