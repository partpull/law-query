const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('lawAPI', {
  // 启动时加载法规库：扫描 .docx → 解析 → 按「第X条」拆条
  loadLibrary: () => ipcRenderer.invoke('library:load'),
  // 用系统默认程序打开指定法规的 Word 文件（参数为相对法规库的路径）
  openLawFile: (rel) => ipcRenderer.invoke('law:open', rel),
});