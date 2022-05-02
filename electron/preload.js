const { ipcRenderer, contextBridge } = require('electron')


if (location.origin != 'file://') {
  throw location.origin
}

contextBridge.exposeInMainWorld('RDP', {
  getDisplayStreams: (spec) => ipcRenderer.invoke('getDisplayStreams', spec),
  sendMouse: (params) => ipcRenderer.invoke('sendMouse', params),
  sendKey: (params) => ipcRenderer.invoke('sendKey', params),
  streamFromPoint: (params) => ipcRenderer.invoke('streamFromPoint', params),
});
