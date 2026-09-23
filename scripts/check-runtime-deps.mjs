/**
 * Runtime-dependency gate (ARCHITECTURE.md §2, ROADMAP Stage 2).
 *
 * `@aibridge/contracts` has **zero runtime dependencies** and must stay parseable in any host. The
 * dependency arrows point one way: core → contracts, host-sdk → contracts + core. This gate makes
 * that mechanical.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

const ALLOWED_IMPORTS = {
  contracts: new Set(),
  core: new Set(['@aibridge/contracts']),
  'host-sdk': new Set(['@aibridge/contracts', '@aibridge/core']),
};

const ALLOWED_DEPENDENCIES = {
  contracts: [],
  core: ['@aibridge/contracts'],
  'host-sdk': ['@aibridge/contracts', '@aibridge/core'],
};

const IMPORT_SPECIFIER = /(?:from\s+|require\(\s*|import\(\s*)['"]([^'"]+)['"]/g;
const IGNORED_DIRS = new Set(['node_modules', 'dist', '.git']);

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

for (const [packageName, allowed] of Object.entries(ALLOWED_IMPORTS)) {
  const packageDir = join(root, 'packages', packageName);

  const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));
  const declared = Object.keys(manifest.dependencies ?? {}).sort();
  const expected = [...ALLOWED_DEPENDENCIES[packageName]].sort();
  if (declared.join(',') !== expected.join(',')) {
    violations.push(
      `packages/${packageName}/package.json: dependencies are [${declared.join(', ')}]; expected [${expected.join(', ')}]`,
    );
  }

  const files = [];
  walk(join(packageDir, 'src'), files);
  for (const file of files) {
    if (extname(file) !== '.ts') {
      continue;
    }
    const repoPath = relative(root, file).split('\\').join('/');
    const lines = readFileSync(file, 'utf8').split(/\r?\n/);
    lines.forEach((line, index) => {
      IMPORT_SPECIFIER.lastIndex = 0;
      let match;
      while ((match = IMPORT_SPECIFIER.exec(line)) !== null) {
        const specifier = match[1];
        if (specifier === undefined) {
          continue;
        }
        if (specifier.startsWith('./') || specifier.startsWith('../')) {
          continue;
        }
        if (!allowed.has(specifier)) {
          violations.push(`${repoPath}:${index + 1} imports "${specifier}", which is not allowed for @aibridge/${packageName}`);
        }
      }
    });
  }
}

if (violations.length > 0) {
  process.stderr.write(`check-runtime-deps: ${violations.length} violation(s)\n`);
  for (const violation of violations) {
    process.stderr.write(`  - ${violation}\n`);
  }
  process.exit(1);
}

process.stdout.write('check-runtime-deps: OK (contracts has zero runtime deps; arrows are one-way)\n');
