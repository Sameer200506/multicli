'use strict';

/**
 * Renderer smoke test — boots the app's real window (main.createWindow, so the
 * real preload path and webPreferences are exercised) with the real IPC handler
 * registry, captures every console message, page/load failure and unhandled
 * rejection, then probes the DOM to confirm the desk actually initialized.
 *
 *   npm run smoke
 *
 * Exits non-zero if the renderer logged an error or the UI did not boot.
 */

const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');
const main = require('../ipc/main');

const BOOT_TIMEOUT_MS = 2500;

const problems = [];
const logs = [];

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');

function record(level, message, source, line) {
  logs.push({ level, message, source, line });
  if (level === 'error' || level === 'warning') {
    problems.push(`[${level}] ${message}${source ? ` (${path.basename(source)}:${line})` : ''}`);
  }
}

async function run() {
  // A missing preload silently disables window.mosaic, so assert it up front.
  if (!fs.existsSync(main.PRELOAD)) problems.push(`preload not found at ${main.PRELOAD}`);

  main.registerHandlers();
  const win = main.createWindow({ show: false });
  const wc = win.webContents;

  // Electron >= 30 may emit either (event, level, message, line, sourceId)
  // or a single event object. Support both so the harness is version-proof.
  wc.on('console-message', (...args) => {
    if (args[0] && typeof args[0] === 'object' && 'message' in args[0]) {
      const e = args[0];
      record(levelName(e.level), e.message, e.sourceId, e.lineNumber);
    } else {
      const [, level, message, line, sourceId] = args;
      record(levelName(level), message, sourceId, line);
    }
  });

  wc.on('did-fail-load', (_event, code, description, url) => {
    problems.push(`did-fail-load ${code} ${description} ${url}`);
  });
  wc.on('render-process-gone', (_event, details) => {
    problems.push(`render-process-gone: ${details.reason}`);
  });
  wc.on('preload-error', (_event, preloadPath, error) => {
    problems.push(`preload-error ${path.basename(preloadPath)}: ${error.message}`);
  });

  if (wc.isLoading()) await new Promise(resolve => wc.once('did-finish-load', resolve));
  await new Promise(resolve => setTimeout(resolve, BOOT_TIMEOUT_MS));

  const probe = await wc.executeJavaScript(`(() => {
    const version = document.getElementById('versionInfo');
    return {
      versionText: version ? version.textContent : null,
      workspaceText: (document.getElementById('workspaceIndicator') || {}).textContent,
      paneCount: document.querySelectorAll('.pane').length,
      hasMosaicApi: typeof window.mosaic === 'object' && window.mosaic !== null,
      apiGroups: window.mosaic ? Object.keys(window.mosaic).sort() : [],
      gridPresent: !!document.getElementById('paneGrid'),
      contextPanelPresent: !!document.getElementById('contextPanel'),
      topicItems: document.querySelectorAll('.topic-item').length,
    };
  })()`);

  report(probe);
  win.destroy();
  app.exit(problems.length === 0 && probe.ok ? 0 : 1);
}

function levelName(level) {
  if (level === 0 || level === 'verbose' || level === 'debug') return 'debug';
  if (level === 1 || level === 'info') return 'info';
  if (level === 2 || level === 'warning') return 'warning';
  return 'error';
}

function report(probe) {
  // The version is fetched over IPC, so a stamped version proves the preload
  // bridge and the main-process handler registry are both live.
  const initialized = probe.hasMosaicApi === true && /^v\d/.test(String(probe.versionText || ''));
  const ok = problems.length === 0 && initialized && probe.gridPresent && probe.contextPanelPresent;
  probe.ok = ok;

  console.log('mosaic renderer smoke test');
  console.log('  shell loaded        :', probe.gridPresent ? 'yes' : 'no');
  console.log('  preload api exposed :', probe.hasMosaicApi ? `yes (${probe.apiGroups.join(', ')})` : 'no');
  console.log('  version stamped     :', probe.versionText);
  console.log('  panes rendered      :', probe.paneCount);
  console.log('  console messages    :', logs.length ? logs.length : 'none');
  for (const log of logs) console.log(`    [${log.level}] ${log.message}`);
  if (problems.length) {
    console.log('  problems:');
    for (const problem of problems) console.log(`    - ${problem}`);
  }
  console.log(ok ? '\nRESULT: PASS' : '\nRESULT: FAIL');
}

app.whenReady().then(() =>
  run().catch(error => {
    console.error('smoke harness crashed:', error);
    app.exit(1);
  })
);
