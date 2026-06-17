import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveLabelSizeInput, type LabelSizeInput } from '@kda/labels';

export interface ElectronPageSizeMicrons {
  width: number;
  height: number;
}

export interface ElectronPrintOptions {
  silent: true;
  deviceName: string;
  printBackground: true;
  landscape: false;
  margins: { marginType: 'none' };
  pageSize: ElectronPageSizeMicrons;
  copies: 1;
}

export interface PrintHtmlToWindowsPrinterInput {
  html: string;
  printerName: string;
  labelSize: LabelSizeInput;
  outputDir?: string;
}

interface ElectronWorkerInput {
  action: 'print-html' | 'list-printers';
  resultPath: string;
  html?: string;
  printerName?: string;
  labelSize?: LabelSizeInput;
  pageSizeMicrons?: ElectronPageSizeMicrons;
}

interface ElectronWorkerResult {
  ok: boolean;
  error?: string;
  printers?: unknown[];
}

interface ElectronRunDependencies {
  electronExecutable?: string;
  workerPath?: string;
  spawnElectron?: typeof spawn;
  tempRoot?: string;
}

export function pageSizeMicrons(labelSize: LabelSizeInput): ElectronPageSizeMicrons {
  const size = resolveLabelSizeInput(labelSize);
  return {
    width: Math.round(size.widthMm * 1000),
    height: Math.round(size.heightMm * 1000),
  };
}

export function electronPrintOptions(printerName: string, labelSize: LabelSizeInput): ElectronPrintOptions {
  return {
    silent: true,
    deviceName: printerName,
    printBackground: true,
    landscape: false,
    margins: { marginType: 'none' },
    pageSize: pageSizeMicrons(labelSize),
    copies: 1,
  };
}

export async function printHtmlToWindowsPrinter(
  input: PrintHtmlToWindowsPrinterInput,
  deps: ElectronRunDependencies = {},
): Promise<void> {
  const printOptions = electronPrintOptions(input.printerName, input.labelSize);
  // eslint-disable-next-line no-console
  console.log(
    [
      `Electron print started`,
      `printerName=${printOptions.deviceName}`,
      `labelSize=${input.labelSize}`,
      `pageSizeMicrons=${printOptions.pageSize.width}x${printOptions.pageSize.height}`,
      `landscape=${printOptions.landscape}`,
    ].join('\n'),
  );

  await runElectronWorker(
    {
      action: 'print-html',
      html: input.html,
      printerName: input.printerName,
      labelSize: input.labelSize,
      pageSizeMicrons: printOptions.pageSize,
      resultPath: '',
    },
    deps,
  );

  // eslint-disable-next-line no-console
  console.log('Electron print success');
}

export async function listElectronPrinters(deps: ElectronRunDependencies = {}): Promise<unknown[]> {
  const result = await runElectronWorker({ action: 'list-printers', resultPath: '' }, deps);
  return Array.isArray(result.printers) ? result.printers : [];
}

async function runElectronWorker(
  input: ElectronWorkerInput,
  deps: ElectronRunDependencies,
): Promise<ElectronWorkerResult> {
  const tempRoot = deps.tempRoot ?? path.join(os.tmpdir(), 'kanika-print-bridge');
  await fsp.mkdir(tempRoot, { recursive: true });
  const nonce = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const inputPath = path.join(tempRoot, `${nonce}.json`);
  const resultPath = path.join(tempRoot, `${nonce}.result.json`);
  const payload = { ...input, resultPath };
  await fsp.writeFile(inputPath, JSON.stringify(payload), 'utf8');

  try {
    const electronExecutable = deps.electronExecutable ?? resolveElectronExecutable();
    const workerPath = deps.workerPath ?? resolveElectronWorkerPath();
    const child = (deps.spawnElectron ?? spawn)(electronExecutable, [workerPath, inputPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: electronWorkerEnv(),
    });
    const { code, stderr } = await waitForChild(child);
    const result = await readWorkerResult(resultPath);
    if (code !== 0 || !result.ok) {
      const message = result.error || stderr.trim() || `Electron worker exited with code ${code}`;
      // eslint-disable-next-line no-console
      console.error(`Electron print failure: ${message}`);
      throw new Error(message);
    }
    return result;
  } finally {
    await Promise.all([
      fsp.rm(inputPath, { force: true }),
      fsp.rm(resultPath, { force: true }),
    ]);
  }
}

interface ElectronChildProcess {
  stdout: { on(event: 'data', listener: (chunk: Buffer) => void): unknown };
  stderr: { on(event: 'data', listener: (chunk: Buffer) => void): unknown };
  on(event: 'error', listener: (err: Error) => void): unknown;
  on(event: 'close', listener: (code: number | null) => void): unknown;
}

function waitForChild(child: ElectronChildProcess): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) {
        // eslint-disable-next-line no-console
        console.log(text);
      }
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stderr }));
  });
}

async function readWorkerResult(resultPath: string): Promise<ElectronWorkerResult> {
  try {
    const raw = await fsp.readFile(resultPath, 'utf8');
    return JSON.parse(raw) as ElectronWorkerResult;
  } catch {
    return { ok: false };
  }
}

function resolveElectronExecutable(): string {
  // Electron intentionally runs only on the shop laptop bridge, never on Render.
  // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
  const electronExecutable = require('electron') as unknown;
  if (typeof electronExecutable !== 'string' || !electronExecutable) {
    throw new Error('Electron executable could not be resolved.');
  }
  return electronExecutable;
}

function resolveElectronWorkerPath(): string {
  const candidates = [
    path.join(__dirname, 'electronPrintWorker.js'),
    path.resolve(process.cwd(), 'src/printing/electronPrintWorker.js'),
    path.resolve(process.cwd(), 'apps/print-bridge/src/printing/electronPrintWorker.js'),
  ];
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) {
    throw new Error(`Electron print worker not found. Checked: ${candidates.join(', ')}`);
  }
  return found;
}

function electronWorkerEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}
