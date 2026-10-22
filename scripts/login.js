import { chromium } from 'playwright';
import { createInterface } from 'node:readline/promises';
import { resolve, join } from 'node:path';
import { openStore } from '../src/store.js';
import { browserOptions, safeUrl, verifyChannelAccount } from '../src/connectors.js';
import { CHANNELS } from '../src/domain.js';
import { resolvedSourceUrl } from '../src/channel-presets.js';

const id = process.argv[2];
if (!CHANNELS.some(channel => channel.id === id)) {
  console.error('사용법: npm run login -- <채널 ID>\n채널 ID: ' + CHANNELS.map(c => c.id).join(', '));
  process.exit(1);
}
const dataDir = resolve(process.env.CS_DATA_DIR || '.data');
const store = openStore(dataDir);
const channel = store.channel(id);
store.close();
const source = channel.config.sources.find(s => s.url);
const url = source && resolvedSourceUrl(source);
if (!url) { console.error('먼저 대시보드 채널 설정에서 문의 페이지 URL을 저장하세요.'); process.exit(1); }
if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
  console.error('로그인에는 화면이 있는 환경이 필요합니다. 개인 PC에서 이 프로그램을 실행하고 npm run login -- ' + id + ' 명령을 실행하세요. 클라우드에는 개인 PC의 로그인 세션이 자동 공유되지 않습니다.');
  process.exit(1);
}
const context = await chromium.launchPersistentContext(join(dataDir, 'profiles', id), browserOptions(false));
try {
  const page = await context.newPage(); await page.goto(safeUrl(url));
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  console.log(`로그인 대상: ${CHANNELS.find(c => c.id === id).name}`);
  if (channel.config.accountCheck) console.log(`반드시 선택할 스토어: ${channel.config.accountCheck.expectedText} (다른 네이버 계정의 세션과 별도로 저장됩니다.)`);
  await terminal.question('브라우저에서 직접 로그인하고 올바른 스토어의 문의 화면이 열리면 Enter를 누르세요. 비밀번호는 터미널에 입력하지 마세요.\n');
  terminal.close();
  if (channel.config.accountCheck?.selector) await verifyChannelAccount(page, channel);
  else if (channel.config.accountCheck) console.log('스토어명 자동 확인 설정이 아직 없습니다. 채널 설정에서 스토어명 선택자를 지정한 뒤 수집을 활성화하세요.');
} finally { await context.close(); }
console.log('브라우저 세션을 저장했습니다. 서버를 시작한 뒤 지금 수집을 실행하세요.');
