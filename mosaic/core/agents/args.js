'use strict';

const { getAgent, listAgents } = require('./registry');

function validateSessionId(sessionId) {
  if (typeof sessionId !== 'string' || !sessionId.trim() || sessionId.length > 512 || /[\0\r\n]/.test(sessionId) || sessionId.startsWith('-')) {
    throw new TypeError('Resume session id must be a non-empty string, not an option');
  }
  return sessionId;
}

function buildResumeArgs(agentId, sessionId) {
  const agent = getAgent(agentId);
  if (!agent) throw new Error(`Unknown agent: ${agentId}`);
  if (sessionId === undefined || sessionId === null || sessionId === false || sessionId === '') return [];
  if (agent.resumeKind === 'none') throw new Error(`${agent.label} does not support resume`);
  if (agent.resumeKind === 'boolean') {
    if (sessionId !== true) throw new Error(`${agent.label} restores workspace chat history, not a session id`);
    return [agent.resumeArg];
  }
  if (sessionId === true) {
    switch (agentId) {
      case 'claude': case 'opencode': case 'qwen': case 'kimi': case 'hermes': return ['--continue'];
      case 'codex': return ['resume', '--last'];
      case 'cursor-agent': return ['--continue'];
      default: return [agent.resumeArg];
    }
  }
  return [agent.resumeArg, validateSessionId(sessionId)];
}

function stripAnsi(text) {
  return text.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\r/g, '');
}

function escapeRegex(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// Parses advertised resume commands only; never executes terminal output.
// Call with a rolling text buffer (sessions maintain a bounded one automatically).
function parseResumeOutput(stream, agentId) {
  const text = stripAnsi(String(stream || '')).slice(-32768);
  let latest = null;
  let latestIndex = -1;
  for (const agent of (agentId ? [getAgent(agentId)].filter(Boolean) : listAgents())) {
    if (!agent.resumeArg || agent.resumeKind === 'boolean') continue;
    const flags = [agent.resumeArg];
    if (['claude', 'gemini', 'qwen', 'hermes', 'droid'].includes(agent.id)) flags.push('-r');
    if (['opencode', 'kimi'].includes(agent.id)) flags.push('-s');
    const pattern = new RegExp(`(?:^|[\\s\x60])${escapeRegex(agent.cmd)}\\s+(?:${flags.map(escapeRegex).join('|')})(?:=|\\s+)(?:"([^"\\r\\n]+)"|'([^'\\r\\n]+)'|([A-Za-z0-9][A-Za-z0-9_.:-]*))`, 'gm');
    for (const match of text.matchAll(pattern)) {
      const sessionId = match[1] || match[2] || match[3];
      if (match.index >= latestIndex) {
        latestIndex = match.index;
        latest = { agentId: agent.id, sessionId, args: buildResumeArgs(agent.id, sessionId) };
      }
    }
  }
  return latest;
}

module.exports = { buildResumeArgs, parseResumeOutput, parseResume: parseResumeOutput, stripAnsi };
