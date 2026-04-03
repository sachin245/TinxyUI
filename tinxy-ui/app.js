/**
 * Tinxy Light Control UI
 * API base: https://backend.tinxy.in
 *
 * Toggle response: { state: "ON"|"OFF", brightness: number }
 * State response:  { state: "ON"|"OFF", brightness: number }
 * Toggle payload:  { request: { state: 0|1, brightness: 0-3 }, deviceNumber: N }
 */

'use strict';

const API_BASE    = 'https://backend.tinxy.in';
const TOKEN_KEY   = 'tinxy_api_token';
const POLL_MS     = 10_000; // poll every 10 s

// ── DOM refs ──────────────────────────────────────────────────────────────────
const tokenScreen  = document.getElementById('token-screen');
const dashScreen   = document.getElementById('dashboard-screen');
const tokenInput   = document.getElementById('token-input');
const connectBtn   = document.getElementById('connect-btn');
const tokenError   = document.getElementById('token-error');
const logoutBtn    = document.getElementById('logout-btn');
const refreshBtn   = document.getElementById('refresh-btn');
const loadingState = document.getElementById('loading-state');
const errorState   = document.getElementById('error-state');
const errorText    = document.getElementById('error-text');
const retryBtn     = document.getElementById('retry-btn');
const devicesGrid  = document.getElementById('devices-grid');
const statusBar    = document.getElementById('status-bar');
const statusMsg    = document.getElementById('status-msg');
const liveBadge    = document.getElementById('live-badge');

const deviceCardTpl = document.getElementById('device-card-tpl');
const nodeRowTpl    = document.getElementById('node-row-tpl');

let apiToken  = '';
let pollTimer = null;

// ── State registry ────────────────────────────────────────────────────────────
// Maps "deviceId:nodeNumber" → function(isOn: bool, brightness: number)
const stateRegistry = new Map();

function registerNode(deviceId, nodeNumber, updateFn) {
  stateRegistry.set(`${deviceId}:${nodeNumber}`, updateFn);
}
function clearRegistry() {
  stateRegistry.clear();
}

// ── API helper ────────────────────────────────────────────────────────────────
async function tinxyFetch(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiToken}`,
      ...(options.headers || {}),
    },
  }).catch(err => { throw new Error(`Network error: ${err.message}`); });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    if (res.status === 401 || res.status === 403)
      throw new Error('Invalid or expired API token. Please logout and re-enter.');
    throw new Error(`API error ${res.status}: ${body || res.statusText}`);
  }
  return res.json();
}

/** Parse the state field — API returns "ON"/"OFF" strings or 1/0 numbers */
function parseIsOn(state) {
  if (typeof state === 'string') return state.toUpperCase() === 'ON';
  return state === 1 || state === true;
}

// ── Status bar ────────────────────────────────────────────────────────────────
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

// ── Polling ───────────────────────────────────────────────────────────────────
function startPolling() {
  stopPolling();
  liveBadge.classList.remove('hidden');
  pollTimer = setInterval(pollAllStates, POLL_MS);
}

function stopPolling() {
  clearInterval(pollTimer);
  pollTimer = null;
  liveBadge.classList.add('hidden');
}

async function pollAllStates() {
  // Fire all state fetches concurrently
  const requests = [...stateRegistry.entries()].map(async ([key, updateFn]) => {
    const [deviceId, nodeNumberStr] = key.split(':');
    try {
      const data = await tinxyFetch(
        `/v2/devices/${deviceId}/state?deviceNumber=${nodeNumberStr}`
      );
      updateFn(parseIsOn(data.state), data.brightness ?? 0);
    } catch { /* silent — device may be offline */ }
  });
  await Promise.allSettled(requests);
}

// ── Auth ──────────────────────────────────────────────────────────────────────
function saveToken(t)  { apiToken = t; localStorage.setItem(TOKEN_KEY, t); }
function clearToken()  { apiToken = ''; localStorage.removeItem(TOKEN_KEY); }

function showTokenError(msg) {
  tokenError.textContent = msg;
  tokenError.classList.remove('hidden');
}
function hideTokenError() { tokenError.classList.add('hidden'); }

function switchToTokenScreen() {
  stopPolling();
  clearRegistry();
  dashScreen.classList.add('hidden');
  tokenScreen.classList.remove('hidden');
  tokenInput.value = '';
  hideTokenError();
}

function switchToDashboard() {
  tokenScreen.classList.add('hidden');
  dashScreen.classList.remove('hidden');
  loadDevices();
}

// ── Device helpers ────────────────────────────────────────────────────────────
function getNodeCount(device) {
  if (Array.isArray(device.devices) && device.devices.length > 0)
    return device.devices.length;
  return device.typeId?.numberOfRelays || device.deviceTypes?.length || 1;
}

function getNodeName(device, idx) {
  return (Array.isArray(device.devices) && device.devices[idx])
    ? device.devices[idx]
    : `Switch ${idx + 1}`;
}

function isFanNode(device, idx) {
  const feature = device.typeId?.features?.[idx] ?? '';
  const dtype   = device.deviceTypes?.[idx] ?? '';
  return feature.includes('FAN') || dtype.toLowerCase() === 'fan';
}

function nodeIcon(device, idx) {
  const dtype = (device.deviceTypes?.[idx] ?? '').toLowerCase();
  if (dtype.includes('fan'))                              return '🌀';
  if (dtype.includes('tubelight') || dtype.includes('tube')) return '💡';
  if (dtype.includes('led') || dtype.includes('bulb'))    return '💡';
  if (dtype.includes('socket'))                           return '🔌';
  if (dtype.includes('heater'))                           return '🔆';
  return '💡';
}

// ── Load devices ──────────────────────────────────────────────────────────────
async function loadDevices() {
  stopPolling();
  clearRegistry();
  setView('loading');
  devicesGrid.innerHTML = '';

  let devices;
  try { devices = await tinxyFetch('/v2/devices/'); }
  catch (err) {
    if (err.message.includes('Invalid or expired')) {
      clearToken(); switchToTokenScreen(); return;
    }
    errorText.textContent = err.message;
    setView('error');
    return;
  }

  if (!Array.isArray(devices) || devices.length === 0) {
    setView('grid');
    devicesGrid.innerHTML = `
      <div class="empty-state">
        <span style="font-size:2rem">💡</span>
        <p>No devices found on this account.</p>
      </div>`;
    return;
  }

  setView('grid');
  for (const device of devices) {
    devicesGrid.appendChild(buildDeviceCard(device));
  }

  startPolling();
}

// ── Build device card ─────────────────────────────────────────────────────────
function buildDeviceCard(device) {
  const frag = deviceCardTpl.content.cloneNode(true);
  const card = frag.querySelector('.device-card');

  card.dataset.deviceId = device._id;
  card.querySelector('.device-name').textContent = device.name || 'Unnamed Device';
  card.querySelector('.device-type').textContent =
    device.typeId?.long_name || device.typeId?.name || 'Switch';

  const badge       = card.querySelector('.device-badge');
  badge.textContent = '…';
  badge.className   = 'device-badge loading';

  const container  = card.querySelector('.device-nodes');
  const nodeCount  = getNodeCount(device);
  const nodeStates = new Array(nodeCount).fill(false);

  function refreshCard() {
    card.classList.toggle('card-on', nodeStates.some(Boolean));
    const onCount = nodeStates.filter(Boolean).length;
    if (nodeCount === 1) {
      badge.textContent = nodeStates[0] ? 'ON' : 'OFF';
      badge.className   = `device-badge ${nodeStates[0] ? 'on' : 'off'}`;
    } else {
      badge.textContent = onCount > 0 ? `${onCount}/${nodeCount} ON` : 'ALL OFF';
      badge.className   = `device-badge ${onCount > 0 ? 'on' : 'off'}`;
    }
  }

  for (let i = 0; i < nodeCount; i++) {
    const row = isFanNode(device, i)
      ? buildFanRow(device, i, nodeStates, refreshCard)
      : buildSwitchRow(device, i, nodeStates, refreshCard);
    container.appendChild(row);
  }

  return card;
}

// ── Switch row ────────────────────────────────────────────────────────────────
function buildSwitchRow(device, idx, nodeStates, refreshCard) {
  const frag   = nodeRowTpl.content.cloneNode(true);
  const row    = frag.querySelector('.node-row');
  const dot    = row.querySelector('.node-state-dot');
  const toggle = row.querySelector('.toggle-btn');

  row.querySelector('.node-label').textContent =
    `${nodeIcon(device, idx)} ${getNodeName(device, idx)}`;

  let isOn = false;

  function applyState(newIsOn) {
    isOn = newIsOn;
    toggle.classList.toggle('on', isOn);
    dot.classList.toggle('on', isOn);
    row.classList.toggle('node-on', isOn);
    nodeStates[idx] = isOn;
    refreshCard();
  }

  // Register for polling
  registerNode(device._id, idx + 1, (newIsOn) => applyState(newIsOn));

  // Initial fetch
  (async () => {
    try {
      const data = await tinxyFetch(
        `/v2/devices/${device._id}/state?deviceNumber=${idx + 1}`
      );
      applyState(parseIsOn(data.state));
    } catch { /* leave as off */ }
  })();

  // Toggle click
  toggle.addEventListener('click', async () => {
    if (toggle.classList.contains('loading')) return;
    const target = isOn ? 0 : 1;
    toggle.classList.add('loading');
    try {
      const data = await tinxyFetch(`/v2/devices/${device._id}/toggle`, {
        method: 'POST',
        body: JSON.stringify({
          request: { state: target, brightness: 0 },
          deviceNumber: idx + 1,
        }),
      });
      // Use response state if available, fall back to target
      applyState(data?.state !== undefined ? parseIsOn(data.state) : target === 1);
      showStatus(`${getNodeName(device, idx)}: ${isOn ? 'ON ✓' : 'OFF ✓'}`);
    } catch (err) {
      showStatus(`Toggle failed: ${err.message}`, 5000);
    } finally {
      toggle.classList.remove('loading');
    }
  });

  return row;
}

// ── Fan row ───────────────────────────────────────────────────────────────────
const FAN_SPEEDS = [
  { label: 'Off',  state: 0, brightness: 0   },
  { label: 'Low',  state: 1, brightness: 33  },
  { label: 'Med',  state: 1, brightness: 66  },
  { label: 'High', state: 1, brightness: 100 },
];

/**
 * Map brightness value to speed index 0-3.
 * Both toggle and state API use percentages: 33=Low, 66=Med, 100=High.
 */
function brightnessToSpeed(isOn, brightness) {
  if (!isOn || brightness === 0) return 0;
  if (brightness <= 40)  return 1;                // ~33%
  if (brightness <= 75)  return 2;                // ~66%
  return 3;                                        // ~100%
}

function buildFanRow(device, idx, nodeStates, refreshCard) {
  const row = document.createElement('div');
  row.className = 'node-row fan-row';

  const info       = document.createElement('div');
  info.className   = 'node-info fan-info';
  const dot        = document.createElement('span');
  dot.className    = 'node-state-dot';
  const label      = document.createElement('span');
  label.className  = 'node-label';
  label.textContent = `🌀 ${getNodeName(device, idx)}`;
  const speedLabel = document.createElement('span');
  speedLabel.className = 'fan-speed-label';
  speedLabel.textContent = '–';
  info.append(dot, label, speedLabel);

  const btns = document.createElement('div');
  btns.className = 'fan-speed-btns';

  let currentSpeed = 0;

  function applyFanState(isOn, brightness) {
    currentSpeed = brightnessToSpeed(isOn, brightness);
    dot.classList.toggle('on', isOn);
    row.classList.toggle('node-on', isOn);
    nodeStates[idx] = isOn;
    refreshCard();
    speedLabel.textContent = FAN_SPEEDS[currentSpeed].label;
    speedLabel.className   = `fan-speed-label ${isOn ? 'on' : ''}`;
    btns.querySelectorAll('.fan-speed-btn').forEach((b, i) => {
      b.classList.toggle('active', i === currentSpeed);
    });
  }

  // Register for polling
  registerNode(device._id, idx + 1, (isOn, brightness) => applyFanState(isOn, brightness));

  FAN_SPEEDS.forEach(({ label: spLabel, state, brightness }, i) => {
    const btn = document.createElement('button');
    btn.className = 'fan-speed-btn';
    btn.textContent = spLabel;

    btn.addEventListener('click', async () => {
      if (btn.disabled) return;
      btns.querySelectorAll('.fan-speed-btn').forEach(b => b.disabled = true);
      try {
        await tinxyFetch(`/v2/devices/${device._id}/toggle`, {
          method: 'POST',
          body: JSON.stringify({
            request: { state, brightness },
            deviceNumber: idx + 1,
          }),
        });
        applyFanState(state === 1, brightness);
        showStatus(`${getNodeName(device, idx)}: ${spLabel}`);
      } catch (err) {
        showStatus(`Fan control failed: ${err.message}`, 5000);
      } finally {
        btns.querySelectorAll('.fan-speed-btn').forEach(b => b.disabled = false);
      }
    });

    btns.appendChild(btn);
  });

  row.append(info, btns);

  // Initial fetch
  (async () => {
    try {
      const data = await tinxyFetch(
        `/v2/devices/${device._id}/state?deviceNumber=${idx + 1}`
      );
      applyFanState(parseIsOn(data.state), data.brightness ?? 0);
    } catch { applyFanState(false, 0); }
  })();

  return row;
}

// ── Events ────────────────────────────────────────────────────────────────────
connectBtn.addEventListener('click', async () => {
  const token = tokenInput.value.trim();
  if (!token) { showTokenError('Please enter your API token.'); return; }
  hideTokenError();
  connectBtn.textContent = 'Connecting…';
  connectBtn.disabled = true;
  apiToken = token;
  try {
    await tinxyFetch('/v2/devices/');
    saveToken(token);
    switchToDashboard();
  } catch (err) {
    clearToken();
    showTokenError(err.message);
  } finally {
    connectBtn.textContent = 'Connect';
    connectBtn.disabled = false;
  }
});

tokenInput.addEventListener('keydown', e => { if (e.key === 'Enter') connectBtn.click(); });
logoutBtn.addEventListener('click',  () => { clearToken(); switchToTokenScreen(); });
refreshBtn.addEventListener('click', loadDevices);
retryBtn.addEventListener('click',   loadDevices);

// Pause polling when tab is hidden, resume when visible
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    stopPolling();
  } else if (apiToken && !dashScreen.classList.contains('hidden')) {
    pollAllStates(); // immediate refresh
    startPolling();
  }
});

// ── Init ──────────────────────────────────────────────────────────────────────
(function init() {
  const saved = localStorage.getItem(TOKEN_KEY);
  if (saved) { apiToken = saved; switchToDashboard(); }
})();
