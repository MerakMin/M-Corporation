import { chromium } from 'playwright';
import { createInterface } from 'node:readline/promises';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { browserOptions, safeUrl } from '../src/connectors.js';
import { readLoginChannel } from '../src/login-config.js';
import { resolvedSourceUrl } from '../src/channel-presets.js';
import { inspectPageStructure } from '../src/page-structure.js';

async function main() {
  const dataDir = resolve(process.env.CS_DATA_DIR || '.data');
  const channel = readLoginChannel(dataDir, 'fashionplus');
  const source = channel.config.sources.find(source => source.url);
  if (!source) throw new Error('패션플러스 문의 주소가 없습니다. 채널 설정을 확인하세요.');
  if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) throw new Error('로그인한 Windows PC에서 실행하세요.');
  console.log('서버와 이전 로그인 브라우저를 종료한 상태에서 실행하세요.');
  console.log('이 도구는 답변을 입력하거나 전송하지 않습니다. 고객 내용·입력값·쿠키·URL은 보고서에 저장하지 않습니다.');
  const context = await chromium.launchPersistentContext(join(dataDir, 'profiles', 'fashionplus'), browserOptions(false));
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const page = await context.newPage();
    await page.goto(safeUrl(resolvedSourceUrl(source)), { waitUntil: 'domcontentloaded' });
    await page.bringToFront();
    const currentPage = () => context.pages().filter(page => !page.isClosed()).at(-1);
    const capture = async () => {
      const target = currentPage();
      if (!target || new URL(target.url()).origin !== new URL(source.url).origin) throw new Error('패션플러스 문의 화면으로 돌아온 뒤 다시 실행하세요.');
      return inspectPageStructure(target);
    };
    await terminal.question('1. 브라우저에서 문의 목록이 보이면 이 창으로 돌아와 Enter를 누르세요.\n');
    const list = await capture();
    const answer = await terminal.question('2. 브라우저에서 문의 한 건을 열어 본문과 답변 입력란을 표시한 뒤 Enter를 누르세요. 열 문의가 없으면 s를 입력하세요. 답변 등록 버튼은 누르지 마세요.\n');
    const detail = answer.trim().toLowerCase() === 's' ? null : await capture();
    const directory = resolve('diagnostics');
    await mkdir(directory, { recursive: true });
    const filename = join(directory, `fashionplus-structure-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    await writeFile(filename, JSON.stringify({ format: 1, channel: 'fashionplus', list, detail }, null, 2), { mode: 0o600 });
    console.log(`진단 파일 저장 완료: ${filename}`);
    console.log('이 JSON 파일만 채팅에 첨부하세요. .data 폴더는 보내지 마세요. 실제 수집 연동은 아직 완료되지 않았습니다.');
  } finally { terminal.close(); await context.close(); }
}
main().catch(() => {
  // Browser exceptions can contain full URLs; keep them out of shared diagnostics.
  console.error('진단을 완료하지 못했습니다. 서버·기존 로그인 브라우저를 종료하고, 로그인 및 문의 화면이 열려 있는지 확인한 뒤 다시 실행하세요.');
  process.exitCode = 1;
});
