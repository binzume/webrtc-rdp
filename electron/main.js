const { app, ipcMain, BrowserWindow, Tray, Menu, desktopCapturer, screen, systemPreferences } = require('electron');
const path = require('path');
const robot = require("hurdle-robotjs");
const ffi = require('ffi-napi');
const { hasScreenCapturePermission, hasPromptedForPermission, openSystemPreferences } = require('mac-screen-capture-permissions');

const user32 = process.platform == 'win32' && ffi.Library("user32.dll", {
  'GetWindowRect': ["bool", ["int32", "pointer"]],
  'SetForegroundWindow': ["bool", ["int32"]],
  'WindowFromPoint': ["int32", ["int64"]], // TODO; struct POINT
  'GetAncestor': ["int32", ["int32", "int32"]],
});

function GetWindowRect(hWnd) {
  let rectBuf = Buffer.alloc(16);
  if (!user32) {
    return null;
  }
  if (!user32.GetWindowRect(hWnd, rectBuf)) {
    return null;
  }
  return {
    left: rectBuf.readInt32LE(0),
    top: rectBuf.readInt32LE(4),
    right: rectBuf.readInt32LE(8),
    bottom: rectBuf.readInt32LE(12),
  };
}

function SetForegroundWindow(hWnd) {
  if (!user32) {
    return false;
  }
  return user32.SetForegroundWindow(hWnd);
}

function WindowFromPoint(x, y) {
  if (!user32) {
    return 0;
  }
  let hWnd = user32.WindowFromPoint(Math.floor(x) + (Math.floor(y) * (2 ** 32)));
  return hWnd != 0 ? user32.GetAncestor(hWnd, 2) : 0;
}

class InputManager {
  constructor() {
    /** @type {Record<string, Electron.Display>} */
    this.displays = {};
    /** @type {Record<string, Electron.DesktopCapturerSource[]>} */
    this.sources = [];
    this.specialKeys = {
      Control: 'control', Shift: 'shift', Alt: 'alt', Meta: 'command', Insert: 'insert',
      Enter: 'enter', Backspace: 'backspace', Tab: 'tab', Escape: 'escape', Delete: 'delete',
      Home: 'home', End: 'end', PageUp: 'pageup', PageDown: 'pagedown',
      ArrowLeft: 'left', ArrowUp: 'up', ArrowRight: 'right', ArrowDown: 'down',
      F1: 'f1', F2: 'f2', F3: 'f3', F4: 'f4', F5: 'f5', F6: 'f6',
      F7: 'f7', F8: 'f8', F9: 'f9', F10: 'f10', F11: 'f11', F12: 'f12',
      ' ': 'space', 'Space': 'space'
    };
    robot.setKeyboardDelay(1);
    robot.setMouseDelay(1);
  }
  async updateSources(types = ['screen']) {
    this.sources = await desktopCapturer.getSources({ types: types, thumbnailSize: { width: 0, height: 0 }, fetchWindowIcons: false });
    if (types.includes('screen')) {
      this.displays = {};
      for (let d of screen.getAllDisplays()) {
        this.displays[d.id] = d;
      }
    }
  }
  getSourceInfos() {
    return this.sources.map(s => ({
      id: s.id,
      name: s.name,
      display_id: s.display_id,
    }));
  }
  _getWindowId(target) {
    let m = target?.id?.match(/^window:(\d+):/);
    return m ? m[1] : null;
  }
  sendMouse(mouseMessage) {
    let { target, action, x, y, button } = mouseMessage;
    let windowId = this._getWindowId(target);
    let d = this.displays[target.display_id];
    if (windowId) {
      action != 'move' && SetForegroundWindow(windowId);
      this.moveMouse_window(windowId, x, y);
    } else if (d) {
      this.moveMouse_display(d, x, y);
    } else {
      console.log("invalid target. use primary display.", target);
      this.moveMouse_display(screen.getPrimaryDisplay(), x, y);
    }
    let buttonStr = ['left', 'middle', 'right'][button] || 'left';
    if (action == 'click') {
      robot.mouseClick(buttonStr);
    } else if (action == 'mouseup' || action == 'up') {
      robot.mouseToggle('up', buttonStr);
    } else if (action == 'mousedown' || action == 'down') {
      robot.mouseToggle('down', buttonStr);
    }
  }
  moveMouse_display(d, x, y) {
    let p = this._toScreenPoint(d, x, y);
    robot.moveMouse(p.x, p.y);
  }
  moveMouse_window(windowId, x, y) {
    let rect = GetWindowRect(windowId);
    if (rect) {
      let sx = rect.left + (rect.right - rect.left) * x;
      let sy = rect.top + (rect.bottom - rect.top) * y;
      robot.moveMouse(sx, sy);
    }
  }
  sendKey(keyMessage) {
    let { target, action, key } = keyMessage;
    let modifiers = keyMessage.modifiers || [];
    let windowId = this._getWindowId(target);
    windowId && SetForegroundWindow(windowId);

    if (key == 'Unidentified') {
      return;
    } else if (key == 'KanaMode' || key == 'HiraganaKatakana') {
      // Robot.js doesn't support KanaMode key.
      key = ' ';
      modifiers = ['control'];
    }

    if (this.specialKeys[key]) {
      key = this.specialKeys[key];
    } else if (/^[A-Za-z0-9]$/.test(key)) {
      if (/[A-Z]/.test(key)) {
        modifiers.push('shift');
      }
    } else {
      action == 'press' && robot.typeString(key);
      return;
    }
    if (action == 'press') {
      // robot.keyTap(key, modifiers);
      robot.keyToggle(key, 'down', modifiers);
      robot.keyToggle(key, 'up', modifiers);
    } else {
      robot.keyToggle(key, action, modifiers);
    }
  }
  streamFromPoint(target, x, y) {
    let d = this.displays[target.display_id];
    if (d == null) {
      console.log('invalid target: ', target);
      return null;
    }
    let p = this._toScreenPoint(d, x, y);
    let hWnd = WindowFromPoint(p.x, p.y);
    if (!hWnd) {
      return null;
    }
    let rect = GetWindowRect(hWnd);
    let r = null;
    if (rect) {
      let p0 = this._fromScreenPoint(d, rect.left, rect.top);
      let p1 = this._fromScreenPoint(d, rect.right, rect.bottom);
      r = { x: p0.x, y: p0.y, width: p1.x - p0.x, height: p1.y - p0.y };
    }
    return { id: `window:${hWnd}:0`, rect: r, rawRect: rect };
  }
  _toScreenPoint(d, x, y) {
    let p = { x: d.bounds.x + d.bounds.width * x, y: d.bounds.y + d.bounds.height * y };
    return process.platform == 'win32' ? screen.dipToScreenPoint(p) : p;
  }
  _fromScreenPoint(d, x, y) {
    let p = process.platform == 'win32' ? screen.screenToDipPoint({ x: x, y: y }) : { x: x, y: y };
    return { x: (p.x - d.bounds.x) / d.bounds.width, y: (p.y - d.bounds.y) / d.bounds.height }; // TODO: dip
  }
}

class RDPApp {
  constructor() {
    this.mainWindow = null;
    this.tray = this.createTray();
    this.inputManager = new InputManager();
    this.createWindow();
  }
  createWindow() {
    if (this.mainWindow) {
      return;
    }
    const window = new BrowserWindow({
      width: 640,
      height: 480,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
      }
    });

    window.addListener('minimize', (ev) => {
      window.hide();
      ev.preventDefault();
    });
    window.addListener('closed', (ev) => {
      this.mainWindow = null;
    });

    window.loadFile('index.html');
    if (process.argv.includes('--debug')) {
      window.webContents.openDevTools();
    }
    this.mainWindow = window;
  }
  createTray() {
    let iconPath = __dirname + '/images/icon1.png';
    let contextMenu = Menu.buildFromTemplate([
      { label: 'Settings', click: () => this.mainWindow.show() },
      { label: 'Reload', click: () => this.mainWindow.reload() },
      { type: 'separator' },
      { label: 'Quit', role: 'quit' },
    ]);
    let tray = new Tray(iconPath);
    tray.setContextMenu(contextMenu);
    tray.setToolTip(app.name);
    tray.on('click', () => tray.popUpContextMenu());
    return tray;
  }
}


let rdp;
app.whenReady().then(() => {
  if (systemPreferences.getMediaAccessStatus('screen') != 'granted') {
    console.log('ERROR: No screen capture permission');
    if (process.platform == 'darwin') {
      if (!hasPromptedForPermission()) {
        hasScreenCapturePermission();
      } else {
        openSystemPreferences();
      }
    }
  }

  rdp = new RDPApp();

  let inputManager = rdp.inputManager;
  ipcMain.handle('getDisplayStreams', async (event, types) => {
    await inputManager.updateSources(types);
    return inputManager.getSourceInfos();
  });
  ipcMain.handle('sendMouse', async (event, mouseMessage) => {
    return inputManager.sendMouse(mouseMessage);
  });
  ipcMain.handle('sendKey', async (event, keyMessage) => {
    return inputManager.sendKey(keyMessage);
  });
  ipcMain.handle('streamFromPoint', async (event, params) => {
    return inputManager.streamFromPoint(params.target, params.x, params.y);
  });

  app.on('activate', () => {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) rdp.createWindow();
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
});
