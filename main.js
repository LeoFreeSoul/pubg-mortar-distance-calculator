const { app, BrowserWindow, ipcMain, globalShortcut, screen, Tray, Menu, nativeImage } = require('electron');
const zlib = require('zlib');

let mainWindow;
let overlayWindow;
let toastWindow;
let tray;
let isCapturing = false;
let captureMode = 'measure';
let pxPer100m = null;
let toastReady = false;
let pendingToast = null;
let toastTimer = null;
let currentKeybind = 'Y';
let currentMeasurementAccelerator = null;
let calibrationShortcutAvailable = false;
const CALIBRATION_KEYBIND = 'Alt+Y';

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 400,
    height: 315,
    resizable: false,
    title: 'PUBG 迫击炮测距',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    },
    backgroundColor: '#c0c0c0',
    autoHideMenuBar: true
  });

  mainWindow.loadFile('index.html');

  mainWindow.on('minimize', (event) => {
    event.preventDefault();
    mainWindow.hide();
  });

  mainWindow.on('closed', () => {
    app.quit();
  });
}

function createTray() {
  const trayIcon = createTrayIcon();

  tray = new Tray(trayIcon);
  tray.setToolTip('PUBG 迫击炮测距');

  const menu = Menu.buildFromTemplate([
    {
      label: '显示窗口',
      click: () => {
        if (!mainWindow) return;
        mainWindow.show();
        mainWindow.focus();
      }
    },
    {
      label: '隐藏窗口',
      click: () => {
        if (!mainWindow) return;
        mainWindow.hide();
      }
    },
    { type: 'separator' },
    {
      label: '退出程序',
      click: () => app.quit()
    }
  ]);

  tray.setContextMenu(menu);
  tray.on('click', () => {
    if (!mainWindow) return;
    if (mainWindow.isVisible()) {
      mainWindow.hide();
    } else {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

function createTrayIcon() {
  const pngBuffer = createSolidPng(16, 16, [0, 0, 128, 255]);
  return nativeImage.createFromBuffer(pngBuffer);
}

function createSolidPng(width, height, rgba) {
  const rowSize = width * 4 + 1;
  const raw = Buffer.alloc(rowSize * height);

  for (let y = 0; y < height; y++) {
    const rowOffset = y * rowSize;
    raw[rowOffset] = 0;
    for (let x = 0; x < width; x++) {
      const i = rowOffset + 1 + x * 4;
      raw[i]     = rgba[0];
      raw[i + 1] = rgba[1];
      raw[i + 2] = rgba[2];
      raw[i + 3] = rgba[3];
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8]  = 8;
  ihdr[9]  = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const idat      = zlib.deflateSync(raw);
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

function pngChunk(type, data) {
  const length  = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type);
  const crcBuf  = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([length, typeBuf, data, crcBuf]);
}

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = crcTable[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function buildCrcTable() {
  const table = new Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c >>> 0;
  }
  return table;
}

const crcTable = buildCrcTable();

function createOverlay() {
  const { width, height } = screen.getPrimaryDisplay().bounds;

  overlayWindow = new BrowserWindow({
    width,
    height,
    x: 0,
    y: 0,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: true,
    fullscreen: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  overlayWindow.loadFile('overlay.html');
  overlayWindow.setIgnoreMouseEvents(false);
  overlayWindow.hide();
}

function createToast() {
  const { x, y, width, height } = screen.getPrimaryDisplay().bounds;
  const toastWidth = 320;
  toastWindow = new BrowserWindow({
    width: toastWidth,
    height: 76,
    x: x + Math.round((width - toastWidth) / 2),
    y: y + Math.round(height * 0.12),
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,
    show: false,
    resizable: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });
  toastWindow.setAlwaysOnTop(true, 'screen-saver');
  toastWindow.setIgnoreMouseEvents(true);
  toastWindow.loadFile('toast.html').then(() => {
    toastReady = true;
    if (pendingToast) {
      const message = pendingToast;
      pendingToast = null;
      showToast(message);
    }
  });
}

function hideToast() {
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = null;
  pendingToast = null;
  if (toastWindow && !toastWindow.isDestroyed()) toastWindow.hide();
}

function showToast(message) {
  if (!toastReady) {
    pendingToast = message;
    return;
  }
  if (toastTimer) clearTimeout(toastTimer);
  toastWindow.webContents.send('show-toast', message);
  toastWindow.showInactive();
  toastTimer = setTimeout(() => {
    toastWindow.hide();
    toastTimer = null;
  }, 2400);
}

function clearCalibration(reason = '已清除校准，请按 Alt+Y 重新校准') {
  pxPer100m = null;
  hideToast();
  if (mainWindow) mainWindow.webContents.send('calibration-cleared', reason);
}

function registerKeybind(keybind) {
  if (!keybind || typeof keybind !== 'string') return false;

  const accelerator = keybind.replace(/-/g, '+').replace(/\s/g, '');
  if (accelerator.toLowerCase() === CALIBRATION_KEYBIND.toLowerCase()) return false;
  if (accelerator === currentMeasurementAccelerator) return true;

  const previous = currentMeasurementAccelerator;
  if (previous) globalShortcut.unregister(previous);
  try {
    const registered = globalShortcut.register(accelerator, () => {
      if (!isCapturing) startCapture();
    });
    if (registered) {
      currentMeasurementAccelerator = accelerator;
      return true;
    }
  } catch (e) {
    console.warn(`Keybind rejected by system: ${keybind}`);
  }

  currentMeasurementAccelerator = null;
  if (previous && globalShortcut.register(previous, () => {
    if (!isCapturing) startCapture();
  })) currentMeasurementAccelerator = previous;
  return false;
}

function startCapture(mode = 'measure') {
  if (isCapturing) return;
  if (mode === 'measure' && pxPer100m === null) {
    if (mainWindow) mainWindow.webContents.send('measurement-blocked');
    showToast('未校准，请按 Alt+Y 校准');
    return;
  }
  if (mode === 'calibrate') clearCalibration('正在校准：请选择 100 米格线两端');
  else hideToast();
  isCapturing = true;
  captureMode = mode;
  overlayWindow.show();
  overlayWindow.focus();
  overlayWindow.webContents.send('start-capture', mode);
}

function stopCapture() {
  isCapturing = false;
  overlayWindow.hide();
}

// IPC handlers
ipcMain.on('set-keybind', (event, keybind) => {
  currentKeybind = keybind;
  const ok = registerKeybind(keybind);
  event.reply('keybind-result', ok);
});

ipcMain.on('start-calibration', () => startCapture('calibrate'));

ipcMain.on('clear-calibration', () => {
  if (isCapturing) stopCapture();
  clearCalibration();
});

ipcMain.on('points-captured', (event, points) => {
  if (!isCapturing || !Array.isArray(points) || points.length !== 2) return;
  const dx = points[1].x - points[0].x;
  const dy = points[1].y - points[0].y;
  const mode = captureMode;
  stopCapture();
  if (mode === 'calibrate') {
    const longSide = Math.max(Math.abs(dx), Math.abs(dy));
    const shortSide = Math.min(Math.abs(dx), Math.abs(dy));
    let error = null;
    if (!Number.isFinite(longSide) || longSide < 10) error = '两点太近，请重试校准';
    else if (shortSide > longSide * 0.2) error = '偏斜太大，请沿同一条格线重试';
    if (error) {
      if (mainWindow) mainWindow.webContents.send('calibration-invalid', error);
      showToast(`校准失败：${error}`);
      return;
    }
    // Grid edges are horizontal or vertical; ignore small mouse offset on the other axis.
    pxPer100m = longSide;
    if (mainWindow) mainWindow.webContents.send('calibration-completed', pxPer100m);
    showToast(`已校准：100 米 = ${pxPer100m.toFixed(1)} 像素`);
  } else {
    const pixelDistance = Math.hypot(dx, dy);
    if (pxPer100m === null || !Number.isFinite(pixelDistance)) return;
    const distance = Math.round(pixelDistance / pxPer100m * 100);
    if (mainWindow) mainWindow.webContents.send('measurement-completed', distance);
    showToast(`距离 ${distance} 米`);
  }
});

ipcMain.on('cancel-capture', () => {
  if (!isCapturing) return;
  const mode = captureMode;
  stopCapture();
  if (mainWindow) {
    mainWindow.webContents.send('capture-cancelled', mode);
  }
});

ipcMain.handle('get-calibration-shortcut', () => ({
  keybind: CALIBRATION_KEYBIND,
  available: calibrationShortcutAvailable
}));

app.whenReady().then(() => {
  createMainWindow();
  createOverlay();
  createToast();
  createTray();
  calibrationShortcutAvailable = globalShortcut.register(CALIBRATION_KEYBIND, () => {
    if (!isCapturing) startCapture('calibrate');
  });
  registerKeybind(currentKeybind);
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  app.quit();
});
