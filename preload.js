const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  getSources:        ()           => ipcRenderer.invoke('get-sources'),
  setSelectedSource: (id)         => ipcRenderer.invoke('set-selected-source', id),
  getSettings:       (key)        => ipcRenderer.invoke('settings:get', key),
  setSettings:       (key, value) => ipcRenderer.invoke('settings:set', key, value),
  saveFile:          (opts)       => ipcRenderer.invoke('save-file', opts),
  onHotkeyRecord:    (cb)         => ipcRenderer.on('hotkey-record', cb),
  platform: process.platform,
})
