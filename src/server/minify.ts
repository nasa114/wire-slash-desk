/**
 * 配信アセット(src/server/assets/)の minify。
 *
 * 目的はバイト削減より情報露出の低減 — アセットのコメントには実装構造への言及
 * (参照する .ts ファイル名や設計意図)が含まれ、攻撃者への手掛かりになり得るため、
 * ブラウザへ配信する応答からコメントを除去する(web.ts の loadAsset が初回のみ
 * 適用してキャッシュする)。ソースファイル自体は可読性のためコメントを保持する。
 *
 * 入力はサーバー自身の src/server/assets/ 配下のファイルに限る(minifyJs は構文検証に
 * new Function を使うため、ユーザー由来コンテンツをこのモジュールへ通してはならない)。
 *
 * 依存を増やさないための自前実装なので、変換は保守的に倒す:
 * - 文字列・url()・正規表現リテラルの中身は一切改変しない
 * - JS はテンプレートリテラルを含む場合は変換せず原文を返し、変換結果は
 *   new Function で構文検証して失敗したら原文へフォールバックする
 */

const TIGHT_CSS_CHARS = new Set(['{', '}', ';', ',']);

/** 引用符付き文字列をエスケープを保ってそのまま写す。開始位置は引用符。 */
function copyString(src: string, start: number, out: string[]): number {
  const quote = src[start] as string;
  out.push(quote);
  let i = start + 1;
  while (i < src.length) {
    const c = src[i] as string;
    out.push(c);
    i++;
    if (c === '\\' && i < src.length) {
      out.push(src[i] as string);
      i++;
      continue;
    }
    if (c === quote) break;
  }
  return i;
}

/**
 * CSS の minify: コメント除去 + 空白圧縮 + `{ } ; ,` 周りの空白除去 + `}` 直前の
 * 不要な `;` 除去。コロン周りの空白は触らない(`a :hover` のような子孫セレクタ +
 * 擬似クラスの意味を変えないため)。
 */
export function minifyCss(css: string): string {
  const out: string[] = [];
  let pendingSpace = false;
  const last = (): string => (out.length > 0 ? (out[out.length - 1] as string) : '');
  const flushSpace = (next: string): void => {
    if (!pendingSpace) return;
    pendingSpace = false;
    const prev = last();
    if (prev === '' || TIGHT_CSS_CHARS.has(prev) || TIGHT_CSS_CHARS.has(next)) return;
    if (prev === '(' || next === ')') return;
    out.push(' ');
  };
  let i = 0;
  const n = css.length;
  while (i < n) {
    const ch = css[i] as string;
    if (/\s/.test(ch)) {
      pendingSpace = true;
      i++;
      continue;
    }
    if (ch === '/' && css[i + 1] === '*') {
      i += 2;
      while (i < n && !(css[i] === '*' && css[i + 1] === '/')) i++;
      i += 2;
      pendingSpace = true;
      continue;
    }
    if (ch === '"' || ch === "'") {
      flushSpace(ch);
      i = copyString(css, i, out);
      continue;
    }
    // out の要素はすべて 1 文字なので、末尾 3 要素だけで url( 判定できる。
    // out.join('') で全体を文字列化すると `(` の個数×出力長で O(n²) になり、
    // 数百KBの入力で数十秒+GC churn を起こす(2026-07-20 に実測)ため不可。
    if (
      ch === '(' &&
      out.length >= 3 &&
      `${out[out.length - 3]}${out[out.length - 2]}${out[out.length - 1]}`.toLowerCase() === 'url'
    ) {
      // url(...) の中身は無引用でも改変しない(data URI 等)。
      flushSpace(ch);
      out.push(ch);
      i++;
      let depth = 1;
      while (i < n && depth > 0) {
        const c = css[i] as string;
        if (c === '"' || c === "'") {
          i = copyString(css, i, out);
          continue;
        }
        if (c === '(') depth++;
        else if (c === ')') depth--;
        out.push(c);
        i++;
      }
      continue;
    }
    if (ch === '}' && last() === ';') out.pop();
    flushSpace(ch);
    out.push(ch);
    i++;
  }
  return out.join('');
}

/** この文字の直後の `/` は正規表現リテラルの開始でありうる(除算ではない)。 */
function regexCanFollow(prevCode: string): boolean {
  return prevCode === '' || '(,=:[!&|?{};+-*%<>~^'.includes(prevCode);
}

/**
 * JS のコメント除去 + インデント・空行除去(改行は ASI 安全のため保持)。
 * テンプレートリテラルを含むソースは行トリムで文字列内容が変わり得るため原文を返す。
 * 変換結果は new Function で構文検証し、失敗したら原文へフォールバックする
 * (誤変換で画面の JS を壊すくらいなら情報露出低減を諦める、の順序)。
 */
export function minifyJs(js: string): string {
  if (js.includes('`')) return js;
  const out: string[] = [];
  let prevCode = '';
  let i = 0;
  const n = js.length;
  while (i < n) {
    const ch = js[i] as string;
    if (ch === '"' || ch === "'") {
      i = copyString(js, i, out);
      prevCode = ch;
      continue;
    }
    if (ch === '/' && js[i + 1] === '/') {
      while (i < n && js[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && js[i + 1] === '*') {
      i += 2;
      while (i < n && !(js[i] === '*' && js[i + 1] === '/')) i++;
      i += 2;
      out.push(' ');
      continue;
    }
    if (ch === '/' && regexCanFollow(prevCode)) {
      out.push(ch);
      i++;
      let inClass = false;
      while (i < n) {
        const c = js[i] as string;
        out.push(c);
        i++;
        if (c === '\\' && i < n) {
          out.push(js[i] as string);
          i++;
          continue;
        }
        if (c === '[') inClass = true;
        else if (c === ']') inClass = false;
        else if (c === '/' && !inClass) break;
        else if (c === '\n') break; // 不正な正規表現 — 下の構文検証で原文に戻る
      }
      prevCode = '/';
      continue;
    }
    out.push(ch);
    if (!/\s/.test(ch)) prevCode = ch;
    i++;
  }
  const compact = out
    .join('')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .join('\n');
  try {
    // 実行はせず構文の妥当性だけを確認する。
    new Function(compact);
  } catch {
    return js;
  }
  return compact;
}
