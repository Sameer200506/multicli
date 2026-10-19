'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * Mosaic renderer API.
 * All calls return Promises resolved with the reply from the main process.
 * Channel naming: mosaic:main:<action> → renderer→main request (ipcMain.handle)
 *                 mosaic:renderer:<action> → main→renderer push event
 */
const MAIN = 'mosaic:main:';
const RENDERER = 'mosaic:renderer:';

/** Renderer → main request. Always resolves; failures arrive as { ok: false, error }. */
const request = (action, payload) => ipcRenderer.invoke(MAIN + action, payload || {});

/** Subscribe to a main → renderer push event. Returns an unsubscribe function. */
function on(action, listener) {
  if (typeof listener !== 'function') throw new TypeError('listener must be a function');
  const channel = RENDERER + action;
  const handler = (_event, payload) => listener(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

const api = {
  /** Subscribe to a main → renderer push event such as 'pane:data'. */
  on,
  app: {
    version: () => request('app:version'),
    quit: () => request('app:quit'),
  },
  workspace: {
    open: (path) => request('workspace:open', { path }),
    pickFolder: (opts = {}) => request('workspace:pickFolder', opts),
  },
  pane: {
    spawn: (opts) => request('pane:spawn', opts),
    write: (paneId, data) => request('pane:write', { paneId, data }),
    resize: (paneId, cols, rows) => request('pane:resize', { paneId, cols, rows }),
    kill: (paneId) => request('pane:kill', { paneId }),
  },
  context: {
    listTopics: (workspaceRoot) => request('context:listTopics', { workspaceRoot }),
    read: (workspaceRoot, topicId) => request('context:read', { workspaceRoot, topicId }),
    write: (workspaceRoot, topicId, entryId, pane, value) =>
      request('context:write', { workspaceRoot, topicId, entryId, pane, value }),
    /**
     * Subscribe to a topic. Resolves with { ok, subscriptionId }; changes are
     * pushed to the 'context:topic' listener installed via mosaic.on().
     */
    subscribe: (workspaceRoot, topicId) => request('context:subscribe', { workspaceRoot, topicId }),
    unsubscribe: (workspaceRoot, subscriptionId) => request('context:unsubscribe', { workspaceRoot, subscriptionId }),
  },
};

contextBridge.exposeInMainWorld('mosaic', api);
