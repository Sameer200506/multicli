'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const definitions = [
  ['claude', 'Claude Code', '--resume', 'flag', '#D97757'],
  ['codex', 'Codex', 'resume', 'subcommand', '#10A37F'],
  ['gemini', 'Gemini CLI', '--resume', 'flag', '#4285F4'],
  ['opencode', 'OpenCode', '--session', 'flag', '#B5A4F4'],
  ['cursor-agent', 'Cursor Agent', '--resume', 'flag', '#D4D4D4'],
  ['aider', 'Aider', '--restore-chat-history', 'boolean', '#14B8A6'],
  ['qwen', 'Qwen Code', '--resume', 'flag', '#8B5CF6'],
  ['kimi', 'Kimi CLI', '--session', 'flag', '#3B82F6'],
  ['hermes', 'Hermes', '--resume', 'flag', '#F59E0B'],
  ['droid', 'Factory Droid', '--resume', 'flag', '#F97316']
];
const AGENTS = Object.freeze(definitions.map(([id, label, resumeArg, resumeKind, iconColor]) =>
  Object.freeze({ id, label, cmd: id, args: Object.freeze([]), resumeArg, resumeKind, iconColor })));
const userAgents = new Map();

function getAgent(id) {
  return userAgents.get(id) || AGENTS.find(agent => agent.id === id) || null;
}

function listAgents() {
  return [...AGENTS, ...userAgents.values()];
}

function registerUserAgent(agent) {
  if (!agent || typeof agent !== 'object' || !/^[a-z0-9][a-z0-9_-]*$/i.test(agent.id || '')) {
    throw new TypeError('Agent requires an alphanumeric id');
  }
  if (AGENTS.some(builtin => builtin.id === agent.id)) throw new Error(`Cannot replace built-in agent: ${agent.id}`);
  if (typeof agent.cmd !== 'string' || !agent.cmd.trim() || /[\0\r\n]/.test(agent.cmd)) {
    throw new TypeError('Agent cmd must be an executable name or path, not a shell command');
  }
  if (agent.args !== undefined && (!Array.isArray(agent.args) || agent.args.some(arg => typeof arg !== 'string' || arg.includes('\0')))) {
    throw new TypeError('Agent args must be an array of strings');
  }
  const resumeKind = agent.resumeKind || 'none';
  if (!['none', 'flag', 'subcommand', 'boolean'].includes(resumeKind)) throw new TypeError('Invalid resumeKind');
  if (resumeKind !== 'none' && (typeof agent.resumeArg !== 'string' || !agent.resumeArg.trim())) {
    throw new TypeError('Resumable agents require resumeArg');
  }
  const registered = Object.freeze({
    id: agent.id, label: agent.label || agent.id, cmd: agent.cmd,
    args: Object.freeze([...(agent.args || [])]), resumeArg: agent.resumeArg || null,
    resumeKind, iconColor: agent.iconColor || '#94A3B8', userDefined: true
  });
  userAgents.set(registered.id, registered);
  return registered;
}

// A missing optional config is normal; malformed config is deliberately not hidden.
function loadUserAgents(configPath = path.join(os.homedir(), '.mosaic', 'agents.json')) {
  let content;
  try { content = fs.readFileSync(configPath, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const config = JSON.parse(content);
  const agents = Array.isArray(config) ? config : config.agents;
  if (!Array.isArray(agents)) throw new TypeError('Agent config must be an array or { agents: [] }');
  return agents.map(registerUserAgent);
}

module.exports = { AGENTS, getAgent, listAgents, registerUserAgent, loadUserAgents };
