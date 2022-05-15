# KarakuriJS

Desktop automation module for Node.js

# Usage

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
- setMousePos(x, y)
- click(button)
- toggleMouseButton(button, down)

button: 0: left, 1: middle, 2: right

### Keyboad

- toggkeKey(key, down, modifiers)
- tapKey(key, modifiers)

### Window

- getWindows()
- getWindowInfo(windowId)
- getWindowBounds(windowId)
- setForegroundWindow(windowId)

windowId: hWnd(Windows) or window number(MacOS)

### Display

- getDisplays()

### Permissions

- requestPermission(screenCapture | accessibility)


## License

MIT
