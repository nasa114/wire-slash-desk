import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { minifyCss, minifyJs } from '../../src/server/minify.ts';
import { createApp } from '../../src/server/app.ts';
import { createMemoryRepositories } from '../../src/repo/memory/index.ts';

/* ---------------------------------------------------------------- minifyCss */

test('css: コメントが除去される', () => {
  const out = minifyCss('/* 実装メモ views.ts 由来 */\nbody { color: red; }');
  assert.equal(/views\.ts/.test(out), false);
  assert.equal(out.includes('/*'), false);
  assert.match(out, /body\{color: red\}|body\{color: red;\}/);
});

test('css: 文字列内の /* や // は保護される', () => {
  const out = minifyCss('a::before { content: "/* not a comment // */"; }');
  assert.ok(out.includes('"/* not a comment // */"'));
});

test('css: url() の中身は改変されない', () => {
  const src = '.x { background: url(data:image/svg+xml;utf8,<svg a="1, 2"/>); }';
  const out = minifyCss(src);
  assert.ok(out.includes('url(data:image/svg+xml;utf8,<svg a="1, 2"/>)'));
});

test('css: 空白の圧縮({ } ; , の周りの空白と改行が消える)', () => {
  const out = minifyCss('.a ,\n .b {\n  margin: 0 auto ;\n  padding: 1px 2px;\n}\n');
  assert.equal(out, '.a,.b{margin: 0 auto;padding: 1px 2px}');
});

test('css: calc やセレクタ内の意味のある空白は保持される', () => {
  const out = minifyCss('.a .b { width: calc(100% - 8px); }');
  assert.ok(out.includes('.a .b'));
  assert.ok(out.includes('calc(100% - 8px)'));
});

test('css: 実物の app.css からコメントが消え、CSS として中身は残る', () => {
  const src = readFileSync(new URL('../../src/server/assets/app.css', import.meta.url), 'utf8');
  const out = minifyCss(src);
  assert.equal(out.includes('/*'), false);
  assert.equal(/views\.ts/.test(out), false);
  assert.ok(out.length > 0 && out.length < src.length);
  assert.ok(out.includes('.colophon'));
  assert.ok(out.includes('--paper:'));
});

test('css: 入力サイズに対して線形時間で完了する(O(n²) 回帰の検知)', () => {
  // かつて url( 判定が「`(` のたびに out.join('') で全出力を文字列化」していたため
  // O(n²) となり、500KB の入力で 16 秒 + 大量のGC churn を起こした(メモリリークに
  // 見える症状)。修正後は ~50ms。境界の 3 秒は壊れた実装だけを確実に弾く値。
  const base = readFileSync(new URL('../../src/server/assets/app.css', import.meta.url), 'utf8');
  const src = base.repeat(40);
  const t0 = performance.now();
  const out = minifyCss(src);
  const elapsed = performance.now() - t0;
  assert.ok(out.length > 0 && out.length < src.length);
  assert.ok(elapsed < 3000, `500KB の minify に ${Math.round(elapsed)}ms かかった(線形なら数十ms)`);
});

/* ---------------------------------------------------------------- minifyJs */

test('js: 行頭・行末の // コメントと /* */ コメントが除去される', () => {
  const src = '// 実装メモ views.ts 参照\nvar a = 1; // 補足\n/* block */\nvar b = 2;\n';
  const out = minifyJs(src);
  assert.equal(/views\.ts/.test(out), false);
  assert.equal(out.includes('//'), false);
  assert.equal(out.includes('/*'), false);
  assert.ok(out.includes('var a = 1;'));
  assert.ok(out.includes('var b = 2;'));
});

test('js: 文字列内の // や /* は保護される', () => {
  const src = "var u = 'http://example.com/*x'; var v = \"a // b\";";
  const out = minifyJs(src);
  assert.ok(out.includes("'http://example.com/*x'"));
  assert.ok(out.includes('"a // b"'));
});

test('js: 正規表現リテラル内の // は保護される', () => {
  const src = 'var re = /a\\/\\/b/; // コメント\nvar c = 1;';
  const out = minifyJs(src);
  assert.ok(out.includes('/a\\/\\/b/'));
  assert.equal(/コメント/.test(out), false);
});

test('js: 除算は正規表現と誤認しない', () => {
  const src = 'var x = 10 / 2 / 5; // half\n';
  const out = minifyJs(src);
  assert.ok(out.includes('10 / 2 / 5;'));
  assert.equal(out.includes('half'), false);
});

test('js: インデントと空行が除去される', () => {
  const out = minifyJs('function f() {\n    return 1;\n}\n\n\nf();\n');
  assert.equal(out, 'function f() {\nreturn 1;\n}\nf();');
});

test('js: テンプレートリテラルを含むコードは安全側で原文のまま返す', () => {
  const src = 'var t = `a\n  // not comment\n`; // real comment\n';
  assert.equal(minifyJs(src), src);
});

test('js: 処理結果が構文不正になる入力は原文のまま返す(フォールバック)', () => {
  // 閉じない文字列 → トークナイザの出力がどうであれ構文検証で弾かれ原文が返る
  const src = "var broken = 'unterminated;\n// comment\n";
  assert.equal(minifyJs(src), src);
});

test('js: 実物の clock.js / login.js からコメントが消え、構文は valid のまま', () => {
  for (const name of ['clock.js', 'login.js']) {
    const src = readFileSync(new URL(`../../src/server/assets/${name}`, import.meta.url), 'utf8');
    const out = minifyJs(src);
    assert.equal(/views\.ts/.test(out), false, `${name}: 実装参照コメントが残らない`);
    assert.equal(out.includes('//'), false, `${name}: コメントが残らない`);
    assert.ok(out.length > 0 && out.length < src.length);
    assert.doesNotThrow(() => new Function(out), `${name}: minify 後も構文が valid`);
  }
});

/* ------------------------------------------------- 配信エンドポイント(結合) */

function listen(server: Server): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

test('assets: 配信される app.css / clock.js / login.js にコメントが含まれない', async () => {
  const app = createApp({
    repos: createMemoryRepositories(),
    runCollect: async () => ({}),
    mcpBearerToken: 'bearer-secret',
    collectorToken: 'collector-secret',
    cacheFulltext: false,
  });
  const { url, close } = await listen(app);
  try {
    for (const [path, marker] of [
      ['/assets/app.css', '.colophon'],
      ['/assets/clock.js', 'data-epoch'],
      ['/assets/login.js', 'data-login-alert'],
    ] as const) {
      const res = await fetch(`${url}${path}`);
      assert.equal(res.status, 200);
      const body = await res.text();
      assert.equal(body.includes('/*'), false, `${path}: /* が含まれない`);
      assert.equal(/(^|\n)\s*\/\//.test(body), false, `${path}: // コメントが含まれない`);
      assert.equal(/views\.ts/.test(body), false, `${path}: 実装参照が含まれない`);
      assert.ok(body.includes(marker), `${path}: 中身は配信される`);
    }
  } finally {
    await close();
  }
});
