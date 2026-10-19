'use strict';

/**
 * Renderer integration test — boots the real renderer inside the real window
 * (real preload, real main-process IPC handlers) and drives the context panel
 * through a live topic subscription.
 *
 *   npm run test:renderer
 *
 * Requires an Electron runtime, so it runs under `electron`, not `node --test`.
 * Exits non-zero on the first assertion failure, renderer console error, or timeout.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { app, BrowserWindow } = require('electron');

const { createContextStore } = require('../core/context');
const { TOPIC_IDS } = require('../core/context/topics');
const main = require('../ipc/main');

const SETTLE_MS = 400;
const WAIT_MS = 5000;
const GLOBAL_TIMEOUT_MS = 45000;

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');

// This file owns the app lifecycle (bootstrap never runs here), so suppress
// Electron's default quit-on-last-window: run() tears the window down while
// cleaning up, and the report must still be able to print afterwards.
app.on('window-all-closed', () => {});

const checks = [];
const consoleProblems = [];
const notes = [];
const output = [];

function record(name, ok, detail) {
  checks.push({ name, ok, detail });
  output.push(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n          ${detail}`}`);
}

function check(name, fn) {
  try {
    fn();
    record(name, true);
  } catch (error) {
    record(name, false, error.message);
  }
}

async function checkAsync(name, fn) {
  try {
    await fn();
    record(name, true);
  } catch (error) {
    record(name, false, error.message);
  }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Poll a page expression until it returns a truthy value (or the deadline passes). */
async function waitFor(webContents, expression, timeout = WAIT_MS) {
  const deadline = Date.now() + timeout;
  let last = null;
  while (Date.now() < deadline) {
    last = await webContents.executeJavaScript(expression);
    if (last) return last;
    await sleep(50);
  }
  return last;
}

function textOf(webContents, selector) {
  return webContents.executeJavaScript(`(document.querySelector(${JSON.stringify(selector)}) || {}).textContent || ''`);
}

/**
 * Windows keeps a watch handle on the context directory until the last
 * subscription drops, so the temp workspace can still be locked at teardown.
 * Retry briefly and treat a stubborn directory as a note, not a test failure.
 */
async function removeTree(target, attempts = 5) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await fs.rm(target, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === attempts) return notes.push(`temp workspace left behind (${error.code}): ${target}`);
      await sleep(100 * attempt);
    }
  }
}

async function run() {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'mosaic-renderer-'));
  const otherPane = createContextStore({ workspaceRoot, paneId: 'pane-other' });
  let win = null;

  try {
    // Importing the app entry must not claim the app lifecycle: this test owns
    // the window so it can drive the real handlers from the outside.
    check('importing the app entry does not open a window', () => {
      assert.equal(BrowserWindow.getAllWindows().length, 0);
    });

    main.initWorkspace(workspaceRoot);
    main.registerHandlers();

    win = main.createWindow({ show: false });
    const wc = win.webContents;
    wc.on('console-message', (...args) => {
      const entry = args[0] && typeof args[0] === 'object' && 'message' in args[0]
        ? args[0]
        : { message: args[2], level: args[1], sourceId: args[4], lineNumber: args[3] };
      const level = entry.level;
      const isProblem = level === 'error' || level === 2 || level === 'warning';
      if (isProblem) consoleProblems.push(entry.message);
    });
    if (wc.isLoading()) await once(wc, 'did-finish-load');

    await checkAsync('renderer boots and stamps the version through preload', async () => {
      const version = await waitFor(wc, `document.getElementById('versionInfo').textContent`);
      assert.match(String(version), /^v\d/, `version element showed ${JSON.stringify(version)}`);
    });

    await checkAsync('renderer owns no privileged globals beyond window.mosaic', async () => {
      const probe = await wc.executeJavaScript(
        `({ hasApi: typeof window.mosaic === 'object' && window.mosaic !== null, hasRequire: typeof window.require !== 'undefined' })`
      );
      assert.equal(probe.hasApi, true);
      assert.equal(probe.hasRequire, false);
    });

    // Same call the 'workspace:open' handler makes once the folder dialog resolves.
    await checkAsync('opening a workspace publishes the topic list', async () => {
      const opened = await main.openWorkspace(workspaceRoot);
      assert.equal(opened.ok, true);
      const indicator = await waitFor(wc, `document.getElementById('workspaceIndicator').textContent`);
      assert.equal(indicator, path.basename(workspaceRoot));
      const topics = await waitFor(wc, `document.querySelectorAll('.topic-item').length`);
      assert.equal(topics, TOPIC_IDS.length, `expected ${TOPIC_IDS.length} topics, saw ${topics}`);
    });

    const clickTopic = topicId => wc.executeJavaScript(
      `document.querySelector('[data-topic-id="${topicId}"]').click(); true`
    );

    await checkAsync('selecting a topic subscribes and paints its current contents', async () => {
      await clickTopic('goal');
      const entries = await waitFor(wc, `document.getElementById('contextEntries').textContent`);
      assert.equal(entries, '{}', `context panel showed ${JSON.stringify(entries)}`);
      const active = await wc.executeJavaScript(
        `document.querySelector('.topic-item[data-topic-id="goal"]').classList.contains('active')`
      );
      assert.equal(active, true);
    });

    await checkAsync('a write from another pane reaches the panel without polling', async () => {
      await otherPane.write('goal', { task: 'wire the context panel' }, { id: 'entry-live', pane: 'pane-other' });
      const shown = await waitFor(wc, `document.getElementById('contextEntries').textContent.includes('wire the context panel')`);
      assert.equal(shown, true, 'live entry never arrived in the context panel');
    });

    await checkAsync('switching topics re-subscribes instead of leaking the old watch', async () => {
      await clickTopic('note');
      const cleared = await waitFor(wc, `document.getElementById('contextEntries').textContent === '{}'`);
      assert.equal(cleared, true, 'note topic never became active');

      await otherPane.write('note', { memo: 'note-marker' }, { id: 'entry-note', pane: 'pane-other' });
      const noteShown = await waitFor(wc, `document.getElementById('contextEntries').textContent.includes('note-marker')`);
      assert.equal(noteShown, true, 'the newly subscribed topic never updated');

      await otherPane.write('goal', { task: 'stale-marker' }, { id: 'entry-stale', pane: 'pane-other' });
      await sleep(SETTLE_MS);
      const entries = await textOf(wc, '#contextEntries');
      assert.ok(!entries.includes('stale-marker'), 'the abandoned goal subscription still pushed updates');
    });

    await checkAsync('no renderer console errors or warnings', () => {
      assert.deepEqual(consoleProblems, []);
    });
  } finally {
    // Tear the window down before the workspace: the renderer's open topic
    // subscription holds a watch handle inside it.
    if (win && !win.isDestroyed()) win.destroy();
    otherPane.close();
    await removeTree(workspaceRoot);
  }
}

function report() {
  const failed = checks.filter(entry => !entry.ok);
  console.log('mosaic renderer integration test');
  for (const line of output) console.log(line);
  if (consoleProblems.length) {
    console.log('  renderer console problems:');
    for (const problem of consoleProblems) console.log(`    - ${problem}`);
  }
  for (const note of notes) console.log(`  note: ${note}`);
  console.log(failed.length ? `\nRESULT: FAIL (${failed.length}/${checks.length})` : `\nRESULT: PASS (${checks.length}/${checks.length})`);
  return failed.length === 0;
}

app.whenReady().then(async () => {
  const timer = setTimeout(() => {
    console.log('\nRESULT: FAIL (timed out)');
    app.exit(1);
  }, GLOBAL_TIMEOUT_MS);
  timer.unref();

  let ok = false;
  try {
    await run();
    ok = report();
  } catch (error) {
    record('test harness', false, error.stack || error.message);
    ok = report();
  }
  clearTimeout(timer);
  for (const win of BrowserWindow.getAllWindows()) win.destroy();
  app.exit(ok ? 0 : 1);
});
