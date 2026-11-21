import { spawn } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { AppError } from './domain.js';

async function readEndpoint(file) {
  try { return await readFile(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return ''; throw error; }
}

export async function launchViaLocalDebugPort(profile, options) {
  const message = '웨일을 시작하지 못했습니다. CS Desk와 이전 로그인·진단 창을 닫은 뒤 다시 시도하세요. 계속 실패하면 프로젝트를 짧은 경로에 풀고 실행하세요.';
  await mkdir(profile, { recursive: true });
  const marker = join(profile, 'DevToolsActivePort');
  const previous = await readEndpoint(marker);
  const args = [
    `--user-data-dir=${profile}`, '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check',
    `--lang=${options.locale}`, 'about:blank',
  ];
  if (options.headless) args.unshift('--headless=new');
  if (process.platform === 'linux') args.unshift('--no-sandbox');
  const child = spawn(options.executablePath, args, { stdio: 'ignore', windowsHide: options.headless });
  let exited = false;
  child.once('exit', () => { exited = true; });
  child.once('error', () => { exited = true; });
  let browser, session;
  const stop = async () => {
    try { await session?.send('Browser.close'); } catch { /* The browser might already be closed. */ }
    if (session) {
      for (let i = 0; i < 30 && !exited; i++) await delay(100);
    }
    if (!exited) child.kill();
    await browser?.close().catch(() => {});
  };
  try {
    let endpoint;
    for (let i = 0; i < 100 && !exited; i++) {
      const current = await readEndpoint(marker);
      const [port, path] = current.trim().split(/\r?\n/);
      if (!exited && current !== previous && /^\d+$/.test(port) && Number(port) > 0 && Number(port) <= 65535
          && /^\/devtools\/browser\/[a-f0-9-]+$/i.test(path || '')) {
        endpoint = `ws://127.0.0.1:${port}${path}`;
        break;
      }
      await delay(100);
    }
    if (!endpoint || exited) throw new AppError(message);
    browser = await chromium.connectOverCDP(endpoint, { timeout: 5000 });
    session = await browser.newBrowserCDPSession();
    const [context] = browser.contexts();
    if (!context) throw new AppError(message);
    let closing;
    context.close = () => { closing ||= stop(); return closing; };
    return context;
  } catch {
    await stop();
    throw new AppError(message);
  }
}

export function launchPersistentBrowser(profile, options) {
  if (process.platform === 'win32' && basename(options.executablePath || '').toLowerCase() === 'whale.exe') {
    return launchViaLocalDebugPort(profile, options);
  }
  return chromium.launchPersistentContext(profile, options);
}
