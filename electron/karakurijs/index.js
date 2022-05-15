// @ts-check
const win = process.platform == 'win32' ? require('karakurijs-win') : null;
const mac = process.platform == 'darwin' ? (() => {
    try {
        // @ts-ignore
        return require('karakurijs-mac');
    } catch {
        console.log('ERROR: Could not load karakurijs-mac.');
    }
})() : null;

const robot = process.platform != 'win32' ? require("hurdle-robotjs") : null;
robot?.setKeyboardDelay(1);
robot?.setMouseDelay(1);

/**
 * @param {{left: number, top: number, right: number, bottom: number}} rect
 * @returns {{x: number, y: number, width: number, height: number}}
 */
function rectToBounds(rect) {
    return rect ? { x: rect.left, y: rect.top, width: rect.right - rect.left, height: rect.bottom - rect.top } : null;
}

/**
 * @param {number} windowId
 * @returns {{x: number, y: number, width: number, height: number}}
 */
function getWindowBounds(windowId) {
    if (win) {
        return rectToBounds(win.GetWindowRect(windowId));
    }
    return mac?.getWindowInfo(windowId | 0)?.bounds;
}

/**
 * @param {number} windowId
 * @returns {{id: number, title: string, bounds: {x: number, y: number, width: number, height: number}, pid: number, tid?: number, visible?: boolean}}
 */
function getWindowInfo(windowId) {
    if (win) {
        let proc = win.GetWindowThreadProcessId(windowId);
        if (!proc) { return null; }
        return {
            id: windowId,
            title: win.GetWindowText(windowId),
            bounds: rectToBounds(win.GetWindowRect(windowId)),
            visible: win.IsWindowVisible(windowId) && !win.IsIconic(windowId),
            pid: proc.pid,
            tid: proc.tid,
        }
    }
    if (mac) {
        return mac.getWindowInfo(windowId | 0);
    }
    return null;
}

/**
 * @param {boolean} all
 * @returns {{id: number, title: string, bounds: {x: number, y: number, width: number, height: number}, pid: number, tid?: number, visible?: boolean}[]}
 */
function getWindows(all = false) {
    if (mac) {
        let windows = win.getWindows();
        return all ? windows : windows.filter((w) => w.layer == 0);
    }
    if (win) {
        let windows = [];
        win.EnumWindows((hWnd) => {
            (all || win.IsWindowVisible(hWnd) && !win.IsIconic(hWnd)) && windows.push(getWindowInfo(hWnd))
            return true;
        });
        return windows;
    }
    return [];
}

/**
 * @param {number} windowId
 * @returns {Promise<boolean>} succeeded
 */
async function setForegroundWindow(windowId) {
    if (win) {
        return win.SetForegroundWindow(windowId);
    }
    if (mac) {
        let result = mac.setActiveWindow(windowId | 0);
        // Wait for window focus (FIXME)
        result && await new Promise((resolve) => setTimeout(resolve, 50));
        return result;
    }
    return false;
}

/**
 * @param {number} x
 * @param {number} y
 * @returns {number} windowId
 */
function windowFromPoint(x, y) {
    if (win) {
        return win.WindowFromPoint(x, y);
    }
    if (mac) {
        let windows = mac.getWindows();
        let w = windows?.find(({ bounds: b, layer: l }) => l == 0 && b.x <= x && b.y <= y && b.x + b.width > x && b.y + b.height > y);
        return w?.id;
    }
    return null;
}

/**
 * @returns {{x: number, y: number}}
 */
function getMousePos() {
    if (win) {
        return win.GetCursorPos();
    } else if (mac) {
        return mac.getMousePos();
    }
    return robot.getMousePos();
}

/**
 * @param {number} x
 * @param {number} y
 */
function setMousePos(x, y) {
    if (win) {
        return win.SetCursorPos(x, y);
    } else if (mac) {
        return mac.setMousePos(x | 0, y | 0);
    }
    return robot.moveMouse(x, y);
}

/**
 * @param {number} button 0:left, 1:middle, 2:right
 * @param {boolean} down
 */
function toggleMouseButton(button, down) {
    if (mac) {
        return mac.toggleMouseButton(button | 0, down ? 1 : 0);
    } else if (!win) {
        let buttonStr = ['left', 'middle', 'right'][button] || 'left';
        return robot.mouseToggle(down ? 'down' : 'up', buttonStr);
    }

    let dwFlags = 0;
    switch (button) {
        case 0:
            dwFlags = down ? 0x0002 : 0x0004;
            break;
        case 1:
            dwFlags = down ? 0x0020 : 0x0040;
            break;
        case 2:
            dwFlags = down ? 0x0008 : 0x0010;
            break;
    }
    return win.SendInput([{ mouse: { flags: dwFlags } }]);
}

/**
 * @param {number} button 0:left, 1:middle, 2:right
 */
function click(button = 0) {
    if (win || mac) {
        toggleMouseButton(button, true);
        toggleMouseButton(button, false);
        return;
    }
    let buttonStr = ['left', 'middle', 'right'][button] || 'left';
    robot.mouseClick(buttonStr);
}

/**
 * @return {{name: string, active: boolean, primary: boolean, bounds: {x: number, y: number, width: number, height: number}}[]}
 */
function getDisplays() {
    let displays = [];
    if (!win) {
        // TODO
        let sz = robot.getScreenSize();
        displays.push({
            name: 'Screen',
            active: true,
            primary: true,
            bounds: { x: 0, y: 0, width: sz.width, height: sz.height },
        });
        return displays;
    }
    let d;
    for (let i = 0; d = win.EnumDisplayDevices(i); i++) {
        let settings = win.EnumDisplaySettings(d.deviceName);
        if (settings == null) { continue; }
        displays.push({
            name: d.deviceString,
            active: (d.stateFlags & 1) != 0,
            primary: (d.stateFlags & 4) != 0,
            bounds: { x: settings.x, y: settings.y, width: settings.width, height: settings.height },
            settings: settings,
        });
    }
    return displays;
}

const robotjsKeys = {
    Control: 'control', Shift: 'shift', Alt: 'alt', Meta: 'command', Insert: 'insert',
    Enter: 'enter', Backspace: 'backspace', Tab: 'tab', Escape: 'escape', Delete: 'delete',
    Home: 'home', End: 'end', PageUp: 'pageup', PageDown: 'pagedown',
    ArrowLeft: 'left', ArrowUp: 'up', ArrowRight: 'right', ArrowDown: 'down',
    F1: 'f1', F2: 'f2', F3: 'f3', F4: 'f4', F5: 'f5', F6: 'f6',
    F7: 'f7', F8: 'f8', F9: 'f9', F10: 'f10', F11: 'f11', F12: 'f12',
    ' ': 'space', 'Space': 'space', CapsLock: 'command'
};

/**
 * @param {string} key
 * @param {boolean} down
 * @param {string[]} modifiers 'Control', 'Shift', 'Alt', 'Meta'(Command)
 * @returns {boolean}
 */
function toggleKey(key, down, modifiers = []) {
    if (key == 'Unidentified') {
        return false;
    }
    if (win) {
        let keys = [];
        let flags = down ? 0 : 0x0002;
        for (let mod of modifiers) {
            let vk = win.keyToVk(mod);
            vk && keys.push({ key: { vk: vk, flags: flags } });
        }
        let vk = win.keyToVk(key);
        if (key.length == 1 && (vk == undefined || vk & 0x100 && modifiers.length == 0)) {
            return win.SendInput([{ key: { scan: key.charCodeAt(0), flags: flags | 0x0004 } }]) != 0;
        }
        if (vk == undefined) { return false; }
        keys.push({ key: { vk: vk, flags: flags } });
        if (!down) { keys.reverse(); }
        return win.SendInput(keys) != 0;
    }

    if (key == 'KanaMode' || key == 'HiraganaKatakana' || key == 'Convert') {
        // Robot.js doesn't support KanaMode key.
        key = ' ';
        modifiers = ['command'];
    }

    if (robotjsKeys[key] != null) {
        key = robotjsKeys[key];
    } else if (/^[A-Za-z0-9]$/.test(key)) {
        if (/[A-Z]/.test(key)) {
            key = key.toLocaleLowerCase();
            modifiers.length == 0 && modifiers.push('shift');
        }
    } else {
        down && robot.typeString(key);
        return;
    }
    robot.keyToggle(key, down ? 'down' : 'up', modifiers.map(m => robotjsKeys[m] || m.toLowerCase()).filter(m => m != key));
    return false;
}

/**
 * @param {string} key
 * @param {string[]} modifiers
 */
function tapKey(key, modifiers = []) {
    toggleKey(key, true, modifiers);
    toggleKey(key, false, modifiers);
}

/**
 * @param {string} text 
 */
function typeString(text) {
    if (win) {
        let keys = [];
        for (let i = 0; i < text.length; i++) {
            keys.push({ key: { scan: text.charCodeAt(i), flags: 0x0004 } }, { key: { scan: text.charCodeAt(i), flags: 2 | 0x0004 } });
        }
        win.SendInput(keys);
    } else {
        robot?.typeString(text);
    }
}

/**
 * @param {string} permission 
 * @returns {boolean}
 */
function requestPermission(permission) {
    if (process.platform != 'darwin') {
        return true;
    }
    if (permission == 'screenCapture') {
        // @ts-ignore
        const { hasScreenCapturePermission, hasPromptedForPermission, openSystemPreferences } = require('mac-screen-capture-permissions');
        if (!hasPromptedForPermission()) {
            hasScreenCapturePermission();
        } else {
            openSystemPreferences();
        }
    }
    if (permission == 'accessibility') {
        return mac.isProcessTrusted();
    }
    return true;
}

module.exports = {
    getWindowInfo: getWindowInfo,
    getWindows: getWindows,
    getWindowBounds: getWindowBounds,
    setForegroundWindow: setForegroundWindow,
    windowFromPoint: windowFromPoint,
    getMousePos: getMousePos,
    setMousePos: setMousePos,
    click: click,
    toggleMouseButton: toggleMouseButton,
    toggleKey: toggleKey,
    tapKey: tapKey,
    typeString: typeString,
    getDisplays: getDisplays,
    requestPermission: requestPermission,
};
