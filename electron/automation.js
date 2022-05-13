

const automationWin = process.platform == 'win32' ? require('automation-win') : null;
const automationMac = process.platform == 'darwin' ? (() => {
    try {
        return require('automation-mac');
    } catch {
        console.log('ERROR: Could not load automation-mac.');
    }
})() : null;

const robot = process.platform != 'win32' ? require("hurdle-robotjs") : null;
robot?.setKeyboardDelay(1);
robot?.setMouseDelay(1);

function getWindowRect(windowId) {
    if (automationWin) {
        return automationWin.GetWindowRect(windowId);
    }
    let bounds = automationMac?.getWindowInfo(windowId | 0)?.bounds;
    if (!bounds) {
        return null;
    }
    return {
        left: bounds.x,
        top: bounds.y,
        right: bounds.x + bounds.width,
        bottom: bounds.y + bounds.height,
    };
}

function getWindowInfo(windowId) {
    if (automationWin) {
        let proc = automationWin.GetWindowThreadProcessId(windowId);
        if (!proc) { return null; }
        let rect = automationWin.GetWindowRect(windowId);
        if (!rect) { return null; }
        return {
            id: windowId,
            pid: proc.pid,
            tid: proc.tid,
            title: automationWin.GetWindowText(windowId),
            bounds: { x: rect.left, y: rect.top, width: rect.right - rect.left, height: rect.bottom - rect.top },
            visible: automationWin.IsWindowVisible(windowId),
        }
    }
    if (automationMac) {
        return automationMac.getWindowInfo(windowId | 0);
    }
    return null;
}

function getWindows(all = false) {
    if (automationMac) {
        let windows = utomationMac.getWindows();
        return all ? windows : windows.filter((w) => w.layer == 0);
    }
    if (automationWin) {
        let windows = [];
        automationWin.EnumWindows((hWnd) => {
            (all || automationWin.IsWindowVisible(hWnd) && !automationWin.IsIconic(hWnd)) && windows.push(getWindowInfo(hWnd))
            return true;
        });
        return windows;
    }
    return [];
}

function setForegroundWindow(windowId) {
    if (automationWin) {
        return automationWin.SetForegroundWindow(windowId);
    }
    return automationMac?.setActiveWindow(windowId | 0) ?? false;
}

function windowFromPoint(x, y) {
    if (automationWin) {
        return automationWin.WindowFromPoint(x, y);
    }
    if (automationMac) {
        let windows = automationMac.getWindows();
        let w = windows?.find(({ bounds: b, layer: l }) => l == 0 && b.x <= x && b.y <= y && b.x + b.width > x && b.y + b.height > y);
        return w?.id;
    }
    return null;
}

function getMousePos() {
    if (automationWin) {
        return automationWin.GetCursorPos();
    } else if (automationMac) {
        return automationMac.getMousePos();
    }
    return robot.getMousePos();
}

function setMousePos(x, y) {
    if (automationWin) {
        return automationWin.SetCursorPos(x, y);
    } else if (automationMac) {
        return automationMac.setMousePos(x | 0, y | 0);
    }
    return robot.moveMouse(x, y);
}

function toggleMouseButton(button, down) {
    if (automationMac) {
        return automationMac.toggleMouseButton(button | 0, down ? 1 : 0);
    } else if (!automationWin) {
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
    return automationWin.SendInput([{ mouse: { flags: dwFlags } }]);
}

function click(button) {
    if (automationWin || automationMac) {
        toggleMouseButton(button, true);
        toggleMouseButton(button, false);
        return;
    }
    let buttonStr = ['left', 'middle', 'right'][button] || 'left';
    robot.mouseClick(buttonStr);
}

function getDisplays() {
    let displays = [];
    if (!automationWin) {
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
    for (let i = 0; d = automationWin.EnumDisplayDevices(i); i++) {
        let settings = automationWin.EnumDisplaySettings(d.deviceName);
        if (settings == null) { continue; }
        displays.push({
            name: d.deviceString,
            active: d.stateFlags & 1,
            primary: d.stateFlags & 4,
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
    ' ': 'space', 'Space': 'space'
};

/**
 * @param {string} key 
 * @param {boolean} down 
 * @param {string[]} modifiers 
 * @returns {boolean}
 */
function toggleKey(key, down, modifiers = []) {
    if (key == 'Unidentified') {
        return false;
    }
    if (automationWin) {
        let keys = [];
        let flags = down ? 0 : 0x0002;
        for (let mod of modifiers) {
            let vk = automationWin.keyToVk(mod);
            vk && keys.push({ key: { vk: vk, flags: flags } });
        }
        let vk = automationWin.keyToVk(key);
        if (key.length == 1 && (vk == undefined || vk & 0x100 && modifiers.length == 0)) {
            return automationWin.SendInput([{ key: { scan: key.charCodeAt(0), flags: flags | 0x0004 } }]);
        }
        if (vk == undefined) { return false; }
        keys.push({ key: { vk: vk, flags: flags } });
        if (!down) { keys.reverse(); }
        return automationWin.SendInput(keys);
    }

    if (key == 'KanaMode' || key == 'HiraganaKatakana') {
        // Robot.js doesn't support KanaMode key.
        key = ' ';
        modifiers = ['control'];
    }

    if (robotjsKeys[key]) {
        key = robotjsKeys[key];
    } else if (/^[A-Za-z0-9]$/.test(key)) {
        if (modifiers.length == 0 && /[A-Z]/.test(key)) {
            modifiers.push('shift');
        }
    } else {
        down && robot.typeString(key);
        return;
    }
    robot.keyToggle(key, down ? 'down' : 'up', modifiers);

    return false;
}

/**
 * @param {string} key 
 * @param {string[]} modifiers
 * @returns {boolean}
 */
function tapKey(key, modifiers = []) {
    toggleKey(key, true, modifiers);
    toggleKey(key, false, modifiers);
}

module.exports = {
    getWindowRect: getWindowRect,
    getWindowInfo: getWindowInfo,
    getWindows: getWindows,
    setForegroundWindow: setForegroundWindow,
    windowFromPoint: windowFromPoint,
    getMousePos: getMousePos,
    setMousePos: setMousePos,
    click: click,
    toggleMouseButton: toggleMouseButton,
    toggleKey: toggleKey,
    tapKey: tapKey,
    getDisplays: getDisplays,
};
