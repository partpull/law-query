const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('lawAPI', {
  // 启动时加载法规库：扫描 .docx → 解析 → 按「第X条」拆条
  loadLibrary: () => ipcRenderer.invoke('library:load'),
});