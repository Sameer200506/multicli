'use strict';

/**
 * Mosaic renderer.
 *
 * Runs with contextIsolation and no node integration: the only capability in
 * this file comes from window.mosaic (see preload.js). Renderer → main calls
 * resolve with a result envelope; main → renderer activity arrives through
 * mosaic.on(...) subscriptions.
 */

const mosaic = window.mosaic;

const MAX_OUTPUT_CHARS = 20000;
const DEFAULT_AGENT_ID = 'claude';

class Store {
  constructor() {
    this.state = {
      workspace: null,
      sessions: [],
      context: {
        topics: [],
        entries: {},
        activeTopic: null,
        subscriptionId: null,
      },
      ui: {
        activePaneId: null,
      },
      status: 'Ready',
    };
    this.listeners = new Set();
  }

  get() { return JSON.parse(JSON.stringify(this.state)); }

  set(patch) {
    Object.assign(this.state, patch);
    this.listeners.forEach(listener => listener());
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

const store = new Store();
let contextEntriesEl = null;

async function initApp() {
  const result = await mosaic.app.version();
  document.getElementById('versionInfo').textContent = `v${(result && result.version) || 'unknown'}`;

  bindEvents();
  store.subscribe(render);
  render();
}

/* ------------------------------------------------------------------ events */

function bindEvents() {
  document.getElementById('btnOpenWorkspace').addEventListener('click', openWorkspaceFlow);
  document.getElementById('btnNewPane').addEventListener('click', spawnPane);
  document.getElementById('btnCommandPalette').addEventListener('click', () => setStatus('Command palette is not wired up yet'));

  mosaic.on('workspace:opened', ({ path }) => {
    store.set({
      workspace: path,
      sessions: [],
      context: { topics: store.get().context.topics, entries: {}, activeTopic: null, subscriptionId: null },
      ui: { activePaneId: null },
    });
  });

  mosaic.on('context:topics', ({ topics }) => {
    store.set({ context: { ...store.get().context, topics: topics || [] } });
  });

  mosaic.on('context:topic', ({ topicId, entries }) => {
    const context = store.get().context;
    store.set({
      context: { ...context, entries: { ...context.entries, [topicId]: entries || {} } },
    });
  });

  mosaic.on('pane:data', ({ paneId, data }) => appendOutput(paneId, data));
  mosaic.on('pane:exit', ({ paneId, exitCode, signal, error }) => removeSession(paneId, { exitCode, signal, error }));
}

async function openWorkspaceFlow() {
  const picked = await mosaic.workspace.pickFolder();
  if (picked.ok === false) return setStatus(`Open failed: ${picked.error}`);
  if (picked.canceled || !picked.path) return;

  const result = await mosaic.workspace.open(picked.path);
  if (result.ok === false) return setStatus(`Open failed: ${result.error}`);

  store.set({
    workspace: result.path,
    sessions: [],
    context: { topics: result.topics || [], entries: {}, activeTopic: null, subscriptionId: null },
    ui: { activePaneId: null },
  });
  setStatus(`Workspace: ${basename(result.path)}`);
}

async function spawnPane() {
  const state = store.get();
  if (!state.workspace) return setStatus('Open a workspace before spawning a pane');

  const agentId = DEFAULT_AGENT_ID;
  const paneId = `${agentId}-${Date.now().toString(36)}`;
  const result = await mosaic.pane.spawn({ paneId, agentId, cols: 100, rows: 30 });
  if (result.ok === false) return setStatus(`Spawn failed: ${result.error}`);

  const session = { paneId, agentId, title: titleFor(agentId), output: '' };
  store.set({ sessions: [...store.get().sessions, session] });
  activatePane(paneId);
  setStatus(`${session.title} started (pid ${result.pid})`);
}

function appendOutput(paneId, data) {
  const state = store.get();
  const session = state.sessions.find(candidate => candidate.paneId === paneId);
  if (!session) return;

  session.output = (session.output + data).slice(-MAX_OUTPUT_CHARS);
  store.set({ sessions: [...state.sessions.filter(candidate => candidate.paneId !== paneId), session] });
  if (state.ui.activePaneId === paneId) scrollPaneToBottom(paneId);
}

function removeSession(paneId, { exitCode, signal, error }) {
  const state = store.get();
  const session = state.sessions.find(candidate => candidate.paneId === paneId);
  const sessions = state.sessions.filter(candidate => candidate.paneId !== paneId);
  const activePaneId = state.ui.activePaneId === paneId ? (sessions[0] ? sessions[0].paneId : null) : state.ui.activePaneId;

  store.set({ sessions, ui: { activePaneId } });
  const reason = error || `exit code ${exitCode === null || exitCode === undefined ? 'n/a' : exitCode}${signal ? ` (${signal})` : ''}`;
  setStatus(`${session ? session.title : paneId} ended — ${reason}`);
}

/**
 * Point the live context subscription at a topic: drop the previous watch and
 * subscribe to the new one. The store only ever changes through observation, so
 * the panel reflects writes from other panes without polling.
 */
async function setActiveTopic(topicId) {
  const state = store.get();
  const previous = state.context.subscriptionId;

  store.set({ context: { ...state.context, activeTopic: topicId, subscriptionId: null } });
  if (previous) {
    const released = await mosaic.context.unsubscribe(state.workspace, previous);
    if (released.ok === false) setStatus(`Unsubscribe failed: ${released.error}`);
  }
  if (!topicId || !state.workspace) return;

  const subscription = await mosaic.context.subscribe(state.workspace, topicId);
  if (subscription.ok === false) return setStatus(`Subscribe failed: ${subscription.error}`);

  const context = store.get().context;
  store.set({
    context: {
      ...context,
      subscriptionId: subscription.subscriptionId,
      entries: { ...context.entries, [topicId]: subscription.entries || {} },
    },
  });
}

function activatePane(paneId) {
  store.set({ ui: { activePaneId: paneId } });
  scrollPaneToBottom(paneId);
}

function scrollPaneToBottom(paneId) {
  const term = document.querySelector(`[data-pane-id="${paneId}"] .pane-terminal`);
  if (term) term.scrollTop = term.scrollHeight;
}

function setStatus(text) {
  store.set({ status: text });
}

/* ------------------------------------------------------------------ render */

function render() {
  const state = store.get();
  renderWorkspace(state);
  renderPanes(state);
  renderSessions(state);
  renderContext(state);
  document.getElementById('shortcuts').textContent = state.status;
}

function renderWorkspace(state) {
  const indicator = document.getElementById('workspaceIndicator');
  indicator.textContent = state.workspace ? basename(state.workspace) : 'No workspace';
  indicator.title = state.workspace || '';
}

function renderPanes(state) {
  const grid = document.getElementById('paneGrid');
  grid.textContent = '';

  if (!state.sessions.length) {
    const hint = document.createElement('div');
    hint.className = 'pane-empty';
    hint.textContent = state.workspace ? 'No agent panes yet — use + to start one' : 'Open a workspace to begin';
    grid.appendChild(hint);
    return;
  }

  for (const session of state.sessions) {
    const pane = document.createElement('div');
    pane.className = 'pane';
    pane.dataset.paneId = session.paneId;
    if (state.ui.activePaneId === session.paneId) pane.classList.add('active');

    const header = document.createElement('div');
    header.className = 'pane-header';

    const title = document.createElement('div');
    title.className = 'pane-title';
    title.appendChild(agentDot(session.agentId));

    const label = document.createElement('span');
    label.textContent = session.title || session.agentId;
    title.appendChild(label);

    const badge = document.createElement('span');
    badge.className = 'pane-agent-badge';
    badge.textContent = session.agentId;
    badge.style.background = agentBadgeBg(session.agentId);
    badge.style.color = agentBadgeFg(session.agentId);
    title.appendChild(badge);
    header.appendChild(title);
    pane.appendChild(header);

    const body = document.createElement('div');
    body.className = 'pane-body';
    const terminal = document.createElement('pre');
    terminal.className = 'pane-terminal';
    terminal.textContent = session.output || '';
    body.appendChild(terminal);
    pane.appendChild(body);

    pane.addEventListener('click', () => activatePane(session.paneId));
    grid.appendChild(pane);
  }
}

function renderSessions(state) {
  const list = document.getElementById('sessionList');
  list.textContent = '';

  for (const session of state.sessions) {
    const chip = document.createElement('li');
    chip.className = 'session-chip';
    if (state.ui.activePaneId === session.paneId) chip.classList.add('active');
    chip.appendChild(agentDot(session.agentId));

    const label = document.createElement('span');
    label.className = 'session-label';
    label.textContent = session.title || session.agentId;
    chip.appendChild(label);

    chip.addEventListener('click', () => activatePane(session.paneId));
    list.appendChild(chip);
  }
}

function renderContext(state) {
  const panel = document.getElementById('contextPanel');
  const list = document.getElementById('topicList');
  list.textContent = '';

  if (!contextEntriesEl) {
    contextEntriesEl = document.createElement('pre');
    contextEntriesEl.className = 'context-entries';
    contextEntriesEl.id = 'contextEntries';
    panel.appendChild(contextEntriesEl);
  }

  if (!state.context.topics.length) {
    const empty = document.createElement('div');
    empty.className = 'topic-empty';
    empty.textContent = state.workspace ? 'No topics yet' : 'No workspace';
    list.appendChild(empty);
    contextEntriesEl.textContent = '';
    return;
  }

  for (const topic of state.context.topics) {
    const item = document.createElement('div');
    item.className = 'topic-item';
    if (state.context.activeTopic === topic.id) item.classList.add('active');
    item.dataset.topicId = topic.id;
    item.textContent = topic.label || topic.id;
    item.addEventListener('click', () => setActiveTopic(topic.id));
    list.appendChild(item);
  }

  const activeTopic = state.context.activeTopic;
  const entries = (activeTopic && state.context.entries[activeTopic]) || {};
  contextEntriesEl.textContent = activeTopic
    ? JSON.stringify(entries, null, 2)
    : 'Select a topic to follow it live';
}

/* ------------------------------------------------------------------ helpers */

function basename(target) {
  const parts = String(target || '').split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : String(target || '');
}

function titleFor(agentId) {
  return `${agentId.charAt(0).toUpperCase()}${agentId.slice(1)} Session`;
}

function agentDot(agentId) {
  const dot = document.createElement('span');
  dot.className = 'agent-dot';
  dot.style.background = AGENT_COLORS[agentId] || '#9CA3AF';
  return dot;
}

const AGENT_COLORS = {
  claude: '#E28C5A',
  codex: '#10B981',
  gemini: '#4285F4',
  opencode: '#8B5CF6',
  'cursor-agent': '#D1D5DB',
  aider: '#10B981',
  qwen: '#A78BFA',
  kimi: '#3B82F6',
  hermes: '#F59E0B',
  droid: '#F97316',
};

function agentBadgeBg(agentId) {
  const map = {
    claude: '#EF4444',
    codex: '#10B981',
    gemini: '#3B82F6',
    opencode: '#8B5CF6',
    'cursor-agent': '#6B7280',
    aider: '#10B981',
    qwen: '#A78BFA',
    kimi: '#3B82F6',
    hermes: '#FBBF24',
    droid: '#F97316',
  };
  return map[agentId] || '#6B7280';
}

function agentBadgeFg(agentId) {
  return agentId === 'hermes' || agentId === 'droid' ? '#1F2937' : '#FFFFFF';
}

initApp();
