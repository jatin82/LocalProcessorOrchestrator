const $ = id => document.getElementById(id);
const sessionKey = 'orchestrator.paired-browser';
const pairingHint = 'Open the local pairing page printed by the manager. To replace a paired browser, restart with npm start -- --pair.';

let apps = [], selected = null, cursor = 0, listKey = '', revision = 0;
let managerStartedAt;
let online = false, busy = false, actionError = '';
const current = () => apps.find(app => app.id === selected);
const clock = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});

function message(id, text) {
  $(id).textContent = text;
  $(id).hidden = !text;
}

async function api(path, method = 'GET', body) {
  const session = localStorage.getItem(sessionKey);
  if (!session) throw new Error(pairingHint);
  const response = await fetch(`/api/apps${path}`, {
    method, headers: { Authorization: `Bearer ${session}`, ...(body && { 'Content-Type': 'application/json' }) },
    body: body ? JSON.stringify(body) : undefined, cache: 'no-store', redirect: 'error',
  });
  if (response.status === 401) {
    if (localStorage.getItem(sessionKey) === session) localStorage.removeItem(sessionKey);
    throw new Error(pairingHint);
  }
  if (response.status === 204) return;
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);
  return data;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function select(id) {
  if (selected === id) return;
  selected = id;
  resetLogs();
}

function resetLogs() {
  cursor = 0;
  $('log-rows').replaceChildren();
  message('log-placeholder', selected ? 'No output yet.' : 'Waiting for an application.');
}

function render() {
  const key = JSON.stringify([apps, selected]);
  if (key !== listKey) {
    listKey = key;
    const focused = document.activeElement?.dataset.app;
    const rows = apps.map(app => {
      const row = el('button', 'app-row');
      row.type = 'button';
      row.dataset.app = app.id;
      row.setAttribute('aria-pressed', String(app.id === selected));
      const info = el('span', 'app-info');
      info.append(el('strong', '', app.name), el('small', '', app.command));
      row.append(info, el('span', `badge ${app.status}`, app.status));
      row.onclick = () => { select(app.id); render(); void refresh(); };
      return row;
    });
    $('app-list').replaceChildren(...rows);
    if (focused) rows.find(row => row.dataset.app === focused)?.focus();
    $('total').textContent = apps.length;
    for (const status of ['running', 'stopped', 'failed']) {
      $(status).textContent = apps.filter(app => app.status === status).length;
    }
    $('empty-list').hidden = apps.length > 0;
  }
  const app = current();
  $('empty-detail').hidden = !!app;
  $('detail').hidden = !app;
  $('add').disabled = $('first-add').disabled = !online || busy;
  if (!app) return;
  $('app-name').textContent = app.name;
  $('app-command').textContent = app.command;
  $('app-cwd').textContent = app.cwd;
  const link = $('open-app');
  link.hidden = !app.url;
  if (app.url) link.href = app.url;
  else link.removeAttribute('href');
  $('app-status').textContent = app.status;
  $('app-status').className = `badge ${app.status}`;
  $('app-meta').textContent = app.pid
    ? `PID ${app.pid}${app.startedAt ? ` | Started ${clock.format(new Date(app.startedAt))}` : ''}`
    : app.lastExit ? `Last exit: ${app.lastExit.signal ?? `code ${app.lastExit.code}`} at ${clock.format(new Date(app.lastExit.time))}`
    : 'No active process';
  const locked = !online || busy || app.status === 'starting' || app.status === 'stopping';
  $('start').disabled = locked || !!app.pid;
  $('stop').disabled = !online || busy || !app.pid;
  $('restart').disabled = locked;
  const active = !['stopped', 'failed'].includes(app.status);
  $('edit').disabled = locked || active;
  $('edit-hint').hidden = !active;
  $('delete').disabled = locked;
}

function appendLogs(logs) {
  if (!logs.length) return;
  const rows = $('log-rows');
  const fragment = document.createDocumentFragment();
  for (const line of logs) {
    const row = el('div', 'log-line');
    row.append(el('span', 'log-time', clock.format(new Date(line.time))),
      el('span', `log-stream ${line.stream}`, line.stream), el('span', 'log-text', line.text));
    fragment.append(row);
    cursor = line.seq;
  }
  rows.append(fragment);
  while (rows.childElementCount > 250) rows.firstElementChild.remove();
  $('log-placeholder').hidden = true;
  if ($('follow').checked) $('viewport').scrollTop = $('viewport').scrollHeight;
}

function connection(isOnline, label) {
  online = isOnline;
  $('connection').classList.toggle('online', online);
  $('connection-label').textContent = label;
}

async function refresh() {
  const turn = ++revision;
  try {
    const data = await api('');
    if (turn !== revision) return;
    if (managerStartedAt !== data.startedAt) resetLogs();
    managerStartedAt = data.startedAt;
    apps = data.apps;
    if (!current()) select(apps[0]?.id ?? null);
    $('root').textContent = data.root;
    $('workspace').hidden = false;
    connection(true, 'Connected locally');
    message('notice', actionError);
    render();
    if (selected) {
      const { logs } = await api(`/${selected}/logs?after=${cursor}`);
      if (turn === revision) appendLogs(logs);
    }
  } catch (error) {
    if (turn !== revision) return;
    const needsPairing = error.message === pairingHint;
    if (needsPairing) $('workspace').hidden = true;
    connection(false, needsPairing ? 'Browser not paired' : 'Disconnected');
    message('notice', needsPairing ? pairingHint : `Cannot refresh the dashboard: ${error.message}`);
    render();
  }
}

async function mutate(fn, dialogId = null, errorId = null) {
  if (busy) return;
  busy = true;
  ++revision;
  actionError = '';
  message('notice', '');
  if (errorId) message(errorId, '');
  for (const id of ['save', 'confirm-delete', 'cancel-form', 'cancel-delete']) $(id).disabled = true;
  render();
  try {
    await fn();
    if (dialogId) $(dialogId).close();
  } catch (error) {
    if (errorId) message(errorId, error.message);
    else actionError = error.message;
  } finally {
    busy = false;
    for (const id of ['save', 'confirm-delete', 'cancel-form', 'cancel-delete']) $(id).disabled = false;
    await refresh();
  }
}

let editingId;
function openForm(app) {
  editingId = app?.id;
  $('app-form').reset();
  if (app) {
    for (const field of ['name', 'command', 'cwd', 'url']) $(field).value = app[field];
  }
  $('form-title').textContent = app ? 'Edit application' : 'Add application';
  $('save').textContent = app ? 'Save changes' : 'Add application';
  message('form-error', '');
  $('app-dialog').showModal();
}
$('add').onclick = $('first-add').onclick = () => openForm();
$('edit').onclick = () => openForm(current());
$('cancel-form').onclick = () => $('app-dialog').close();
$('app-form').onsubmit = event => {
  event.preventDefault();
  void mutate(async () => {
    const app = await api(editingId ? `/${editingId}` : '', editingId ? 'PUT' : 'POST', {
      name: $('name').value, command: $('command').value, cwd: $('cwd').value, url: $('url').value,
    });
    select(app.id);
  }, 'app-dialog', 'form-error');
};
for (const action of ['start', 'stop', 'restart']) {
  $(action).onclick = () => { void mutate(() => api(`/${selected}/${action}`, 'POST')); };
}
let deleteId;
$('delete').onclick = () => {
  deleteId = selected;
  $('delete-name').textContent = current().name;
  message('delete-error', '');
  $('delete-dialog').showModal();
};
$('cancel-delete').onclick = () => $('delete-dialog').close();
$('delete-form').onsubmit = event => {
  event.preventDefault();
  void mutate(() => api(`/${deleteId}`, 'DELETE'), 'delete-dialog', 'delete-error');
};
for (const dialog of document.querySelectorAll('dialog')) {
  dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
}
$('follow').onchange = () => {
  if ($('follow').checked) $('viewport').scrollTop = $('viewport').scrollHeight;
};
async function poll() {
  if (!busy) await refresh();
  setTimeout(poll, 1200);
}
async function initialize() {
  const code = new URLSearchParams(location.hash.slice(1)).get('pair');
  if (code !== null) {
    history.replaceState(null, '', location.pathname);
    try {
      const response = await fetch('/api/pair', {
        method: 'POST', headers: { Authorization: `Pair ${code}` }, cache: 'no-store', redirect: 'error',
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      localStorage.setItem(sessionKey, data.session);
    } catch (error) {
      connection(false, 'Pairing failed');
      message('notice', `${error.message} Open the bookmarked dashboard if this browser is already paired.`);
      return;
    }
  }
  void poll();
}
void initialize();
