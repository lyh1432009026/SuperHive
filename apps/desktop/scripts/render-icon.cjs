// 用 Electron 自己把 build/icon.svg 渲染成 1024px PNG（scripts/icons.mjs 调用）
const { app, BrowserWindow } = require("electron");
const { readFileSync, writeFileSync } = require("node:fs");

const [input, output] = process.argv.slice(-2);
app.dock?.hide();
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1024,
    height: 1024,
    show: false,
    transparent: true,
    backgroundColor: "#00000000",
    frame: false,
    useContentSize: true,
    webPreferences: { offscreen: true, sandbox: true, contextIsolation: true },
  });
  win.webContents.setZoomFactor(1);
  const svg = readFileSync(input, "utf8");
  const html = `<html><body style="margin:0;background:transparent">${svg}</body></html>`;
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  await new Promise((resolve) => setTimeout(resolve, 300));
  const image = await win.webContents.capturePage({ x: 0, y: 0, width: 1024, height: 1024 });
  writeFileSync(output, image.resize({ width: 1024, height: 1024 }).toPNG());
  app.quit();
});
