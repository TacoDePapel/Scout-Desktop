// Scout Desktop — preload bridge (v2.3.0)
// Exposes a narrow, named API to the renderer. Nothing here grants raw access
// to Node or Electron internals — every entry is an explicit IPC channel.

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  // Recording
  getSources:        ()           => ipcRenderer.invoke('get-sources'),
  setSelectedSource: (id)         => ipcRenderer.invoke('set-selected-source', id),
  getSettings:       (key)        => ipcRenderer.invoke('settings:get', key),
  setSettings:       (key, value) => ipcRenderer.invoke('settings:set', key, value),
  saveFile:          (opts)       => ipcRenderer.invoke('save-file', opts),
  openExternal:      (url)        => ipcRenderer.invoke('shell:open-external', url),
  overlayShow:       (opts)       => ipcRenderer.invoke('overlay:show', opts),
  overlayHide:       ()           => ipcRenderer.invoke('overlay:hide'),
  onOverlayStop:     (cb)         => ipcRenderer.on('overlay:stop',  () => cb()),
  onOverlayPause:    (cb)         => ipcRenderer.on('overlay:pause', () => cb()),
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

  // Macro mode (offline record + replay, no sign-in)
  macroGetState:       ()                  => ipcRenderer.invoke('macro:state'),
  macroList:           ()                  => ipcRenderer.invoke('macro:list'),
  macroGet:            (id)                => ipcRenderer.invoke('macro:get', { id }),
  macroDelete:         (id)                => ipcRenderer.invoke('macro:delete', { id }),
  macroRename:         (id, name)          => ipcRenderer.invoke('macro:rename', { id, name }),
  macroStartRecording: ()                  => ipcRenderer.invoke('macro:start-recording'),
  macroStopRecording:  (name)              => ipcRenderer.invoke('macro:stop-recording', { name }),
  macroPlay:           (id, opts)          => ipcRenderer.invoke('macro:play', { id, ...(opts || {}) }),
  macroStopPlay:       ()                  => ipcRenderer.invoke('macro:stop-play'),
  onMacroState:        (cb)                => ipcRenderer.on('macro:state', (_e, data) => cb(data)),

  // Active foreground window info (used to enrich recorded skills with app/route)
  getActiveWindowInfo: ()                  => ipcRenderer.invoke('system:get-window-info'),
})
