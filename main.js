const { app, BrowserWindow, ipcMain, globalShortcut, screen, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const zlib = require('zlib');

let mainWindow;
let overlayWindow;
let tray;
let isCapturing = false;
let capturedPoints = [];
let currentKeybind = 'Y';

// px per 100m at max zoom, keyed by game width resolution
// borderless = game res matches display res
const PX_PER_100M_TABLE = {
  1280: 97.1,
  1366: 103.6,
  1600: 121.3,
  1920: 147.0,
  2560: 196.0,
  3840: 294.0,
};

function getPhysicalResolution() {
  const display = screen.getPrimaryDisplay();
  const { width, height } = display.bounds;
  const scale = display.scaleFactor;
  return {
    width:  Math.round(width  * scale),
    height: Math.round(height * scale)
  };
}

function getPxPer100m() {
  const { width } = getPhysicalResolution();
  // exact match
  if (PX_PER_100M_TABLE[width]) return PX_PER_100M_TABLE[width];
  // linear interpolate between nearest two entries
  const keys = Object.keys(PX_PER_100M_TABLE).map(Number).sort((a, b) => a - b);
  for (let i = 0; i < keys.length - 1; i++) {
    const lo = keys[i], hi = keys[i + 1];
    if (width >= lo && width <= hi) {
      const t = (width - lo) / (hi - lo);
      return PX_PER_100M_TABLE[lo] + t * (PX_PER_100M_TABLE[hi] - PX_PER_100M_TABLE[lo]);
    }
  }
  // fallback: scale linearly from 1920 baseline
  return (width / 1920) * 147.0;
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 420,
    height: 420,
    resizable: false,
    title: 'PUBG Mortar Calc',
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
  tray.setToolTip('PUBG Mortar Calc');

  const menu = Menu.buildFromTemplate([
    {
      label: 'Show',
      click: () => {
        if (!mainWindow) return;
        mainWindow.show();
        mainWindow.focus();
      }
    },
    {
      label: 'Hide',
      click: () => {
        if (!mainWindow) return;
        mainWindow.hide();
      }
    },
    { type: 'separator' },
    {
      label: 'Quit',
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

function registerKeybind(keybind) {
  globalShortcut.unregisterAll();
  if (!keybind || typeof keybind !== 'string') return false;

  try {
    // Convert hyphens to pluses and remove spaces to better match Electron's format
    const accelerator = keybind.replace(/-/g, '+').replace(/\s/g, '');
    const registered = globalShortcut.register(accelerator, () => {
      if (!isCapturing) startCapture();
    });
    return registered;
  } catch (e) {
    // Return false gracefully without dumping a massive warning/stack trace if invalid
    console.warn(`Keybind rejected by system: ${keybind}`);
    return false;
  }
}

function startCapture() {
  isCapturing = true;
  capturedPoints = [];
  overlayWindow.show();
  overlayWindow.focus();
  overlayWindow.webContents.send('start-capture');
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

ipcMain.on('points-captured', (event, points) => {
  stopCapture();
  if (mainWindow) {
    mainWindow.webContents.send('points-captured', points);
  }
});

ipcMain.on('cancel-capture', () => {
  stopCapture();
  if (mainWindow) {
    mainWindow.webContents.send('capture-cancelled');
  }
});

ipcMain.on('mouse-position', (event, pos) => {
  if (mainWindow) {
    mainWindow.webContents.send('mouse-position', pos);
  }
});

// Renderer asks for the scale at startup
ipcMain.handle('get-scale', () => {
  const { width, height } = getPhysicalResolution();
  const pxPer100m = getPxPer100m();
  return { width, height, pxPer100m };
});

app.whenReady().then(() => {
  createMainWindow();
  createOverlay();
  createTray();
  registerKeybind(currentKeybind);
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  app.quit();
});
