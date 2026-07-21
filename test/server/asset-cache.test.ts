import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../../src/server/app.ts';
import { createMemoryRepositories } from '../../src/repo/memory/index.ts';
// 実装対象(T: 静的アセットの内容ハッシュ版キャッシュバスティング + SVG minify)。
// このモジュールはまだ存在しない — 本テストが実装の契約を先に定義する(TDD)。
import { getAsset, assetVersion, assetPath, type AssetName } from '../../src/server/assets.ts';

/** getAsset が扱う全アセット名(実装契約)。 */
const ASSET_NAMES = ['app.css', 'clock.js', 'login.js', 'login-bg.svg', 'htmx.min.js'] as const;

const HEX12_RE = /^[0-9a-f]{12}$/;

/** 契約どおりの自前計算: getAsset の内容(UTF-8)の sha256 hex 先頭12文字。 */
function expectedVersion(name: AssetName): string {
  return createHash('sha256').update(getAsset(name), 'utf8').digest('hex').slice(0, 12);
}

/* ------------------------------------------------------------ unit */

test('assets(unit): assetVersion は sha256 先頭12hex(全アセット)', () => {
  for (const name of ASSET_NAMES) {
    const version = assetVersion(name);
    assert.match(version, HEX12_RE, `${name} の version は 12 桁の小文字 hex`);
    assert.equal(
      version,
      expectedVersion(name),
      `${name} の version は getAsset 内容の sha256 hex 先頭12文字と一致`,
    );
  }
});

test('assets(unit): assetPath は /assets/<name>?v=<version> 形式', () => {
  for (const name of ASSET_NAMES) {
    assert.equal(assetPath(name), `/assets/${name}?v=${assetVersion(name)}`);
  }
});

test('assets(unit): app.css 内の login-bg.svg 参照はバージョン付きに書き換えられる', () => {
  const css = getAsset('app.css');
  const svgPath = assetPath('login-bg.svg');
  assert.equal(
    svgPath,
    `/assets/login-bg.svg?v=${assetVersion('login-bg.svg')}`,
    '前提: SVG のバージョン付きパス',
  );
  assert.ok(
    css.includes(`login-bg.svg?v=${assetVersion('login-bg.svg')}`),
    'CSS 内の参照は SVG の内容ハッシュ版に置換される',
  );
  assert.ok(css.includes(svgPath), 'assetPath("login-bg.svg") の返す文字列そのものを含む');
  // minify 後のソースは url('/assets/login-bg.svg') — v 無しの素URL参照が残ってはならない。
  assert.ok(!css.includes("login-bg.svg')"), 'バージョン無しの素URL参照が残っていない');
});

test('assets(unit): app.css の version は書き換え後の内容から算出される', () => {
  // expectedVersion は getAsset('app.css')(=書き換え済み)から計算しているので、
  // 実装が「書き換え前の内容」でハッシュを取るとここで不一致になる。
  assert.equal(assetVersion('app.css'), expectedVersion('app.css'));
});

test('assets(unit): login-bg.svg は minify される(コメント・インデント除去、<svg は残る)', () => {
  const svg = getAsset('login-bg.svg');
  assert.ok(!svg.includes('<!--'), 'XML コメントが除去されている');
  assert.ok(!/\n[ \t]/.test(svg), '改行直後の空白(インデント)が除去されている');
  assert.match(svg, /<svg/, 'svg 要素そのものは残る');
});

test('assets(unit): getAsset / assetVersion は冪等(2回呼んでも同一)', () => {
  for (const name of ASSET_NAMES) {
    assert.equal(getAsset(name), getAsset(name), `${name} の内容は毎回同一(キャッシュ)`);
    assert.equal(assetVersion(name), assetVersion(name), `${name} の version は安定`);
  }
});

/* ------------------------------------------------- 統合テスト setup */
/* web.test.ts と同じ起動・ログイン手順(あちらは変更しない方針のため複製)。 */

const ADMIN_USER = 'admin';
const ADMIN_PASSWORD = 'test-password-123';

interface TestApp {
  base: string;
  close: () => Promise<void>;
}

async function startApp(): Promise<TestApp> {
  const repos = createMemoryRepositories();
  const app: Server = createApp({
    repos,
    runCollect: async () => ({}),
    mcpBearerToken: 'mcp-token',
    collectorToken: 'collector-token',
    cacheFulltext: false,
  });
  await new Promise<void>((resolve) => app.listen(0, resolve));
  const { port } = app.address() as AddressInfo;
  return {
    base: `http://localhost:${port}`,
    close: () => new Promise((resolve) => app.close(() => resolve())),
  };
}

function postForm(base: string, path: string, body: Record<string, string>): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      origin: base,
    },
    body: new URLSearchParams(body).toString(),
  });
}

function getPage(base: string, path: string, cookie?: string): Promise<Response> {
  return fetch(`${base}${path}`, {
    redirect: 'manual',
    ...(cookie !== undefined ? { headers: { cookie } } : {}),
  });
}

async function setupAdmin(base: string): Promise<void> {
  const res = await postForm(base, '/setup', {
    username: ADMIN_USER,
    password: ADMIN_PASSWORD,
    password_confirm: ADMIN_PASSWORD,
  });
  assert.equal(res.status, 303, 'setup は成功すること');
}

async function login(base: string): Promise<string> {
  const res = await postForm(base, '/login', { username: ADMIN_USER, password: ADMIN_PASSWORD });
  assert.equal(res.status, 303, 'login は成功すること');
  const setCookie = res.headers.getSetCookie().find((v) => v.startsWith('session='));
  assert.ok(setCookie, 'Set-Cookie: session が返ること');
  return setCookie.split(';', 1)[0] as string;
}

/* -------------------------------------------------------- integration */

test('assets(統合): HTML ページのアセットURLはすべてバージョン付き', async (t) => {
  const { base, close } = await startApp();
  try {
    await setupAdmin(base);

    await t.test('/login: app.css / htmx.min.js / login.js がバージョン付きで参照される', async () => {
      const res = await getPage(base, '/login');
      assert.equal(res.status, 200);
      const html = await res.text();
      // 値が assetVersion と一致するバージョン付きURLであること(形式だけでなく値も検証)。
      assert.ok(
        html.includes(`href="${assetPath('app.css')}"`),
        `app.css は ${assetPath('app.css')} で参照される`,
      );
      assert.ok(
        html.includes(`src="${assetPath('htmx.min.js')}"`),
        `htmx.min.js は ${assetPath('htmx.min.js')} で参照される`,
      );
      assert.ok(
        html.includes(`src="${assetPath('login.js')}"`),
        `login.js は ${assetPath('login.js')} で参照される`,
      );
      // v 値の形式も明示的に確認(12hex)。
      assert.match(html, /\/assets\/app\.css\?v=[0-9a-f]{12}/);
      assert.match(html, /\/assets\/htmx\.min\.js\?v=[0-9a-f]{12}/);
      assert.match(html, /\/assets\/login\.js\?v=[0-9a-f]{12}/);
      // バージョン無しの参照が残っていないこと(属性値の閉じ引用符で判定)。
      assert.ok(!html.includes('href="/assets/app.css"'), 'v 無しの app.css 参照が残らない');
      assert.ok(!html.includes('src="/assets/htmx.min.js"'), 'v 無しの htmx 参照が残らない');
      assert.ok(!html.includes('src="/assets/login.js"'), 'v 無しの login.js 参照が残らない');
    });

    await t.test('認証後ページ(ダッシュボード): clock.js がバージョン付きで参照される', async () => {
      const cookie = await login(base);
      const res = await getPage(base, '/', cookie);
      assert.equal(res.status, 200);
      const html = await res.text();
      assert.ok(
        html.includes(`src="${assetPath('clock.js')}"`),
        `clock.js は ${assetPath('clock.js')} で参照される`,
      );
      assert.match(html, /\/assets\/clock\.js\?v=[0-9a-f]{12}/);
      assert.ok(!html.includes('src="/assets/clock.js"'), 'v 無しの clock.js 参照が残らない');
      // 認証後ページも共通アセットはバージョン付き。
      assert.ok(html.includes(`href="${assetPath('app.css')}"`));
      assert.ok(html.includes(`src="${assetPath('htmx.min.js')}"`));
    });
  } finally {
    await close();
  }
});

test('assets(統合): v クエリの一致で cache-control が immutable / no-cache に分かれる', async (t) => {
  const { base, close } = await startApp();
  try {
    await t.test('app.css: 正しい v は immutable、v 無し・誤 v は no-cache、ボディは同一', async () => {
      const good = await fetch(`${base}/assets/app.css?v=${assetVersion('app.css')}`);
      assert.equal(good.status, 200);
      assert.equal(
        good.headers.get('cache-control'),
        'public, max-age=31536000, immutable',
        '現行バージョン一致は長期キャッシュ + immutable',
      );

      const noVersion = await fetch(`${base}/assets/app.css`);
      assert.equal(noVersion.status, 200, 'v 無しでも 200(拒否しない)');
      assert.equal(noVersion.headers.get('cache-control'), 'no-cache', 'v 無しは no-cache');

      const wrong = await fetch(`${base}/assets/app.css?v=deadbeef1234`);
      assert.equal(wrong.status, 200, '誤った v でも 200(拒否しない)');
      assert.equal(wrong.headers.get('cache-control'), 'no-cache', 'v 不一致は no-cache');

      const [goodBody, noVersionBody, wrongBody] = await Promise.all([
        good.text(),
        noVersion.text(),
        wrong.text(),
      ]);
      assert.equal(noVersionBody, goodBody, 'v の有無でボディは変わらない');
      assert.equal(wrongBody, goodBody, 'v の値でボディは変わらない');
    });

    await t.test('htmx.min.js: 正しい v で immutable', async () => {
      const good = await fetch(`${base}/assets/htmx.min.js?v=${assetVersion('htmx.min.js')}`);
      assert.equal(good.status, 200);
      assert.equal(good.headers.get('cache-control'), 'public, max-age=31536000, immutable');
      const wrong = await fetch(`${base}/assets/htmx.min.js?v=deadbeef1234`);
      assert.equal(wrong.status, 200);
      assert.equal(wrong.headers.get('cache-control'), 'no-cache');
      assert.equal(await wrong.text(), await good.text(), 'ボディは同一');
    });

    await t.test('login-bg.svg: 正しい v で immutable', async () => {
      const good = await fetch(`${base}/assets/login-bg.svg?v=${assetVersion('login-bg.svg')}`);
      assert.equal(good.status, 200);
      assert.equal(good.headers.get('cache-control'), 'public, max-age=31536000, immutable');
      const wrong = await fetch(`${base}/assets/login-bg.svg?v=deadbeef1234`);
      assert.equal(wrong.status, 200);
      assert.equal(wrong.headers.get('cache-control'), 'no-cache');
      assert.equal(await wrong.text(), await good.text(), 'ボディは同一');
    });
  } finally {
    await close();
  }
});

test('assets(統合): 配信される app.css は getAsset の書き換え・minify 済み内容そのもの', async () => {
  const { base, close } = await startApp();
  try {
    const res = await fetch(`${base}/assets/app.css`);
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.equal(body, getAsset('app.css'), '配信ボディは getAsset("app.css") と完全一致');
    // ダブルチェック: 配信ボディにもバージョン付き SVG 参照が含まれる。
    assert.ok(
      body.includes(`login-bg.svg?v=${assetVersion('login-bg.svg')}`),
      '配信 CSS も書き換え済み(SVG 参照がバージョン付き)',
    );
  } finally {
    await close();
  }
});
