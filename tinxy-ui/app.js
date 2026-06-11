/**
 * Dudu Life Control UI
 *
 * The browser never sees the Tinxy token. It authenticates with a shared
 * password (POST /auth/login → HttpOnly session cookie) and all device calls
 * go through this server's proxy at /api/v2/... which attaches the token.
 *
 * Toggle payload:  { request: { state: 0|1, brightness: 0-100 }, deviceNumber: N }
 * State response:  { state: "ON"|"OFF", brightness: number }
 */

'use strict';

const API_PREFIX  = '/api';          // proxy prefix → server forwards to backend.tinxy.in
const POLL_MS     = 10_000;          // base poll interval
const POLL_MAX_MS = 60_000;          // max interval after repeated failures (backoff)
const GROUPS_KEY  = 'dlc_groups';    // localStorage key for user-edited groups
const TOKEN_KEY   = 'tinxy_api_token'; // localStorage key for the saved API token

// ── DOM refs ──────────────────────────────────────────────────────────────────
const loginScreen  = document.getElementById('login-screen');
const loginForm    = document.getElementById('login-form');
const tokenInput   = document.getElementById('token-input');
const loginBtn     = document.getElementById('login-btn');
const loginError   = document.getElementById('login-error');

const dashScreen   = document.getElementById('dashboard-screen');
const logoutBtn    = document.getElementById('logout-btn');
const refreshBtn   = document.getElementById('refresh-btn');
const allOffBtn    = document.getElementById('all-off-btn');
const settingsBtn  = document.getElementById('settings-btn');
const loadingState = document.getElementById('loading-state');
const errorState   = document.getElementById('error-state');
const errorText    = document.getElementById('error-text');
const retryBtn     = document.getElementById('retry-btn');
const devicesGrid  = document.getElementById('devices-grid');
const statusBar    = document.getElementById('status-bar');
const statusMsg    = document.getElementById('status-msg');
const liveBadge    = document.getElementById('live-badge');
const lastUpdated  = document.getElementById('last-updated');

const settingsModal = document.getElementById('settings-modal');
const settingsClose = document.getElementById('settings-close-btn');
const settingsCancel= document.getElementById('settings-cancel-btn');
const settingsSave  = document.getElementById('settings-save-btn');
const settingsReset = document.getElementById('settings-reset-btn');
const addGroupBtn   = document.getElementById('add-group-btn');
const groupsEditor  = document.getElementById('groups-editor');
const knownDevices  = document.getElementById('known-devices');

const deviceCardTpl = document.getElementById('device-card-tpl');
const nodeRowTpl    = document.getElementById('node-row-tpl');

// ── Runtime state ───────────────────────────────────────────────────────────
let apiToken     = '';                       // the user's Tinxy token (kept in localStorage)
let pollTimer    = null;
let pollInterval = POLL_MS;
let lastSyncAt   = 0;
let tickTimer    = null;
let lastDevices  = [];                       // for the groups editor hints

// All controllable nodes, keyed by "deviceId:nodeNumber".
const controllers = [];
const byKey = new Map();

// ── Default device groups ─────────────────────────────────────────────────────
const DEFAULT_GROUPS = [
  { groupName: 'Sachin Room',      match: ['Sachin Room', 'Laptop', 'AC', 'Gyser', 'Mac Mini', '🔌 Mac Mini'] },
  { groupName: 'Living Room',      match: ['Living Room'] },
  { groupName: 'GF Motor & FF AC', match: ['GF motor', 'FF AC'] },
];

function loadGroups() {
  try {
    const raw = JSON.parse(localStorage.getItem(GROUPS_KEY));
    if (Array.isArray(raw)) return raw;
  } catch { /* fall through to defaults */ }
  return DEFAULT_GROUPS.map(g => ({ groupName: g.groupName, match: [...g.match] }));
}
function saveGroups(groups) {
  localStorage.setItem(GROUPS_KEY, JSON.stringify(groups));
}

// Exact (trimmed, case-insensitive) name match — predictable, no accidental
// substring hits like "AC" matching "Machine".
function deviceMatchesGroup(deviceName, group) {
  const name = (deviceName || '').trim().toLowerCase();
  return group.match.some(keyword => keyword.trim().toLowerCase() === name);
}

// ── API helper ─────────────────────────────────────────────────────────────
async function tinxyFetch(path, options = {}) {
  if (!apiToken) throw new Error('No API token configured.');

  const res = await fetch(`${API_PREFIX}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiToken}`,
      ...(options.headers || {}),
    },
  }).catch(() => { throw new Error('Network error: unable to reach the server.'); });

  if (res.status === 401 || res.status === 403) {
    handleUnauthorized();
    throw new Error('Invalid or expired API token. Please re-enter it.');
  }
  if (!res.ok) {
    let msg = `Request failed (HTTP ${res.status}).`;
    try { const j = await res.json(); if (j && j.error) msg = j.error; } catch { /* keep default */ }
    throw new Error(msg);
  }
  const data = await res.json().catch(() => { throw new Error('Invalid response from server.'); });
  if (typeof data !== 'object' || data === null) throw new Error('Unexpected response format.');
  return data;
}

/** Parse the state field — API returns "ON"/"OFF" strings or 1/0 numbers. */
function parseIsOn(state) {
  if (typeof state === 'string') return state.toUpperCase() === 'ON';
  return state === 1 || state === true;
}

// ── Status overlay ────────────────────────────────────────────────────────────
function showStatus(msg, ms = 3500) {
  statusMsg.textContent = msg;
  statusBar.classList.remove('hidden');
  clearTimeout(showStatus._t);
  showStatus._t = setTimeout(() => statusBar.classList.add('hidden'), ms);
}

function setView(view) {
  loadingState.classList.toggle('hidden', view !== 'loading');
  errorState.classList.toggle('hidden',   view !== 'error');
  devicesGrid.classList.toggle('hidden',  view !== 'grid');
}

// ── "Last updated" ticker ──────────────────────────────────────────────────────
function markSynced() {
  lastSyncAt = Date.now();
  renderLastUpdated();
}
function renderLastUpdated() {
  if (!lastSyncAt) { lastUpdated.textContent = ''; return; }
  const secs = Math.round((Date.now() - lastSyncAt) / 1000);
  lastUpdated.textContent =
    secs < 5 ? 'Updated just now' :
    secs < 60 ? `Updated ${secs}s ago` :
    `Updated ${Math.round(secs / 60)}m ago`;
}

// ── Polling (with backoff) ─────────────────────────────────────────────────────
function startPolling() {
  stopPolling();
  liveBadge.classList.remove('hidden');
  scheduleNextPoll();
  tickTimer = setInterval(renderLastUpdated, 5000);
}
function stopPolling() {
  clearTimeout(pollTimer);
  clearInterval(tickTimer);
  pollTimer = null;
  tickTimer = null;
  pollInterval = POLL_MS;
  liveBadge.classList.add('hidden');
}
function scheduleNextPoll() {
  pollTimer = setTimeout(async () => {
    await pollAllStates();
    scheduleNextPoll();
  }, pollInterval);
}

async function pollAllStates() {
  if (controllers.length === 0) return;
  const results = await Promise.allSettled(controllers.map(c => c.sync()));
  const anyOk = results.some(r => r.status === 'fulfilled' && r.value === true);

  if (anyOk) {
    pollInterval = POLL_MS;          // healthy → reset cadence
    markSynced();
  } else {
    // Everything failed (likely the network/server) → back off, capped.
    pollInterval = Math.min(pollInterval * 2, POLL_MAX_MS);
  }
}

// ── Auth ──────────────────────────────────────────────────────────────────────
function showLoginError(msg) {
  loginError.textContent = msg;
  loginError.classList.remove('hidden');
}
function hideLoginError() { loginError.classList.add('hidden'); }

function saveToken(t) { apiToken = t; localStorage.setItem(TOKEN_KEY, t); }
function clearToken() { apiToken = ''; localStorage.removeItem(TOKEN_KEY); }
function loadToken()  { return localStorage.getItem(TOKEN_KEY) || ''; }

// Validate a token by hitting the devices endpoint; throws on bad token.
async function validateToken(token) {
  apiToken = token;                                  // tinxyFetch reads this
  try {
    await tinxyFetch('/v2/devices/');
  } catch (err) {
    apiToken = '';
    throw err;
  }
}

function handleUnauthorized() {
  // Called when a proxied request returns 401/403 — the saved token is bad.
  clearToken();
  showLoginScreen();
}

function showLoginScreen() {
  stopPolling();
  clearControllers();
  closeSettings();
  dashScreen.classList.add('hidden');
  loginScreen.classList.remove('hidden');
  tokenInput.value = '';
  hideLoginError();
  window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
  tokenInput.focus();
}

function showDashboard() {
  loginScreen.classList.add('hidden');
  dashScreen.classList.remove('hidden');
  window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
  loadDevices();
}

// ── Device metadata helpers ────────────────────────────────────────────────────
function getNodeCount(device) {
  if (Array.isArray(device.devices) && device.devices.length > 0)
    return device.devices.length;
  return device.typeId?.numberOfRelays || device.deviceTypes?.length || 1;
}

function getNodeName(device, idx) {
  if (Array.isArray(device.devices) && device.devices[idx])
    return device.devices[idx];
  if (getNodeCount(device) === 1 && device.name)
    return device.name;
  return `Switch ${idx + 1}`;
}

function isFanNode(device, idx) {
  const feature = device.typeId?.features?.[idx] ?? '';
  const dtype   = device.deviceTypes?.[idx] ?? '';
  return feature.includes('FAN') || dtype.toLowerCase() === 'fan';
}

function nodeIcon(device, idx) {
  const dtype = (device.deviceTypes?.[idx] ?? '').toLowerCase();
  if (dtype.includes('fan'))    return '🌀';
  if (dtype.includes('socket')) return '🔌';
  if (dtype.includes('heater')) return '🔆';
  return '💡';
}

// ── Controller registry ────────────────────────────────────────────────────────
function clearControllers() {
  controllers.length = 0;
  byKey.clear();
}

// ── Load devices ────────────────────────────────────────────────────────────────
async function loadDevices() {
  stopPolling();
  clearControllers();
  setView('loading');
  devicesGrid.innerHTML = '';

  let devices;
  try { devices = await tinxyFetch('/v2/devices/'); }
  catch (err) {
    if (/Invalid or expired API token/i.test(err.message)) return; // handleUnauthorized already fired
    errorText.textContent = err.message;
    setView('error');
    return;
  }

  lastDevices = Array.isArray(devices) ? devices : [];

  if (!Array.isArray(devices) || devices.length === 0) {
    setView('grid');
    devicesGrid.innerHTML = `
      <div class="empty-state">
        <span class="empty-state-icon">💡</span>
        <p>No devices found on this account.</p>
      </div>`;
    return;
  }

  setView('grid');

  const groups = loadGroups();
  const renderedIds = new Set();

  for (const group of groups) {
    const members = devices.filter(d => deviceMatchesGroup(d.name || '', group));
    if (members.length > 0) {
      members.forEach(d => renderedIds.add(d._id));
      devicesGrid.appendChild(buildCard(group.groupName, members).el);
    }
  }

  for (const device of devices) {
    if (!renderedIds.has(device._id)) {
      devicesGrid.appendChild(buildCard(device.name || 'Unnamed Device', [device]).el);
    }
  }

  startPolling();
  markSynced();
}

// ── Card builder (handles single device OR a merged group) ─────────────────────
function buildCard(title, deviceList) {
  const frag = deviceCardTpl.content.cloneNode(true);
  const el   = frag.querySelector('.device-card');

  el.querySelector('.device-name').textContent = title;

  // Card icon from the first device's first node type.
  el.querySelector('.device-icon').textContent = nodeIcon(deviceList[0], 0);

  const badge = el.querySelector('.device-badge');
  badge.textContent = '…';
  badge.className   = 'device-badge loading';

  const master    = el.querySelector('.card-master');
  const container = el.querySelector('.device-nodes');

  const card = { el, badge, master, nodes: [], refresh: null };

  card.refresh = function () {
    const states  = card.nodes.map(n => n.isOn);
    const total   = states.length;
    const onCount = states.filter(Boolean).length;
    el.classList.toggle('card-on', onCount > 0);
    master.classList.toggle('on', onCount > 0);
    if (total === 1) {
      badge.textContent = states[0] ? 'ON' : 'OFF';
      badge.className   = `device-badge ${states[0] ? 'on' : 'off'}`;
    } else {
      badge.textContent = onCount > 0 ? `${onCount}/${total} ON` : 'ALL OFF';
      badge.className   = `device-badge ${onCount > 0 ? 'on' : 'off'}`;
    }
  };

  // Node count summary under the title.
  let totalNodes = 0;
  for (const device of deviceList) {
    const nodeCount = getNodeCount(device);
    totalNodes += nodeCount;
    for (let i = 0; i < nodeCount; i++) {
      const ctrl = isFanNode(device, i)
        ? buildFanRow(device, i, card)
        : buildSwitchRow(device, i, card);
      container.appendChild(ctrl.row);
      card.nodes.push(ctrl);
    }
  }
  el.querySelector('.device-type').textContent =
    `${totalNodes} ${totalNodes === 1 ? 'control' : 'controls'}`;

  // Master toggle: if anything is on, turn all off; otherwise turn all on.
  master.addEventListener('click', async () => {
    if (master.classList.contains('loading')) return;
    const anyOn  = card.nodes.some(n => n.isOn);
    const target = !anyOn;
    master.classList.add('loading');
    try {
      await Promise.allSettled(card.nodes.map(n => n.setOn(target)));
      showStatus(`${title}: all ${target ? 'ON' : 'OFF'}`);
    } finally {
      master.classList.remove('loading');
    }
  });

  card.refresh();
  return card;
}

// ── Shared controller factory ──────────────────────────────────────────────────
function registerController(ctrl) {
  controllers.push(ctrl);
  byKey.set(ctrl.key, ctrl);
}

function setOffline(ctrl, offline) {
  ctrl.unreachable = offline;
  ctrl.offlineEl?.classList.toggle('hidden', !offline);
  ctrl.row.classList.toggle('node-offline-state', offline);
}

// ── Switch row ──────────────────────────────────────────────────────────────────
function buildSwitchRow(device, idx, card) {
  const frag   = nodeRowTpl.content.cloneNode(true);
  const row    = frag.querySelector('.node-row');
  const dot    = row.querySelector('.node-state-dot');
  const toggle = row.querySelector('.toggle-btn');
  const offlineEl = row.querySelector('.node-offline');
  const name   = getNodeName(device, idx);

  row.querySelector('.node-label').textContent = `${nodeIcon(device, idx)} ${name}`;
  toggle.setAttribute('aria-label', `Toggle ${name}`);

  const ctrl = {
    key: `${device._id}:${idx + 1}`,
    deviceId: device._id,
    nodeNumber: idx + 1,
    name,
    isOn: false,
    inFlight: false,
    unreachable: false,
    row, offlineEl,
  };

  function render() {
    toggle.classList.toggle('on', ctrl.isOn);
    toggle.setAttribute('aria-checked', String(ctrl.isOn));
    dot.classList.toggle('on', ctrl.isOn);
    row.classList.toggle('node-on', ctrl.isOn);
    card.refresh();
  }

  // Apply state that came from the server (poll / initial fetch).
  ctrl.applyRemote = function (isOn) {
    if (ctrl.inFlight) return;             // don't clobber an in-flight toggle
    ctrl.isOn = isOn;
    render();
  };

  // Send a desired state to the device.
  ctrl.setOn = async function (target) {
    if (ctrl.isOn === target) return;
    return sendToggle(ctrl, toggle, { state: target ? 1 : 0, brightness: 0 }, () => {
      ctrl.isOn = target;
      render();
    });
  };

  // Fetch current state; returns true on success.
  ctrl.sync = async function () {
    try {
      const data = await tinxyFetch(`/v2/devices/${ctrl.deviceId}/state?deviceNumber=${ctrl.nodeNumber}`);
      setOffline(ctrl, false);
      ctrl.applyRemote(parseIsOn(data.state));
      return true;
    } catch {
      setOffline(ctrl, true);
      return false;
    }
  };

  toggle.addEventListener('click', () => {
    if (ctrl.inFlight) return;
    const target = !ctrl.isOn;
    sendToggle(ctrl, toggle, { state: target ? 1 : 0, brightness: 0 }, () => {
      ctrl.isOn = target;
      render();
      showStatus(`${name}: ${target ? 'ON ✓' : 'OFF ✓'}`);
    });
  });

  registerController(ctrl);
  ctrl.sync();
  return ctrl;
}

// Shared toggle POST with in-flight guard + button loading state.
async function sendToggle(ctrl, btnEl, request, onOk) {
  ctrl.inFlight = true;
  btnEl?.classList.add('loading');
  try {
    const data = await tinxyFetch(`/v2/devices/${ctrl.deviceId}/toggle`, {
      method: 'POST',
      body: JSON.stringify({ request, deviceNumber: ctrl.nodeNumber }),
    });
    setOffline(ctrl, false);
    onOk(data);
  } catch (err) {
    if (!/Invalid or expired API token/i.test(err.message))
      showStatus(`${ctrl.name}: ${err.message}`, 5000);
    throw err;
  } finally {
    ctrl.inFlight = false;
    btnEl?.classList.remove('loading');
  }
}

// ── Fan row ──────────────────────────────────────────────────────────────────────
const FAN_SPEEDS = [
  { label: 'Off',  state: 0, brightness: 0   },
  { label: 'Low',  state: 1, brightness: 33  },
  { label: 'Med',  state: 1, brightness: 66  },
  { label: 'High', state: 1, brightness: 100 },
];

function brightnessToSpeed(isOn, brightness) {
  if (!isOn || brightness === 0) return 0;
  if (brightness <= 40) return 1;
  if (brightness <= 75) return 2;
  return 3;
}

function buildFanRow(device, idx, card) {
  const row = document.createElement('div');
  row.className = 'node-row fan-row';
  const name = getNodeName(device, idx);

  const info        = document.createElement('div');
  info.className    = 'node-info fan-info';
  const dot         = document.createElement('span');
  dot.className     = 'node-state-dot';
  const label       = document.createElement('span');
  label.className   = 'node-label';
  label.textContent = `🌀 ${name}`;
  const offlineEl   = document.createElement('span');
  offlineEl.className = 'node-offline hidden';
  offlineEl.title   = 'Device unreachable';
  offlineEl.textContent = 'offline';
  const speedLabel  = document.createElement('span');
  speedLabel.className = 'fan-speed-label';
  speedLabel.textContent = '–';
  info.append(dot, label, offlineEl, speedLabel);

  const btns = document.createElement('div');
  btns.className = 'fan-speed-btns';
  btns.setAttribute('role', 'radiogroup');
  btns.setAttribute('aria-label', `${name} speed`);

  const ctrl = {
    key: `${device._id}:${idx + 1}`,
    deviceId: device._id,
    nodeNumber: idx + 1,
    name,
    isOn: false,
    speed: 0,
    inFlight: false,
    unreachable: false,
    row, offlineEl,
  };

  function render() {
    dot.classList.toggle('on', ctrl.isOn);
    row.classList.toggle('node-on', ctrl.isOn);
    speedLabel.textContent = FAN_SPEEDS[ctrl.speed].label;
    speedLabel.className    = `fan-speed-label ${ctrl.isOn ? 'on' : ''}`;
    btns.querySelectorAll('.fan-speed-btn').forEach((b, i) => {
      b.classList.toggle('active', i === ctrl.speed);
      b.setAttribute('aria-checked', String(i === ctrl.speed));
    });
    card.refresh();
  }

  ctrl.applyRemote = function (isOn, brightness) {
    if (ctrl.inFlight) return;
    ctrl.isOn  = isOn;
    ctrl.speed = brightnessToSpeed(isOn, brightness);
    render();
  };

  ctrl.setOn = async function (target) {
    if (ctrl.isOn === target) return;
    const sp = target ? 3 : 0;                       // master-on → High
    const { state, brightness } = FAN_SPEEDS[sp];
    return sendToggle(ctrl, null, { state, brightness }, () => {
      ctrl.isOn  = state === 1;
      ctrl.speed = sp;
      render();
    });
  };

  ctrl.sync = async function () {
    try {
      const data = await tinxyFetch(`/v2/devices/${ctrl.deviceId}/state?deviceNumber=${ctrl.nodeNumber}`);
      setOffline(ctrl, false);
      ctrl.applyRemote(parseIsOn(data.state), data.brightness ?? 0);
      return true;
    } catch {
      setOffline(ctrl, true);
      return false;
    }
  };

  FAN_SPEEDS.forEach(({ label: spLabel, state, brightness }, i) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'fan-speed-btn';
    btn.textContent = spLabel;
    btn.setAttribute('role', 'radio');
    btn.setAttribute('aria-checked', 'false');
    btn.setAttribute('aria-label', `${name}: ${spLabel}`);

    btn.addEventListener('click', () => {
      if (ctrl.inFlight) return;
      btns.querySelectorAll('.fan-speed-btn').forEach(b => b.disabled = true);
      sendToggle(ctrl, null, { state, brightness }, () => {
        ctrl.isOn  = state === 1;
        ctrl.speed = i;
        render();
        showStatus(`${name}: ${spLabel}`);
      }).finally(() => {
        btns.querySelectorAll('.fan-speed-btn').forEach(b => b.disabled = false);
      });
    });

    btns.appendChild(btn);
  });

  row.append(info, btns);

  registerController(ctrl);
  ctrl.sync();
  return ctrl;
}

// ── Global "All Off" ────────────────────────────────────────────────────────────
async function allOff() {
  const on = controllers.filter(c => c.isOn);
  if (on.length === 0) { showStatus('Everything is already off.'); return; }
  allOffBtn.disabled = true;
  const original = allOffBtn.textContent;
  allOffBtn.textContent = 'Turning off…';
  try {
    await Promise.allSettled(on.map(c => c.setOn(false)));
    showStatus(`Turned off ${on.length} device${on.length === 1 ? '' : 's'}.`);
  } finally {
    allOffBtn.disabled = false;
    allOffBtn.textContent = original;
  }
}

// ── Settings: device groups editor ──────────────────────────────────────────────
function openSettings() {
  renderGroupsEditor(loadGroups());
  renderKnownDevices();
  settingsModal.classList.remove('hidden');
}
function closeSettings() {
  settingsModal.classList.add('hidden');
}

function renderKnownDevices() {
  const names = lastDevices.map(d => d.name).filter(Boolean);
  if (names.length === 0) { knownDevices.innerHTML = ''; return; }
  knownDevices.innerHTML =
    `<span class="known-label">Your devices:</span> ` +
    names.map(n => `<button type="button" class="known-chip">${escapeHtml(n)}</button>`).join(' ');
  knownDevices.querySelectorAll('.known-chip').forEach(chip => {
    chip.addEventListener('click', () => navigator.clipboard?.writeText(chip.textContent).then(
      () => showStatus(`Copied "${chip.textContent}"`),
      () => {},
    ));
  });
}

function renderGroupsEditor(groups) {
  groupsEditor.innerHTML = '';
  groups.forEach(g => groupsEditor.appendChild(groupRow(g.groupName, g.match.join(', '))));
}

function groupRow(groupName = '', matchCsv = '') {
  const row = document.createElement('div');
  row.className = 'group-row';
  row.innerHTML = `
    <input class="group-name" type="text" placeholder="Group name" />
    <input class="group-match" type="text" placeholder="Device names, comma-separated" />
    <button type="button" class="btn btn-icon group-remove" aria-label="Remove group">&times;</button>`;
  row.querySelector('.group-name').value  = groupName;
  row.querySelector('.group-match').value = matchCsv;
  row.querySelector('.group-remove').addEventListener('click', () => row.remove());
  return row;
}

function readGroupsEditor() {
  const out = [];
  groupsEditor.querySelectorAll('.group-row').forEach(row => {
    const name  = row.querySelector('.group-name').value.trim();
    const match = row.querySelector('.group-match').value
      .split(',').map(s => s.trim()).filter(Boolean);
    if (name && match.length) out.push({ groupName: name, match });
  });
  return out;
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// ── Events ───────────────────────────────────────────────────────────────────────
loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const token = tokenInput.value.trim();
  if (!token) { showLoginError('Please paste your API token.'); return; }
  hideLoginError();
  loginBtn.textContent = 'Connecting…';
  loginBtn.disabled = true;
  try {
    await validateToken(token);   // throws if the token is rejected
    saveToken(token);
    showDashboard();
  } catch (err) {
    showLoginError(err.message);
  } finally {
    loginBtn.textContent = 'Connect';
    loginBtn.disabled = false;
  }
});

logoutBtn.addEventListener('click', () => {
  clearToken();
  showLoginScreen();
});

refreshBtn.addEventListener('click', loadDevices);
retryBtn.addEventListener('click', loadDevices);
allOffBtn.addEventListener('click', allOff);

settingsBtn.addEventListener('click', openSettings);
settingsClose.addEventListener('click', closeSettings);
settingsCancel.addEventListener('click', closeSettings);
settingsModal.addEventListener('click', (e) => { if (e.target === settingsModal) closeSettings(); });
addGroupBtn.addEventListener('click', () => groupsEditor.appendChild(groupRow()));
settingsReset.addEventListener('click', () => renderGroupsEditor(
  DEFAULT_GROUPS.map(g => ({ groupName: g.groupName, match: [...g.match] }))
));
settingsSave.addEventListener('click', () => {
  saveGroups(readGroupsEditor());
  closeSettings();
  loadDevices();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !settingsModal.classList.contains('hidden')) closeSettings();
});

// Pause polling when tab is hidden; refresh immediately when it returns.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    stopPolling();
  } else if (!dashScreen.classList.contains('hidden') && controllers.length) {
    startPolling();
    pollAllStates();
  }
});

// ── Service worker (PWA) ──────────────────────────────────────────────────────────
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => { /* offline support is best-effort */ });
  });
}

// ── Init ──────────────────────────────────────────────────────────────────────────
(function init() {
  const saved = loadToken();
  if (saved) {
    // Trust the saved token and go straight in; loadDevices() will bounce back
    // to the token screen if it turns out to be invalid.
    apiToken = saved;
    showDashboard();
  } else {
    showLoginScreen();
  }
})();
