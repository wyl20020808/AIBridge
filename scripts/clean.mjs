/**
 * Remove build output and scratch directories. Never touches source or fixtures.
 */
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

const targets = [
  join(root, 'packages', 'contracts', 'dist'),
  join(root, 'packages', 'core', 'dist'),
  join(root, 'packages', 'host-sdk', 'dist'),
  join(root, 'packages', 'runtime', 'dist'),
  join(root, 'packages', 'provider-openai-compatible', 'dist'),
  join(root, 'tmp'),
];

for (const target of targets) {
  rmSync(target, { recursive: true, force: true });
  process.stdout.write(`removed ${target}\n`);
}
