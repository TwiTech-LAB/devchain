import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  GENERATED_PATHS,
  checkGeneratedOutputs,
  renderGeneratedOutputs,
  writeGeneratedOutputs,
} from '../../scripts/generate-mobile-rpc-contract.mjs';

const repositoryRoot = fileURLToPath(new URL('../../../..', import.meta.url));
const temporaryRoots: string[] = [];

async function temporaryOutputRoot(): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), 'devchain-mobile-rpc-contract-'));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('mobile RPC contract generator', () => {
  it('produces identical bytes across consecutive writes', async () => {
    const outputRoot = await temporaryOutputRoot();
    expect(await writeGeneratedOutputs({ repositoryRoot, outputRoot })).toEqual([
      GENERATED_PATHS.local,
      GENERATED_PATHS.mobile,
      GENERATED_PATHS.bridge,
    ]);

    const first = await Promise.all(
      Object.values(GENERATED_PATHS).map((path) => readFile(resolve(outputRoot, path), 'utf8')),
    );
    expect(await writeGeneratedOutputs({ repositoryRoot, outputRoot })).toEqual([]);
    const second = await Promise.all(
      Object.values(GENERATED_PATHS).map((path) => readFile(resolve(outputRoot, path), 'utf8')),
    );
    expect(second).toEqual(first);
  });

  it('checks without mutation and detects an altered temporary output', async () => {
    const outputRoot = await temporaryOutputRoot();
    await writeGeneratedOutputs({ repositoryRoot, outputRoot });
    expect(await checkGeneratedOutputs({ repositoryRoot, outputRoot })).toEqual([]);

    const alteredPath = resolve(outputRoot, GENERATED_PATHS.mobile);
    const altered = `${await readFile(alteredPath, 'utf8')}\n// drift\n`;
    await writeFile(alteredPath, altered, 'utf8');

    expect(await checkGeneratedOutputs({ repositoryRoot, outputRoot })).toEqual([
      GENERATED_PATHS.mobile,
    ]);
    expect(await readFile(alteredPath, 'utf8')).toBe(altered);
  });

  it('emits byte-identical full local and mobile contracts after one stable header', async () => {
    const outputs = await renderGeneratedOutputs({ repositoryRoot });
    const local = outputs.get(GENERATED_PATHS.local);
    const mobile = outputs.get(GENERATED_PATHS.mobile);

    expect(local).toBe(mobile);
    expect(local).toContain('DO NOT EDIT');
    expect(local).toContain("import { z } from 'zod';");
    expect(local).not.toMatch(/@generated[^\n]*\d{4}-\d{2}-\d{2}/);
  });

  it('keeps the bridge projection method-only and dependency-free', async () => {
    const outputs = await renderGeneratedOutputs({ repositoryRoot });
    const bridge = outputs.get(GENERATED_PATHS.bridge);

    expect(bridge).toContain('export const MOBILE_RPC_METHODS = [');
    expect(bridge).toContain('export type MobileRpcMethod');
    expect(bridge).toContain('export const ALLOWED_METHODS: ReadonlySet<string>');
    expect(bridge).toContain('export function isMobileRpcMethod');
    expect(bridge).not.toMatch(/\b(?:zod|paramsSchema|resultSchema|compatibility|cryptoMode)\b/i);
    expect(bridge?.match(/"(?:board|chat|terminal|e2ee)\.[^"]+"/g)).toHaveLength(42);
  });
});
