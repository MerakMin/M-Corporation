import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { openStore } from './store.js';
import { createConnectors, validateConfig } from './connectors.js';
import { AppError, CATEGORIES, CHANNELS, makeDraft, missingFields } from './domain.js';
import { resolvedSourceUrl } from './channel-presets.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const INTERVAL = 10 * 60 * 1000;
const modeOf = value => { if (!['live', 'demo'].includes(value)) throw new AppError('작업 모드를 확인하세요.'); return value; };
const string = (value, label, max = 10000) => { if (typeof value !== 'string' || !value.trim() || value.length > max) throw new AppError(`${label}을(를) 확인하세요. (최대 ${max}자)`); return value.trim(); };

export function createApp({ dataDir = process.env.CS_DATA_DIR || join(root, '.data'), connectors, scheduler = true } = {}) {
  const store = openStore(resolve(dataDir));
  const { db } = store;
  const browser = connectors || createConnectors(resolve(dataDir));
  let syncing = false;
  let nextSync = new Date(Date.now() + INTERVAL).toISOString();
  let timer;
  let shuttingDown = false;
  let syncFinished = Promise.resolve();
  const armTimer = () => {
    if (!scheduler || shuttingDown) return;
    clearTimeout(timer);
    nextSync = new Date(Date.now() + INTERVAL).toISOString();
    timer = setTimeout(() => { sync().catch(() => {}); }, INTERVAL);
    timer.unref();
  };
  const publicInquiry = row => ({ ...row, missing: missingFields(row.draft) });
  const getInquiry = (id, mode) => { const row = store.inquiry(id); if (!row || row.mode !== mode) throw new AppError('문의를 찾을 수 없습니다.', 404); return row; };
  const checkVersion = (row, version) => { if (row.version !== version) throw new AppError('다른 작업으로 문의가 변경되었습니다. 새로고침 후 다시 검토하세요.', 409); };
  const editable = row => { if (!['pending', 'failed'].includes(row.status)) throw new AppError('현재 상태에서는 답변을 수정하거나 전송할 수 없습니다.', 409); };

  async function sync(mode = 'live') {
    if (shuttingDown) throw new AppError('서버가 종료 중입니다.', 503);
    if (syncing) throw new AppError('이미 수집 중입니다.', 409);
    syncing = true;
    let resolveSync;
    syncFinished = new Promise(resolve => { resolveSync = resolve; });
    const results = [];
    try {
      if (mode === 'demo') {
        store.event(mode, null, 'sync', '예시 문의를 확인했습니다. 실제 채널에는 접속하지 않았습니다.');
        return { added: 0, results: [], demo: true };
      }
      for (const def of store.channelDefinitions()) {
        const channel = store.channel(def.id);
        if (!channel.config.enabled) continue;
        db.prepare("UPDATE channels SET status='syncing', error=NULL WHERE id=?").run(def.id);
        try {
          const items = await browser.collect(channel);
          let added = 0;
          db.exec('BEGIN');
          try {
            for (const item of items) added += store.addInquiry('live', item);
            db.prepare("UPDATE channels SET status='connected', last_sync=?, error=NULL WHERE id=?").run(new Date().toISOString(), def.id);
            store.event('live', null, 'sync', `${def.name}: ${items.length}건 확인, ${added}건 추가`);
            db.exec('COMMIT');
          } catch (error) { db.exec('ROLLBACK'); throw error; }
          results.push({ channel: def.id, added, ok: true });
        } catch (error) {
          const message = error instanceof AppError ? error.message : '문의 화면을 읽지 못했습니다. 로그인·URL·선택자와 브라우저 설치 상태를 확인하세요.';
          db.prepare("UPDATE channels SET status='error', error=? WHERE id=?").run(message, def.id);
          store.event('live', null, 'sync_failed', `${def.name}: ${message}`);
          results.push({ channel: def.id, ok: false, error: message });
        }
      }
      return { added: results.reduce((sum, r) => sum + (r.added || 0), 0), results };
    } finally { syncing = false; resolveSync(); if (mode === 'live') armTimer(); }
  }
  armTimer();
  async function route(method, path, query, body) {
    if (method === 'GET' && path === '/api/health') return { ok: true };
    if (method === 'GET' && path === '/api/state') {
      const mode = modeOf(query.get('mode') || 'demo');
      return {
        mode, shop: store.getSetting('shop'), templates: store.getSetting('templates'), categories: CATEGORIES,
        inquiries: db.prepare('SELECT * FROM inquiries WHERE mode=? ORDER BY created_at DESC').all(mode).map(publicInquiry),
        channels: store.channelDefinitions().map(c => {
          const saved = store.channel(c.id);
          return { ...c, ...saved, sources: saved.config.sources.map(s => s.name), resolvedSources: saved.config.sources.map(s => ({ id: s.id, url: resolvedSourceUrl(s) })) };
        }),
        products: store.products(mode), events: db.prepare('SELECT * FROM events WHERE mode=? ORDER BY id DESC LIMIT 100').all(mode),
        syncing, nextSync,
      };
    }
    if (method === 'POST' && path === '/api/sync') return sync(modeOf(body.mode));
    if (method === 'PUT' && path === '/api/settings') {
      const shop = string(body.shop, '상호명', 100);
      const templates = {};
      for (const category of CATEGORIES) templates[category] = string(body.templates?.[category], `${category} 템플릿`, 10000);
      store.setSetting('shop', shop); store.setSetting('templates', templates);
      store.event('live', null, 'settings', '상호명과 답변 템플릿을 저장했습니다. 기존 초안은 유지됩니다.');
      return { ok: true };
    }
    const channelMatch = path.match(/^\/api\/channels\/([a-z0-9_-]+)$/);
    if (channelMatch && method === 'PUT') {
      if (!store.channel(channelMatch[1])) throw new AppError('알 수 없는 채널입니다.', 404);
      if (syncing) throw new AppError('수집이 끝난 후 설정을 변경하세요.', 409);
      const definition = store.channelDefinitions().find(c => c.id === channelMatch[1]);
      const previous = store.channel(channelMatch[1]).config;
      const config = validateConfig({ ...previous, ...body.config }, definition);
      db.prepare("UPDATE channels SET config=?, status=?, error=NULL WHERE id=?").run(JSON.stringify(config), config.enabled ? 'configured' : 'unconfigured', channelMatch[1]);
      return { ok: true };
    }
    if (method === 'POST' && (path === '/api/products' || path === '/api/products/collect')) {
      const mode = modeOf(body.mode);
      if (path === '/api/products/collect') {
        try { body.products = await browser.collectProducts(body.config); }
        catch (error) { throw error instanceof AppError ? error : new AppError('상품 실측을 읽지 못했습니다. URL과 화면 선택자를 확인하세요.'); }
      }
      if (!Array.isArray(body.products) || !body.products.length || body.products.length > 1000) throw new AppError('상품을 1~1,000개 입력하세요.');
      const products = body.products.map(product => {
        const name = string(product.name, '상품명', 200);
        if (!Array.isArray(product.sizes) || !product.sizes.length || product.sizes.length > 50) throw new AppError('사이즈별 실측을 입력하세요.');
        const sizes = product.sizes.map(size => {
          const row = { size: string(size.size, '사이즈', 30) };
          for (const key of ['length', 'shoulder', 'chest', 'waist']) {
            if (size[key] == null || size[key] === '') continue;
            if (typeof size[key] !== 'number' || !Number.isFinite(size[key]) || size[key] <= 0 || size[key] > 300) throw new AppError('실측은 0보다 크고 300 이하인 cm 숫자여야 합니다.');
            row[key] = size[key];
          }
          if (Object.keys(row).length === 1) throw new AppError('각 사이즈에 한 가지 이상 실측을 입력하세요.');
          return row;
        });
        if (new Set(sizes.map(s => s.size)).size !== sizes.length) throw new AppError('사이즈 이름이 중복되었습니다.');
        return { name, sizes };
      });
      db.exec('BEGIN');
      try {
        for (const product of products) db.prepare('INSERT INTO products VALUES (?,?,?,?) ON CONFLICT(mode,name) DO UPDATE SET sizes=excluded.sizes').run(randomUUID(), mode, product.name, JSON.stringify(product.sizes));
        store.event(mode, null, 'products', `상품 ${products.length}개 실측을 저장했습니다.`);
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      return { ok: true, count: products.length };
    }
    const productMatch = path.match(/^\/api\/products\/([\w-]+)$/);
    if (productMatch && method === 'DELETE') {
      const mode = modeOf(body.mode);
      db.prepare('DELETE FROM products WHERE id=? AND mode=?').run(productMatch[1], mode);
      return { ok: true };
    }
    const inquiryMatch = path.match(/^\/api\/inquiries\/([\w-]+)(?:\/(regenerate|send|resolve))?$/);
    if (inquiryMatch) {
      const mode = modeOf(body.mode);
      const row = getInquiry(inquiryMatch[1], mode);
      checkVersion(row, body.version);
      const action = inquiryMatch[2];
      if (method === 'PATCH' && !action) {
        editable(row);
        const draft = string(body.draft, '답변', 10000);
        if (!CATEGORIES.includes(body.category)) throw new AppError('문의 유형을 확인하세요.');
        db.prepare("UPDATE inquiries SET draft=?,category=?,version=version+1,status='pending',error=NULL WHERE id=?").run(draft, body.category, row.id);
        store.event(mode, row.id, 'draft_saved', '답변 초안을 수정했습니다.');
      } else if (method === 'POST' && action === 'regenerate') {
        editable(row);
        const category = body.category || row.category;
        if (!CATEGORIES.includes(category)) throw new AppError('문의 유형을 확인하세요.');
        const draft = makeDraft({ ...row, category }, store.getSetting('templates'), store.replyShop(row.channel), store.products(mode));
        db.prepare("UPDATE inquiries SET draft=?,category=?,version=version+1,status='pending',error=NULL WHERE id=?").run(draft, category, row.id);
        store.event(mode, row.id, 'draft_generated', `${category} 템플릿으로 초안을 다시 작성했습니다.`);
      } else if (method === 'POST' && action === 'send') {
        editable(row);
        if (body.approved !== true) throw new AppError('답변을 검토하고 전송을 확인해 주세요.');
        if (missingFields(row.draft).length) throw new AppError('답변의 빈칸을 모두 채운 후 전송하세요.');
        const channel = store.channel(row.channel);
        if (mode === 'live' && !channel.config.enabled) throw new AppError('먼저 해당 채널을 연결하세요.');
        const changed = db.prepare("UPDATE inquiries SET status='sending',error=NULL,version=version+1 WHERE id=? AND version=? AND status IN ('pending','failed')").run(row.id, row.version).changes;
        if (!changed) throw new AppError('이미 전송 중이거나 처리된 문의입니다.', 409);
        store.event(mode, row.id, 'send_approved', mode === 'demo' ? '예시 전송을 승인했습니다.' : '사용자가 검토한 답변의 전송을 승인했습니다.');
        try {
          if (mode === 'live') await browser.send(channel, row);
          db.prepare("UPDATE inquiries SET status='sent',sent_at=?,sent_body=?,error=NULL,version=version+1 WHERE id=?").run(new Date().toISOString(), row.draft, row.id);
          store.event(mode, row.id, 'sent', mode === 'demo' ? '예시 전송 완료. 외부 게시 없음.' : '원문에서 답변 게시를 확인했습니다.');
        } catch (error) {
          const status = error.uncertain ? 'uncertain' : 'failed';
          const message = error instanceof AppError ? error.message : '전송 전 작업에 실패했습니다. 로그인·화면 선택자와 브라우저 상태를 확인하세요.';
          db.prepare('UPDATE inquiries SET status=?,error=?,version=version+1 WHERE id=?').run(status, message, row.id);
          store.event(mode, row.id, status, message);
          throw new AppError(message, 409);
        }
      } else if (method === 'POST' && action === 'resolve') {
        if (row.status !== 'uncertain' || body.confirmed !== true || !['sent', 'pending'].includes(body.outcome)) throw new AppError('원문 확인 후 게시 여부를 선택하세요.');
        db.prepare('UPDATE inquiries SET status=?,error=NULL,sent_at=?,sent_body=?,version=version+1 WHERE id=?').run(body.outcome, body.outcome === 'sent' ? new Date().toISOString() : null, body.outcome === 'sent' ? row.draft : null, row.id);
        store.event(mode, row.id, 'resolved', `사용자가 원문을 확인하고 ${body.outcome === 'sent' ? '게시 완료' : '미게시'} 상태로 정리했습니다.`);
      } else throw new AppError('지원하지 않는 요청입니다.', 404);
      return publicInquiry(store.inquiry(row.id));
    }
    throw new AppError('요청한 경로를 찾을 수 없습니다.', 404);
  }
  const server = http.createServer(async (req, res) => {
    const headers = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" };
    try {
      const expectedHost = `127.0.0.1:${server.address()?.port}`;
      if (![expectedHost, `localhost:${server.address()?.port}`].includes(req.headers.host)) throw new AppError('허용되지 않은 호스트입니다.', 403);
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (url.pathname.startsWith('/api/')) {
        if (req.headers['sec-fetch-site'] === 'cross-site' || (req.headers.origin && req.headers.origin !== url.origin)) throw new AppError('같은 출처에서 요청하세요.', 403);
        let body = {};
        if (!['GET', 'HEAD'].includes(req.method)) {
          if (!req.headers['content-type']?.startsWith('application/json')) throw new AppError('JSON 요청이 필요합니다.', 415);
          const chunks = []; let bytes = 0;
          for await (const chunk of req) { bytes += chunk.length; if (bytes > 2 * 1024 * 1024) throw new AppError('요청이 너무 큽니다.', 413); chunks.push(chunk); }
          const raw = Buffer.concat(chunks).toString('utf8');
          try { body = JSON.parse(raw || '{}'); } catch { throw new AppError('JSON 형식이 올바르지 않습니다.'); }
          if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AppError('JSON 객체가 필요합니다.');
        }
        const result = await route(req.method, url.pathname, url.searchParams, body);
        res.writeHead(200, { ...headers, 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(result));
      } else {
        if (req.method !== 'GET') throw new AppError('지원하지 않는 요청입니다.', 405);
        const files = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/styles.css': ['styles.css', 'text/css'] };
        const file = files[url.pathname];
        if (!file) throw new AppError('페이지를 찾을 수 없습니다.', 404);
        const content = await readFile(join(root, 'public', file[0]));
        res.writeHead(200, { ...headers, 'Content-Type': `${file[1]}; charset=utf-8` }); res.end(content);
      }
    } catch (error) {
      if (!(error instanceof AppError)) console.error('Request failed:', error.message);
      res.writeHead(error.status || 500, { ...headers, 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: error instanceof AppError ? error.message : '서버 오류가 발생했습니다. 서버 로그를 확인하세요.' }));
    }
  });
  return { server, store, sync, async close() { shuttingDown = true; clearTimeout(timer); await new Promise(resolve => server.listening ? server.close(resolve) : resolve()); await syncFinished; store.close(); } };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = createApp();
  const port = Number(process.env.PORT || 3000);
  app.server.listen(port, '127.0.0.1', () => console.log(`M-Corporation CS Desk: http://127.0.0.1:${port}`));
  const stop = async () => { await app.close(); process.exit(0); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}
