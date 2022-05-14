# KarakuriJs

Desktop automation module for Node.js


T.B.D.


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


## License

MIT
