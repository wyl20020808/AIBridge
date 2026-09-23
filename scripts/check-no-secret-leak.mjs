/**
 * Secret-leak gate (AGENTS.md §3, TESTING.md §2.1, ROADMAP Stage 2).
 *
 * Scans every committed file — tracked or untracked-but-not-ignored — for credential-shaped
 * material. A key in a fixture, a doc or a stack trace is a billing and privacy incident waiting to
 * happen, and "reviewed by a human" is not a security control.
 *
 * One file is allow-listed by name: the frozen secret-input fixture, whose marker is a synthetic,
 * obviously fake `sk-EXAMPLE…` shape that exists precisely so the input-safety layer has something
 * to detect. It is skipped whole rather than pattern-exempted, so its content stays frozen and
 * reviewed in one place.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

const ALLOWLISTED_PATHS = new Set([
  'Docs/fixtures/fixture-set.v1/ai.structured.generate.request.secret-input.json',
]);

const CREDENTIAL_PATTERNS = [
  { id: 'PEM_PRIVATE_KEY', pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/ },
  { id: 'OPENAI_STYLE_KEY', pattern: /\bsk-[A-Za-z0-9_-]{16,}\b/ },
  { id: 'GITHUB_TOKEN', pattern: /\bghp_[A-Za-z0-9]{20,}\b/ },
  { id: 'AWS_ACCESS_KEY_ID', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { id: 'SLACK_TOKEN', pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { id: 'JWT', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/ },
  { id: 'API_KEY_ASSIGNMENT', pattern: /\bapi[_-]?key\s*[:=]\s*["'][A-Za-z0-9._-]{16,}["']/i },
  { id: 'PASSWORD_ASSIGNMENT', pattern: /\bpassword\s*[:=]\s*["'][^"']{8,}["']/i },
];

function listFiles() {
  const output = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
    cwd: root,
    encoding: 'utf8',
  });
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

const violations = [];

for (const repoPath of listFiles()) {
  if (ALLOWLISTED_PATHS.has(repoPath)) {
    continue;
  }
  const full = join(root, repoPath);
  let stats;
  try {
    stats = statSync(full);
  } catch {
    continue;
  }
  if (!stats.isFile()) {
    continue;
  }
  let text;
  try {
    text = readFileSync(full, 'utf8');
  } catch {
    continue;
  }
  if (text.includes('\u0000')) {
    continue;
  }
  for (const { id, pattern } of CREDENTIAL_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) {
      violations.push(`${repoPath}: matches ${id}`);
    }
  }
}

if (violations.length > 0) {
  process.stderr.write(`check-no-secret-leak: ${violations.length} finding(s)\n`);
  for (const violation of violations) {
    process.stderr.write(`  - ${violation}\n`);
  }
  process.exit(1);
}

process.stdout.write(
  `check-no-secret-leak: OK (${listFiles().length} files scanned; allow-listed ${[...ALLOWLISTED_PATHS].map((p) => basename(p)).join(', ')})\n`,
);
