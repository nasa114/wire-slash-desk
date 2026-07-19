import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildUserAgent, ConfigError, loadConfig, validateEgressProxyTrust } from '../../src/config.ts';

// --- loadConfig: 基本挙動 ---------------------------------------------------

test('loadConfig: 既定値(未設定env)', () => {
  const config = loadConfig({});
  assert.equal(config.port, 3000);
  assert.equal(config.databaseUrl, undefined);
  assert.equal(config.mcpBearerToken, undefined);
  assert.equal(config.collectorToken, undefined);
  assert.equal(config.cacheFulltext, false);
  assert.equal(config.collectorContact, undefined);
  assert.equal(config.trustEgressProxy, false);
  assert.equal(config.cookieSecure, false, 'development では Secure なし(HTTP でも使える)');
  assert.equal(config.nodeEnv, 'development');
});

test('loadConfig: cookieSecure は NODE_ENV=production で true、SESSION_COOKIE_SECURE が優先', () => {
  // production は PT-003 の直接egress fail-closed に掛かるため、この観点の検証では
  // ALLOW_DIRECT_EGRESS=true で明示オプトアウトしておく(egress の是非は別テスト)。
  const prod = { NODE_ENV: 'production', ALLOW_DIRECT_EGRESS: 'true' };
  assert.equal(loadConfig(prod).cookieSecure, true);
  assert.equal(loadConfig({ ...prod, SESSION_COOKIE_SECURE: 'false' }).cookieSecure, false);
  assert.equal(loadConfig({ SESSION_COOKIE_SECURE: 'true' }).cookieSecure, true);
  assert.equal(loadConfig({ SESSION_COOKIE_SECURE: '1' }).cookieSecure, false, '"true" 以外は false');
});

test('loadConfig: PORT が数値でなければ既定の3000にフォールバック', () => {
  assert.equal(loadConfig({ PORT: 'not-a-number' }).port, 3000);
  assert.equal(loadConfig({ PORT: '0' }).port, 3000);
  assert.equal(loadConfig({ PORT: '-5' }).port, 3000);
  assert.equal(loadConfig({ PORT: '8080' }).port, 8080);
});

test('loadConfig: CACHE_FULLTEXT は文字列 "true" のときのみ有効', () => {
  assert.equal(loadConfig({ CACHE_FULLTEXT: 'true' }).cacheFulltext, true);
  assert.equal(loadConfig({ CACHE_FULLTEXT: 'false' }).cacheFulltext, false);
  assert.equal(loadConfig({ CACHE_FULLTEXT: '1' }).cacheFulltext, false);
  assert.equal(loadConfig({}).cacheFulltext, false);
});

test('loadConfig: 空文字・空白のみの値は未設定扱い', () => {
  const config = loadConfig({ DATABASE_URL: '   ', COLLECTOR_CONTACT: '' });
  assert.equal(config.databaseUrl, undefined);
  assert.equal(config.collectorContact, undefined);
});

test('loadConfig: 文字列値はそのままトリムして格納される', () => {
  const config = loadConfig({
    DATABASE_URL: '  postgresql://x  ',
    MCP_BEARER_TOKEN: 'mcp-token',
    COLLECTOR_TOKEN: 'collector-token',
    NODE_ENV: 'production',
    ALLOW_DIRECT_EGRESS: 'true',
  });
  assert.equal(config.databaseUrl, 'postgresql://x');
  assert.equal(config.mcpBearerToken, 'mcp-token');
  assert.equal(config.collectorToken, 'collector-token');
  assert.equal(config.nodeEnv, 'production');
});

// --- loadConfig: TRUST_EGRESS_PROXY は文字列 "true" のときのみ有効 ----------

test('loadConfig: TRUST_EGRESS_PROXY は "true" 以外なら false', () => {
  assert.equal(loadConfig({ TRUST_EGRESS_PROXY: 'false' }).trustEgressProxy, false);
  assert.equal(loadConfig({ TRUST_EGRESS_PROXY: '1' }).trustEgressProxy, false);
  assert.equal(loadConfig({}).trustEgressProxy, false);
});

// --- validateEgressProxyTrust: 単体テスト -----------------------------------

test('validateEgressProxyTrust: trustEgressProxy=false なら検証不要で通る', () => {
  assert.doesNotThrow(() => validateEgressProxyTrust({}, false));
  assert.doesNotThrow(() =>
    validateEgressProxyTrust({ TRUST_EGRESS_PROXY: 'false' /* 無関係な他env */ }, false),
  );
});

test('validateEgressProxyTrust: true + プロキシ関連env完備なら通る', () => {
  assert.doesNotThrow(() =>
    validateEgressProxyTrust(
      {
        HTTPS_PROXY: 'http://squid:3128',
        HTTP_PROXY: 'http://squid:3128',
        NODE_USE_ENV_PROXY: '1',
      },
      true,
    ),
  );
  // 小文字版でも可
  assert.doesNotThrow(() =>
    validateEgressProxyTrust(
      {
        https_proxy: 'http://squid:3128',
        http_proxy: 'http://squid:3128',
        NODE_USE_ENV_PROXY: '1',
      },
      true,
    ),
  );
});

test('validateEgressProxyTrust: true + HTTPS_PROXY 欠落でエラー', () => {
  assert.throws(
    () =>
      validateEgressProxyTrust(
        { HTTP_PROXY: 'http://squid:3128', NODE_USE_ENV_PROXY: '1' },
        true,
      ),
    ConfigError,
  );
});

test('validateEgressProxyTrust: true + HTTP_PROXY 欠落でエラー', () => {
  assert.throws(
    () =>
      validateEgressProxyTrust(
        { HTTPS_PROXY: 'http://squid:3128', NODE_USE_ENV_PROXY: '1' },
        true,
      ),
    ConfigError,
  );
});

test('validateEgressProxyTrust: true + NODE_USE_ENV_PROXY 欠落でエラー', () => {
  assert.throws(
    () =>
      validateEgressProxyTrust(
        { HTTPS_PROXY: 'http://squid:3128', HTTP_PROXY: 'http://squid:3128' },
        true,
      ),
    ConfigError,
  );
});

test('validateEgressProxyTrust: エラーメッセージは欠落変数名のみを含み、値は含めない', () => {
  const secretValue = 'http://super-secret-user:hunter2@squid:3128';
  try {
    validateEgressProxyTrust({ HTTP_PROXY: secretValue }, true);
    assert.fail('should have thrown');
  } catch (err) {
    assert.ok(err instanceof ConfigError);
    const message = (err as Error).message;
    assert.ok(message.includes('HTTPS_PROXY'), 'mentions missing HTTPS_PROXY');
    assert.ok(message.includes('NODE_USE_ENV_PROXY'), 'mentions missing NODE_USE_ENV_PROXY');
    assert.equal(message.includes(secretValue), false, 'must not leak proxy URL value');
    assert.equal(message.includes('hunter2'), false, 'must not leak credentials');
  }
});

// --- loadConfig: TRUST_EGRESS_PROXY=true の起動時検証を組み込み済み --------

test('loadConfig: TRUST_EGRESS_PROXY 未設定なら検証不要で通る', () => {
  assert.doesNotThrow(() => loadConfig({}));
});

test('loadConfig: TRUST_EGRESS_PROXY=true + プロキシenv完備なら通る', () => {
  const config = loadConfig({
    TRUST_EGRESS_PROXY: 'true',
    HTTPS_PROXY: 'http://squid:3128',
    HTTP_PROXY: 'http://squid:3128',
    NODE_USE_ENV_PROXY: '1',
  });
  assert.equal(config.trustEgressProxy, true);
});

test('loadConfig: TRUST_EGRESS_PROXY=true + HTTPS_PROXY 欠落で ConfigError', () => {
  assert.throws(
    () =>
      loadConfig({
        TRUST_EGRESS_PROXY: 'true',
        HTTP_PROXY: 'http://squid:3128',
        NODE_USE_ENV_PROXY: '1',
      }),
    ConfigError,
  );
});

test('loadConfig: TRUST_EGRESS_PROXY=true + NODE_USE_ENV_PROXY 欠落で ConfigError', () => {
  assert.throws(
    () =>
      loadConfig({
        TRUST_EGRESS_PROXY: 'true',
        HTTPS_PROXY: 'http://squid:3128',
        HTTP_PROXY: 'http://squid:3128',
      }),
    ConfigError,
  );
});

// --- PT-003: 本番の直接egress fail-closed --------------------------------

test('loadConfig: 本番 + 直接egress(proxy信頼なし)は既定で起動拒否', () => {
  assert.throws(
    () => loadConfig({ NODE_ENV: 'production' }),
    ConfigError,
    'production かつ TRUST_EGRESS_PROXY!=true は ConfigError',
  );
});

test('loadConfig: 本番の直接egressは ALLOW_DIRECT_EGRESS=true で明示許可できる', () => {
  const config = loadConfig({ NODE_ENV: 'production', ALLOW_DIRECT_EGRESS: 'true' });
  assert.equal(config.trustEgressProxy, false);
  assert.equal(config.nodeEnv, 'production');
});

test('loadConfig: 本番 + egress proxy 構成なら拒否しない', () => {
  const config = loadConfig({
    NODE_ENV: 'production',
    TRUST_EGRESS_PROXY: 'true',
    HTTPS_PROXY: 'http://squid:3128',
    HTTP_PROXY: 'http://squid:3128',
    NODE_USE_ENV_PROXY: '1',
  });
  assert.equal(config.trustEgressProxy, true);
});

test('loadConfig: development の直接egressは従来どおり許可(拒否しない)', () => {
  const config = loadConfig({ NODE_ENV: 'development' });
  assert.equal(config.trustEgressProxy, false);
});

test('loadConfig: NODE_ENV の大小差でも本番判定を取りこぼさない(fail-closed 堅牢化)', () => {
  // 'Production' でも本番扱いになり、直接egressは拒否される。
  assert.throws(() => loadConfig({ NODE_ENV: 'Production' }), ConfigError);
  // 明示オプトアウトすれば起動でき、nodeEnv は小文字正規化される。
  const config = loadConfig({ NODE_ENV: 'PRODUCTION', ALLOW_DIRECT_EGRESS: 'true' });
  assert.equal(config.nodeEnv, 'production');
  assert.equal(config.cookieSecure, true, '大小差でも Secure Cookie が有効になる');
});

// --- buildUserAgent -----------------------------------------------------

test('buildUserAgent: 連絡先ありなし', () => {
  assert.equal(buildUserAgent(undefined), 'personal-rss-reader/0.1');
  assert.equal(
    buildUserAgent('admin@example.com'),
    'personal-rss-reader/0.1 (+admin@example.com)',
  );
});

// --- OAUTH_ISSUER_URL (T4-2) --------------------------------------------

test('loadConfig: OAUTH_ISSUER_URL 未設定なら undefined(OAuth 無効)', () => {
  assert.equal(loadConfig({}).oauthIssuerUrl, undefined);
  assert.equal(loadConfig({ OAUTH_ISSUER_URL: '   ' }).oauthIssuerUrl, undefined);
});

test('loadConfig: OAUTH_ISSUER_URL は https、localhost のみ http 可', () => {
  assert.equal(
    loadConfig({ OAUTH_ISSUER_URL: 'https://reader.example.com' }).oauthIssuerUrl,
    'https://reader.example.com/',
  );
  assert.equal(
    loadConfig({ OAUTH_ISSUER_URL: 'http://localhost:3000' }).oauthIssuerUrl,
    'http://localhost:3000/',
  );
  assert.equal(
    loadConfig({ OAUTH_ISSUER_URL: 'http://127.0.0.1:3000' }).oauthIssuerUrl,
    'http://127.0.0.1:3000/',
  );
  assert.throws(() => loadConfig({ OAUTH_ISSUER_URL: 'http://reader.example.com' }), ConfigError);
  assert.throws(() => loadConfig({ OAUTH_ISSUER_URL: 'not a url' }), ConfigError);
  assert.throws(() => loadConfig({ OAUTH_ISSUER_URL: 'https://x.example/?a=1' }), ConfigError);
  assert.throws(() => loadConfig({ OAUTH_ISSUER_URL: 'https://x.example/#frag' }), ConfigError);
});

// --- SETUP_TOKEN (PT-001) -----------------------------------------------

test('loadConfig: SETUP_TOKEN は設定時のみ値、未設定/空白は undefined', () => {
  assert.equal(loadConfig({}).setupToken, undefined);
  assert.equal(loadConfig({ SETUP_TOKEN: '   ' }).setupToken, undefined);
  assert.equal(loadConfig({ SETUP_TOKEN: 's3cret' }).setupToken, 's3cret');
});
