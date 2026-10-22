import { chromium } from 'playwright';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { AppError, normalizeText } from './domain.js';
import { CHANNELS, resolvedSourceUrl } from './channel-presets.js';

export function browserOptions(headless = true) {
  const executablePath = process.env.CS_CHROMIUM_PATH || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined);
  return { headless, executablePath, viewport: { width: 1440, height: 1000 }, locale: 'ko-KR' };
}
export function safeUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new AppError('올바른 문의 페이지 URL을 입력하세요.'); }
  const local = /^(localhost|127\.|0\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[|.*\.local$)/i.test(url.hostname);
  if (url.username || url.password || (!['https:'].includes(url.protocol) && !(process.env.CS_ALLOW_LOCAL_CONNECTORS === '1' && url.protocol === 'http:')) || (local && process.env.CS_ALLOW_LOCAL_CONNECTORS !== '1')) throw new AppError('자격 증명이 없는 공개 HTTPS 주소를 사용하세요.');
  return url.href;
}
export function validateConfig(config, definition = {}) {
  if (typeof config?.enabled !== 'boolean' || !Array.isArray(config.sources) || config.sources.length < 1 || config.sources.length > 10) throw new AppError('채널 설정 형식이 올바르지 않습니다.');
  if (config.replyShopName != null && (typeof config.replyShopName !== 'string' || config.replyShopName.length > 100)) throw new AppError('답변 상호는 100자 이하로 입력하세요.');
  if (config.accountCheck != null) {
    if (typeof config.accountCheck.selector !== 'string' || config.accountCheck.selector.length > 500 || typeof config.accountCheck.expectedText !== 'string' || config.accountCheck.expectedText.length > 100) throw new AppError('스토어 확인 설정을 확인하세요.');
  }
  if (config.enabled && definition.requireAccountCheck && (!config.accountCheck?.selector?.trim() || !config.accountCheck?.expectedText?.trim())) throw new AppError('네이버 계정을 구분할 스토어명 선택자와 정확한 표시 이름을 입력하세요.');
  if (config.enabled && !config.sources.some(s => s.enabled !== false)) throw new AppError('수집할 문의함을 하나 이상 선택하세요.');
  const ids = new Set();
  for (const source of config.sources) {
    if (source.enabled != null && typeof source.enabled !== 'boolean') throw new AppError('문의함 활성화 값은 true 또는 false여야 합니다.');
    if (!/^[a-z0-9_-]{1,60}$/.test(source.id) || ids.has(source.id)) throw new AppError('수집함 ID는 중복 없는 영문·숫자여야 합니다.');
    ids.add(source.id);
    if (typeof source.name !== 'string' || source.name.length > 100) throw new AppError('수집함 이름을 확인하세요.');
    if (source.url) source.url = safeUrl(source.url);
    if (!source.selectors || typeof source.selectors !== 'object' || Array.isArray(source.selectors)) throw new AppError('선택자 설정이 필요합니다.');
    for (const value of Object.values(source.selectors)) if (typeof value !== 'string' || value.length > 500) throw new AppError('선택자는 500자 이하 문자열이어야 합니다.');
    if (config.enabled && source.enabled !== false && (!source.url || !['ready', 'row', 'idAttribute', 'body', 'link', 'detailIdentity', 'detailIdAttribute', 'editor', 'submit', 'postedReply'].every(key => source.selectors[key]?.trim()))) throw new AppError('연동을 켜려면 수집할 문의함의 URL과 필수 선택자를 모두 입력하세요.');
    if (source.maxPages != null && (!Number.isInteger(source.maxPages) || source.maxPages < 1 || source.maxPages > 100)) throw new AppError('최대 페이지 수는 1~100입니다.');
    if (source.dateRange != null) {
      const range = source.dateRange;
      if (!Number.isInteger(range.days) || range.days < 1 || range.days > 365 || !/^[a-zA-Z0-9_]+$/.test(range.startParam || '') || !/^[a-zA-Z0-9_]+$/.test(range.endParam || '') || range.startParam === range.endParam || (range.periodParam != null && (!/^[a-zA-Z0-9_]+$/.test(range.periodParam) || [range.startParam, range.endParam].includes(range.periodParam)))) throw new AppError('자동 날짜 범위와 URL 파라미터를 확인하세요. (1~365일)');
    }
  }
  return config;
}
export async function verifyChannelAccount(page, channel) {
  const required = CHANNELS.find(c => c.id === channel.id)?.requireAccountCheck;
  const check = channel.config.accountCheck;
  if (!required && !check?.selector) return;
  if (!check?.selector?.trim() || !check?.expectedText?.trim()) throw new AppError('수집·전송 전에 스토어명 확인 설정이 필요합니다.');
  const actual = normalizeText(await page.locator(check.selector).innerText());
  if (actual !== normalizeText(check.expectedText)) throw new AppError('로그인한 스토어명이 이 채널의 설정과 다릅니다. 계정을 확인하세요.');
}
export function createConnectors(dataDir) {
  const busy = new Set();
  async function withChannel(channel, fn) {
    if (busy.has(channel.id)) throw new AppError('이 채널에서 다른 작업이 진행 중입니다. 잠시 후 다시 시도하세요.', 409);
    busy.add(channel.id);
    let context;
    try {
      context = await chromium.launchPersistentContext(join(dataDir, 'profiles', channel.id), browserOptions());
      context.setDefaultTimeout(12000);
      return await fn(context);
    } finally { await context?.close().catch(() => {}); busy.delete(channel.id); }
  }
  async function open(page, url, selectors) {
    await page.goto(safeUrl(url), { waitUntil: 'domcontentloaded', timeout: 45000 });
    if (selectors.login && await page.locator(selectors.login).count() && await page.locator(selectors.login).first().isVisible()) throw new AppError('로그인이 필요합니다. 해당 채널의 로그인 세션을 갱신하세요.');
  }
  return {
    async collectProducts(config) {
      if (!Array.isArray(config?.urls) || !config.urls.length || config.urls.length > 50) throw new AppError('상품 URL을 1~50개 입력하세요.');
      if (!config.selectors || !['name', 'row', 'size'].every(key => typeof config.selectors[key] === 'string' && config.selectors[key].trim())) throw new AppError('상품명(name), 실측 행(row), 사이즈(size) 선택자가 필요합니다.');
      for (const value of Object.values(config.selectors)) if (typeof value !== 'string' || value.length > 500) throw new AppError('선택자 형식을 확인하세요.');
      const urls = config.urls.map(safeUrl);
      const browser = await chromium.launch(browserOptions());
      try {
        const page = await browser.newPage(); page.setDefaultTimeout(12000);
        const products = [];
        for (const url of urls) {
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
          const s = config.selectors;
          const name = (await page.locator(s.name).first().innerText()).trim();
          await page.locator(s.row).first().waitFor();
          const rows = page.locator(s.row);
          const sizes = [];
          const count = await rows.count();
          if (count > 50) throw new AppError('상품당 사이즈 행이 50개를 초과합니다. 선택자를 확인하세요.');
          for (let i = 0; i < count; i++) {
            const row = rows.nth(i);
            const size = { size: (await row.locator(s.size).innerText()).trim() };
            for (const key of ['length', 'shoulder', 'chest', 'waist']) {
              if (!s[key]) continue;
              const text = (await row.locator(s[key]).innerText()).trim();
              if (!text || text === '—' || text === '-') continue;
              if (!/^\d+(\.\d+)?\s*(cm)?$/i.test(text)) throw new AppError('실측이 단일 cm 숫자가 아닙니다. 이미지·범위 실측은 직접 확인 후 등록하세요.');
              size[key] = Number.parseFloat(text);
            }
            sizes.push(size);
          }
          products.push({ name, sizes });
        }
        return products;
      } finally { await browser.close(); }
    },
    async collect(channel) {
      return withChannel(channel, async context => {
        const page = await context.newPage();
        const inquiries = [];
        for (const source of channel.config.sources) {
          if (source.enabled === false) continue;
          const s = source.selectors;
          await open(page, resolvedSourceUrl(source), s);
          await verifyChannelAccount(page, channel);
          await page.locator(s.ready).waitFor({ state: 'visible' });
          const seen = new Set();
          let complete = false;
          for (let pageIndex = 0; pageIndex < (source.maxPages || 20); pageIndex++) {
            const rows = page.locator(s.row);
            const count = await rows.count();
            if (!count && (!s.empty || !await page.locator(s.empty).first().isVisible())) throw new AppError('문의 행을 찾지 못했습니다. row 선택자 또는 빈 목록 표시(empty)를 확인하세요.');
            let added = 0;
            for (let index = 0; index < count; index++) {
              const row = rows.nth(index);
              const external_id = await row.getAttribute(s.idAttribute);
              if (!external_id) throw new AppError('문의 고유 ID를 읽지 못했습니다. idAttribute 선택자를 확인하세요.');
              if (seen.has(external_id)) continue;
              seen.add(external_id); added++;
              const text = async key => s[key] ? (await row.locator(s[key]).first().innerText()).trim() : '';
              const href = await row.locator(s.link).first().getAttribute('href');
              if (!href) throw new AppError('문의 원문 링크를 읽지 못했습니다.');
              const detailUrl = safeUrl(new URL(href, page.url()).href);
              if (new URL(detailUrl).origin !== new URL(page.url()).origin) throw new AppError('문의 상세 링크가 다른 사이트를 가리킵니다. link 선택자를 확인하세요.');
              const body = await text('body');
              if (!body) throw new AppError('문의 내용이 비어 있습니다. body 선택자를 확인하세요.');
              const date = s.date ? await text('date') : null;
              inquiries.push({ channel: channel.id, source: source.id, external_id, customer: await text('customer'), title: await text('title'), body, product: await text('product'), url: detailUrl, created_at: date && Number.isFinite(Date.parse(date)) ? new Date(date).toISOString() : undefined });
            }
            const next = s.next ? page.locator(s.next).first() : null;
            if (!next || !await next.count() || !await next.isVisible() || !await next.isEnabled() || await next.getAttribute('aria-disabled') === 'true') { complete = true; break; }
            if (!added) throw new AppError('페이지가 이동하지 않았습니다. next 선택자를 확인하세요.');
            const before = await rows.first().getAttribute(s.idAttribute);
            await next.click();
            await page.waitForFunction(({ row, attr, before }) => document.querySelector(row)?.getAttribute(attr) !== before, { row: s.row, attr: s.idAttribute, before });
          }
          if (!complete) throw new AppError('수집 페이지 한도에 도달했습니다. maxPages를 조정하세요. 이번 수집은 저장하지 않았습니다.');
        }
        return inquiries;
      });
    },
    async send(channel, inquiry) {
      return withChannel(channel, async context => {
        const source = channel.config.sources.find(s => s.id === inquiry.source);
        if (!source) throw new AppError('원래 수집함 설정이 없습니다. 채널 설정을 확인하세요.');
        const s = source.selectors;
        const page = await context.newPage();
        await open(page, inquiry.url, s);
        await verifyChannelAccount(page, channel);
        const actualId = await page.locator(s.detailIdentity).getAttribute(s.detailIdAttribute);
        if (actualId !== inquiry.external_id) throw new AppError('원문 문의의 고유 ID가 일치하지 않아 전송을 중단했습니다.');
        const replies = page.locator(s.postedReply);
        const matching = async () => (await replies.allTextContents()).some(text => normalizeText(text) === normalizeText(inquiry.draft));
        if (await matching()) return { alreadyPosted: true };
        if ((await replies.allTextContents()).some(text => text.trim())) throw new AppError('이미 다른 답변이 게시되어 있어 전송을 중단했습니다. 원문을 확인하세요.');
        const editor = page.locator(s.editor);
        await editor.fill(inquiry.draft);
        if (normalizeText(await editor.evaluate(el => el.value ?? el.textContent)) !== normalizeText(inquiry.draft)) throw new AppError('답변 입력값이 일치하지 않아 전송을 중단했습니다.');
        // Failures from this point can mean the remote side accepted the reply.
        // The caller must keep an uncertain state, never automatically retry.
        try {
          await page.locator(s.submit).click();
          if (s.confirm) await page.locator(s.confirm).click();
          await page.waitForFunction(({ selector, body }) => [...document.querySelectorAll(selector)].some(el => el.textContent.replace(/\s+/g, ' ').trim() === body), { selector: s.postedReply, body: normalizeText(inquiry.draft) }, { timeout: 15000 });
          if (!await matching()) throw new Error('답변 게시 결과 불일치');
        } catch (error) {
          const uncertain = new AppError('게시 결과를 확인하지 못했습니다. 원문에서 전송 여부를 확인한 뒤 상태를 정리하세요.', 409);
          uncertain.uncertain = true;
          throw uncertain;
        }
        return { alreadyPosted: false };
      });
    },
  };
}
