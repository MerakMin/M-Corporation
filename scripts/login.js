import { CAFE24_INQUIRIES, openCafe24InquiryPage } from '../src/cafe24-inquiries.js';
import { launchChannelBrowser } from '../src/persistent-browser.js';
import { createInterface } from 'node:readline/promises';
import { resolve } from 'node:path';
import { isExistingDesk } from '../src/server.js';
import { readLoginChannel } from '../src/login-config.js';
import { browserOptions, safeUrl, verifyChannelAccount } from '../src/connectors.js';
import { AppError, CHANNELS } from '../src/domain.js';
import { resolvedSourceUrl } from '../src/channel-presets.js';

const id = process.argv[2];
if (!CHANNELS.some(channel => channel.id === id)) {
  console.error('사용법: npm run login -- <채널 ID>\n채널 ID: ' + CHANNELS.map(c => c.id).join(', '));
  process.exit(1);
}
const dataDir = resolve(process.env.CS_DATA_DIR || '.data');
if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
  console.error('로그인에는 화면이 있는 환경이 필요합니다. 개인 PC에서 이 프로그램을 실행하고 npm run login -- ' + id + ' 명령을 실행하세요. 클라우드에는 개인 PC의 로그인 세션이 자동 공유되지 않습니다.');
  process.exit(1);
}
let context;
let terminal;
let verified = false;
try {
  const port = Number(process.env.PORT || 3000);
  if (Number.isInteger(port) && port > 0 && port <= 65535 && await isExistingDesk(`http://127.0.0.1:${port}`)) {
    throw new AppError('CS Desk 서버가 아직 실행 중입니다. 브라우저 탭을 닫아도 서버는 계속 동작합니다. 02-start.cmd 검은 창에서 Ctrl+C로 서버를 종료한 뒤 로그인하세요.');
  }
  const channel = readLoginChannel(dataDir, id);
  const source = channel.config.sources.find(s => s.url);
  const url = source && resolvedSourceUrl(source);
  if (!url) throw new AppError('먼저 대시보드 채널 설정에서 문의 페이지 URL을 저장하세요.');
  const session = await launchChannelBrowser(dataDir, id, browserOptions(false), { login: true });
  context = session.context;
  console.log(`로그인 브라우저: ${session.name}`);
  const isCafe24 = source.adapter === CAFE24_INQUIRIES;
  const page = context.pages()[0] || await context.newPage();
  const loginUrl = isCafe24 ? new URL('/admin/', safeUrl(url)).href : safeUrl(url);
  await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
  terminal = createInterface({ input: process.stdin, output: process.stdout });
  console.log(`로그인 대상: ${CHANNELS.find(c => c.id === id).name}`);
  if (channel.config.accountCheck) console.log(`반드시 선택할 스토어: ${channel.config.accountCheck.expectedText} (다른 네이버 계정의 세션과 별도로 저장됩니다.)`);
  await terminal.question(isCafe24
    ? '카페24 관리자 로그인을 마친 뒤 Enter를 누르세요. 등록된 상품 문의 목록을 확인합니다.\n'
    : '브라우저에서 직접 로그인하고 올바른 스토어의 문의 화면이 열리면 Enter를 누르세요. 비밀번호는 터미널에 입력하지 마세요.\n');
  if (isCafe24) {
    await openCafe24InquiryPage(page, safeUrl(url));
    console.log('카페24 미답변 상품 문의 화면을 확인했습니다.');
  } else if (channel.config.accountCheck?.selector) await verifyChannelAccount(page, channel);
  else if (channel.config.accountCheck) console.log('스토어명 자동 확인 설정이 아직 없습니다. 채널 설정에서 스토어명 선택자를 지정한 뒤 수집을 활성화하세요.');
  verified = true;
} catch (error) {
  console.error(error instanceof AppError ? error.message : '로그인 브라우저를 열거나 문의 페이지에 접속하지 못했습니다. CS Desk와 이전 로그인 창을 종료하고 다시 시도하세요.');
  process.exitCode = 1;
} finally {
  terminal?.close();
  await context?.close();
}
if (verified) {
  console.log('브라우저 세션을 저장했습니다. 02-start.cmd로 서버를 시작하고 지금 수집으로 확인하세요.');
}
