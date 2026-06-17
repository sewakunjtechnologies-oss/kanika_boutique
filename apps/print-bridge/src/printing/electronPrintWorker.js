const fs = require('node:fs');
const { app, BrowserWindow } = require('electron');

app.commandLine.appendSwitch('disable-gpu');

async function main() {
  const inputPath = process.argv[2];
  if (!inputPath) throw new Error('Missing electron print input path.');

  const input = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  try {
    if (input.action === 'list-printers') {
      await window.loadURL('data:text/html;charset=utf-8,<html><body>Kanika printer diagnostics</body></html>');
      const printers = await window.webContents.getPrintersAsync();
      fs.writeFileSync(input.resultPath, JSON.stringify({ ok: true, printers }), 'utf8');
      return;
    }

    if (input.action !== 'print-html') {
      throw new Error(`Unsupported electron print action: ${input.action}`);
    }

    await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(input.html)}`);
    await window.webContents.executeJavaScript(`
      Promise.resolve(document.fonts ? document.fonts.ready : undefined)
        .then(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
        .then(() => Boolean(document.querySelector('#barcode')));
    `);

    await new Promise((resolve, reject) => {
      window.webContents.print(
        {
          silent: true,
          deviceName: input.printerName,
          printBackground: true,
          landscape: false,
          margins: { marginType: 'none' },
          pageSize: input.pageSizeMicrons,
          copies: 1,
        },
        (success, failureReason) => {
          if (success) {
            resolve();
            return;
          }
          reject(new Error(failureReason || 'Electron print failed'));
        },
      );
    });

    fs.writeFileSync(input.resultPath, JSON.stringify({ ok: true }), 'utf8');
  } finally {
    window.destroy();
  }
}

app.whenReady()
  .then(main)
  .then(() => app.quit())
  .catch((err) => {
    const inputPath = process.argv[2];
    if (inputPath) {
      try {
        const input = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
        if (input.resultPath) {
          fs.writeFileSync(input.resultPath, JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }), 'utf8');
        }
      } catch {
        // Keep the worker failure path best-effort only.
      }
    }
    console.error(err instanceof Error ? err.message : err);
    app.quit();
    process.exitCode = 1;
  });
