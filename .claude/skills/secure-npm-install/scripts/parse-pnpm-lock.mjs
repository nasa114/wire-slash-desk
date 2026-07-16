#!/usr/bin/env node
/**
 * parse-pnpm-lock.mjs
 * Parses pnpm-lock.yaml (lockfileVersion 9.x) and outputs JSON for inspect.sh.
 *
 * Usage:
 *   node parse-pnpm-lock.mjs <pnpm-lock.yaml> [--allowlist=<file>] [--base-lock=<file>]
 *
 * pnpm-lock v9 uses YAML 1.2. The packages section uses:
 *   - Block-style mapping: each field on its own indented line
 *   - Flow-style mapping: resolution: {integrity: sha512-..., tarball: ...}
 *
 * stdlib only - no eval, no external dependencies.
 */

import fs from 'node:fs';

// ---------------------------------------------------------------------------
// Flow-style YAML map parser: parses "{key: value, key2: value2}" strings.
// Handles values that may contain colons (e.g. URLs, sha512 hashes).
// ---------------------------------------------------------------------------
function parseFlowMap(str) {
  const result = {};
  // Strip outer braces
  const inner = str.trim().replace(/^\{/, '').replace(/\}$/, '').trim();
  if (!inner) return result;

  // Split on ", key:" boundaries. We walk char by char to handle URLs/sha512.
  // A key starts after '{' or after a ',' that is followed by whitespace and a key.
  const entries = [];
  let depth = 0;
  let current = '';
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === '{' || ch === '[') { depth++; current += ch; }
    else if (ch === '}' || ch === ']') { depth--; current += ch; }
    else if (ch === ',' && depth === 0) {
      entries.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) entries.push(current.trim());

  for (const entry of entries) {
    // Find first colon that separates key from value
    const colonIdx = entry.indexOf(':');
    if (colonIdx < 0) continue;
    const k = entry.slice(0, colonIdx).trim().replace(/^['"]|['"]$/g, '');
    const v = entry.slice(colonIdx + 1).trim().replace(/^['"]|['"]$/g, '');
    result[k] = v;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Minimal line-based YAML parser for pnpm-lock.yaml v9.
// Handles both block-style and flow-style resolution mappings.
// ---------------------------------------------------------------------------
function parsePnpmLockYaml(text) {
  const lines = text.split('\n');
  const result = { lockfileVersion: null, packages: {} };

  let section = null;
  let currentPkg = null;
  let currentPkgKey = null;
  let inResolution = false;
  let resolutionIndent = -1;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.replace(/\r$/, '');

    if (/^\s*#/.test(line) || line.trim() === '') continue;

    const indent = line.search(/\S/);
    const content = line.trim();

    // Top-level keys (indent 0)
    if (indent === 0) {
      inResolution = false;
      resolutionIndent = -1;
      currentPkg = null;
      currentPkgKey = null;

      if (content.startsWith('lockfileVersion:')) {
        const val = content.replace('lockfileVersion:', '').trim().replace(/['"]/g, '');
        result.lockfileVersion = val;
        section = null;
      } else if (content === 'packages:') {
        section = 'packages';
      } else if (content === 'snapshots:' || content === 'importers:' || content === 'settings:') {
        section = null;
      } else {
        section = null;
      }
      continue;
    }

    if (section !== 'packages') continue;

    // Package key: indent 2, ends with ':'
    if (indent === 2 && content.endsWith(':')) {
      inResolution = false;
      resolutionIndent = -1;
      currentPkgKey = content.slice(0, -1).trim().replace(/^['"]|['"]$/g, '');
      currentPkg = { resolution: {} };
      result.packages[currentPkgKey] = currentPkg;
      continue;
    }

    if (currentPkg === null) continue;

    // resolution field at indent 4
    if (indent === 4 && content.startsWith('resolution:')) {
      const afterColon = content.slice('resolution:'.length).trim();
      if (afterColon.startsWith('{')) {
        // Flow-style: resolution: {integrity: sha512-..., tarball: ...}
        // May span one line or multiple lines - collect until balanced '}'
        let flowStr = afterColon;
        let braceDepth = (flowStr.match(/\{/g) || []).length - (flowStr.match(/\}/g) || []).length;
        let j = i + 1;
        while (braceDepth > 0 && j < lines.length) {
          flowStr += ' ' + lines[j].trim();
          braceDepth += ((lines[j].match(/\{/g) || []).length - (lines[j].match(/\}/g) || []).length);
          j++;
        }
        currentPkg.resolution = parseFlowMap(flowStr);
        inResolution = false;
        i = j - 1; // skip consumed lines
      } else if (afterColon === '') {
        // Block-style resolution starts on next lines
        inResolution = true;
        resolutionIndent = 6;
      }
      continue;
    }

    // Inside block-style resolution
    if (inResolution && indent >= resolutionIndent) {
      const colonIdx = content.indexOf(':');
      if (colonIdx > 0) {
        const k = content.slice(0, colonIdx).trim();
        const v = content.slice(colonIdx + 1).trim().replace(/^['"]|['"]$/g, '');
        currentPkg.resolution[k] = v;
      }
      continue;
    }

    // Other package-level fields (indent 4)
    if (indent === 4) {
      inResolution = false;
      const colonIdx = content.indexOf(':');
      if (colonIdx > 0) {
        const k = content.slice(0, colonIdx).trim();
        const v = content.slice(colonIdx + 1).trim().replace(/^['"]|['"]$/g, '');
        currentPkg[k] = v;
      }
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Classify resolution type
// ---------------------------------------------------------------------------
function classifyResolution(resolution) {
  if (!resolution || typeof resolution !== 'object') return 'unknown';
  const { tarball, directory, link, integrity, registry } = resolution;

  if (typeof tarball === 'string') {
    if (/^git(\+|:)|^github:/.test(tarball)) return 'git';
    if (tarball.startsWith('file:')) return 'file';
    if (tarball.startsWith('link:')) return 'link';
    if (tarball.startsWith('directory:')) return 'directory';
    // https:// tarball from non-registry host
    if (/^https?:\/\//.test(tarball)) return 'tarball';
    // relative or path tarball
    return 'tarball';
  }
  if (typeof directory === 'string') return 'directory';
  if (typeof link === 'string') return 'link';
  // Has integrity -> registry package
  if (integrity) return 'registry';
  return 'unknown';
}

function extractRegistryUrl(resolution) {
  if (!resolution || typeof resolution !== 'object') return null;
  if (resolution.registry) return resolution.registry.endsWith('/') ? resolution.registry : resolution.registry + '/';
  if (resolution.tarball && /^https?:\/\//.test(resolution.tarball)) {
    try {
      const u = new URL(resolution.tarball);
      return `${u.protocol}//${u.host}/`;
    } catch { return null; }
  }
  return null;
}

function parsePackageKey(key) {
  const stripped = key.replace(/\(.*\)$/, '');
  const atIdx = stripped.lastIndexOf('@');
  if (atIdx <= 0) return { name: stripped, version: '' };
  return { name: stripped.slice(0, atIdx), version: stripped.slice(atIdx + 1) };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
let lockFile = null;
let allowlistFile = null;
let baseLockFile = null;

for (const arg of args) {
  if (arg.startsWith('--allowlist=')) allowlistFile = arg.slice('--allowlist='.length);
  else if (arg.startsWith('--base-lock=')) baseLockFile = arg.slice('--base-lock='.length);
  else if (!arg.startsWith('-')) lockFile = arg;
}

if (!lockFile) {
  process.stderr.write('Usage: parse-pnpm-lock.mjs <pnpm-lock.yaml> [--allowlist=<file>] [--base-lock=<file>]\n');
  process.exit(2);
}

let text;
try {
  text = fs.readFileSync(lockFile, 'utf8');
} catch (e) {
  process.stderr.write(`Cannot read lockfile: ${e.message}\n`);
  process.exit(2);
}

const parsed = parsePnpmLockYaml(text);

const packages = Object.entries(parsed.packages).map(([key, data]) => {
  const { name, version } = parsePackageKey(key);
  const resolution = data.resolution || {};
  const resolutionType = classifyResolution(resolution);
  const registryUrl = extractRegistryUrl(resolution);
  return {
    key,
    name,
    version,
    resolution,
    resolutionType,
    integrity: resolution.integrity || null,
    registryUrl,
    cpu: data.cpu || null,
    os: data.os || null,
    optional: data.optional === 'true' || data.optional === true,
  };
});

let newPackages = null;
if (baseLockFile) {
  let baseText = '';
  try { baseText = fs.readFileSync(baseLockFile, 'utf8'); } catch {}
  const baseParsed = baseText ? parsePnpmLockYaml(baseText) : { packages: {} };
  const baseKeys = new Set(Object.keys(baseParsed.packages));
  newPackages = packages.filter(p => !baseKeys.has(p.key));
}

const output = {
  lockfileVersion: parsed.lockfileVersion,
  packages,
  ...(newPackages !== null ? { newPackages } : {}),
};

process.stdout.write(JSON.stringify(output, null, 2));
process.stdout.write('\n');
process.exit(0);
