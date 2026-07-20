import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

/**
 * ビルド・バージョン情報。デプロイ後に「どのコードが動いているか」を確認するための
 * メタデータで、認証済み UI のフッターと GET /internal/version(X-Collector-Token
 * 必須)に表示する。ブラウザから無認証で見える場所には出さない。
 */
export interface BuildInfo {
  /** package.json の version。 */
  version: string;
  /** git コミットハッシュ。取得できなければ 'unknown'。 */
  commit: string;
  /** ビルド日時(ISO 8601)。Docker ビルド時に BUILD_TIME で焼き込む。 */
  builtAt?: string;
}

/** 取得不能時のフォールバック値。 */
export const UNKNOWN_BUILD_INFO: BuildInfo = { version: '0.0.0', commit: 'unknown' };

const COMMIT_HASH_RE = /^[0-9a-f]{40}$/;
/** env 経由(GIT_COMMIT)は短縮ハッシュも許す。それ以外の文字列は誤設定として弾く。 */
const ENV_COMMIT_RE = /^[0-9a-f]{7,40}$/;

function tryRead(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/**
 * .git から HEAD のコミットハッシュを読む(子プロセスを使わない)。
 * Docker イメージには .git を含めないため、本番では env(GIT_COMMIT)が前提で、
 * これは開発環境(dev container で node src/main.ts 直接実行)向けのフォールバック。
 */
function readGitCommit(rootDir: string): string | null {
  const gitDir = join(rootDir, '.git');
  const head = tryRead(join(gitDir, 'HEAD'))?.trim();
  if (head === undefined || head === null || head === '') return null;
  if (!head.startsWith('ref: ')) {
    return COMMIT_HASH_RE.test(head) ? head : null;
  }
  const ref = head.slice('ref: '.length).trim();
  // "refs/heads/..." 固定形式のみ辿る(パス外への相対参照を弾く)。
  if (!/^refs\/[A-Za-z0-9._\-/]+$/.test(ref) || ref.includes('..')) return null;
  const direct = tryRead(join(gitDir, ...ref.split('/')))?.trim();
  if (direct !== undefined && direct !== null && COMMIT_HASH_RE.test(direct)) return direct;
  // ref ファイルが無い場合(gc 済み等)は packed-refs から引く。
  const packed = tryRead(join(gitDir, 'packed-refs'));
  if (packed === null) return null;
  for (const line of packed.split('\n')) {
    if (line.startsWith('#') || line.startsWith('^')) continue;
    const [hash, name] = line.trim().split(' ');
    if (name === ref && hash !== undefined && COMMIT_HASH_RE.test(hash)) return hash;
  }
  return null;
}

function readPackageVersion(rootDir: string): string | null {
  const raw = tryRead(join(rootDir, 'package.json'));
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : null;
  } catch {
    return null;
  }
}

/** このモジュール(src/server/)から見たアプリルート。Docker では /app、開発では repo 直下。 */
const DEFAULT_ROOT_DIR = fileURLToPath(new URL('../../', import.meta.url));

/**
 * ビルド情報を解決する。優先順位:
 * - commit: env GIT_COMMIT(Docker ビルド時に焼き込み)→ .git(開発環境)→ 'unknown'
 * - version: rootDir/package.json → '0.0.0'
 * - builtAt: env BUILD_TIME(空・未設定なら省略)
 */
export function loadBuildInfo(
  env: NodeJS.ProcessEnv = process.env,
  rootDir: string = DEFAULT_ROOT_DIR,
): BuildInfo {
  const envCommit = env['GIT_COMMIT']?.trim().toLowerCase();
  const commit =
    envCommit !== undefined && ENV_COMMIT_RE.test(envCommit)
      ? envCommit
      : (readGitCommit(rootDir) ?? 'unknown');
  const version = readPackageVersion(rootDir) ?? UNKNOWN_BUILD_INFO.version;
  const builtAt = env['BUILD_TIME']?.trim();
  return {
    version,
    commit,
    ...(builtAt !== undefined && builtAt !== '' ? { builtAt } : {}),
  };
}
