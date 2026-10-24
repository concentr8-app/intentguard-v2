import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { loadLocalEnv } from '../main/env';

test('local .env loads without overriding an existing shell variable', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c8-env-'));
  const previous = process.env.GROQ_MODEL;
  t.after(() => {
    if (previous === undefined) delete process.env.GROQ_MODEL;
    else process.env.GROQ_MODEL = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  fs.writeFileSync(path.join(dir, '.env'), 'GROQ_MODEL=example/file-model\n');
  delete process.env.GROQ_MODEL;
  loadLocalEnv(dir);
  assert.equal(process.env.GROQ_MODEL, 'example/file-model');

  process.env.GROQ_MODEL = 'example/shell-model';
  loadLocalEnv(dir);
  assert.equal(process.env.GROQ_MODEL, 'example/shell-model');
});
