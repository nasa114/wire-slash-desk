import { isIP } from 'node:net';
import { lookup as dnsLookup } from 'node:dns/promises';

/** DNS 解決結果の1件。node:dns/promises lookup({all:true}) と互換。 */
export interface LookupAddress {
  address: string;
  family: number;
}

/** hostname を全アドレスに解決する関数。テストから注入して実 DNS を避ける。 */
export type LookupFn = (
  hostname: string,
  options: { all: true },
) => Promise<LookupAddress[]>;

/** 既定の解決関数(node:dns/promises)。 */
export const defaultLookup: LookupFn = (hostname, _options) => dnsLookup(hostname, { all: true });

/** SSRF ガードでの拒否。理由メッセージに内部情報(トークン等)は含めない。 */
export class SsrfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SsrfError';
  }
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    n = n * 256 + octet;
  }
  return n >>> 0;
}

function inCidrV4(ip: number, base: number, bits: number): boolean {
  if (bits === 0) return true;
  const mask = (0xffffffff << (32 - bits)) >>> 0;
  return ((ip & mask) >>> 0) === ((base & mask) >>> 0);
}

// 拒否する IPv4 帯(設計書 §6)。
const PRIVATE_V4_RANGES: ReadonlyArray<readonly [string, number]> = [
  ['0.0.0.0', 8], // "this" network
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // CGNAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local
  ['172.16.0.0', 12], // private
  ['192.168.0.0', 16], // private
];

export function isPrivateIPv4(ipStr: string): boolean {
  const ip = ipv4ToInt(ipStr);
  if (ip === null) return true; // パース不能は安全側に倒す
  for (const [baseStr, bits] of PRIVATE_V4_RANGES) {
    const base = ipv4ToInt(baseStr);
    if (base !== null && inCidrV4(ip, base, bits)) return true;
  }
  return false;
}

/** IPv6 文字列を 8 個の 16bit グループに展開。不正なら null。 */
function parseIPv6(input: string): number[] | null {
  let ip = input;
  const zone = ip.indexOf('%');
  if (zone !== -1) ip = ip.slice(0, zone);

  // 末尾に埋め込み IPv4(例: ::ffff:192.168.0.1)があれば 2 グループへ変換。
  const v4Match = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(ip);
  if (v4Match) {
    const v4 = ipv4ToInt(v4Match[1] as string);
    if (v4 === null) return null;
    const hi = (v4 >>> 16) & 0xffff;
    const lo = v4 & 0xffff;
    ip = ip.slice(0, v4Match.index) + hi.toString(16) + ':' + lo.toString(16);
  }

  const halves = ip.split('::');
  if (halves.length > 2) return null;

  const parseGroups = (segment: string): number[] | null => {
    if (segment.length === 0) return [];
    const out: number[] = [];
    for (const part of segment.split(':')) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(part)) return null;
      out.push(Number.parseInt(part, 16));
    }
    return out;
  };

  const head = parseGroups(halves[0] as string);
  if (head === null) return null;

  if (halves.length === 1) {
    return head.length === 8 ? head : null;
  }

  const tail = parseGroups(halves[1] as string);
  if (tail === null) return null;
  const missing = 8 - head.length - tail.length;
  if (missing < 0) return null;
  return [...head, ...new Array<number>(missing).fill(0), ...tail];
}

export function isPrivateIPv6(ipStr: string): boolean {
  const g = parseIPv6(ipStr);
  if (g === null || g.length !== 8) return true;
  const [g0, g1, g2, g3, g4, g5, g6, g7] = g as [
    number, number, number, number, number, number, number, number,
  ];
  // :: (unspecified)
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0 && g6 === 0 && g7 === 0) {
    return true;
  }
  // ::1 (loopback)
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0 && g6 === 0 && g7 === 1) {
    return true;
  }
  // ::ffff:a.b.c.d (IPv4-mapped) — 埋め込み IPv4 で判定
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) {
    const v4 = `${(g6 >> 8) & 0xff}.${g6 & 0xff}.${(g7 >> 8) & 0xff}.${g7 & 0xff}`;
    return isPrivateIPv4(v4);
  }
  // fc00::/7 (ULA) — 上位 7bit が 1111110
  if ((g0 & 0xfe00) === 0xfc00) return true;
  // fe80::/10 (link-local)
  if ((g0 & 0xffc0) === 0xfe80) return true;
  return false;
}

/** アドレス文字列が非公開(ローカル/予約)帯なら true。判定不能も true(安全側)。 */
export function isPrivateAddress(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) return isPrivateIPv4(ip);
  if (version === 6) return isPrivateIPv6(ip);
  return true;
}

function stripBrackets(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

/**
 * ホスト文字列が「プライベート/予約 IP のリテラル」なら true。
 * ホスト名(非 IP リテラル)は名前解決しないため false を返す — 解決先の判定は
 * 取得時の SSRF ガード(assertPublicHttpUrl)と egress プロキシに委ねる。
 * フィード URL 登録時の入口バリデーション用(設計書 §6、IP 直指定の悪用を弾く)。
 * URL.hostname が返す IPv6 の角括弧は取り除いてから判定する。
 */
export function isPrivateIpLiteral(host: string): boolean {
  const h = stripBrackets(host);
  return isIP(h) !== 0 && isPrivateAddress(h);
}

/**
 * URL が本文取得に使ってよい公開先か検証(設計書 §6 SSRF)。
 * - スキームは http/https のみ
 * - hostname を解決し、全アドレスが公開 IP であること
 * - IP リテラルはその場で判定
 * 問題なければ解析済み URL を返し、違反なら SsrfError を投げる。
 */
/**
 * egress プロキシを信頼する環境向けの軽量検証(TRUST_EGRESS_PROXY=true)。
 * ローカル DNS が使えない(解決はプロキシが代行する)前提のため名前解決は行わず、
 * スキームと IP リテラルのみ検査する。接続先の最終制御はプロキシの
 * 許可リスト(例: squid の allowed-domains)が担う。
 */
export function assertProxySafeHttpUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SsrfError('invalid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SsrfError('unsupported URL scheme');
  }
  const host = stripBrackets(url.hostname);
  if (host.length === 0) throw new SsrfError('empty host');
  if (isIP(host) !== 0 && isPrivateAddress(host)) {
    throw new SsrfError('URL resolves to a non-public address');
  }
  return url;
}

export async function assertPublicHttpUrl(rawUrl: string, lookupFn: LookupFn): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SsrfError('invalid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SsrfError('unsupported URL scheme');
  }
  const host = stripBrackets(url.hostname);
  if (host.length === 0) throw new SsrfError('empty host');

  let addresses: string[];
  if (isIP(host) !== 0) {
    addresses = [host];
  } else {
    const resolved = await lookupFn(host, { all: true });
    if (!Array.isArray(resolved) || resolved.length === 0) {
      throw new SsrfError('host did not resolve');
    }
    addresses = resolved.map((r) => r.address);
  }
  for (const addr of addresses) {
    if (isPrivateAddress(addr)) {
      throw new SsrfError('URL resolves to a non-public address');
    }
  }
  return url;
}
