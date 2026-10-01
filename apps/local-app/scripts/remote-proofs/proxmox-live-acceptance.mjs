#!/usr/bin/env node
// Opt-in live proof: published image -> VM -> bootstrap claim -> guarded cleanup.
// The lifecycle script owns redaction, VM guards, and cleanup in finally.
// Usage: node apps/local-app/scripts/remote-proofs/proxmox-live-acceptance.mjs
//   [--env .devchain/proxmox/.env] [--port <home DevChain PORT>]

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const builtInHostImage = JSON.parse(
  readFileSync(resolve(scriptDir, '../../src/common/config/host-image.json'), 'utf8'),
);

function selectHostImage(url, sha256, fallback) {
  if (url !== undefined || sha256 !== undefined) return url && sha256 ? { url, sha256 } : null;
  if (
    fallback &&
    typeof fallback.version === 'string' &&
    typeof fallback.url === 'string' &&
    typeof fallback.sha256 === 'string' &&
    fallback.version &&
    fallback.url &&
    fallback.sha256
  ) {
    return fallback;
  }
  return null;
}

function argsOf(argv) {
  const args = { env: resolve(scriptDir, '../../../../.devchain/proxmox/.env'), port: null };
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--env') {
      if (!argv[index + 1]) throw new Error('--env requires a path.');
      args.env = resolve(argv[++index]);
    } else if (argv[index] === '--port') {
      if (!argv[index + 1]) throw new Error('--port requires a number.');
      args.port = Number(argv[++index]);
    } else throw new Error(`Unknown option: ${argv[index]}`);
  }
  return args;
}

function readEnv(path) {
  const values = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (match) values[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return values;
}

async function preflightImage(url, expectedSha) {
  if (expectedSha && !/^[a-fA-F0-9]{64}$/.test(expectedSha)) {
    throw new Error('The configured image SHA-256 is invalid.');
  }
  const parsed = new URL(url);
  const filename = parsed.pathname.split('/').pop() ?? '';
  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    !/^devchain-host-[0-9A-Za-z][0-9A-Za-z.+-]*\.qcow2$/.test(filename)
  )
    throw new Error(
      'HOST_IMAGE_URL must name a published DevChain .qcow2 without credentials or query parameters.',
    );
  const head = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(10_000) });
  if (!head.ok) throw new Error(`HOST_IMAGE_URL is unreachable (${head.status}).`);
  const checksum = await fetch(`${url}.sha256`, { signal: AbortSignal.timeout(10_000) });
  if (!checksum.ok)
    throw new Error(`The published image checksum is unavailable (${checksum.status}).`);
  const line = (await checksum.text())
    .split(/\r?\n/)
    .find((row) => row.endsWith(` ${filename}`) || row.endsWith(` *${filename}`));
  const sha = line?.split(/\s+/)[0];
  if (!sha || !/^[a-fA-F0-9]{64}$/.test(sha))
    throw new Error('The published image checksum is invalid.');
  if (expectedSha && sha.toLowerCase() !== expectedSha.toLowerCase()) {
    throw new Error('HOST_IMAGE_SHA256 differs from the published image checksum.');
  }
  return (expectedSha ?? sha).toLowerCase();
}

async function main() {
  const args = argsOf(process.argv.slice(2));
  const env = readEnv(args.env);
  const configuredImage = selectHostImage(
    process.env.HOST_IMAGE_URL ?? env.HOST_IMAGE_URL,
    process.env.HOST_IMAGE_SHA256 ?? env.HOST_IMAGE_SHA256,
    builtInHostImage,
  );
  const imageUrl = configuredImage?.url;
  if (!imageUrl) {
    throw new Error(
      'No host image is configured; set HOST_IMAGE_URL and HOST_IMAGE_SHA256 or publish a built-in image entry. No Proxmox request was sent.',
    );
  }
  const port = args.port ?? Number(process.env.PORT ?? env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error('The claimed DevChain PORT must be an integer from 1024 through 65535.');
  }
  if (configuredImage?.version) {
    const filename = new URL(imageUrl).pathname.split('/').pop();
    if (filename !== `devchain-host-${configuredImage.version}.qcow2`) {
      throw new Error('The built-in host image version does not match its URL.');
    }
  }
  const sha = await preflightImage(imageUrl, configuredImage?.sha256);
  process.stdout.write(`[OK] Published image and SHA-256 reachable (${sha.slice(0, 12)}…)\n`);
  const proof = resolve(scriptDir, 'proxmox-lifecycle.mjs');
  const child = spawn(
    process.execPath,
    [
      proof,
      '--env',
      args.env,
      '--image',
      imageUrl,
      '--image-sha256',
      sha,
      '--claim',
      '--port',
      String(port),
    ],
    {
      stdio: 'inherit',
      shell: false,
    },
  );
  const code = await new Promise((resolveCode, reject) => {
    child.once('error', reject);
    child.once('exit', (exitCode, signal) => resolveCode(signal ? 1 : (exitCode ?? 1)));
  });
  process.exitCode = code;
}

main().catch((error) => {
  process.stderr.write(
    `[FAIL] Live Proxmox preflight: ${error instanceof Error ? error.message : 'unknown error'}\n`,
  );
  process.exitCode = 1;
});
