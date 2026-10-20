function createUpdateManager({
  autoUpdater,
  app,
  dialog,
  getWindow,
  setTimeoutFn = setTimeout,
  setIntervalFn = setInterval,
  logger = console,
}) {
  let started = false;
  let checking = false;
  let state = {
    status: 'idle',
    currentVersion: app.getVersion(),
    availableVersion: null,
    percent: 0,
    message: 'Automatic updates are ready.',
  };

  function currentWindow() {
    const window = getWindow();
    return window && !window.isDestroyed() ? window : null;
  }

  function publish(patch) {
    state = { ...state, ...patch };
    const window = currentWindow();
    if (window) window.webContents.send('updater:status', { ...state });
    return { ...state };
  }

  function showMessage(options) {
    const window = currentWindow();
    return window ? dialog.showMessageBox(window, options) : dialog.showMessageBox(options);
  }

  function installUpdate() {
    if (state.status !== 'downloaded') return false;
    autoUpdater.quitAndInstall(false, true);
    return true;
  }

  async function checkForUpdates(manual = false) {
    if (!app.isPackaged) {
      return publish({ status: 'development', message: 'Update checks run in the installed app.' });
    }
    if (checking) return { ...state };

    checking = true;
    publish({ status: 'checking', percent: 0, message: 'Checking for updates…' });
    try {
      await autoUpdater.checkForUpdates();
    } catch (error) {
      logger.error('Automatic update check failed', error);
      publish({ status: 'error', message: error.message || 'Update check failed.' });
      if (manual) {
        await showMessage({
          type: 'error',
          title: 'Update check failed',
          message: 'Golden Hand Admin could not check for updates.',
          detail: error.message || 'Check the internet connection and try again.',
          buttons: ['OK'],
        });
      }
    } finally {
      checking = false;
    }
    return { ...state };
  }

  function start() {
    if (started) return;
    started = true;

    if (!app.isPackaged) {
      publish({ status: 'development', message: 'Update checks run in the installed app.' });
      return;
    }

    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.allowPrerelease = false;

    autoUpdater.on('checking-for-update', () => {
      publish({ status: 'checking', percent: 0, message: 'Checking for updates…' });
    });
    autoUpdater.on('update-available', (info) => {
      publish({
        status: 'downloading',
        availableVersion: info.version,
        percent: 0,
        message: `Downloading version ${info.version}…`,
      });
    });
    autoUpdater.on('update-not-available', () => {
      publish({
        status: 'up-to-date',
        availableVersion: null,
        percent: 100,
        message: `Version ${app.getVersion()} is up to date.`,
      });
    });
    autoUpdater.on('download-progress', (progress) => {
      const percent = Math.max(0, Math.min(100, Math.round(progress.percent || 0)));
      publish({ status: 'downloading', percent, message: `Downloading update… ${percent}%` });
    });
    autoUpdater.on('update-downloaded', async (info) => {
      publish({
        status: 'downloaded',
        availableVersion: info.version,
        percent: 100,
        message: `Version ${info.version} is ready to install.`,
      });
      const response = await showMessage({
        type: 'info',
        title: 'Golden Hand Admin update ready',
        message: `Version ${info.version} has been downloaded.`,
        detail: 'Restart now to install it, or choose Later. It will install automatically when the app closes.',
        buttons: ['Restart and install', 'Later'],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      });
      if (response.response === 0) installUpdate();
    });
    autoUpdater.on('error', (error) => {
      logger.error('Automatic updater error', error);
      publish({ status: 'error', message: error.message || 'Automatic update failed.' });
    });

    const startupTimer = setTimeoutFn(() => checkForUpdates(false), 10000);
    const intervalTimer = setIntervalFn(() => checkForUpdates(false), 6 * 60 * 60 * 1000);
    startupTimer?.unref?.();
    intervalTimer?.unref?.();
  }

  return {
    start,
    checkForUpdates,
    installUpdate,
    getState: () => ({ ...state }),
  };
}

module.exports = { createUpdateManager };
