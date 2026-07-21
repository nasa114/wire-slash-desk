import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { minifyCss, minifyHtml, minifyJs } from './minify.ts';

/**
 * 配信アセットの読み込み・変換・内容ハッシュ版(キャッシュバスティング)の一元管理。
 *
 * アセットURLに配信内容の sha256 先頭12hex を `?v=` として付ける。内容が変われば
 * URL も変わる(=ブラウザ側の変更検知)ため、正しい v へのレスポンスは
 * `immutable` 付きで1年キャッシュさせても安全 — 更新は常に新URLで配信され、
 * 古いキャッシュが参照され続けることがない。v の判定と Cache-Control の出し分けは
 * web.ts の /assets ルートが行う。
 *
 * 変換(minify)は src/server/minify.ts と同じ方針 — バイト削減より実装情報の
 * 露出低減が目的で、ソースはコメント付きのまま保ち、初回アクセス時に1回だけ
 * 変換してキャッシュする。バージョン算出を同じパイプラインに統合することで、
 * 「配信される内容」と「ハッシュの元になった内容」が必ず一致する。
 *
 * 依存順序の注意: app.css は CSS 内の `/assets/login-bg.svg` 参照をバージョン付き
 * URL へ書き換えてからハッシュを取る。したがって svg の変換・バージョン確定が
 * 常に先行し、SVG を更新すると CSS の内容(と URL)も連動して変わる。
 */

/** 配信対象のアセット名。ユニオンで閉じ、任意文字列がファイル読み込みへ流れる余地を型で塞ぐ。 */
export type AssetName = 'app.css' | 'clock.js' | 'login.js' | 'login-bg.svg' | 'htmx.min.js';

const require = createRequire(import.meta.url);

/** 変換済みの配信内容(初回のみ構築)。 */
const contentCache = new Map<string, string>();
/** 配信内容の sha256 hex 先頭12文字。 */
const versionCache = new Map<string, string>();

/** src/server/assets/ 配下のソースファイルを読む。 */
function readLocalAsset(name: string): string {
  return readFileSync(new URL(`./assets/${name}`, import.meta.url), 'utf8');
}

/** アセット名ごとの読み込み+変換。名前はコード内固定のため、未知の名前は実装バグ。 */
function buildAsset(name: AssetName): string {
  switch (name) {
    case 'htmx.min.js':
      // node_modules の配布物(minify 済み)をそのまま配信する。
      return readFileSync(require.resolve('htmx.org/dist/htmx.min.js'), 'utf8');
    case 'clock.js':
    case 'login.js':
      return minifyJs(readLocalAsset(name));
    case 'login-bg.svg':
      return minifyHtml(readLocalAsset(name));
    case 'app.css':
      // svg のバージョンを先に確定し(assetPath が再帰的に解決)、CSS 内の
      // 素URL参照をバージョン付きへ書き換える。version はこの書き換え後の
      // 内容から算出されるため、SVG だけ更新しても CSS の URL が追従する。
      return minifyCss(readLocalAsset(name)).replaceAll(
        "url('/assets/login-bg.svg')",
        `url('${assetPath('login-bg.svg')}')`,
      );
    default:
      throw new Error(`unknown asset: ${name}`);
  }
}

/** 変換済みの配信内容を返す(初回のみ読み込み+変換、以後キャッシュ)。 */
export function getAsset(name: AssetName): string {
  let content = contentCache.get(name);
  if (content === undefined) {
    content = buildAsset(name);
    contentCache.set(name, content);
  }
  return content;
}

/** 配信内容(UTF-8)の sha256 hex 先頭12文字。 */
export function assetVersion(name: AssetName): string {
  let version = versionCache.get(name);
  if (version === undefined) {
    version = createHash('sha256').update(getAsset(name), 'utf8').digest('hex').slice(0, 12);
    versionCache.set(name, version);
  }
  return version;
}

/** ビュー・CSS から参照するバージョン付きアセットURL。 */
export function assetPath(name: AssetName): string {
  return `/assets/${name}?v=${assetVersion(name)}`;
}
