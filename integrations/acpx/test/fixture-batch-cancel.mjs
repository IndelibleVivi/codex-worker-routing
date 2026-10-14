// SPDX-License-Identifier: SUL-1.0
// Test-only parent signal after a prompt, or an explicit test marker. Windows
// child.kill('SIGTERM') terminates Node without delivering its JS handler, so a
// marker lets the caller exercise that same handler after its readback checks.
import fs from 'node:fs/promises';
import path from 'node:path';
import { main } from '../src/cli.mjs';
const args = process.argv.slice(2);
const config = JSON.parse(await fs.readFile(args[args.indexOf('--config') + 1], 'utf8'));
const audit = path.join(config.routes.worker.workerHome, 'fixture-audit.ndjson');
const stopFile = process.env.CWR_TEST_PARENT_CANCEL_FILE;
let fired = false;
const watch = setInterval(async () => {
  const ready = stopFile
    ? await fs.access(stopFile).then(() => true, () => false)
    : (await fs.readFile(audit, 'utf8').catch(() => '')).includes('session/prompt');
  if (!fired && ready) {
    fired = true; clearInterval(watch); process.emit('SIGTERM');
  }
}, 25);
try { process.exitCode = await main(args); }
finally { clearInterval(watch); }
