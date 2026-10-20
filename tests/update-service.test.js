const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { createUpdateManager } = require('../electron/update-service');

function createFixture({ packaged = true, dialogResponse = 1 } = {}) {
  const autoUpdater = new EventEmitter();
  autoUpdater.checkForUpdates = async () => ({ updateInfo: { version: '1.0.6' } });
  autoUpdater.quitAndInstall = () => { autoUpdater.installed = true; };
  const sent = [];
  const timers = [];
  const window = {
    isDestroyed: () => false,
    webContents: { send: (channel, payload) => sent.push({ channel, payload }) },
  };
  const manager = createUpdateManager({
    autoUpdater,
    app: { isPackaged: packaged, getVersion: () => '1.0.5' },
    dialog: { showMessageBox: async () => ({ response: dialogResponse }) },
    getWindow: () => window,
    setTimeoutFn: (callback, delay) => { timers.push({ callback, delay, type: 'timeout' }); return { unref() {} }; },
    setIntervalFn: (callback, delay) => { timers.push({ callback, delay, type: 'interval' }); return { unref() {} }; },
    logger: { error() {} },
  });
  return { autoUpdater, manager, sent, timers };
}

test('starts packaged automatic checks with safe defaults', () => {
  const fixture = createFixture();
  fixture.manager.start();
  assert.equal(fixture.autoUpdater.autoDownload, true);
  assert.equal(fixture.autoUpdater.autoInstallOnAppQuit, true);
  assert.equal(fixture.autoUpdater.allowPrerelease, false);
  assert.deepEqual(fixture.timers.map((timer) => timer.delay), [10000, 21600000]);
});

test('publishes available and download progress states', () => {
  const fixture = createFixture();
  fixture.manager.start();
  fixture.autoUpdater.emit('update-available', { version: '1.0.6' });
  fixture.autoUpdater.emit('download-progress', { percent: 42.4 });
  assert.equal(fixture.manager.getState().status, 'downloading');
  assert.equal(fixture.manager.getState().availableVersion, '1.0.6');
  assert.equal(fixture.manager.getState().percent, 42);
  assert.equal(fixture.sent.at(-1).channel, 'updater:status');
});

test('keeps downloaded update pending when Later is selected', async () => {
  const fixture = createFixture({ dialogResponse: 1 });
  fixture.manager.start();
  fixture.autoUpdater.emit('update-downloaded', { version: '1.0.6' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fixture.manager.getState().status, 'downloaded');
  assert.equal(fixture.autoUpdater.installed, undefined);
  assert.equal(fixture.manager.installUpdate(), true);
  assert.equal(fixture.autoUpdater.installed, true);
});

test('does not contact update servers in development mode', async () => {
  const fixture = createFixture({ packaged: false });
  fixture.manager.start();
  const state = await fixture.manager.checkForUpdates(true);
  assert.equal(state.status, 'development');
  assert.equal(fixture.timers.length, 0);
});
