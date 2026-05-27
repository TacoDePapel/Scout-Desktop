const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  // Recording
  getSources:        ()           => ipcRenderer.invoke('get-sources'),
  setSelectedSource: (id)         => ipcRenderer.invoke('set-selected-source', id),
  getSettings:       (key)        => ipcRenderer.invoke('settings:get', key),
  setSettings:       (key, value) => ipcRenderer.invoke('settings:set', key, value),
  saveFile:          (opts)       => ipcRenderer.invoke('save-file', opts),
  onHotkeyRecord:    (cb)         => ipcRenderer.on('hotkey-record', cb),
  platform: process.platform,

  // Background agent (runs in main process — survives minimize)
  startAgentBg:  (opts) => ipcRenderer.invoke('agent:start-bg', opts),
  stopAgentBg:   ()     => ipcRenderer.invoke('agent:stop-bg'),
  getAgentState: ()     => ipcRenderer.invoke('agent:get-state'),
  onAgentUpdate: (cb)   => ipcRenderer.on('agent:update', (_e, data) => cb(data)),

  // Screen monitor
  toggleMonitor:    (opts) => ipcRenderer.invoke('monitor:toggle', opts),
  getMonitorFrames: ()     => ipcRenderer.invoke('monitor:get-frames'),
  getMonitorStatus: ()     => ipcRenderer.invoke('monitor:get-status'),
  onMonitorFrame:   (cb)   => ipcRenderer.on('monitor:frame',  (_e, data) => cb(data)),
  onMonitorStatus:  (cb)   => ipcRenderer.on('monitor:status', (_e, data) => cb(data)),

  // MCP servers
  getMCPStatus: () => ipcRenderer.invoke('mcp:get-status'),
  onMCPReady:   (cb) => ipcRenderer.on('mcp:ready', (_e, data) => cb(data)),

  // Agent tools (renderer-side agent, still available)
  agentBash:          (opts) => ipcRenderer.invoke('agent:bash', opts),
  agentReadFile:      (opts) => ipcRenderer.invoke('agent:read-file', opts),
  agentWriteFile:     (opts) => ipcRenderer.invoke('agent:write-file', opts),
  agentListDir:       (opts) => ipcRenderer.invoke('agent:list-dir', opts),
  agentSaveEnv:       (opts) => ipcRenderer.invoke('agent:save-env', opts),
  agentBrowserOpen:   (opts) => ipcRenderer.invoke('agent:browser-open', opts),
  agentBrowserAction: (opts) => ipcRenderer.invoke('agent:browser-action', opts),
})
