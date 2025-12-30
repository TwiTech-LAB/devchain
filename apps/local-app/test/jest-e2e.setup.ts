import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { resetEnvConfig } from '../src/common/config/env.config';

type TestGlobals = typeof globalThis & {
  __DEVCHAIN_E2E_TEMPLATES_DIR__?: string;
};

const g = globalThis as TestGlobals;

if (!g.__DEVCHAIN_E2E_TEMPLATES_DIR__) {
  g.__DEVCHAIN_E2E_TEMPLATES_DIR__ = mkdtempSync(join(tmpdir(), 'devchain-e2e-templates-'));

  process.on('exit', () => {
    try {
      rmSync(g.__DEVCHAIN_E2E_TEMPLATES_DIR__!, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });
}

process.env.TEMPLATES_DIR = g.__DEVCHAIN_E2E_TEMPLATES_DIR__;
process.env.SKIP_PREFLIGHT = process.env.SKIP_PREFLIGHT ?? '1';
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'silent';
resetEnvConfig();

const templatesDir = g.__DEVCHAIN_E2E_TEMPLATES_DIR__;
const emptyTemplatePath = join(templatesDir, 'empty-project.json');

if (!existsSync(emptyTemplatePath)) {
  writeFileSync(
    emptyTemplatePath,
    JSON.stringify(
      {
        version: 1,
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
}
