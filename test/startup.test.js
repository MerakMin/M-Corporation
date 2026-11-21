import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/server.js';

const exec = promisify(execFile);
const serverScript = fileURLToPath(new URL('../src/server.js', import.meta.url));
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

test('포트를 사용 중인 최신·이전 CS Desk를 확인하고 새 DB나 스케줄러를 만들지 않는다', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cs-port-'));
  const running = createApp({ dataDir: join(dir, 'active'), scheduler: false });
  const port = await listen(running.server);
  const legacy = http.createServer((request, response) => {
    if (request.url === '/api/health') {
      response.setHeader('Content-Type', 'application/json');
      response.end('{"ok":true}');
    } else response.end('<title>M-Corporation · CS 데스크</title>');
  });
  const oldPort = await listen(legacy);
  try {
    for (const occupied of [port, oldPort]) {
      const dataDir = join(dir, 'duplicate');
      const result = await exec(process.execPath, [serverScript], {
        env: { ...process.env, PORT: String(occupied), CS_DATA_DIR: dataDir }, timeout: 8000,
      });
      assert.match(result.stdout, /이미 실행 중/);
      assert.match(result.stdout, new RegExp(`127\\.0\\.0\\.1:${occupied}`));
      assert.ok(!existsSync(dataDir));
    }
  } finally {
    await running.close();
    await new Promise(resolve => legacy.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});

test('다른 프로그램이 점유한 포트는 기존 CS Desk로 오인하거나 새 DB를 만들지 않는다', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cs-other-port-'));
  const server = http.createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.end('{"ok":true}');
  });
  const port = await listen(server);
  const dataDir = join(dir, 'new');
  try {
    await assert.rejects(exec(process.execPath, [serverScript], {
      env: { ...process.env, PORT: String(port), CS_DATA_DIR: dataDir }, timeout: 8000,
    }), error => error.code === 1 && /다른 프로세스가 사용 중/.test(error.stderr) && !/Unhandled/.test(error.stderr));
    assert.ok(!existsSync(dataDir));
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});
