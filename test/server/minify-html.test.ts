import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { minifyHtml } from '../../src/server/minify.ts';
import { createApp } from '../../src/server/app.ts';
import { createMemoryRepositories } from '../../src/repo/memory/index.ts';
import type { Repositories } from '../../src/domain/repositories.ts';

/* --------------------------------------------------------------- minifyHtml */

test('html: HTML コメントが除去される(複数行コメント含む)', () => {
  const out = minifyHtml('<p>a</p><!-- 実装メモ views.ts 参照 --><p>b</p><!--\n  複数行の\n  コメント\n--><p>c</p>');
  assert.equal(out.includes('<!--'), false);
  assert.equal(/views\.ts/.test(out), false);
  assert.equal(/コメント/.test(out), false);
  assert.ok(out.includes('<p>a</p>'));
  assert.ok(out.includes('<p>b</p>'));
  assert.ok(out.includes('<p>c</p>'));
});

test('html: タグ外の連続空白(改行・インデント)は半角スペース1つに圧縮される', () => {
  assert.equal(
    minifyHtml('<div>\n  <p>hello   world</p>\n\t<p>second</p>\n</div>'),
    '<div> <p>hello world</p> <p>second</p> </div>',
  );
});

test('html: <textarea> の中身は一切改変されない', () => {
  const src = '<div>\n  <textarea id="tos-note" name="tos_note">1行目\n  2行目   連続空白も保持</textarea>\n</div>';
  const out = minifyHtml(src);
  assert.ok(
    out.includes('<textarea id="tos-note" name="tos_note">1行目\n  2行目   連続空白も保持</textarea>'),
    'textarea 内の改行・インデント・連続空白が保持されること',
  );
  assert.equal(out, '<div> <textarea id="tos-note" name="tos_note">1行目\n  2行目   連続空白も保持</textarea> </div>');
});

test('html: <pre> の中身は一切改変されない', () => {
  const src = '<pre>line1\n    indented\n\nblank kept</pre>';
  assert.ok(minifyHtml(`<div>\n${src}\n</div>`).includes(src));
});

test('html: <script> / <style> の中身は一切改変されない', () => {
  const script = '<script>\nvar a = 1;\n  var b = "x  y";\n</script>';
  const style = '<style>\n.a {\n  color: red;\n}\n</style>';
  const out = minifyHtml(`<head>\n${script}\n${style}\n</head>`);
  assert.ok(out.includes(script), 'script の中身(改行・インデント)が保持されること');
  assert.ok(out.includes(style), 'style の中身(改行・インデント)が保持されること');
});

test('html: 引用符付き属性値の中身は一切改変されない', () => {
  // ダブルクォート内の連続空白
  const confirm = 'hx-confirm="「A」を削除します。  記事も一緒に削除されます。"';
  // シングルクォート内の改行+インデント
  const title = "title='1行目\n  2行目'";
  const out = minifyHtml(`<div>\n  <form ${confirm}>\n    <a ${title}>x</a>\n  </form>\n</div>`);
  assert.ok(out.includes(confirm), 'ダブルクォート属性値の連続空白が保持されること');
  assert.ok(out.includes(title), 'シングルクォート属性値の改行・インデントが保持されること');
});

test('html: <!doctype html> は保持される', () => {
  const out = minifyHtml('<!doctype html>\n<html lang="ja">\n<body>\n  <p>a</p>\n</body>\n</html>');
  assert.ok(out.startsWith('<!doctype html>'), 'doctype がコメントと誤認されて消えないこと');
  assert.ok(out.includes('<p>a</p>'));
});

test('html: 冪等(2回適用しても同じ結果)', () => {
  const src = `<!doctype html>
<html lang="ja">
<head>
<!-- head comment -->
<script>
var a = 1;
  var b = 2;
</script>
</head>
<body>
  <div class="shell">
    <form hx-confirm="削除します。  よろしいですか?">
      <textarea name="tos_note">1行目
  2行目</textarea>
    </form>
    <pre>a
  b</pre>
  </div>
</body>
</html>`;
  const once = minifyHtml(src);
  assert.equal(minifyHtml(once), once);
});

/* ------------------------------------------------------- Web 統合(結合) */

const ADMIN_USER = 'admin';
const ADMIN_PASSWORD = 'test-password-123';

interface TestApp {
  repos: Repositories;
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
    repos,
    base: `http://localhost:${port}`,
    close: () => new Promise((resolve) => app.close(() => resolve())),
  };
}

function postForm(
  base: string,
  path: string,
  body: Record<string, string>,
  opts: { cookie?: string } = {},
): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      origin: base,
      ...(opts.cookie !== undefined ? { cookie: opts.cookie } : {}),
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

/** minify 済み HTML の検査: 改行直後の空白(=インデント残り)と HTML コメントが無いこと。 */
function assertMinified(html: string, page: string): void {
  assert.equal(/\n[ \t]/.test(html), false, `${page}: 改行+インデントが残っていない`);
  assert.equal(html.includes('<!--'), false, `${page}: HTML コメントが残っていない`);
}

test('web: 全 HTML ページのレスポンスが minify されている(setup/login/認証後)', async () => {
  const { base, repos, close } = await startApp();
  try {
    // 認証前ページ
    const setupHtml = await (await getPage(base, '/setup')).text();
    assertMinified(setupHtml, '/setup');
    assert.match(setupHtml, /初回セットアップ/, '中身は表示される');

    await setupAdmin(base);

    const loginRes = await getPage(base, '/login');
    assert.equal(loginRes.status, 200);
    const loginHtml = await loginRes.text();
    assertMinified(loginHtml, '/login');
    assert.ok(loginHtml.includes('<!doctype html>'), 'doctype は保持される');
    assert.match(loginHtml, /name="username"/, 'フォームの中身は保たれる');

    // 認証後ページ
    const cookie = await login(base);
    const feed = await repos.feeds.create({ name: 'MinifyFeed', feedUrl: 'https://minify.example.com/rss' });
    await repos.articles.upsertMany([
      {
        feedId: feed.id,
        guid: 'g1',
        title: 'MinifyCheckArticle',
        url: 'https://minify.example.com/1',
        publishedAt: new Date(),
      },
    ]);
    for (const path of ['/', '/articles', '/feeds', `/feeds/${feed.id}`]) {
      const res = await getPage(base, path, cookie);
      assert.equal(res.status, 200, `${path} は 200`);
      const html = await res.text();
      assertMinified(html, path);
    }
    // minify 後も記事・フィードは表示されている
    const articles = await (await getPage(base, '/articles', cookie)).text();
    assert.match(articles, /MinifyCheckArticle/);
    const feeds = await (await getPage(base, '/feeds', cookie)).text();
    assert.match(feeds, /MinifyFeed/);
  } finally {
    await close();
  }
});

test('web: フィード編集画面の <textarea>(規約メモ)は改行を保持する', async () => {
  const { base, repos, close } = await startApp();
  try {
    await setupAdmin(base);
    const cookie = await login(base);

    // 改行入りの規約メモをフォームから保存する
    const note = '1行目の規約メモ\n2行目: 個人利用のみ許可';
    const res = await postForm(
      base,
      '/feeds',
      {
        name: 'TosFeed',
        feed_url: 'https://tos.example.com/rss',
        fetch_interval_minutes: '60',
        enabled: 'on',
        tos_note: note,
      },
      { cookie },
    );
    assert.equal(res.status, 303);
    const feed = (await repos.feeds.list())[0]!;
    assert.equal(feed.tosNote, note, '改行入りのまま保存されること');

    const html = await (await getPage(base, `/feeds/${feed.id}`, cookie)).text();
    // minify されつつも textarea の中身の改行は保持される
    assertMinified(html, `/feeds/${feed.id}`);
    assert.ok(html.includes(note), 'textarea 内の規約メモは改行を保持して表示される');
  } finally {
    await close();
  }
});
