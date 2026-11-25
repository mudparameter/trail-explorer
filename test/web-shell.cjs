// A plain browser window for test/e2e-web.ts: Electron's Chromium, with none of
// the desktop app. It loads the test's host page, and keeps its storage in a
// folder the test chooses, so a second launch sees what the first one stored.
const { app, BrowserWindow } = require('electron');

app.setPath('userData', process.env.WEB_TEST_DATA);
app.whenReady().then(() => {
  // WEB_TEST_SIZE, such as 390x844, makes a phone-sized window.
  const [width, height] = (process.env.WEB_TEST_SIZE ?? '1280x860').split('x').map(Number);
  const w = new BrowserWindow({ width, height, useContentSize: true, webPreferences: { sandbox: true, contextIsolation: true } });
  // The page asks before closing with unexported changes; tests close it anyway.
  w.webContents.on('will-prevent-unload', (e) => e.preventDefault());
  void w.loadURL(process.env.WEB_TEST_URL);
});
app.on('window-all-closed', () => app.quit());
