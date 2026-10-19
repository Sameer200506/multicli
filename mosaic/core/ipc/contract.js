'use strict';

/**
 * Mosaic IPC contract — the only channel naming convention.
 * Format: mosaic:<scope>:<action>
 * Renderer → Main: mosaic:main:<action>
 * Main → Renderer: mosaic:renderer:<action>
 * Main ↔ Agent PTY: mosaic:pty:<paneId>:<action>
 */
const SCOPE_MAIN = 'main';
const SCOPE_RENDERER = 'renderer';
const SCOPE_PTY = 'pty';

const CHANNELS = Object.freeze({
  // App lifecycle
  'app:version': { dir: 'bidirectional', payload: Object.freeze({}) },
  'app:ready': { dir: 'main→renderer', payload: Object.freeze({ version: 'string' }) },
  'app:quit': { dir: 'renderer→main', payload: Object.freeze({}) },

  // Workspace
  'workspace:open': { dir: 'renderer→main', payload: Object.freeze({ path: 'string' }) },
  'workspace:opened': { dir: 'main→renderer', payload: Object.freeze({ path: 'string' }) },
  'workspace:pickFolder': { dir: 'renderer→main', payload: Object.freeze({ title: 'string?' }) },
  'workspace:picked': { dir: 'main→renderer', payload: Object.freeze({ canceled: 'boolean', path: 'string|null' }) },

  // Panes / sessions
  'pane:spawn': { dir: 'renderer→main', payload: Object.freeze({ paneId: 'string', agentId: 'string', 'contextDir?': 'string', 'resume?': 'string|string[]|boolean', 'cols?': 'number', 'rows?': 'number', 'env?': 'Object<string,string>' }) },
  'pane:spawned': { dir: 'main→renderer', payload: Object.freeze({ paneId: 'string', agentId: 'string', pid: 'number', ok: 'boolean', 'error?': 'string' }) },
  'pane:write': { dir: 'renderer→main', payload: Object.freeze({ paneId: 'string', data: 'string' }) },
  'pane:resize': { dir: 'renderer→main', payload: Object.freeze({ paneId: 'string', cols: 'number', rows: 'number' }) },
  'pane:kill': { dir: 'renderer→main', payload: Object.freeze({ paneId: 'string' }) },
  'pane:data': { dir: 'main→renderer', payload: Object.freeze({ paneId: 'string', data: 'string' }) },
  'pane:exit': { dir: 'main→renderer', payload: Object.freeze({ paneId: 'string', exitCode: 'number|null', signal: 'string|null' }) },

  // Context (read by renderer for context panel)
  'context:listTopics': { dir: 'renderer→main', payload: Object.freeze({ workspaceRoot: 'string' }) },
  'context:topics': { dir: 'main→renderer', payload: Object.freeze({ workspaceRoot: 'string', topics: 'Object[] of { id, label }' }) },
  'context:read': { dir: 'renderer→main', payload: Object.freeze({ workspaceRoot: 'string', topicId: 'string' }) },
  // Subscriptions: main watches the topic and pushes 'context:topic' on change.
  'context:subscribe': { dir: 'renderer→main', payload: Object.freeze({ workspaceRoot: 'string', topicId: 'string' }) },
  'context:unsubscribe': { dir: 'renderer→main', payload: Object.freeze({ workspaceRoot: 'string', subscriptionId: 'string' }) },
  'context:topic': { dir: 'main→renderer', payload: Object.freeze({ workspaceRoot: 'string', topicId: 'string', 'entries?': 'Object' }) },

  // Context writes go main→context engine; renderer never touches fs directly.
  'context:write': { dir: 'renderer→main', payload: Object.freeze({ workspaceRoot: 'string', topicId: 'string', entryId: 'string', pane: 'string', value: 'Object' }) },
  'context:written': { dir: 'main→renderer', payload: Object.freeze({ workspaceRoot: 'string', topicId: 'string', entryId: 'string', ok: 'boolean' }) },
});

function channelMatches(channel, pattern) {
  const parts = channel.split(':');
  const proto = pattern.split(':');
  if (parts.length !== proto.length) return false;
  for (let i = 0; i < parts.length; i++) {
    if (proto[i].endsWith('?')) {
      const key = proto[i].slice(0, -1);
      const keyIdx = parts.indexOf(key);
      if (keyIdx === -1) return false;
      if (parts[i] !== parts[keyIdx]) return false;
    } else if (proto[i] === '*') {
      continue;
    } else if (parts[i] !== proto[i]) {
      return false;
    }
  }
  return true;
}

function validatePayload(channel, payload) {
  const spec = CHANNELS[channel];
  if (!spec) return { ok: false, error: `unknown channel: ${channel}` };
  if (!payload || typeof payload !== 'object') return { ok: false, error: 'payload must be an object' };
  return { ok: true, spec };
}

module.exports = {
  SCOPE_MAIN,
  SCOPE_RENDERER,
  SCOPE_PTY,
  CHANNELS,
  channelMatches,
  validatePayload,
};