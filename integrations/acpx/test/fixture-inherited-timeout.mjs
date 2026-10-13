// Synthetic CLI wrapper: retain the production environment/locking/lifecycle
// boundary, changing only the public runtime's inherited timeout. No provider,
// internal acpx imports, or test-runner process state participates in the turn.
import assert from 'node:assert/strict';
import { main, loadAcpx } from '../src/cli.mjs';

try {
  process.exitCode = await main(process.argv.slice(2), {
    loadAcpx: async () => {
      assert.equal(process.env.CWR_PRIVATE_TEST_MARKER, undefined, 'CLI must scrub before importing acpx');
      const installed = await loadAcpx();
      return {
        ...installed,
        createAcpRuntime: options => installed.createAcpRuntime({ ...options, timeoutMs: 2000 }),
      };
    },
  });
} catch (error) {
  process.stderr.write(`${error.stack}\n`);
  process.exitCode = 2;
}
