import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { resetEnvConfig } from '../src/common/config/env.config';

// Jest runs this once per test file, in that file's own globals.
const templatesDir = mkdtempSync(join(tmpdir(), 'devchain-e2e-templates-'));

afterAll(() => {
  rmSync(templatesDir, { recursive: true, force: true });
});

process.env.TEMPLATES_DIR = templatesDir;
process.env.NODE_ENV = 'test';
process.env.SKIP_PREFLIGHT = process.env.SKIP_PREFLIGHT ?? '1';
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'silent';
resetEnvConfig();

writeFileSync(
  join(templatesDir, 'empty-project.json'),
  JSON.stringify(
    {
      version: 1,
      _manifest: { name: 'Empty Project' },
      prompts: [],
      profiles: [],
      agents: [],
      statuses: [{ label: 'To Do', color: '#3b82f6', position: 0 }],
    },
    null,
    2,
  ),
  'utf-8',
);
