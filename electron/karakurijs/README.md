# KarakuriJS

Desktop automation module for Node.js

- DOM event friendly mouse and keyboard functions
- Support more special keys in Windows
- Functions for window, display, permissions

The purpose of this package is to complement RobotJS.


# Usage

```sh
npm install karakurijs
```

```js
const karakuri = require('karakurijs');

let pos = karakuri.getMousePos();
console.log(pos);
let wid = karakuri.windowFromPoint(pos.x, pos.y);
console.log(wid);
let info = karakuri.getWindowInfo(wid);
console.log(info);
karakuri.setForegroundWindow(wid);

karakuri.click();

karakuri.tapKey('a');
karakuri.tapKey('!');
karakuri.tapKey('あ');

if (process.platform == 'darwin') {
    karakuri.tapKey('a', ['Command']);
} else {
    karakuri.tapKey('a', ['Control']);
}
```

## API

### Mouse

- getMousePos()
- setMousePos(x: number, y: number)
- click(button: number)
- toggleMouseButton(button: number, down: number)

button: 0: left, 1: middle, 2: right (same as MouseEvent.button)

### Keyboad

- toggkeKey(key: string, down: boolean, modifiers: string[])
- tapKey(key: string, modifiers: string[])

key: Same string as [KeyboardEvent.key](https://developer.mozilla.org/en-US/docs/Web/API/UI_Events/Keyboard_event_key_values)

### Window

- getWindows()
- getWindowInfo(windowId: number)
- getWindowBounds(windowId: number)
- setForegroundWindow(windowId: number)

windowId: hWnd(Windows) or window number(MacOS)

### Display

- getDisplays()

### Permissions

- requestPermission('screenCapture' | 'accessibility')


## License

MIT
