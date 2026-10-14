// SPDX-License-Identifier: SUL-1.0
// Test-only child CLI double for batch stream collection. It speaks just enough
// of the child contract (a start handle, then a receipt on stdout) to exercise
// the REAL spawnJob collector; behavior is selected by the order file content.
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';

const args = process.argv.slice(2);
const arg = name => args[args.indexOf(name) + 1];
const order = fs.readFileSync(arg('--file'), 'utf8').trim();
const session_id = randomUUID(), request_id = randomUUID();
fs.writeFileSync(arg('--start-handle'), JSON.stringify({
  schema: 'cwr.acp.start-handle/1', session_id, request_id,
  cwd: fs.realpathSync(arg('--cwd')), route: arg('--route'),
}));
const receipt = JSON.stringify({
  schema: 'cwr.acp.receipt/1', session_id, request_id,
  runtime_status: 'completed', cleanup: 'confirmed', receipt_path: null, error_code: null,
});

if (order === 'flood-stderr') {
  // 300 KiB of diagnostics BEFORE the receipt: beyond the per-stream retention
  // budget, so stderr truncates while the stdout receipt must survive intact.
  process.stderr.write('x'.repeat(300 * 1024));
  setTimeout(() => process.stdout.write(`${receipt}\n`), 80);
} else if (order === 'stdout-overflow') {
  // A complete receipt followed by padding past the budget: the RETAINED prefix
  // still parses as valid JSON, but a truncated stdout must never be accepted.
  process.stdout.write(receipt);
  process.stdout.write(' '.repeat(256 * 1024));
  process.stdout.write('{"tail":true}\n');
}
