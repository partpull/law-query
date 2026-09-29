const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const library = require('./lib/library');
const pkg = require('./package.json');

// 程序名格式：法规查询vX.X By CAIJIAXING（X.X = 主版本.次版本，自动跟随 package.json）
const APP_TITLE = '法规查询v' + pkg.version.split('.').slice(0, 2).join('.') + ' By CAIJIAXING';

// 法规 Word 文件所在的文件夹名（位于程序根目录）
const LIB_DIR_NAME = '法规库';
// 拆条索引缓存（放在用户数据目录，不写进法规库）
const CACHE_FILE = 'law-index-cache.json';

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
    title: APP_TITLE,
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
  // 应用就绪即开始读取法规库：与窗口创建、页面加载并行，不必等渲染进程发起请求
  const libraryReady = library.loadLibrary(
    path.join(getBaseDir(), LIB_DIR_NAME),
    LIB_DIR_NAME,
    path.join(app.getPath('userData'), CACHE_FILE)
  );
  ipcMain.handle('library:load', () => libraryReady);

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});