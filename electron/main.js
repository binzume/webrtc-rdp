const { app, ipcMain, BrowserWindow, desktopCapturer, screen } = require('electron')
const path = require('path')
const robot = require("robotjs");

var ffi = require('ffi-napi')
var ref = require('ref-napi')

const wu32 = process.platform == 'win32' && ffi.Library("user32.dll", {
  'GetWindowRect': ["bool", ["int32", "pointer"]],
  'SetForegroundWindow': ["bool", ["int32"]],
  // 'SetProcessDpiAwarenessContext': [ref.types.int32, [ref.types.int32]],
});

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
    this.specialKeys = {
      Control: 'control', Shift: 'shift', ALT: 'alt', Meta: 'command', Insert: 'insert',
      Enter: 'enter', Backspace: 'backspace', Tab: 'tab', Escape: 'escape', Delete: 'delete',
      Home: 'home', End: 'end', PageUp: 'pageup', PageDown: 'pagedown',
      ArrowLeft: 'left', ArrowUp: 'up', ArrowRight: 'right', ArrowDown: 'down',
      F1: 'f1', F2: 'f2', F3: 'f3', F4: 'f4', F5: 'f5', F6: 'f6',
      F7: 'f7', F8: 'f8', F9: 'f9', F10: 'f10', F11: 'f11', F12: 'f12',
      ' ': 'space', 'Space': 'space'
    };
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
  sendKey(keyMessage) {
    let modifiers = keyMessage.modifiers || [];
    console.log(keyMessage);
    if (this.specialKeys[keyMessage.key]) {
      robot.keyTap(this.specialKeys[keyMessage.key], modifiers);
    } else if (/^[A-Za-z0-9]$/.test(keyMessage.key)) {
      if (/[A-Z]/.test(keyMessage.key)) {
        modifiers.push('shift')
      }
      robot.keyTap(keyMessage.key, modifiers);
    } else {
      robot.typeString(keyMessage.key);
    }
  }
}

function createWindow() {
  const mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    }
  });

  mainWindow.loadFile('index.html');
  if (process.argv.includes('--debug')) {
    mainWindow.webContents.openDevTools();
  }
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
  ipcMain.handle('sendKey', async (event, keyMessage) => {
    return rdp.sendKey(keyMessage);
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
