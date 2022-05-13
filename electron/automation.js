
const ffi = require('ffi-napi');
const robot = require("hurdle-robotjs");

robot.setKeyboardDelay(1);
robot.setMouseDelay(1);

const user32 = process.platform == 'win32' && ffi.Library('user32.dll', {
    'GetWindowRect': ['bool', ['int32', 'pointer']],
    'SetForegroundWindow': ['bool', ['int32']],
    'WindowFromPoint': ['int32', ['int64']], // TODO; struct POINT
    'GetAncestor': ['int32', ['int32', 'int32']],
    'GetCursorPos': ['bool', ['pointer']],
    'SetCursorPos': ['bool', ['int32', 'int32']],
    'SendInput': ['uint32', ['uint32', 'pointer', 'int32']],
});

const nativeAutomation = (() => {
    // TODO
    try {
        return user32 ? null : require('./build/Release/automation');
    } catch {
        return null;
    }
})();

function getWindowRect(hWnd) {
    if (!user32) {
        let bounds = nativeAutomation?.getWindowInfo(hWnd | 0)?.bounds;
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
    let rectBuf = Buffer.alloc(16);
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

function setForegroundWindow(hWnd) {
    if (!user32) {
        return nativeAutomation?.setActiveWindow(hWnd | 0) ?? false;
    }
    return user32.SetForegroundWindow(hWnd);
}

function windowFromPoint(x, y) {
    if (nativeAutomation) {
        let windows = nativeAutomation.getWindows();
        let w = windows?.find(({ bounds: b, layer: l }) => l == 0 && b.x <= x && b.y <= y && b.x + b.width > x && b.y + b.height > y);
        return w?.id ?? 0;
    }
    let hWnd = user32.WindowFromPoint(Math.floor(x) + (Math.floor(y) * (2 ** 32)));
    return hWnd != 0 ? user32.GetAncestor(hWnd, 2) : 0;
}

function getMousePos() {
    if (user32) {
        let buf = Buffer.alloc(8);
        if (!user32.GetCursorPos(buf)) {
            return null;
        }
        return { x: buf.readInt32LE(0), y: buf.readInt32LE(4) };
    } else if (nativeAutomation) {
        return nativeAutomation.getMousePos(hWnd | 0);
    }
    return robot.getMousePos();
}

function setMousePos(x, y) {
    if (user32) {
        return user32.SetCursorPos(x, y);
    } else if (nativeAutomation) {
        return nativeAutomation.setMousePos(x | 0, y | 0);
    }
    return robot.moveMouse(x, y);
}

function toggleMouseButton(button, down) {
    if (nativeAutomation) {
        return nativeAutomation.toggleMouseButton(button | 0, down ? 1 : 0);
    } else if (!user32) {
        let buttonStr = ['left', 'middle', 'right'][button] || 'left';
        return robot.mouseToggle(down ? 'down' : 'up', buttonStr);
    }

    let buf = Buffer.alloc(40); // x64
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
    buf.writeInt32LE(dwFlags, 20);
    return user32.SendInput(1, buf, buf.byteLength);
}

function click(button) {
    if (nativeAutomation || user32) {
        toggleMouseButton(button, true);
        toggleMouseButton(button, false);
        return;
    }
    let buttonStr = ['left', 'middle', 'right'][button] || 'left';
    robot.mouseClick(buttonStr);
}

module.exports = {
    getWindowRect: getWindowRect,
    setForegroundWindow: setForegroundWindow,
    windowFromPoint: windowFromPoint,
    getMousePos: getMousePos,
    setMousePos: setMousePos,
    click: click,
    toggleMouseButton: toggleMouseButton,
};
