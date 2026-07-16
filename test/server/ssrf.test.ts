import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertPublicHttpUrl,
  isPrivateAddress,
  SsrfError,
  type LookupFn,
} from '../../src/server/ssrf.ts';

test('isPrivateAddress: representative private/public table', () => {
  // 非公開(true)
  const priv = [
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.0.1',
    '0.0.0.0',
    '100.64.0.1',
    '::1',
    '::',
    'fc00::1',
    'fd12:3456::1',
    'fe80::1',
    '::ffff:192.168.0.1',
    '::ffff:10.0.0.1',
  ];
  for (const ip of priv) {
    assert.equal(isPrivateAddress(ip), true, `${ip} should be private`);
  }
  // 公開(false)
  const pub = [
    '8.8.8.8',
    '1.1.1.1',
    '93.184.216.34',
    '172.15.255.255', // 172.16/12 の直前
    '172.32.0.1', // 172.16/12 の直後
    '100.63.255.255', // 100.64/10 の直前
    '2606:4700:4700::1111', // Cloudflare
    '::ffff:8.8.8.8',
  ];
  for (const ip of pub) {
    assert.equal(isPrivateAddress(ip), false, `${ip} should be public`);
  }
  // 判定不能は安全側(true)
  assert.equal(isPrivateAddress('not-an-ip'), true);
});

const publicLookup: LookupFn = async () => [{ address: '93.184.216.34', family: 4 }];

test('assertPublicHttpUrl: rejects non-http scheme', async () => {
  await assert.rejects(
    () => assertPublicHttpUrl('ftp://example.com/x', publicLookup),
    SsrfError,
  );
  await assert.rejects(
    () => assertPublicHttpUrl('file:///etc/passwd', publicLookup),
    SsrfError,
  );
});

test('assertPublicHttpUrl: accepts public host', async () => {
  const url = await assertPublicHttpUrl('https://example.com/article', publicLookup);
  assert.equal(url.hostname, 'example.com');
});

test('assertPublicHttpUrl: rejects host resolving to private IP', async () => {
  const privLookup: LookupFn = async () => [{ address: '10.0.0.5', family: 4 }];
  await assert.rejects(
    () => assertPublicHttpUrl('https://internal.example.com/x', privLookup),
    SsrfError,
  );
});

test('assertPublicHttpUrl: rejects if ANY resolved address is private', async () => {
  const mixed: LookupFn = async () => [
    { address: '93.184.216.34', family: 4 },
    { address: '127.0.0.1', family: 4 },
  ];
  await assert.rejects(() => assertPublicHttpUrl('https://mixed.example.com/x', mixed), SsrfError);
});

test('assertPublicHttpUrl: rejects IP literal to loopback without lookup', async () => {
  let called = false;
  const lookup: LookupFn = async () => {
    called = true;
    return [{ address: '93.184.216.34', family: 4 }];
  };
  await assert.rejects(() => assertPublicHttpUrl('http://127.0.0.1/x', lookup), SsrfError);
  await assert.rejects(() => assertPublicHttpUrl('http://[::1]/x', lookup), SsrfError);
  assert.equal(called, false, 'IP literals must be judged directly, not via lookup');
});

test('assertPublicHttpUrl: accepts public IP literal', async () => {
  const url = await assertPublicHttpUrl('http://93.184.216.34/x', publicLookup);
  assert.equal(url.hostname, '93.184.216.34');
});
