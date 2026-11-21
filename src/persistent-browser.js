import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'node:net';
import { basename } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { AppError } from './domain.js';

async function availableLocalPort() {
  const socket = createServer();
  await new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', resolve);
  });
  const { port } = socket.address();
  await new Promise((resolve, reject) => socket.close(error => error ? reject(error) : resolve()));
  return port;
}

async function localBrowserEndpoint(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
      redirect: 'error', signal: AbortSignal.timeout(350),
    });
    if (!response.ok) return;
    const { webSocketDebuggerUrl } = await response.json();
    const url = new URL(webSocketDebuggerUrl);
    if (url.protocol === 'ws:' && url.hostname === '127.0.0.1' && Number(url.port) === port
        && /^\/devtools\/browser\/[a-f0-9-]+$/i.test(url.pathname) && !url.search && !url.hash) return url.href;
  } catch { /* The browser may still be starting. */ }
}

export async function launchViaLocalDebugPort(profile, options) {
  const failure = reason => new AppError(`웨일 연결 실패: ${reason}`);
  try { await mkdir(profile, { recursive: true }); }
  catch { throw failure('채널 프로필 폴더를 열 수 없습니다.'); }
  let port;
  try { port = await availableLocalPort(); }
  catch { throw failure('PC 내부의 자동 수집 연결 포트를 열 수 없습니다.'); }
  const args = [
    `--user-data-dir=${profile}`, '--remote-debugging-address=127.0.0.1',
    `--remote-debugging-port=${port}`, '--no-first-run', '--no-default-browser-check',
    `--lang=${options.locale}`, 'about:blank',
  ];
  if (options.headless) args.unshift('--headless=new');
  if (process.platform === 'linux') args.unshift('--no-sandbox');
  const child = spawn(options.executablePath, args, { stdio: 'ignore', windowsHide: options.headless });
  let exited = false;
  child.once('exit', () => { exited = true; });
  let launchError = false;
  child.once('error', () => { exited = true; launchError = true; });
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
    const deadline = Date.now() + 20000;
    while (!exited && Date.now() < deadline) {
      endpoint = await localBrowserEndpoint(port);
      if (endpoint) break;
      await delay(100);
    }
    if (launchError) throw failure('웨일 실행 파일을 열 수 없습니다.');
    if (exited) throw failure('웨일이 연결 전에 닫혔습니다. 이전 CS Desk 전용 웨일 창을 닫아 주세요.');
    if (!endpoint) throw failure('웨일이 열렸지만 자동 수집 연결을 시작하지 않았습니다.');
    browser = await chromium.connectOverCDP(endpoint, { timeout: 5000 });
    session = await browser.newBrowserCDPSession();
    const [context] = browser.contexts();
    if (!context) throw failure('채널 브라우저 프로필에 연결하지 못했습니다.');
    let closing;
    context.close = () => { closing ||= stop(); return closing; };
    return context;
  } catch (error) {
    await stop();
    if (error instanceof AppError) throw error;
    throw failure('웨일의 자동 수집 연결에 응답이 없습니다.');
  }
}

export function launchPersistentBrowser(profile, options) {
  if (process.platform === 'win32' && basename(options.executablePath || '').toLowerCase() === 'whale.exe') {
    return launchViaLocalDebugPort(profile, { ...options, headless: false });
  }
  return chromium.launchPersistentContext(profile, options);
}
