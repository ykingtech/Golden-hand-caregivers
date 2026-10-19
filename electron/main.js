const { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const { initializeApp, cert, deleteApp } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore } = require('firebase-admin/firestore');
const { getDatabase } = require('firebase-admin/database');

const { ADMIN_EMAIL, deleteUserCompletely } = require('./delete-service');

const PROJECT_ID = 'care-2a20d';
const DATABASE_URL = 'https://care-2a20d-default-rtdb.asia-southeast1.firebasedatabase.app';
const SEYLAN_CORPORATE_URL = 'https://www.seylanbank.lk/corporate/login';
const SEYLAN_ALLOWED_HOSTS = new Set(['seylanbank.lk', 'www.seylanbank.lk', 'seylan.lk', 'www.seylan.lk']);
let mainWindow = null;
let seylanWindow = null;
let adminApp = null;
let inMemoryCredential = null;

function appIconPath() {
  return path.join(__dirname, '..', 'assets', 'icon.png');
}

function isAllowedSeylanUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return url.protocol === 'https:' && SEYLAN_ALLOWED_HOSTS.has(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

function openSeylanWindow() {
  if (seylanWindow && !seylanWindow.isDestroyed()) {
    seylanWindow.show();
    seylanWindow.focus();
    return;
  }

  seylanWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 980,
    minHeight: 680,
    parent: mainWindow,
    modal: false,
    autoHideMenuBar: true,
    title: 'Seylan Corporate Banking — Golden Hand Admin',
    icon: appIconPath(),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      partition: 'persist:seylan-corporate-banking',
    },
  });

  seylanWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedSeylanUrl(url)) seylanWindow.loadURL(url);
    return { action: 'deny' };
  });
  seylanWindow.webContents.on('will-navigate', (event, url) => {
    if (!isAllowedSeylanUrl(url)) event.preventDefault();
  });
  seylanWindow.on('closed', () => {
    seylanWindow = null;
  });
  seylanWindow.loadURL(SEYLAN_CORPORATE_URL);
}

function credentialStorePath() {
  return path.join(app.getPath('userData'), 'firebase-service-account.bin');
}

function assertLocalRenderer(event) {
  const sourceUrl = event.senderFrame?.url || '';
  if (!sourceUrl.startsWith('file://')) throw new Error('Administrator operations are only available from the local desktop dashboard.');
}

function readStoredCredential() {
  if (inMemoryCredential) return inMemoryCredential;
  const storePath = credentialStorePath();
  if (!fs.existsSync(storePath)) return null;
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows credential encryption is unavailable. Select the service-account file again for this session.');
  const encrypted = fs.readFileSync(storePath);
  return JSON.parse(safeStorage.decryptString(encrypted));
}

async function closeAdminApp() {
  if (adminApp) await deleteApp(adminApp);
  adminApp = null;
}

async function servicesFor(serviceAccount = null) {
  if (serviceAccount) {
    await closeAdminApp();
    inMemoryCredential = serviceAccount;
  }
  if (!adminApp) {
    const account = serviceAccount || readStoredCredential();
    if (!account) throw new Error('SERVICE_ACCOUNT_REQUIRED');
    if (account.project_id !== PROJECT_ID) throw new Error(`The selected key belongs to ${account.project_id || 'an unknown project'}, not ${PROJECT_ID}.`);
    adminApp = initializeApp({
      credential: cert(account),
      projectId: PROJECT_ID,
      databaseURL: DATABASE_URL,
    }, 'golden-hand-local-admin');
  }
  return {
    auth: getAuth(adminApp),
    db: getFirestore(adminApp),
    realtimeDb: getDatabase(adminApp),
  };
}

async function configureCredential() {
  const selection = await dialog.showOpenDialog(mainWindow, {
    title: 'Select care-2a20d Firebase service-account JSON',
    properties: ['openFile'],
    filters: [{ name: 'JSON files', extensions: ['json'] }],
  });
  if (selection.canceled || !selection.filePaths[0]) return { configured: false };

  const account = JSON.parse(fs.readFileSync(selection.filePaths[0], 'utf8'));
  if (account.project_id !== PROJECT_ID || !account.client_email || !account.private_key) {
    throw new Error(`Select a valid service-account key for ${PROJECT_ID}.`);
  }
  const services = await servicesFor(account);
  await services.auth.listUsers(1);

  let persisted = false;
  if (safeStorage.isEncryptionAvailable()) {
    fs.mkdirSync(path.dirname(credentialStorePath()), { recursive: true });
    fs.writeFileSync(credentialStorePath(), safeStorage.encryptString(JSON.stringify(account)));
    persisted = true;
  }
  return { configured: true, persisted, projectId: PROJECT_ID };
}

async function verifyDesktopAdmin(auth, idToken) {
  if (!idToken || typeof idToken !== 'string') throw new Error('Administrator sign-in token is missing.');
  const decoded = await auth.verifyIdToken(idToken, true);
  if (decoded.email_verified !== true || (decoded.email || '').toLowerCase() !== ADMIN_EMAIL) {
    throw new Error('Verified Golden Hand administrator access is required.');
  }
  return decoded;
}

function registerIpc() {
  ipcMain.handle('admin:get-credential-status', async (event) => {
    assertLocalRenderer(event);
    return { configured: Boolean(inMemoryCredential || fs.existsSync(credentialStorePath())), projectId: PROJECT_ID };
  });

  ipcMain.handle('admin:configure-credentials', async (event) => {
    assertLocalRenderer(event);
    return configureCredential();
  });

  ipcMain.handle('portal:open-seylan', async (event) => {
    assertLocalRenderer(event);
    openSeylanWindow();
    return { opened: true };
  });

  ipcMain.handle('admin:delete-user-completely', async (event, request) => {
    assertLocalRenderer(event);
    const uid = typeof request?.uid === 'string' ? request.uid.trim() : '';
    const { auth, db, realtimeDb } = await servicesFor();
    const administrator = await verifyDesktopAdmin(auth, request?.idToken);
    if (!uid) throw new Error('A target user ID is required.');

    let targetLabel = uid;
    try {
      const target = await auth.getUser(uid);
      targetLabel = target.email || target.displayName || uid;
    } catch (error) {
      if (error.code !== 'auth/user-not-found') throw error;
    }
    const confirmation = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      title: 'Permanently delete account',
      message: `Delete ${targetLabel}?`,
      detail: 'Firebase Auth and all linked Firestore/Realtime Database records will be removed. This cannot be undone.',
      buttons: ['Cancel', 'Delete permanently'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (confirmation.response !== 1) throw new Error('Deletion cancelled.');

    return deleteUserCompletely({ auth, db, realtimeDb, uid, adminUid: administrator.uid });
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1500,
    height: 950,
    minWidth: 1100,
    minHeight: 700,
    show: false,
    icon: appIconPath(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.loadFile(path.join(__dirname, '..', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) event.preventDefault();
  });
}

app.whenReady().then(() => {
  registerIpc();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  closeAdminApp().catch(() => {});
});
