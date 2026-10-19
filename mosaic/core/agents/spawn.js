'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { getAgent } = require('./registry');
const { detectAgent, envValue } = require('./detect');
const { buildResumeArgs, parseResumeOutput } = require('./args');

function dimensions(cols = 100, rows = 30) {
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1 || cols > 1000 || rows > 1000) {
    throw new RangeError('Terminal cols and rows must be integers between 1 and 1000');
  }
  return { cols, rows };
}

function mergeEnvironment(base, extra, platform) {
  const result = {};
  for (const source of [base, extra || {}]) {
    for (const [key, value] of Object.entries(source)) {
      if (/[\0=]/.test(key) || key.length === 0) continue;
      if (platform === 'win32') {
        const old = Object.keys(result).find(name => name.toLowerCase() === key.toLowerCase());
        if (old) delete result[old];
      }
      if (value !== undefined && value !== null) {
        if (String(value).includes('\0')) throw new TypeError(`Environment variable ${key} contains NUL`);
        result[key] = String(value);
      }
    }
  }
  return result;
}

function launchCommand(executable, args, platform = process.platform, env = process.env) {
  if (platform !== 'win32') return { file: executable, args };
  const extension = path.win32.extname(executable).toLowerCase();
  if (extension === '.cmd' || extension === '.bat') {
    // CMD expands %VAR% even in quotes. Reject unrepresentable input rather than
    // silently corrupt arguments or permit command expansion. /d disables AutoRun.
    const quote = value => {
      if (/["%\r\n\0]/.test(value)) throw new TypeError('Windows CMD shim arguments cannot contain quotes, percent signs or newlines');
      return `"${value}"`;
    };
    const command = [executable, ...args].map(quote).join(' ');
    return { file: envValue(env, 'ComSpec', platform) || 'C:\\Windows\\System32\\cmd.exe', args: `/d /s /v:off /c "${command}"` };
  }
  if (extension === '.ps1') {
    const quote = value => `'${value.replace(/'/g, "''")}'`;
    const command = `& ${[executable, ...args].map(quote).join(' ')}; if ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE }`;
    const root = envValue(env, 'SystemRoot', platform) || 'C:\\Windows';
    return {
      file: path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      args: ['-NoLogo', '-NoProfile', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')]
    };
  }
  return { file: executable, args };
}

class AgentSession extends EventEmitter {
  constructor(terminal, metadata) {
    super();
    Object.assign(this, metadata);
    this.terminal = terminal;
    this.pid = terminal.pid;
    this.state = 'running';
    this.exit = null;
    this.resume = null;
    this._buffer = '';
    this._subscriptions = [];
    this._subscriptions.push(terminal.onData(data => {
      if (this.state === 'exited') return;
      this._buffer = (this._buffer + data).slice(-32768);
      const resume = parseResumeOutput(this._buffer, this.agentId);
      if (resume && resume.sessionId !== this.resume?.sessionId) {
        this.resume = resume;
        this.emit('resume', resume);
      }
      this.emit('data', data);
    }));
    this._subscriptions.push(terminal.onExit(event => this._finish(event)));
    if (typeof terminal.onError === 'function') {
      this._subscriptions.push(terminal.onError(error => {
        this.lastError = error;
        // Do not allow an unobserved optional EventEmitter error to crash Electron.
        if (this.listenerCount('error')) this.emit('error', error);
      }));
    }
  }

  _finish(event) {
    if (this.state === 'exited') return;
    this.state = 'exited';
    this.exit = { exitCode: event.exitCode, signal: event.signal };
    for (const subscription of this._subscriptions.splice(0)) subscription?.dispose?.();
    this.emit('exit', this.exit);
  }

  _subscribe(name, listener) {
    if (typeof listener !== 'function') throw new TypeError('Event listener must be a function');
    this.on(name, listener);
    return { dispose: () => this.off(name, listener) };
  }

  onData(listener) { return this._subscribe('data', listener); }
  onExit(listener) {
    const subscription = this._subscribe('exit', listener);
    if (this.exit) queueMicrotask(() => { if (this.listeners('exit').includes(listener)) listener(this.exit); });
    return subscription;
  }
  onError(listener) { return this._subscribe('error', listener); }
  write(data) {
    if (typeof data !== 'string') throw new TypeError('PTY input must be a string');
    if (this.state !== 'running') return false;
    this.terminal.write(data);
    return true;
  }
  resize(cols, rows) {
    dimensions(cols, rows);
    if (this.state !== 'running') return false;
    this.terminal.resize(cols, rows);
    return true;
  }
  kill(signal) {
    if (this.state !== 'running') return false;
    this.state = 'stopping';
    try { this.terminal.kill(signal); }
    catch (error) { this.state = 'running'; throw error; }
    return true;
  }
}

async function createAgentSession(options, deps = {}) {
  const opts = options || {};
  const agent = getAgent(opts.agentId);
  if (!agent) throw new Error(`Unknown agent: ${opts.agentId}`);
  if (typeof opts.workspaceRoot !== 'string' || !path.isAbsolute(opts.workspaceRoot)) throw new TypeError('workspaceRoot must be an absolute path');
  if (typeof opts.paneId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(opts.paneId)) throw new TypeError('paneId must be a non-empty alphanumeric identifier');
  const workspaceRoot = await fs.promises.realpath(opts.workspaceRoot);
  if (!(await fs.promises.stat(workspaceRoot)).isDirectory()) throw new TypeError('workspaceRoot must be a directory');
  // This fixes the initial cwd; it is not an OS sandbox preventing the CLI from cd/access elsewhere.
  if (opts.cwd !== undefined && await fs.promises.realpath(opts.cwd) !== workspaceRoot) throw new Error('cwd is locked to workspaceRoot');
  const contextDir = path.resolve(workspaceRoot, opts.contextDir || '.mosaic/context');
  const platform = deps.platform || process.platform;
  const env = mergeEnvironment(deps.env || process.env, opts.env, platform);
  const protectedEnv = { MOSAIC_WORKSPACE: workspaceRoot, MOSAIC_CONTEXT_DIR: contextDir, MOSAIC_PANE_ID: opts.paneId };
  const childEnv = mergeEnvironment(env, protectedEnv, platform);
  const size = dimensions(opts.cols, opts.rows);
  if (opts.args !== undefined && (!Array.isArray(opts.args) || opts.args.some(arg => typeof arg !== 'string' || arg.includes('\0')))) {
    throw new TypeError('args must be an array of strings without NUL');
  }
  const resume = typeof opts.resume === 'object' && opts.resume !== null ? opts.resume.sessionId : opts.resume;
  const args = [...agent.args, ...buildResumeArgs(agent.id, resume), ...(opts.args || [])];
  const detected = await (deps.detectAgent || detectAgent)(agent.id, { env: childEnv, platform });
  if (!detected.available || !detected.path) {
    const error = new Error(`${agent.label} is not installed or is not on PATH`);
    error.code = 'AGENT_NOT_FOUND';
    throw error;
  }
  const command = launchCommand(detected.path, args, platform, childEnv);
  let pty = deps.pty;
  if (!pty) {
    try { pty = require('node-pty'); }
    catch (cause) { throw new Error('node-pty is unavailable; install dependencies and rebuild it for your Electron runtime', { cause }); }
  }
  const terminal = pty.spawn(command.file, command.args, {
    name: 'xterm-256color', ...size, cwd: workspaceRoot, env: childEnv
  });
  return new AgentSession(terminal, { id: opts.paneId, paneId: opts.paneId, agentId: agent.id, workspaceRoot, contextDir });
}

class AgentManager {
  constructor(defaults = {}, deps = {}) {
    this.defaults = { ...defaults };
    this.deps = deps;
    this.sessions = new Map();
    this.pending = new Set();
  }
  async spawn(options) {
    const opts = { ...this.defaults, ...options };
    if (this.defaults.workspaceRoot) opts.workspaceRoot = this.defaults.workspaceRoot;
    if (this.sessions.has(opts.paneId) || this.pending.has(opts.paneId)) throw new Error(`Pane already running: ${opts.paneId}`);
    this.pending.add(opts.paneId);
    try {
      const session = await createAgentSession(opts, this.deps);
      this.sessions.set(session.id, session);
      session.once('exit', () => { if (this.sessions.get(session.id) === session) this.sessions.delete(session.id); });
      return session;
    } finally { this.pending.delete(opts.paneId); }
  }
  create(options) { return this.spawn(options); }
  get(paneId) { return this.sessions.get(paneId) || null; }
  list() { return [...this.sessions.values()]; }
  write(paneId, data) { return this.get(paneId)?.write(data) || false; }
  resize(paneId, cols, rows) { return this.get(paneId)?.resize(cols, rows) || false; }
  kill(paneId, signal) { return this.get(paneId)?.kill(signal) || false; }
  killAll() { for (const session of this.sessions.values()) session.kill(); }
}

module.exports = { createAgentSession, AgentSession, AgentManager, launchCommand, mergeEnvironment };
