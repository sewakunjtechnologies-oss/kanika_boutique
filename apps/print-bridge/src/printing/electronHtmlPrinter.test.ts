import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  electronPrintOptions,
  pageSizeMicrons,
  printHtmlToWindowsPrinter,
} from './electronHtmlPrinter';

const tempDirs: string[] = [];

afterEach(async () => {
  delete process.env.ELECTRON_RUN_AS_NODE;
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('Electron HTML printer', () => {
  test('uses exact 4x3 custom page size with no landscape rotation', () => {
    const options = electronPrintOptions('4BARCODE 4B-2054TG', '4x3');

    expect(options.deviceName).toBe('4BARCODE 4B-2054TG');
    expect(options.landscape).toBe(false);
    expect(options.silent).toBe(true);
    expect(options.printBackground).toBe(true);
    expect(options.margins).toEqual({ marginType: 'none' });
    expect(options.pageSize).toEqual({ width: 101600, height: 76200 });
    expect(options.copies).toBe(1);
  });

  test('uses exact 4x4 future custom page size', () => {
    expect(pageSizeMicrons('4x4')).toEqual({ width: 101600, height: 101600 });
  });

  test('spawns Electron worker, never Edge or a PDF shell command', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'kanika-electron-test-'));
    tempDirs.push(tempRoot);
    process.env.ELECTRON_RUN_AS_NODE = '1';
    const spawnElectron = vi.fn((command: string, args: readonly string[], options: { env?: NodeJS.ProcessEnv }) => {
      expect(command).toBe('/fake/electron');
      expect(command.toLowerCase()).not.toContain('edge');
      expect(args[0]).toBe('/fake/worker.js');
      expect(options.env?.ELECTRON_RUN_AS_NODE).toBeUndefined();
      const inputPath = args[1]!;
      const input = JSON.parse(fs.readFileSync(inputPath, 'utf8')) as {
        action: string;
        html: string;
        printerName: string;
        pageSizeMicrons: { width: number; height: number };
        resultPath: string;
      };
      expect(input.action).toBe('print-html');
      expect(input.html).toContain('KANIKA DESIGNS');
      expect(input.printerName).toBe('4BARCODE 4B-2054TG');
      expect(input.pageSizeMicrons).toEqual({ width: 101600, height: 76200 });
      fs.writeFileSync(input.resultPath, JSON.stringify({ ok: true }), 'utf8');
      return fakeChild(0);
    });

    await printHtmlToWindowsPrinter(
      {
        html: '<html><body>KANIKA DESIGNS <svg id="barcode"></svg></body></html>',
        printerName: '4BARCODE 4B-2054TG',
        labelSize: '4x3',
      },
      {
        electronExecutable: '/fake/electron',
        workerPath: '/fake/worker.js',
        tempRoot,
        spawnElectron: spawnElectron as never,
      },
    );

    expect(spawnElectron).toHaveBeenCalledTimes(1);
  });

  test('failed Electron print rejects with worker failure', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'kanika-electron-test-'));
    tempDirs.push(tempRoot);
    const spawnElectron = vi.fn((_command: string, args: readonly string[]) => {
      const input = JSON.parse(fs.readFileSync(args[1]!, 'utf8')) as { resultPath: string };
      fs.writeFileSync(input.resultPath, JSON.stringify({ ok: false, error: 'printer offline' }), 'utf8');
      return fakeChild(1);
    });

    await expect(
      printHtmlToWindowsPrinter(
        {
          html: '<html><body><svg id="barcode"></svg></body></html>',
          printerName: '4BARCODE 4B-2054TG',
          labelSize: '4x3',
        },
        {
          electronExecutable: '/fake/electron',
          workerPath: '/fake/worker.js',
          tempRoot,
          spawnElectron: spawnElectron as never,
        },
      ),
    ).rejects.toThrow('printer offline');
  });
});

function fakeChild(code: number): NodeJS.EventEmitter & { stdout: EventEmitter; stderr: EventEmitter } {
  const child = new EventEmitter() as NodeJS.EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  queueMicrotask(() => child.emit('close', code));
  return child;
}
