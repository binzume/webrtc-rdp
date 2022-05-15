const ffi = require('ffi-napi');

const user32 = process.platform == 'win32' && ffi.Library('user32.dll', {
    'GetWindowRect': ['bool', ['int32', 'pointer']],
    'SetForegroundWindow': ['bool', ['int32']],
    'WindowFromPoint': ['int32', ['int64']], // TODO; struct POINT
    'EnumWindows': ['bool', ['pointer', 'int32']],
    'GetWindowTextW': ['int32', ['int32', 'pointer', 'int32']],
    'IsWindowVisible': ['bool', ['int32']],
    'IsIconic': ['bool', ['int32']],
    'GetWindowThreadProcessId': ['int32', ['int32', 'pointer']],
    'GetAncestor': ['int32', ['int32', 'int32']],
    'GetCursorPos': ['bool', ['pointer']],
    'SetCursorPos': ['bool', ['int32', 'int32']],
    'SendInput': ['uint32', ['uint32', 'pointer', 'int32']],
    'VkKeyScanW': ['uint16', ['uint16']],
    'EnumDisplayDevicesW': ['bool', ['pointer', 'int32', 'pointer', 'int32']],
    'EnumDisplaySettingsExW': ['bool', ['pointer', 'int32', 'pointer', 'int32']],
});

const keys = {
    backspace: 8, tab: 9, claer: 12, enter: 13, capslock: 0x14, shift: 16, control: 17, alt: 18,
    escape: 0x1B, space: 0x20, ' ': 0x20, pageup: 0x21, pagedown: 0x22, end: 0x23, home: 0x24,
    arrowleft: 0x25, arrowup: 0x26, arrowright: 0x27, arrowdown: 0x28,
    insert: 0x2D, delete: 0x2E, meta: 0x5B,
    kanamode: 0x15,
    f1: 0x70, f2: 0x71, f3: 0x72, f4: 0x73, f5: 0x74, f6: 0x75, f7: 0x76, f8: 0x77, f9: 0x78, f10: 0x79,
    f11: 0x7A, f12: 0x7B, f13: 0x7C, f14: 0x7D, f15: 0x7E, f16: 0x7F, f17: 0x80, f18: 0x81, f19: 0x82, f20: 0x80,
}

function GetWindowRect(hWnd) {
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

function GetCursorPos() {
    let buf = Buffer.alloc(8);
    if (!user32.GetCursorPos(buf)) {
        return null;
    }
    return { x: buf.readInt32LE(0), y: buf.readInt32LE(4) };
}

function WindowFromPoint(x, y) {
    let hWnd = user32.WindowFromPoint(Math.floor(x) + (Math.floor(y) * (2 ** 32)));
    return hWnd != 0 ? user32.GetAncestor(hWnd, 2) : 0;
}

/**
 * @param {{mouse?:{dx?: number, dy?: number, flags: number}, key?:{vk?: number, scan?: number, flags: number}}[]} inputs 
 */
function SendInput(inputs) {
    let sz = 40; // x64
    let offset = 8;
    let buf = Buffer.alloc(sz * inputs.length);
    inputs.forEach((input, i) => {
        if (input.mouse) {
            buf.writeInt32LE(input.mouse.dx || 0, sz * i + offset);
            buf.writeInt32LE(input.mouse.dy || 0, sz * i + offset + 4);
            buf.writeUInt32LE(input.mouse.flags, sz * i + offset + 12);
        } else if (input.key) {
            buf.writeInt32LE(1, sz * i);
            buf.writeUInt16LE(input.key.vk, sz * i + offset);
            buf.writeUInt16LE(input.key.scan, sz * i + offset + 2);
            buf.writeUInt32LE(input.key.flags, sz * i + offset + 4);
        }
    });
    return user32.SendInput(inputs.length, buf, sz);
}

/**
 * @param {number} hWnd 
 * @returns {{pid:number, tid:number}}
 */
function GetWindowThreadProcessId(hWnd) {
    let buf = Buffer.alloc(4);
    let threadId = user32.GetWindowThreadProcessId(hWnd, buf);
    return { pid: buf.readInt32LE(0), tid: threadId };
}

/**
 * @param {number} hWnd 
 * @returns {string}
 */
function GetWindowText(hWnd) {
    let buf = Buffer.alloc(1024);
    let len = user32.GetWindowTextW(hWnd, buf, buf.byteLength);
    return buf.toString('ucs2', 0, len * 2);
}

/**
 * @param {string} key 
 * @returns {number|undefined}
 */
function keyToVk(key) {
    let vk = keys[key.toLowerCase()];
    if (vk !== undefined) { return vk; }
    if (key.length != 1) { return undefined; }
    vk = user32.VkKeyScanW(key.charCodeAt(0));
    return vk == 0xffff ? undefined : vk;
}

function EnumDisplayDevices(i) {
    let buf = Buffer.alloc(840);
    buf.writeInt32LE(buf.byteLength, 0);
    if (!user32.EnumDisplayDevicesW(null, i, buf, 0)) {
        return null;
    }
    return {
        deviceName: buf.toString('ucs2', 4, 68).replace(/\0/g, ''),
        deviceString: buf.toString('ucs2', 68, 324).replace(/\0/g, ''),
        stateFlags: buf.readInt32LE(324),
    };
}

function EnumDisplaySettings(name, modeNum = -1, flags = 0) {
    let buf = Buffer.alloc(220);
    buf.writeInt16LE(buf.byteLength, 68);
    if (!user32.EnumDisplaySettingsExW(Buffer.from(name + "\0", 'ucs2'), modeNum, buf, flags)) {
        return null;
    }
    return {
        devicename: buf.toString('ucs2', 0, 64).replace(/\0/g, ''),
        x: buf.readInt32LE(76),
        y: buf.readInt32LE(80),
        formName: buf.toString('ucs2', 102, 166).replace(/\0/g, ''),
        bitsPerPixel: buf.readInt32LE(168),
        width: buf.readInt32LE(172),
        height: buf.readInt32LE(176),
        flags: buf.readInt32LE(180),
        frequency: buf.readInt32LE(184),
    };
}

function EnumWindows(proc, lpram = 0) {
    const windowProc = ffi.Callback('bool', ['long', 'int32'], proc);
    user32.EnumWindows(windowProc, lpram);
}

module.exports = {
    GetWindowRect: GetWindowRect,
    SetForegroundWindow: user32.SetForegroundWindow,
    WindowFromPoint: WindowFromPoint,
    GetCursorPos: GetCursorPos,
    SetCursorPos: user32.SetCursorPos,
    SendInput: SendInput,
    GetWindowThreadProcessId: GetWindowThreadProcessId,
    GetWindowText: GetWindowText,
    keyToVk: keyToVk,
    EnumDisplayDevices: EnumDisplayDevices,
    EnumDisplaySettings: EnumDisplaySettings,
    EnumWindows: EnumWindows,
    IsWindowVisible: user32.IsWindowVisible,
    IsIconic: user32.IsIconic,
};
