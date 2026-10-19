'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  AGENTS, getAgent, listAgents, registerUserAgent, loadUserAgents,
  detectAgent, resolveExecutable, buildResumeArgs, parseResumeOutput,
  createAgentSession, AgentManager, launchCommand
} = require('../core/agents');

function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mosaic-agents-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function fakePty() {
  const callbacks = {};
  const calls = [];
  const terminal = {
    pid: 4321,
    onData: fn => { callbacks.data = fn; return { dispose() { calls.push(['dispose-data']); } }; },
    onExit: fn => { callbacks.exit = fn; return { dispose() { calls.push(['dispose-exit']); } }; },
    onError: fn => { callbacks.error = fn; return { dispose() {} }; },
    write: data => calls.push(['write', data]),
    resize: (cols, rows) => calls.push(['resize', cols, rows]),
    kill: signal => calls.push(['kill', signal])
  };
  return { callbacks, calls, terminal, spawn: (...args) => { calls.push(['spawn', ...args]); return terminal; } };
}
function dependencies(pty) {
  return { pty, platform: 'linux', detectAgent: async () => ({ available: true, path: '/usr/bin/claude' }) };
}

test('registry exposes all ten immutable built-ins', () => {
  assert.deepEqual(AGENTS.map(a => a.id), ['claude', 'codex', 'gemini', 'opencode', 'cursor-agent', 'aider', 'qwen', 'kimi', 'hermes', 'droid']);
  assert.equal(getAgent('unknown'), null);
  assert.ok(Object.isFrozen(AGENTS));
  assert.ok(Object.isFrozen(getAgent('claude').args));
});

test('user agent registration and config loading', t => {
  const root = temporary(t);
  const file = path.join(root, 'agents.json');
  fs.writeFileSync(file, JSON.stringify({ agents: [{ id: 'test-helper', cmd: 'test-helper', args: ['--interactive'] }] }));
  assert.equal(loadUserAgents(file)[0].id, 'test-helper');
  assert.ok(listAgents().some(a => a.id === 'test-helper'));
  assert.deepEqual(loadUserAgents(path.join(root, 'missing')), []);
  assert.throws(() => registerUserAgent({ id: 'claude', cmd: 'other' }), /built-in/);
  assert.throws(() => registerUserAgent({ id: 'bad id', cmd: 'helper' }), /id/);
  fs.writeFileSync(file, '{');
  assert.throws(() => loadUserAgents(file), SyntaxError);
});

test('POSIX detection requires executable files and ignores relative PATH entries', async () => {
  const file = '/opt/test-bin/test-agent';
  let executable = true;
  const io = {
    stat: async candidate => { if (candidate !== file) throw Object.assign(new Error(), { code: 'ENOENT' }); return { isFile: () => true }; },
    access: async (candidate, mode) => { assert.equal(mode, fs.constants.X_OK); if (!executable) throw Object.assign(new Error(), { code: 'EACCES' }); }
  };
  const options = { platform: 'linux', env: { PATH: '/opt/test-bin' }, disableWhich: true, fs: io };
  assert.equal(await resolveExecutable('test-agent', options), file);
  assert.equal(await resolveExecutable('missing', options), null);
  assert.equal(await resolveExecutable('test-agent', { ...options, env: { PATH: '.' } }), null);
  executable = false;
  assert.equal(await resolveExecutable('test-agent', options), null);
});

test('Windows PATH and PATHEXT are case insensitive and skip extensionless shims', async () => {
  const files = new Set(['C:\\Tools\\claude', 'C:\\Tools\\claude.cmd']);
  const io = { stat: async file => { if (!files.has(file)) throw Object.assign(new Error(), { code: 'ENOENT' }); return { isFile: () => true }; }, access: async () => {} };
  const result = await detectAgent('claude', { platform: 'win32', env: { Path: 'C:\\Tools', Pathext: '.EXE;.CMD' }, fs: io });
  assert.deepEqual(result, { id: 'claude', label: 'Claude Code', available: true, path: 'C:\\Tools\\claude.cmd' });
});

test('Unix which fallback returns only verified executable paths', async () => {
  const io = { stat: async () => ({ isFile: () => true }), access: async () => {} };
  const result = await resolveExecutable('claude', { platform: 'linux', env: { PATH: '' }, fs: io,
    execFile: (file, args, options, callback) => { assert.equal(file, '/usr/bin/which'); callback(null, '/opt/bin/claude\n'); } });
  assert.equal(result, '/opt/bin/claude');
});

test('resume argument translation covers every built-in', () => {
  for (const agent of AGENTS) {
    if (agent.id === 'aider') {
      assert.deepEqual(buildResumeArgs(agent.id, true), ['--restore-chat-history']);
      assert.throws(() => buildResumeArgs(agent.id, 'session-123'), /not a session id/);
    } else assert.deepEqual(buildResumeArgs(agent.id, 'session-123'), [agent.resumeArg, 'session-123']);
  }
  assert.deepEqual(buildResumeArgs('codex', true), ['resume', '--last']);
  assert.deepEqual(buildResumeArgs('claude', true), ['--continue']);
  assert.deepEqual(buildResumeArgs('claude', false), []);
  assert.throws(() => buildResumeArgs('claude', '--dangerous'), /not an option/);
});

test('resume output parsing strips ANSI and returns most recent advertised command', () => {
  assert.deepEqual(parseResumeOutput('\x1b[32mResume with: claude --resume abc-123\x1b[0m'), {
    agentId: 'claude', sessionId: 'abc-123', args: ['--resume', 'abc-123']
  });
  assert.equal(parseResumeOutput('codex resume first\nclaude --resume second').sessionId, 'second');
  assert.equal(parseResumeOutput('claude --resume="quoted session"').sessionId, 'quoted session');
  assert.equal(parseResumeOutput('a normal conversation'), null);
  assert.equal(parseResumeOutput('codex resume abc', 'claude'), null);
});

test('launch builder uses direct POSIX execution and native Windows executables', () => {
  const args = ['hello; $(not-shell)', 'two words'];
  assert.deepEqual(launchCommand('/bin/agent', args, 'linux'), { file: '/bin/agent', args });
  assert.deepEqual(launchCommand('C:\\bin\\agent.exe', args, 'win32'), { file: 'C:\\bin\\agent.exe', args });
});

test('Windows CMD shim launches with AutoRun and delayed expansion disabled', () => {
  const launch = launchCommand('C:\\Program Files\\agent.cmd', ['two words', 'a&b'], 'win32', { ComSpec: 'C:\\cmd.exe' });
  assert.equal(launch.file, 'C:\\cmd.exe');
  assert.equal(launch.args, '/d /s /v:off /c ""C:\\Program Files\\agent.cmd" "two words" "a&b""');
  for (const value of ['%PATH%', 'a"b', 'a\nb']) assert.throws(() => launchCommand('agent.cmd', [value], 'win32'), /cannot contain/);
});

test('PowerShell shim arguments remain literal', () => {
  const launch = launchCommand('C:\\bin\\agent.ps1', ["it's $literal; text"], 'win32', {});
  const command = Buffer.from(launch.args.at(-1), 'base64').toString('utf16le');
  assert.match(command, /'it''s \$literal; text'/);
  assert.ok(launch.args.includes('-NoProfile'));
});

test('PTY starts at canonical workspace root and protects pane environment', async t => {
  const root = temporary(t);
  const pty = fakePty();
  const session = await createAgentSession({ agentId: 'claude', workspaceRoot: root, paneId: 'pane-1',
    args: ['--verbose'], resume: 'abc-123', env: { MOSAIC_WORKSPACE: 'wrong', MOSAIC_PANE_ID: 'wrong', CUSTOM: 'yes' }, cols: 120, rows: 40 }, dependencies(pty));
  const [, file, args, options] = pty.calls[0];
  assert.equal(file, '/usr/bin/claude');
  assert.deepEqual(args, ['--resume', 'abc-123', '--verbose']);
  assert.equal(options.cwd, fs.realpathSync(root));
  assert.equal(options.env.MOSAIC_WORKSPACE, fs.realpathSync(root));
  assert.equal(options.env.MOSAIC_CONTEXT_DIR, path.join(fs.realpathSync(root), '.mosaic', 'context'));
  assert.equal(options.env.MOSAIC_PANE_ID, 'pane-1');
  assert.equal(options.env.CUSTOM, 'yes');
  assert.equal(options.cols, 120);
  assert.equal(session.pid, 4321);
});

test('PTY streams I/O, resize, fragmented resume, errors and exit once', async t => {
  const pty = fakePty();
  const session = await createAgentSession({ agentId: 'claude', workspaceRoot: temporary(t), paneId: 'pane-2' }, dependencies(pty));
  const data = [];
  const exits = [];
  const errors = [];
  session.onData(chunk => data.push(chunk));
  session.onExit(event => exits.push(event));
  session.onError(error => errors.push(error));
  session.write('hello\r');
  session.resize(80, 24);
  pty.callbacks.data('Resume: claude --res');
  pty.callbacks.data('ume abc-123\n');
  assert.equal(session.resume.sessionId, 'abc-123');
  assert.equal(data.length, 2);
  pty.callbacks.error(new Error('test'));
  assert.equal(errors.length, 1);
  assert.equal(session.kill(), true);
  assert.equal(session.kill(), false);
  pty.callbacks.exit({ exitCode: 0, signal: 0 });
  pty.callbacks.exit({ exitCode: 1 });
  assert.equal(exits.length, 1);
  assert.equal(session.state, 'exited');
  assert.equal(session.write('ignored'), false);
  assert.equal(session.resize(80, 24), false);
  assert.throws(() => session.resize(0, 20), /integers/);
});

test('bad spawn parameters and absent CLI fail before spawning', async t => {
  const root = temporary(t);
  const pty = fakePty();
  const opts = { agentId: 'claude', workspaceRoot: root, paneId: 'pane-3' };
  await assert.rejects(createAgentSession({ ...opts, cwd: os.tmpdir() }, dependencies(pty)), /locked/);
  await assert.rejects(createAgentSession({ ...opts, workspaceRoot: '.' }, dependencies(pty)), /absolute/);
  await assert.rejects(createAgentSession({ ...opts, paneId: '../pane' }, dependencies(pty)), /paneId/);
  await assert.rejects(createAgentSession({ ...opts, args: 'raw shell' }, dependencies(pty)), /array/);
  await assert.rejects(createAgentSession(opts, { ...dependencies(pty), detectAgent: async () => ({ available: false, path: null }) }), { code: 'AGENT_NOT_FOUND' });
  assert.equal(pty.calls.length, 0);
});

test('manager locks default root, prevents concurrent duplicate panes and removes exited sessions', async t => {
  const root = temporary(t);
  const pty = fakePty();
  const manager = new AgentManager({ workspaceRoot: root }, dependencies(pty));
  const pending = manager.spawn({ agentId: 'claude', paneId: 'manager-pane', workspaceRoot: os.tmpdir() });
  await assert.rejects(manager.spawn({ agentId: 'claude', paneId: 'manager-pane' }), /already running/);
  const session = await pending;
  assert.equal(session.workspaceRoot, fs.realpathSync(root));
  assert.equal(manager.get('manager-pane'), session);
  assert.equal(manager.write('manager-pane', 'hi'), true);
  manager.killAll();
  pty.callbacks.exit({ exitCode: 0 });
  assert.equal(manager.list().length, 0);
});
