const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const library = require('./lib/library');

// 法规 Word 文件所在的文件夹名（位于程序根目录）
const LIB_DIR_NAME = '法规库';

// 打包后：程序根目录 = exe 所在目录；开发时：项目根目录
function getBaseDir() {
  return app.isPackaged ? path.dirname(process.execPath) : __dirname;
}

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 760,
    minWidth: 940,
    minHeight: 600,
    title: '法规查询v2.0 by 6bu',
    backgroundColor: '#F7F7F8',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      spellcheck: false,
    },
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  // 启动时读取法规库，把「法规名 + 条号 + 条文」索引交给界面
  ipcMain.handle('library:load', () =>
    library.loadLibrary(path.join(getBaseDir(), LIB_DIR_NAME), LIB_DIR_NAME)
  );

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});