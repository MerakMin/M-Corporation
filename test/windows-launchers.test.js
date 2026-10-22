import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('Windows batch files preserve ASCII and CRLF to avoid broken cmd.exe parsing', () => {
  for (const file of ['01-install.cmd', '02-start.cmd', '03-login.cmd', 'scripts/windows-env.cmd']) {
    const bytes = readFileSync(new URL(`../${file}`, import.meta.url));
    assert.ok(bytes.every(byte => byte < 128), `${file}: batch commands must not depend on the active code page`);
    const content = bytes.toString('ascii');
    assert.ok(content.startsWith('@echo off\r\n'), `${file}: CRLF required`);
    assert.ok(!/[\r\n]/.test(content.replaceAll('\r\n', '')), `${file}: bare CR or LF found`);
  }
});
