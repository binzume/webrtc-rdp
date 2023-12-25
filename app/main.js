// @ts-check
const { app, ipcMain, BrowserWindow, Tray, Menu, desktopCapturer, screen, systemPreferences } = require('electron');
const path = require('path');
const karakuri = require('karakurijs');

// https://github.com/electron/electron/issues/28422
app.commandLine.appendSwitch('enable-experimental-web-platform-features');

class InputManager {
  constructor() {
    /** @type {Record<string, Electron.Display>} */
    this.displays = {};
    /** @type {Electron.DesktopCapturerSource[]} */
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
  async sendMouse(mouseMessage) {
    let { target, action, x, y, button } = mouseMessage;
    let windowId = this._getWindowId(target);
    if (windowId) {
      action != 'move' && await karakuri.setForegroundWindow(windowId);
      this.moveMouse_window(windowId, x, y);
    } else {
      let d = this.displays[target.display_id];
      this.moveMouse_display(d || screen.getPrimaryDisplay(), x, y);
    }
    if (action == 'click') {
      karakuri.click(button);
    } else if (action == 'mouseup' || action == 'up') {
      karakuri.toggleMouseButton(button, false);
    } else if (action == 'mousedown' || action == 'down') {
      karakuri.toggleMouseButton(button, true);
    }
  }
  moveMouse_display(d, x, y) {
    let p = this._toScreenPoint(d, x, y);
    karakuri.setMousePos(p.x, p.y)
  }
  moveMouse_window(windowId, x, y) {
    let bounds = karakuri.getWindowBounds(windowId);
    if (bounds) {
      karakuri.setMousePos(bounds.x + bounds.width * x, bounds.y + bounds.height * y)
    }
  }
  async sendKey(keyMessage) {
    let { target, action, key, modifiers } = keyMessage;
    let windowId = this._getWindowId(target);
    windowId && karakuri.setForegroundWindow(windowId);
    if (action == 'press') {
      karakuri.tapKey(key, modifiers);
    } else {
      karakuri.toggleKey(key, action == 'down', modifiers);
    }
  }
  streamFromPoint(target, x, y) {
    let d = this.displays[target.display_id];
    if (d == null && target.id?.startsWith('screen:0:')) {
      console.log('primary display?', target.id);
      d = screen.getPrimaryDisplay();
    }
    if (d == null) {
      console.log('invalid target: ', target);
      return null;
    }
    let p = this._toScreenPoint(d, x, y);
    let hWnd = karakuri.windowFromPoint(p.x, p.y);
    if (!hWnd) {
      return null;
    }
    let bounds = karakuri.getWindowBounds(hWnd);
    let r = null;
    if (bounds) {
      let p0 = this._fromScreenPoint(d, bounds.x, bounds.y);
      let p1 = this._fromScreenPoint(d, bounds.x + bounds.width, bounds.y + bounds.height);
      r = { x: p0.x, y: p0.y, width: p1.x - p0.x, height: p1.y - p0.y };
    }
    return { id: `window:${hWnd}:0`, rect: r, rawBounds: bounds };
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

    const isMac = process.platform === 'darwin'
    let menuTemplate = [
      ...(isMac ? [
        { role: 'appMenu' }
      ] : [
        { role: 'fileMenu' }
      ]),
      {
        label: 'Debug',
        submenu: [
          { role: 'reload' },
          { role: 'forceReload' },
          { role: 'toggleDevTools' },
        ]
      },
    ];
    // @ts-ignore
    const menu = Menu.buildFromTemplate(menuTemplate);
    Menu.setApplicationMenu(menu);

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
    karakuri.requestPermission('screenCapture');
  }
  if (!karakuri.requestPermission('accessibility')) {
    console.log('ERROR: No accessibility permission');
  }

  rdp = new RDPApp();

  let inputManager = rdp.inputManager;
  ipcMain.handle('getDisplayStreams', async (event, types) => {
    await inputManager.updateSources(types);
    return inputManager.getSourceInfos();
  });
  ipcMain.handle('sendMouse', (event, mouseMessage) => {
    return inputManager.sendMouse(mouseMessage);
  });
  ipcMain.handle('sendKey', (event, keyMessage) => {
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
