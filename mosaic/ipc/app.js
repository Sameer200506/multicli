'use strict';

/**
 * Electron entry point (package.json "main").
 *
 * Kept deliberately separate from main.js so the window factory and IPC handler
 * registry stay importable from tests: importing main.js must never open a
 * window or claim the app lifecycle on its own.
 */

const { bootstrap } = require('./main');

bootstrap();
