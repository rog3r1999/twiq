// 用 Electron 离屏渲染 build/icon.html，输出 build/icon.png（1024）与 build/icon.iconset 各尺寸。
// 用法：npx electron scripts/render-icon.cjs && iconutil -c icns build/icon.iconset -o build/icon.icns
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const dir = path.join(__dirname, '../build')
app.disableHardwareAcceleration()
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1024, height: 1024, show: false, frame: false, transparent: true, useContentSize: true, webPreferences: { offscreen: true } })
  win.webContents.setZoomFactor(1)
  await win.loadFile(path.join(dir, 'icon.html'))
  await new Promise((r) => setTimeout(r, 400))
  let img = await win.webContents.capturePage()
  img = img.resize({ width: 1024, height: 1024, quality: 'best' })
  const set = path.join(dir, 'icon.iconset')
  fs.mkdirSync(set, { recursive: true })
  const name = { 16: ['16x16'], 32: ['16x16@2x', '32x32'], 64: ['32x32@2x'], 128: ['128x128'], 256: ['128x128@2x', '256x256'], 512: ['256x256@2x', '512x512'], 1024: ['512x512@2x'] }
  for (const [s, names] of Object.entries(name)) {
    const png = img.resize({ width: Number(s), height: Number(s), quality: 'best' }).toPNG()
    for (const n of names) fs.writeFileSync(path.join(set, `icon_${n}.png`), png)
  }
  fs.writeFileSync(path.join(dir, 'icon.png'), img.toPNG())
  app.quit()
})
