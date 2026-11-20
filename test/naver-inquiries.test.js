import test from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import { CHANNELS, defaultChannelConfig } from '../src/channel-presets.js';
import { automaticCollectionPlan, createConnectors, validateConfig } from '../src/connectors.js';
import { createNaverCollector, naverCredentials } from '../src/naver-inquiries.js';

test('네이버 두 스토어와 페이센터는 자기 계정의 토큰으로 공식 문의 API만 조회한다', async t => {
  const salt = bcrypt.genSaltSync(4);
  const keys = { BEYOND: 'fixture-beyond', QUARTER: 'fixture-quarter', PAY: 'fixture-pay' };
  for (const [prefix, key] of Object.entries(keys)) {
    const id = `CS_NAVER_${prefix}_CLIENT_ID`, secret = `CS_NAVER_${prefix}_CLIENT_SECRET`;
    const previous = [process.env[id], process.env[secret]];
    t.after(() => {
      for (const [index, name] of [id, secret].entries()) {
        if (previous[index] === undefined) delete process.env[name]; else process.env[name] = previous[index];
      }
    });
    process.env[id] = key;
    process.env[secret] = salt;
  }
  const calls = [];
  const request = async (input, options) => {
    const url = new URL(input);
    calls.push(url.pathname);
    assert.equal(url.origin, 'https://api.commerce.naver.com');
    assert.equal(options.redirect, 'error');
    if (url.pathname.endsWith('/oauth2/token')) {
      assert.equal(options.method, 'POST');
      assert.equal(options.body.get('type'), 'SELF');
      const clientId = options.body.get('client_id');
      const password = `${clientId}_${options.body.get('timestamp')}`;
      assert.ok(await bcrypt.compare(password, Buffer.from(options.body.get('client_secret_sign'), 'base64').toString()));
      return Response.json({ access_token: clientId, expires_in: 10000 });
    }
    assert.equal(options.method, 'GET');
    assert.equal(url.searchParams.get('answered'), 'false');
    const token = options.headers.Authorization.slice('Bearer '.length);
    assert.ok(Object.values(keys).includes(token));
    const page = Number(url.searchParams.get('page'));
    const product = url.pathname.endsWith('/contents/qnas');
    const date = '2026-11-19T15:30:00Z';
    const fields = product
      ? { contents: [{ questionId: page, question: token, answered: false, createDate: date }] }
      : { content: [{ inquiryNo: page, inquiryContent: token, answered: false, inquiryRegistrationDateTime: date }] };
    if (!product) assert.equal(url.searchParams.get('endSearchDate'), '2026-11-20');
    return Response.json({ ...fields, last: page === 2, totalPages: 2, totalElements: 2 });
  };
  const collector = createNaverCollector(request);
  const now = new Date('2026-11-19T15:30:00Z');
  for (const [id, expected] of [['smartstore', keys.BEYOND], ['smartstore_quarter', keys.QUARTER], ['naverpay', keys.PAY]]) {
    const config = defaultChannelConfig(id);
    const def = CHANNELS.find(channel => channel.id === id);
    const plan = automaticCollectionPlan({ id, config }, def);
    assert.deepEqual(plan.map(source => source.ready), id === 'naverpay' ? [true] : [true, true, false, false]);
    for (const source of config.sources.filter(source => source.adapter)) {
      const items = await collector({ id }, source, now);
      assert.deepEqual(items.map(item => item.body), [expected, expected]);
      assert.deepEqual(items.map(item => item.external_id), ['1', '2']);
    }
  }
  assert.equal(calls.filter(path => path.endsWith('/oauth2/token')).length, 3);
  const config = defaultChannelConfig('smartstore');
  await assert.rejects(createConnectors('/tmp').send({ id: 'smartstore', config }, { source: 'smartstore-0' }), /직접 답변/);
  const duplicate = { CS_NAVER_BEYOND_CLIENT_ID: 'same', CS_NAVER_QUARTER_CLIENT_ID: 'same', CS_NAVER_BEYOND_CLIENT_SECRET: salt };
  assert.throws(() => naverCredentials('smartstore', duplicate), /다른 판매자/);
});

test('하이버·에이블리·룩핀 읽기 전용 설정에는 답변 폼 선택자가 필요 없다', async () => {
  for (const id of ['hiver', 'ably', 'lookpin']) {
    const config = defaultChannelConfig(id);
    config.enabled = true;
    for (const source of config.sources) {
      source.readOnly = true;
      source.selectors = { ready: 'main', row: 'article', idAttribute: 'data-id', body: 'p', link: 'a' };
    }
    const def = CHANNELS.find(channel => channel.id === id);
    assert.equal(validateConfig(config, def), config);
    assert.ok(automaticCollectionPlan({ id, config }, def).every(source => source.ready));
    await assert.rejects(createConnectors('/tmp').send({ id, config }, { source: config.sources[0].id }), /읽기 전용/);
    config.sources[0].readOnly = false;
    assert.throws(() => validateConfig(config, def), /필수 선택자/);
  }
});
