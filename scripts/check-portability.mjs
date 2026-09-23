/**
 * Portability gate (ROADMAP Stage 2, ARCHITECTURE.md §21).
 *
 * Proves that `@aibridge/*` is consumable **outside this repository**: build → `npm pack` each
 * package → install the tarballs into an isolated project with `--offline` (no registry, no
 * network) → typecheck a consumer against the packed `.d.ts` → run a runtime smoke against the
 * packed `dist/`.
 *
 * This is what makes "portable" a checked property rather than a claim: the isolated project has no
 * workspace, no `paths` aliases and no access to `src/`. If it compiles and runs, a host can consume
 * it.
 *
 * The scratch project lives under `tmp/` (gitignored) and is removed on success and on failure.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const work = join(root, 'tmp', 'portability');
const tarballDir = join(work, 'tarballs');
const projectDir = join(work, 'project');

const PACKAGE_DIRS = ['contracts', 'core', 'host-sdk'];

const tscEntry = join(root, 'node_modules', 'typescript', 'bin', 'tsc');
const useShell = process.platform === 'win32';

/** Run npm through the shell: on Windows `.cmd` shims are not directly executable. */
function npm(args, cwd) {
  execFileSync('npm', args, { cwd, stdio: 'inherit', shell: useShell });
}

function build() {
  execFileSync(process.execPath, [tscEntry, '-b', '--pretty', 'false'], {
    cwd: root,
    stdio: 'inherit',
  });
}

const CONSUMER_TSCONFIG = {
  compilerOptions: {
    target: 'ES2022',
    lib: ['ES2022'],
    module: 'NodeNext',
    moduleResolution: 'NodeNext',
    strict: true,
    exactOptionalPropertyTypes: true,
    noUncheckedIndexedAccess: true,
    verbatimModuleSyntax: true,
    skipLibCheck: true,
    noEmit: true,
    // Deliberately no `node` types: the contract packages must not need platform globals.
    types: [],
  },
  include: ['consumer.ts'],
};

function main() {
  rmSync(work, { recursive: true, force: true });
  mkdirSync(tarballDir, { recursive: true });
  mkdirSync(projectDir, { recursive: true });

  build();

  for (const name of PACKAGE_DIRS) {
    npm(['pack', '--pack-destination', tarballDir, '--silent'], join(root, 'packages', name));
  }
  const packed = readdirSync(tarballDir).filter((entry) => entry.endsWith('.tgz'));
  if (packed.length !== PACKAGE_DIRS.length) {
    throw new Error(
      `check-portability: expected ${PACKAGE_DIRS.length} tarballs, found ${packed.length} (${packed.join(', ') || 'none'})`,
    );
  }

  writeFileSync(
    join(projectDir, 'package.json'),
    `${JSON.stringify({ name: 'aibridge-portability-consumer', private: true, type: 'module' }, null, 2)}\n`,
  );

  // Offline: every dependency is one of the local tarballs, so a registry hit is a failure, not a
  // fallback. This is the check that "no network at runtime" is real for a consuming host.
  npm(
    [
      'install',
      '--offline',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      ...packed.map((entry) => join(tarballDir, entry)),
    ],
    projectDir,
  );

  cpSync(join(root, 'scripts', 'portability-consumer.ts'), join(projectDir, 'consumer.ts'));
  cpSync(join(root, 'scripts', 'portability-smoke.mjs'), join(projectDir, 'smoke.mjs'));
  writeFileSync(join(projectDir, 'tsconfig.json'), `${JSON.stringify(CONSUMER_TSCONFIG, null, 2)}\n`);

  // Typecheck against the packed declarations (no src/, no aliases).
  execFileSync(process.execPath, [tscEntry, '-p', join(projectDir, 'tsconfig.json'), '--pretty', 'false'], {
    cwd: projectDir,
    stdio: 'inherit',
  });

  // Run against the packed dist/.
  execFileSync(process.execPath, [join(projectDir, 'smoke.mjs')], { cwd: projectDir, stdio: 'inherit' });

  rmSync(work, { recursive: true, force: true });
  process.stdout.write(
    `check-portability: OK (${packed.length} packages packed, installed offline, typechecked and smoke-tested in an isolated project)\n`,
  );
}

try {
  main();
} catch (error) {
  // Never leave scratch behind, even on failure.
  rmSync(work, { recursive: true, force: true });
  throw error;
}
