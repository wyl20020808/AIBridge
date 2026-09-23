/**
 * Host-coupling gate (AGENTS.md §1, ROADMAP Stage 2, TESTING.md §3.10).
 *
 * `@aibridge/*` packages must not import `@ojplatform/*` or `@algoquest/*`, and must not reach into
 * either repository's source tree. Host-specific knowledge belongs in a separate adapter package
 * with a one-way dependency arrow.
 *
 * Failure prevented: AI Bridge becoming unportable and silently un-maintainable outside the one host
 * it was born in.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs']);
const IGNORED_DIRS = new Set(['node_modules', 'dist', '.git', 'tmp', 'coverage']);

const FORBIDDEN_SPECIFIER = /(?:^|['"/])(@ojplatform|@algoquest)\//;
const FORBIDDEN_PATH = /(?:^|[\\/])(?:AlgoQuest|OJPlatform)[\\/](?:packages|src|fixtures|Docs)/i;
const IMPORT_SPECIFIER = /(?:from\s+|require\(\s*|import\(\s*)['"]([^'"]+)['"]/g;

const FORBIDDEN_DEP_SCOPES = ['@ojplatform/', '@algoquest/'];

const violations = [];

function walk(dir, out) {
  for (const entry of readdirSync(dir)) {
    if (IGNORED_DIRS.has(entry)) {
      continue;
    }
    const full = join(dir, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) {
      walk(full, out);
    } else {
      out.push(full);
    }
  }
}

function scanSourceTree(relativeDir) {
  const dir = join(root, relativeDir);
  const files = [];
  try {
    walk(dir, files);
  } catch {
    return;
  }
  for (const file of files) {
    if (!SOURCE_EXTENSIONS.has(extname(file))) {
      continue;
    }
    const repoPath = relative(root, file).split('\\').join('/');
    const text = readFileSync(file, 'utf8');
    const lines = text.split(/\r?\n/);
    lines.forEach((line, index) => {
      if (FORBIDDEN_SPECIFIER.test(line)) {
        violations.push(`${repoPath}:${index + 1} forbidden host/consumer import: ${line.trim()}`);
      }
      if (FORBIDDEN_PATH.test(line)) {
        violations.push(`${repoPath}:${index + 1} references another repository's source tree: ${line.trim()}`);
      }
      IMPORT_SPECIFIER.lastIndex = 0;
      let match;
      while ((match = IMPORT_SPECIFIER.exec(line)) !== null) {
        const specifier = match[1];
        if (specifier !== undefined && FORBIDDEN_SPECIFIER.test(specifier)) {
          violations.push(`${repoPath}:${index + 1} forbidden import specifier "${specifier}"`);
        }
      }
    });
  }
}

function scanManifest(relativePath) {
  const file = join(root, relativePath);
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return;
  }
  for (const section of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    const deps = manifest[section];
    if (deps === undefined || deps === null || typeof deps !== 'object') {
      continue;
    }
    for (const name of Object.keys(deps)) {
      if (FORBIDDEN_DEP_SCOPES.some((scope) => name.startsWith(scope))) {
        violations.push(`${relativePath}: ${section} contains forbidden "${name}"`);
      }
    }
  }
}

scanSourceTree('packages');
for (const packageDir of ['packages/contracts', 'packages/core', 'packages/host-sdk']) {
  scanManifest(`${packageDir}/package.json`);
}
scanManifest('package.json');

if (violations.length > 0) {
  process.stderr.write(`check-adapter-coupling: ${violations.length} violation(s)\n`);
  for (const violation of violations) {
    process.stderr.write(`  - ${violation}\n`);
  }
  process.exit(1);
}

process.stdout.write('check-adapter-coupling: OK (no @ojplatform/*, @algoquest/* or cross-repo source imports)\n');
