import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const bootstrapPath = path.resolve('test/tsx-bootstrap.cjs');
const fixturePath = path.resolve('test/fixtures/firestore-required-scenario.ts');

for (const scenario of ['no-backend', 'hydration-failure']) {
  test(`required Firestore startup rejects: ${scenario}`, () => {
    const result = spawnSync(
      process.execPath,
      ['--require', bootstrapPath, '--import', 'tsx', fixturePath, scenario],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: { ...process.env }
      }
    );

    assert.equal(
      result.status,
      0,
      [
        `Scenario '${scenario}' failed with exit code ${result.status}.`,
        result.stdout,
        result.stderr
      ].filter(Boolean).join('\n')
    );
  });
}
