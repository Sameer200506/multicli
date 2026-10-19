'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { getAgent, listAgents } = require('./registry');

function envValue(env, key, platform = process.platform) {
  if (platform !== 'win32') return env[key];
  const found = Object.keys(env).find(name => name.toLowerCase() === key.toLowerCase());
  return found ? env[found] : undefined;
}

async function resolveExecutable(command, options = {}) {
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const io = options.fs || fs.promises;
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const windows = platform === 'win32';
  const extensions = windows
    ? [...new Set((String(envValue(env, 'PATHEXT', platform) || '.COM;.EXE;.BAT;.CMD') + ';.PS1').split(';')
      .filter(ext => /^\.[a-z0-9]+$/i.test(ext)).map(ext => ext.toLowerCase()))]
    : [''];
  // On Windows an extensionless npm shim is a POSIX script, not a native executable.
  const suffixes = windows && extensions.includes(paths.extname(command).toLowerCase()) ? [''] : extensions;
  const directories = paths.isAbsolute(command) ? [''] : command.includes('/') || command.includes('\\')
    ? [] : String(envValue(env, 'PATH', platform) || '').split(windows ? ';' : ':')
      .map(directory => directory.replace(/^"|"$/g, ''))
      .filter(directory => directory && paths.isAbsolute(directory));
  for (const directory of directories) {
    for (const extension of suffixes) {
      const candidate = directory ? paths.join(directory, command + extension) : command + extension;
      try {
        if (!(await io.stat(candidate)).isFile()) continue;
        await io.access(candidate, windows ? fs.constants.F_OK : fs.constants.X_OK);
        return candidate;
      } catch (error) {
        if (!['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(error.code)) throw error;
      }
    }
  }
  // Useful on Unix installations whose `which` performs additional platform lookup.
  // Never use a shell or accept an option as the executable name.
  if (!windows && !options.disableWhich && /^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/.test(command)) {
    const execute = options.execFile || execFile;
    const found = await new Promise(resolve => {
      execute('/usr/bin/which', [command], { env, timeout: 2000, maxBuffer: 8192, windowsHide: true }, (error, stdout) => {
        resolve(error ? null : String(stdout).split(/\r?\n/)[0].trim());
      });
    });
    if (found && paths.isAbsolute(found)) {
      try {
        if ((await io.stat(found)).isFile()) { await io.access(found, fs.constants.X_OK); return found; }
      } catch { /* Missing or unusable which result is not an installed CLI. */ }
    }
  }
  return null;
}

async function detectAgent(id, options = {}) {
  const agent = getAgent(id);
  if (!agent) throw new Error(`Unknown agent: ${id}`);
  const executable = await resolveExecutable(agent.cmd, options);
  return { id: agent.id, label: agent.label, available: executable !== null, path: executable };
}

async function detectAgents(options = {}) {
  return Promise.all(listAgents().map(agent => detectAgent(agent.id, options)));
}

module.exports = { detectAgent, detectAgents, resolveExecutable, envValue };
