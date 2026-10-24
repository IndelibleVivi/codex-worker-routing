// SPDX-License-Identifier: SUL-1.0
// Test-only process holder. It optionally spawns a child that ignores SIGTERM,
// then writes both PIDs so a parent can be killed without relying on timing.
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const [rootPidFile, childPidFile, mode = 'child'] = process.argv.slice(2);
fs.writeFileSync(rootPidFile, String(process.pid), { mode: 0o600 });

let child = null;
if (mode === 'child') {
  child = spawn(process.execPath, ['-e', `
    process.on('SIGTERM', () => {});
    const fs = require('node:fs');
    // The harness can signal readiness through the child's stdin. Normal holder
    // mode never writes that marker.
    process.stdin.resume();
    fs.writeFileSync(${JSON.stringify(childPidFile)}, String(process.pid), { mode: 0o600 });
    setInterval(() => {}, 1000);
  `], { stdio: 'ignore' });
  child.unref();
}
setInterval(() => {}, 1000);
