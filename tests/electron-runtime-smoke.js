const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const resultPath = process.env.GOLDEN_HAND_SMOKE_RESULT;

function finish(exitCode, payload) {
  if (resultPath) fs.writeFileSync(resultPath, JSON.stringify(payload, null, 2));
  app.exit(exitCode);
}

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'electron', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  try {
    await window.loadFile(path.join(__dirname, '..', 'index.html'));
    await wait(5000);
    const result = await window.webContents.executeJavaScript(`(() => {
      renderDesktopUpdateStatus({
        currentVersion: '1.0.6',
        status: 'downloading',
        percent: 37,
        message: 'Runtime updater test'
      });
      return {
        title: document.title,
        updaterPanel: Boolean(document.getElementById('desktop-update-status')),
        updaterText: document.getElementById('desktop-update-status')?.textContent,
        updaterProgress: document.getElementById('desktop-update-progress')?.style.width,
        checkDisabled: document.getElementById('desktop-check-update')?.disabled,
        draggableTabs: document.querySelectorAll('aside nav ul > li[draggable=true]').length,
        liveSummary: Boolean(document.getElementById('ops-job-list')),
        callCenterFullscreen: typeof toggleCallCenterFullscreen,
        mapFullscreen: typeof toggleMapFullscreen,
        accountCreated: Boolean(document.getElementById('modal-account-created')),
        updateBridge: Boolean(window.goldenHandAdmin?.checkForUpdates),
        manualAssignmentsSection: Boolean(document.getElementById('section-manualjobs')),
        manualAssignmentModal: Boolean(document.getElementById('manual-assignment-modal')),
        manualStaffPicker: Boolean(document.getElementById('manual-staff-picker-banner')),
        manualStaffSelector: typeof selectManualStaff,
        manualAssignmentLoader: typeof loadManualAssignments,
        manualAssignmentSaver: typeof saveManualAssignment,
        releaseNotesPopup: typeof showPendingDesktopReleaseNotes,
        companyBankSettings: Boolean(document.getElementById('setting-company-account-number'))
      };
    })()`);

    const expected = {
      updaterPanel: true,
      updaterText: 'Runtime updater test',
      updaterProgress: '37%',
      checkDisabled: true,
      liveSummary: true,
      callCenterFullscreen: 'function',
      mapFullscreen: 'function',
      accountCreated: true,
      updateBridge: true,
      manualAssignmentsSection: true,
      manualAssignmentModal: true,
      manualStaffPicker: true,
      manualStaffSelector: 'function',
      manualAssignmentLoader: 'function',
      manualAssignmentSaver: 'function',
      releaseNotesPopup: 'function',
      companyBankSettings: true,
    };
    for (const [key, value] of Object.entries(expected)) {
      if (result[key] !== value) throw new Error(`${key}: expected ${value}, received ${result[key]}`);
    }
    if (result.draggableTabs < 15) throw new Error(`Only ${result.draggableTabs} sidebar tabs became draggable.`);
    finish(0, { ok: true, result });
  } catch (error) {
    finish(1, { ok: false, error: error.stack || error.message || String(error) });
  }
});
