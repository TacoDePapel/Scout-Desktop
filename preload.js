const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  getSources:        ()           => ipcRenderer.invoke('get-sources'),
  setSelectedSource: (id)         => ipcRenderer.invoke('set-selected-source', id),
  getSettings:       (key)        => ipcRenderer.invoke('settings:get', key),
  setSettings:       (key, value) => ipcRenderer.invoke('settings:set', key, value),
  saveFile:          (opts)       => ipcRenderer.invoke('save-file', opts),
  onHotkeyRecord:    (cb)         => ipcRenderer.on('hotkey-record', cb),
  platform: process.platform,

  // Agent tools — executed in main process, safe from renderer sandbox
  agentBash:          (opts)       => ipcRenderer.invoke('agent:bash', opts),
  agentReadFile:      (opts)       => ipcRenderer.invoke('agent:read-file', opts),
  agentWriteFile:     (opts)       => ipcRenderer.invoke('agent:write-file', opts),
  agentListDir:       (opts)       => ipcRenderer.invoke('agent:list-dir', opts),
  agentSaveEnv:       (opts)       => ipcRenderer.invoke('agent:save-env', opts),
  agentBrowserOpen:   (opts)       => ipcRenderer.invoke('agent:browser-open', opts),
  agentBrowserAction: (opts)       => ipcRenderer.invoke('agent:browser-action', opts),
})
