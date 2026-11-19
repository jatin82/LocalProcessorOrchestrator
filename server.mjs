import { execFile } from 'node:child_process';
import { mkdtempSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ProcessManager } from './lib/manager.mjs';
import { serve } from './lib/http.mjs';
import { BrowserPairing, pairingLifetime } from './lib/pairing.mjs';

function openPairingPage(url) {
  // Pass only the private file path (not the invitation secret) to the OS opener.
  const dir = mkdtempSync(path.join(homedir(), '.orchestrator-pair-'));
  const page = path.join(dir, 'pair.html');
  let removed = false;
  let timer;
  function cleanup() {
    if (removed) return;
    clearTimeout(timer);
    rmSync(page, { force: true });
    rmdirSync(dir);
    removed = true;
  }
  try {
    writeFileSync(page, `<!doctype html><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta http-equiv="refresh" content="0;url=${url}"><title>Pair Orchestrator</title><a href="${url}">Pair this browser with Orchestrator</a>`, { mode: 0o600 });
    timer = setTimeout(cleanup, pairingLifetime).unref();
    const localUrl = pathToFileURL(page).href;
    console.log(`Pairing your browser. If it does not open, open this local page within five minutes:\n${localUrl}`);
    const win = process.platform === 'win32';
    const opener = win ? path.join(process.env.SystemRoot, 'System32', 'rundll32.exe') :
      process.platform === 'darwin' ? 'open' : 'xdg-open';
    execFile(opener, win ? ['url.dll,FileProtocolHandler', localUrl] : [localUrl], { windowsHide: true },
      error => { if (error) console.error('Browser did not open automatically. Open the local pairing page shown above.'); });
    return cleanup;
  } catch (error) { cleanup(); throw error; }
}

try {
  const dataDir = process.env.ORCHESTRATOR_DATA_DIR ?? fileURLToPath(new URL('./.orchestrator/', import.meta.url));
  const manager = new ProcessManager(
    process.env.ORCHESTRATOR_APPS_ROOT ?? fileURLToPath(new URL('./apps/', import.meta.url)),
    dataDir,
  );
  const pairing = new BrowserPairing(dataDir);
  const dashboard = await serve(manager, 4321, pairing);
  console.log(`Dashboard: ${dashboard.url}/\n\nApplications folder: ${manager.root}\nPress Ctrl+C to stop the manager and its applications.`);
  let cleanup;
  if (!pairing.paired || process.argv.includes('--pair')) {
    try { cleanup = openPairingPage(`${dashboard.url}/#pair=${pairing.invite()}`); }
    catch (error) { await dashboard.close(); throw error; }
  }
  let closing = false;
  async function close() {
    if (closing) return;
    closing = true;
    try { await dashboard.close(); cleanup?.(); }
    catch (error) { console.error(`Shutdown failed: ${error.message}`); process.exitCode = 1; }
  }
  process.on('SIGINT', close);
  process.on('SIGTERM', close);
} catch (error) {
  console.error(`Cannot start Orchestrator: ${error.message}`);
  process.exitCode = 1;
}
