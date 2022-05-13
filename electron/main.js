const { app, ipcMain, BrowserWindow, Tray, Menu, desktopCapturer, screen, systemPreferences } = require('electron');
const path = require('path');
const automation = require('./automation');
const { hasScreenCapturePermission, hasPromptedForPermission, openSystemPreferences } = process.platform == 'darwin' ? require('mac-screen-capture-permissions') : {};

class InputManager {
  constructor() {
    /** @type {Record<string, Electron.Display>} */
    this.displays = {};
    /** @type {Record<string, Electron.DesktopCapturerSource[]>} */
    this.sources = [];
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
    if (windowId) {
      action != 'move' && automation.setForegroundWindow(windowId);
      this.moveMouse_window(windowId, x, y);
    } else {
      let d = this.displays[target.display_id];
      this.moveMouse_display(d || screen.getPrimaryDisplay(), x, y);
    }
    if (action == 'click') {
      automation.click(button);
    } else if (action == 'mouseup' || action == 'up') {
      automation.toggleMouseButton(button, false);
    } else if (action == 'mousedown' || action == 'down') {
      automation.toggleMouseButton(button, true);
    }
  }
  moveMouse_display(d, x, y) {
    let p = this._toScreenPoint(d, x, y);
    automation.setMousePos(p.x, p.y)
  }
  moveMouse_window(windowId, x, y) {
    let rect = automation.getWindowRect(windowId);
    if (rect) {
      let sx = rect.left + (rect.right - rect.left) * x;
      let sy = rect.top + (rect.bottom - rect.top) * y;
      automation.setMousePos(sx, sy)
    }
  }
  sendKey(keyMessage) {
    let { target, action, key, modifiers } = keyMessage;
    let windowId = this._getWindowId(target);
    windowId && automation.setForegroundWindow(windowId);
    if (action == 'press') {
      automation.tapKey(key, modifiers);
    } else {
      automation.toggleKey(key, action == 'down', modifiers);
    }
  }
  streamFromPoint(target, x, y) {
    let d = this.displays[target.display_id];
    if (d == null) {
      console.log('invalid target: ', target);
      return null;
    }
    let p = this._toScreenPoint(d, x, y);
    let hWnd = automation.windowFromPoint(p.x, p.y);
    if (!hWnd) {
      return null;
    }
    let rect = automation.getWindowRect(hWnd);
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
    return { x: (p.x - d.bounds.x) / d.bounds.width, y: (p.y - d.bounds.y) / d.bounds.height };
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

    window.addListener('close', (ev) => {
      if (this.mainWindow) {
        window.hide();
        ev.preventDefault();
      }
    });
    window.addListener('closed', (ev) => {
      this.mainWindow = null;
    });
    app.addListener('before-quit', (ec) => {
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
  });
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
});
