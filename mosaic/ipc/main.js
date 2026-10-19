'use strict';

const { app, BrowserWindow, ipcMain, dialog, Menu, nativeImage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const { AgentManager } = require('../core/agents');
const { createContextStore, getTopic } = require('../core/context');
const { channelMatches, validatePayload } = require('../core/ipc/contract');

const VERSION = require('../package.json').version;
const PRELOAD = path.join(__dirname, 'preload.js');
const RENDERER_HTML = path.join(__dirname, 'renderer', 'index.html');

// Channel convention (core/ipc/contract.js): renderer→main requests are handled
// on mosaic:main:<action>, main→renderer pushes go out on mosaic:renderer:<action>.
const MAIN = 'mosaic:main:';
const RENDERER = 'mosaic:renderer:';

let window = null;
let workspaceRoot = null;
let contextStore = null;
let agentManager = null;
const paneSessions = new Map();
const contextSubscriptions = new Map();

/** Push an event to the renderer, if a live window still exists. */
function send(action, payload) {
  if (window && !window.isDestroyed()) window.webContents.send(RENDERER + action, payload);
}

/** Map on-disk topic ids to the { id, label } shape the context panel renders. */
function describeTopics(ids) {
  return ids.map(id => {
    const known = getTopic(id);
    if (known) return { id, label: known.label };
    return { id, label: id.split(/[-_]/).map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ') };
  });
}

function releaseContextSubscriptions() {
  for (const unsubscribe of contextSubscriptions.values()) {
    try { unsubscribe(); } catch { /* the watch handle is already closed */ }
  }
  contextSubscriptions.clear();
}

function ensureWorkspace() {
  if (!workspaceRoot) throw new Error('No workspace open');
  return workspaceRoot;
}

function ensureContext() {
  if (!contextStore) throw new Error('No context store initialized');
  return contextStore;
}

function ensureManager() {
  if (!agentManager) throw new Error('No agent manager initialized');
  return agentManager;
}

function initWorkspace(root) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) throw new TypeError('Workspace path must be an absolute path');
  releaseContextSubscriptions();
  for (const session of paneSessions.values()) session.kill();
  paneSessions.clear();
  workspaceRoot = path.resolve(root);
  contextStore = createContextStore({ workspaceRoot, paneId: 'desktop' });
  agentManager = new AgentManager({ workspaceRoot });
}

async function openWorkspace(root) {
  initWorkspace(root);
  const topics = describeTopics(await contextStore.listTopics());
  send('workspace:opened', { path: workspaceRoot });
  send('context:topics', { workspaceRoot, topics });

  return { ok: true, path: workspaceRoot, topics };
}

/** Guard against a renderer that still references a previously opened workspace. */
function ensureWorkspaceIsOpen(claimed) {
  const open = ensureWorkspace();
  if (claimed && path.resolve(claimed) !== open) throw new Error('Workspace mismatch; reopen the workspace');
  return open;
}

function handlePaneSpawn(event, payload) {
  const { paneId, agentId, contextDir, resume, cols, rows, env } = payload;
  const manager = ensureManager();
  const root = ensureWorkspace();
  return manager.spawn({
    agentId,
    paneId,
    workspaceRoot: root,
    contextDir: contextDir || path.join(root, '.mosaic', 'context'),
    resume,
    cols,
    rows,
    env,
  }).then(session => {
    paneSessions.set(paneId, session);
    session.onData(data => send('pane:data', { paneId, data }));
    session.onExit(exit => {
      paneSessions.delete(paneId);
      send('pane:exit', { paneId, exitCode: exit.exitCode, signal: exit.signal });
    });
    session.onError(error => {
      paneSessions.delete(paneId);
      send('pane:exit', { paneId, exitCode: null, signal: null, error: error.message });
    });
    return { paneId, agentId, pid: session.pid, ok: true };
  }).catch(error => ({ paneId, agentId, ok: false, error: error.message }));
}

// write/resize/kill all report false for a pane that has already exited, so the
// renderer learns about a dead session instead of a silent success.
function handlePaneWrite(event, payload) {
  const session = paneSessions.get(payload.paneId);
  if (!session) return { ok: false, error: 'pane not found' };
  return session.write(payload.data) ? { ok: true } : { ok: false, error: 'pane is not running' };
}

function handlePaneResize(event, payload) {
  const session = paneSessions.get(payload.paneId);
  if (!session) return { ok: false, error: 'pane not found' };
  return session.resize(payload.cols, payload.rows) ? { ok: true } : { ok: false, error: 'pane is not running' };
}

function handlePaneKill(event, payload) {
  const session = paneSessions.get(payload.paneId);
  if (!session) return { ok: false, error: 'pane not found' };
  return session.kill() ? { ok: true } : { ok: false, error: 'pane is not running' };
}

async function handleContextListTopics(event, payload) {
  const store = ensureContext();
  const root = ensureWorkspaceIsOpen(payload.workspaceRoot);
  return { ok: true, workspaceRoot: root, topics: describeTopics(await store.listTopics()) };
}

async function handleContextRead(event, payload) {
  const store = ensureContext();
  const root = ensureWorkspaceIsOpen(payload.workspaceRoot);
  const document = await store.read(payload.topicId);
  return { ok: true, workspaceRoot: root, topicId: payload.topicId, entries: document.entries };
}

async function handleContextWrite(event, payload) {
  const store = ensureContext();
  const root = ensureWorkspaceIsOpen(payload.workspaceRoot);
  // createTopic() is idempotent, so this covers both builtin and ad-hoc topics.
  await store.createTopic(payload.topicId);
  const entry = await store.write(payload.topicId, payload.value, { id: payload.entryId, pane: payload.pane });
  send('context:written', { workspaceRoot: root, topicId: payload.topicId, entryId: entry.id, ok: true });
  return { ok: true, workspaceRoot: root, topicId: payload.topicId, entryId: entry.id };
}

/** Watches one topic and pushes 'context:topic' whenever its contents change. */
async function handleContextSubscribe(event, payload) {
  const store = ensureContext();
  const root = ensureWorkspaceIsOpen(payload.workspaceRoot);
  await store.init();
  const subscriptionId = randomUUID();
  const unsubscribe = store.subscribe(payload.topicId, (document) => {
    if (!contextSubscriptions.has(subscriptionId)) return;
    send('context:topic', { workspaceRoot: root, topicId: payload.topicId, entries: document.entries });
  });
  contextSubscriptions.set(subscriptionId, unsubscribe);
  const document = await store.read(payload.topicId);
  send('context:topic', { workspaceRoot: root, topicId: payload.topicId, entries: document.entries });
  return { ok: true, subscriptionId, workspaceRoot: root, topicId: payload.topicId, entries: document.entries };
}

async function handleContextUnsubscribe(event, payload) {
  ensureContext();
  ensureWorkspaceIsOpen(payload.workspaceRoot);
  const unsubscribe = contextSubscriptions.get(payload.subscriptionId);
  if (!unsubscribe) return { ok: true, removed: false };
  unsubscribe();
  contextSubscriptions.delete(payload.subscriptionId);
  return { ok: true, removed: true };
}

function handleAppQuit() {
  if (agentManager) agentManager.killAll();
  app.quit();
}

const HANDLERS = {
  'app:version': () => ({ version: VERSION }),
  'app:quit': handleAppQuit,
  'workspace:open': (event, payload) => openWorkspace(payload.path),
  'workspace:pickFolder': async (event, payload) => {
    const result = await dialog.showOpenDialog(window, {
      title: payload.title || 'Open workspace folder',
      properties: ['openDirectory'],
    });
    return { canceled: result.canceled, path: result.filePaths[0] || null };
  },
  'pane:spawn': handlePaneSpawn,
  'pane:write': handlePaneWrite,
  'pane:resize': handlePaneResize,
  'pane:kill': handlePaneKill,
  'context:listTopics': handleContextListTopics,
  'context:read': handleContextRead,
  'context:write': handleContextWrite,
  'context:subscribe': handleContextSubscribe,
  'context:unsubscribe': handleContextUnsubscribe,
};

function registerHandlers() {
  for (const [channel, handler] of Object.entries(HANDLERS)) {
    ipcMain.handle(MAIN + channel, async (event, payload) => {
      const validation = validatePayload(channel, payload);
      // Handlers resolve instead of throwing: the renderer reads a result
      // envelope, and a rejected invoke would surface as an uncaught page error.
      if (!validation.ok) return { ok: false, error: validation.error };
      try {
        const result = await handler(event, payload);
        return result === undefined ? { ok: true } : result;
      } catch (error) {
        return { ok: false, error: error.message };
      }
    });
  }
}

function createWindow(overrides = {}) {
  const created = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'Mosaic',
    backgroundColor: '#1E1F22',
    ...overrides,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      ...(overrides.webPreferences || {}),
    },
  });

  window = created;
  created.loadFile(RENDERER_HTML);

  created.on('closed', () => {
    if (window === created) window = null;
    if (agentManager) agentManager.killAll();
  });
  return created;
}

function bootstrap() {
  app.whenReady().then(() => {
    registerHandlers();
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (agentManager) agentManager.killAll();
    if (process.platform !== 'darwin') app.quit();
  });
}


module.exports = {
  MAIN,
  RENDERER,
  PRELOAD,
  RENDERER_HTML,
  describeTopics,
  createWindow,
  bootstrap,
  openWorkspace,
  initWorkspace,
  ensureWorkspace,
  ensureWorkspaceIsOpen,
  ensureContext,
  ensureManager,
  registerHandlers,
  handlePaneSpawn,
  handlePaneWrite,
  handlePaneResize,
  handlePaneKill,
  handleContextListTopics,
  handleContextRead,
  handleContextWrite,
  handleContextSubscribe,
  handleContextUnsubscribe,
  handleAppQuit,
};