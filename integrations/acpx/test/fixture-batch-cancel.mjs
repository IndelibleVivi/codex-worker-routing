// SPDX-License-Identifier: SUL-1.0
// Test-only parent signal after the real synthetic adapter receives its prompt.
import fs from 'node:fs/promises';
import path from 'node:path';
import { main } from '../src/cli.mjs';
const args = process.argv.slice(2);
const config = JSON.parse(await fs.readFile(args[args.indexOf('--config') + 1], 'utf8'));
const audit = path.join(config.routes.worker.workerHome, 'fixture-audit.ndjson');
let fired = false;
const watch = setInterval(async () => {
  const text = await fs.readFile(audit, 'utf8').catch(() => '');
  if (!fired && text.includes('session/prompt')) {
    fired = true; clearInterval(watch); process.emit('SIGTERM');
  }
}, 25);
try { process.exitCode = await main(args); }
finally { clearInterval(watch); }
