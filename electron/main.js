const { app, ipcMain, BrowserWindow, desktopCapturer, screen } = require('electron')
const path = require('path')
const robot = require("robotjs");

var ffi = require('ffi-napi')
var ref = require('ref-napi')

const wu32 = ffi.Library("user32.dll", {
  'MessageBoxA': ["int", [ref.refType(ref.types.void), ref.types.CString, ref.types.CString, ref.types.int32]],
  'GetWindowRect': ["bool", ["int32", "pointer"]],
  'SetForegroundWindow': ["bool", ["int32"]],
  // 'SetProcessDpiAwarenessContext': [ref.types.int32, [ref.types.int32]],
});

// wu32.MessageBoxA(ref.NULL, "Hello", "title", 0);

function GetWindowRect(hWnd) {
  let rectBuf = Buffer.alloc(16);
  if (!wu32.GetWindowRect(hWnd, rectBuf)) {
    return null;
  }
  return {
    left: rectBuf.readUInt32LE(0),
    top: rectBuf.readUInt32LE(4),
    right: rectBuf.readUInt32LE(8),
    bottom: rectBuf.readUInt32LE(12),
  };
}



class RDPApp {
  constructor() {
    /** @type {Record<string, Electron.Display>} */
    this.displays = {};
    /** @type {Record<string, Electron.DesktopCapturerSource[]>} */
    this.sources = [];
  }
  async updateSources(types = ['screen']) {
    this.sources = await desktopCapturer.getSources({ types: types });
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
  sendMouse(target, action, x, y, button) {
    let d = this.displays[target.display_id];
    if (d) {
      this.moveMouse_display(d, x, y);
    } else if (target.id.startsWith('window:')) {
      let m = target.id.match(/^window:(\d+):/);
      if (m) {
        this.moveMouse_window(m[1], x, y);
      }
    } else {
      console.log("invalid target", target);
      return;
    }
    if (action == 'click') {
      robot.mouseClick();
    }
  }
  moveMouse_display(d, x, y) {
    let sx = d.bounds.x + d.bounds.width * x, sy = d.bounds.y + d.bounds.height * y;
    robot.moveMouse(sx * d.scaleFactor, sy * d.scaleFactor);
  }
  moveMouse_window(windowId, x, y) {
    wu32.SetForegroundWindow(windowId);
    let rect = GetWindowRect(windowId);
    if (rect) {
      let sx = rect.left + (rect.right - rect.left) * x;
      let sy = rect.top + (rect.bottom - rect.top) * y;
      robot.moveMouse(sx, sy);
    }
  }
  sendKey(target, action, key, modifiers = []) {
    // TODO
    robot.keyTap(key, modifiers);
  }
}

function createWindow() {
  const mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js')
    }
  })

  mainWindow.loadFile('index.html')
  mainWindow.webContents.openDevTools()
}


app.whenReady().then(() => {

  let rdp = new RDPApp();

  ipcMain.handle('getDisplayStreams', async (event, types) => {
    await rdp.updateSources(types);
    // console.log(robot.getScreenSize());
    // console.log(rdp.displays);
    return rdp.getSourceInfos();
  });
  ipcMain.handle('sendMouse', async (event, mouseAction) => {
    return rdp.sendMouse(mouseAction.target, mouseAction.action, mouseAction.x, mouseAction.y, mouseAction.button);
  });
  ipcMain.handle('sendKey', async (event, keyAction) => {
    return rdp.sendKey(keyAction.target, keyAction.action, keyAction.key);
  });


  createWindow();
  app.on('activate', () => {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
});
