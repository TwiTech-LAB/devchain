#!/usr/bin/env node
// Proxmox VM lifecycle proof: import cloud image -> template -> full clone ->
// resize -> start -> guest-agent IP -> stop -> destroy, all with the
// pool-scoped API token from .devchain/proxmox/.env.
//
// Usage:
//   node apps/local-app/scripts/remote-proofs/proxmox-lifecycle.mjs [--env <path>]
//     [--keep-template] [--delete-image] [--agent-timeout <seconds>] [--image <url>]
//     [--image-sha256 <digest>] [--claim] [--claim-version <v>] [--update-version <v>]
//     [--verify-codex-login] [--check-cloud-init] [--claim-memory <MiB>]
//     [--port <claimed DevChain port>]
//
// --image takes a published DevChain host image (`<base-url>/devchain-host-<v>.qcow2`,
// checksum at `<url>.sha256`) instead of the stock Ubuntu cloud image.
//
// Not part of the build or the test suite. Prints one line per step; the
// token secret is never printed.

import * as https from 'node:https';
import * as tls from 'node:tls';
import { execFile } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Agent, fetch as undiciFetch } from 'undici';

const execFileAsync = promisify(execFile);

const STOCK_IMAGE = {
  url: 'https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64.img',
  sumsUrl: 'https://cloud-images.ubuntu.com/noble/current/SHA256SUMS',
  sumsName: 'noble-server-cloudimg-amd64.img',
  // `import` content only accepts known disk extensions; the Ubuntu .img is qcow2.
  filename: 'noble-server-cloudimg-amd64.qcow2',
};

/** A host image published as `<url>` plus `<url>.sha256` (sha256sum format). */
function publishedImage(url) {
  const filename = new URL(url).pathname.split('/').pop();
  if (!filename?.endsWith('.qcow2')) throw new Error(`--image must name a .qcow2 file: ${url}`);
  return { url, sumsUrl: `${url}.sha256`, sumsName: filename, filename };
}

const TEMPLATE_SPEC = { cores: 1, memory: 1024 };
const CLONE_SPEC = { cores: 2, memory: 2048, diskBytes: 8 * 1024 ** 3 };

// ---------------------------------------------------------------------------
// Arguments and configuration

function parseArgs(argv) {
  const args = {
    env: null,
    keepTemplate: false,
    deleteImage: false,
    agentTimeoutSec: 240,
    image: null,
    imageSha256: null,
    claim: false,
    claimVersion: null,
    updateVersion: null,
    verifyCodexLogin: false,
    // Injects a throwaway SSH key and checks the guest over SSH: real VMs only.
    checkCloudInit: false,
    claimMemory: 4096,
    port: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--env') args.env = argv[++i];
    else if (a === '--keep-template') args.keepTemplate = true;
    else if (a === '--delete-image') args.deleteImage = true;
    else if (a === '--agent-timeout') args.agentTimeoutSec = Number(argv[++i]);
    else if (a === '--image') args.image = argv[++i];
    else if (a === '--image-sha256') args.imageSha256 = argv[++i];
    else if (a === '--claim') args.claim = true;
    else if (a === '--claim-version') {
      if (!argv[i + 1]) throw new Error('--claim-version requires a version');
      args.claimVersion = argv[++i];
    } else if (a === '--update-version') {
      if (!argv[i + 1]) throw new Error('--update-version requires a version');
      args.updateVersion = argv[++i];
    } else if (a === '--verify-codex-login') args.verifyCodexLogin = true;
    else if (a === '--check-cloud-init') args.checkCloudInit = true;
    else if (a === '--claim-memory') args.claimMemory = Number(argv[++i]);
    else if (a === '--port') args.port = Number(argv[++i]);
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (args.claim && !args.image) throw new Error('--claim requires a published --image');
  if (
    (args.claimVersion || args.updateVersion || args.verifyCodexLogin || args.checkCloudInit) &&
    !args.claim
  )
    throw new Error(
      'Claim version, update version, login verification and the cloud-init check require --claim',
    );
  if (!Number.isInteger(args.claimMemory) || args.claimMemory < 4096)
    throw new Error('--claim-memory must be at least 4096 MiB');
  if (args.imageSha256 && !/^[a-fA-F0-9]{64}$/.test(args.imageSha256)) {
    throw new Error('--image-sha256 must be a 64-character hex digest');
  }
  if (
    args.port !== null &&
    (!Number.isInteger(args.port) || args.port < 1024 || args.port > 65535)
  ) {
    throw new Error('--port must be an integer from 1024 through 65535');
  }
  return args;
}

function loadEnv(path) {
  const env = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  const required = [
    'PROXMOX_API_URL',
    'PROXMOX_TOKEN_ID',
    'PROXMOX_TOKEN_SECRET',
    'PROXMOX_NODE',
    'PROXMOX_POOL',
    'PROXMOX_STORAGE',
    'PROXMOX_ISO_STORAGE',
    'PROXMOX_BRIDGE',
    'PROXMOX_VMID_MIN',
    'PROXMOX_VMID_MAX',
    'PROXMOX_NAME_PREFIX',
    'PROXMOX_TAG',
  ];
  const missing = required.filter((k) => !env[k]);
  if (missing.length) throw new Error(`Missing env variables: ${missing.join(', ')}`);
  if (env.PROXMOX_VERIFY_SSL === 'false' && !env.PROXMOX_SSL_FINGERPRINT) {
    throw new Error('PROXMOX_VERIFY_SSL=false requires PROXMOX_SSL_FINGERPRINT for pinning');
  }
  const api = new URL(env.PROXMOX_API_URL);
  return {
    host: api.hostname,
    port: api.port ? Number(api.port) : 443,
    basePath: api.pathname.replace(/\/$/, ''),
    tokenId: env.PROXMOX_TOKEN_ID,
    tokenSecret: env.PROXMOX_TOKEN_SECRET,
    node: env.PROXMOX_NODE,
    verifySsl: env.PROXMOX_VERIFY_SSL !== 'false',
    fingerprint: env.PROXMOX_SSL_FINGERPRINT?.toUpperCase() ?? null,
    pool: env.PROXMOX_POOL,
    storage: env.PROXMOX_STORAGE,
    importStorage: env.PROXMOX_ISO_STORAGE,
    bridge: env.PROXMOX_BRIDGE,
    vmidMin: Number(env.PROXMOX_VMID_MIN),
    vmidMax: Number(env.PROXMOX_VMID_MAX),
    namePrefix: env.PROXMOX_NAME_PREFIX,
    tag: env.PROXMOX_TAG,
  };
}

// ---------------------------------------------------------------------------
// Output. Every printed string passes through redact() so the secret cannot
// leak even through an echoed error body.

let SECRET = null;
function redact(text) {
  const s = String(text);
  return SECRET ? s.split(SECRET).join('<redacted>') : s;
}
function out(line) {
  process.stdout.write(`${redact(line)}\n`);
}

const records = [];
async function step(name, fn) {
  const started = Date.now();
  try {
    const result = await fn();
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    const http = result?.http ?? '-';
    const task = result?.task ?? '-';
    records.push({ name, ok: true, http, task, secs, note: result?.note });
    out(
      `[OK]   ${name} | HTTP ${http} | task ${task} | ${secs}s${result?.note ? ` | ${result.note}` : ''}`,
    );
    return result;
  } catch (err) {
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    const http = err.http ?? '-';
    const task = err.task ?? '-';
    records.push({ name, ok: false, http, task, secs, note: err.message });
    out(`[FAIL] ${name} | HTTP ${http} | task ${task} | ${secs}s | ${err.message}`);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// HTTP. With PROXMOX_VERIFY_SSL=false the server leaf certificate is trusted
// only if its SHA-256 fingerprint equals PROXMOX_SSL_FINGERPRINT; TLS
// verification itself is never disabled for requests that carry the token.

async function buildTlsOptions(cfg) {
  if (cfg.verifySsl) return {};
  const leafPem = await new Promise((resolvePem, reject) => {
    const socket = tls.connect(
      { host: cfg.host, port: cfg.port, rejectUnauthorized: false },
      () => {
        const cert = socket.getPeerCertificate();
        socket.end();
        if (cert.fingerprint256?.toUpperCase() !== cfg.fingerprint) {
          reject(
            new Error('Proxmox certificate fingerprint does not match PROXMOX_SSL_FINGERPRINT'),
          );
          return;
        }
        const b64 = cert.raw
          .toString('base64')
          .match(/.{1,64}/g)
          .join('\n');
        resolvePem(`-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----\n`);
      },
    );
    socket.on('error', reject);
  });
  return {
    ca: leafPem,
    allowPartialTrustChain: true,
    checkServerIdentity: (_host, cert) =>
      cert.fingerprint256?.toUpperCase() === cfg.fingerprint
        ? undefined
        : new Error('Proxmox certificate fingerprint changed'),
  };
}

class ApiError extends Error {
  constructor(message, http) {
    super(message);
    this.http = http;
  }
}

function makeApi(cfg, tlsOptions) {
  return function api(method, path, params) {
    const encoded = params
      ? new URLSearchParams(
          Object.entries(params)
            .filter(([, v]) => v !== undefined && v !== null)
            .map(([k, v]) => [k, String(v)]),
        ).toString()
      : '';
    const hasBody = encoded && (method === 'POST' || method === 'PUT');
    const fullPath = `${cfg.basePath}${path}${encoded && !hasBody ? `?${encoded}` : ''}`;
    return new Promise((resolveReq, reject) => {
      const req = https.request(
        {
          host: cfg.host,
          port: cfg.port,
          method,
          path: fullPath,
          rejectUnauthorized: true,
          timeout: 60_000,
          ...tlsOptions,
          headers: {
            Authorization: `PVEAPIToken=${cfg.tokenId}=${cfg.tokenSecret}`,
            Accept: 'application/json',
            ...(hasBody
              ? {
                  'Content-Type': 'application/x-www-form-urlencoded',
                  'Content-Length': Buffer.byteLength(encoded),
                }
              : {}),
          },
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            let body = null;
            try {
              body = JSON.parse(text);
            } catch {
              // Proxmox puts the error reason in the status message for some failures.
            }
            const status = res.statusCode;
            if (status < 200 || status >= 300) {
              const detail = [res.statusMessage, body?.errors ? JSON.stringify(body.errors) : null]
                .filter(Boolean)
                .join(' ');
              reject(new ApiError(`${method} ${path} -> ${status} ${detail}`.trim(), status));
              return;
            }
            resolveReq({ http: status, data: body?.data ?? null });
          });
          res.on('error', reject);
        },
      );
      req.on('timeout', () => req.destroy(new Error(`${method} ${path} timed out`)));
      req.on('error', reject);
      if (hasBody) req.write(encoded);
      req.end();
    });
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Proxmox helpers

async function waitTask(api, cfg, upid, timeoutMs = 20 * 60_000) {
  const node = encodeURIComponent(cfg.node);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { data } = await api('GET', `/nodes/${node}/tasks/${encodeURIComponent(upid)}/status`);
    if (data?.status === 'stopped') {
      if (data.exitstatus === 'OK') return 'OK';
      let tail = '';
      try {
        const log = await api('GET', `/nodes/${node}/tasks/${encodeURIComponent(upid)}/log`, {
          start: 0,
          limit: 500,
        });
        tail = (log.data ?? [])
          .map((l) => l.t)
          .slice(-5)
          .join(' / ');
      } catch {
        // The log is diagnostic only.
      }
      const err = new Error(`task ${data.exitstatus}${tail ? `: ${tail}` : ''}`);
      err.task = data.exitstatus;
      throw err;
    }
    await sleep(2000);
  }
  const err = new Error('task did not finish before the timeout');
  err.task = 'timeout';
  throw err;
}

/** Runs a call that returns a UPID and waits for the task to finish. */
async function runTask(api, cfg, method, path, params, timeoutMs) {
  const res = await api(method, path, params);
  if (typeof res.data !== 'string' || !res.data.startsWith('UPID:')) {
    return { http: res.http, task: 'sync' };
  }
  try {
    const task = await waitTask(api, cfg, res.data, timeoutMs);
    return { http: res.http, task };
  } catch (err) {
    err.http = res.http;
    throw err;
  }
}

async function isVmidFree(api, vmid) {
  try {
    await api('GET', '/cluster/nextid', { vmid });
    return true;
  } catch (err) {
    if (err.http === 400) return false;
    throw err;
  }
}

async function pickVmids(api, cfg, count) {
  const picked = [];
  for (let id = cfg.vmidMin; id <= cfg.vmidMax && picked.length < count; id++) {
    if (await isVmidFree(api, id)) picked.push(id);
  }
  if (picked.length < count) throw new Error('No free VMIDs in the configured range');
  return picked;
}

/**
 * Destroy guard: the VM must carry the pool tag, the name prefix, and a VMID
 * inside the configured range. Anything else is refused.
 */
async function assertOwned(api, cfg, vmid) {
  const node = encodeURIComponent(cfg.node);
  const { data } = await api('GET', `/nodes/${node}/qemu/${vmid}/config`);
  const tags = String(data?.tags ?? '')
    .split(/[;,\s]+/)
    .filter(Boolean);
  const problems = [];
  if (!tags.includes(cfg.tag)) problems.push(`missing tag ${cfg.tag}`);
  if (!String(data?.name ?? '').startsWith(cfg.namePrefix))
    problems.push(`name not ${cfg.namePrefix}*`);
  if (vmid < cfg.vmidMin || vmid > cfg.vmidMax) problems.push('VMID outside range');
  if (problems.length) throw new Error(`destroy guard refused VM ${vmid}: ${problems.join(', ')}`);
  return `guard ok (tag=${cfg.tag}, name=${data.name}, vmid=${vmid})`;
}

async function vmStatus(api, cfg, vmid) {
  const { data } = await api(
    'GET',
    `/nodes/${encodeURIComponent(cfg.node)}/qemu/${vmid}/status/current`,
  );
  return data?.status;
}

async function vmExists(api, cfg, vmid) {
  const { data } = await api('GET', `/nodes/${encodeURIComponent(cfg.node)}/qemu`);
  return (data ?? []).some((v) => Number(v.vmid) === vmid);
}

async function destroyVm(api, cfg, vmid, label) {
  const node = encodeURIComponent(cfg.node);
  if (!(await vmExists(api, cfg, vmid))) {
    out(`[SKIP] ${label}: VM ${vmid} does not exist`);
    return;
  }
  await step(`${label}: destroy guard`, async () => ({ note: await assertOwned(api, cfg, vmid) }));
  if ((await vmStatus(api, cfg, vmid)) === 'running') {
    await step(`${label}: stop`, () =>
      runTask(api, cfg, 'POST', `/nodes/${node}/qemu/${vmid}/status/stop`),
    );
  }
  await step(`${label}: DELETE /nodes/${cfg.node}/qemu/${vmid}`, () =>
    runTask(api, cfg, 'DELETE', `/nodes/${node}/qemu/${vmid}`, {
      purge: 1,
      'destroy-unreferenced-disks': 1,
    }),
  );
}

async function readAgentIp(api, cfg, vmid, timeoutSec) {
  const node = encodeURIComponent(cfg.node);
  const deadline = Date.now() + timeoutSec * 1000;
  let lastError = 'no response';
  while (Date.now() < deadline) {
    try {
      const { http, data } = await api(
        'GET',
        `/nodes/${node}/qemu/${vmid}/agent/network-get-interfaces`,
      );
      const ips = (data?.result ?? [])
        .filter((i) => i.name !== 'lo')
        .flatMap((i) => i['ip-addresses'] ?? [])
        .filter((a) => a['ip-address-type'] === 'ipv4')
        .map((a) => a['ip-address']);
      if (ips.length)
        return { http, task: 'sync', note: `ipv4=${ips.join(',')}`, ip: ips[0], agent: true };
      lastError = 'agent answered without an IPv4 address';
    } catch (err) {
      lastError = err.message;
      if (err.http === 403) throw err;
    }
    await sleep(5000);
  }
  const err = new Error(`guest agent gave no IP within ${timeoutSec}s (last: ${lastError})`);
  err.http = 500;
  throw err;
}

// The bootstrap writes the VM certificate here; the proof trusts only the copy
// read over the pinned Proxmox API, never the certificate the VM shows.
const VM_CERTIFICATE_PATH = '/etc/devchain-host/tls/cert.pem';

async function readAgentCertificate(api, cfg, vmid, timeoutSec) {
  const node = encodeURIComponent(cfg.node);
  const deadline = Date.now() + timeoutSec * 1000;
  let lastError = 'no response';
  while (Date.now() < deadline) {
    try {
      const { http, data } = await api('GET', `/nodes/${node}/qemu/${vmid}/agent/file-read`, {
        file: VM_CERTIFICATE_PATH,
      });
      if (typeof data?.content === 'string' && !data.truncated) {
        const certificate = new X509Certificate(data.content);
        return {
          http,
          task: 'sync',
          note: `sha256=${certificate.fingerprint256.replace(/:/g, '')}`,
          pem: certificate.toString(),
        };
      }
      lastError = 'agent answered without the certificate';
    } catch (err) {
      lastError = err.message;
      if (err.http === 403) throw err;
    }
    await sleep(2000);
  }
  const err = new Error(
    `guest agent gave no certificate within ${timeoutSec}s (last: ${lastError})`,
  );
  err.http = 500;
  throw err;
}

/** fetch() for the VM: HTTPS pinned to its certificate, no redirects. */
function pinnedVmFetch(pem) {
  const fingerprint = new X509Certificate(pem).fingerprint256;
  const dispatcher = new Agent({
    connect: {
      ca: [pem],
      rejectUnauthorized: true,
      // The VM certificate has no IP SAN; the pin replaces the name check.
      checkServerIdentity: (_host, cert) =>
        cert.fingerprint256 === fingerprint
          ? undefined
          : new Error('VM TLS certificate does not match the guest-agent copy'),
    },
  });
  return (url, init = {}) => undiciFetch(url, { ...init, dispatcher, redirect: 'error' });
}

// ---------------------------------------------------------------------------
// Proof

async function fetchImageSha256(image) {
  try {
    const res = await fetch(image.sumsUrl);
    if (!res.ok) return null;
    const line = (await res.text())
      .split('\n')
      .find((l) => l.endsWith(`*${image.sumsName}`) || l.endsWith(` ${image.sumsName}`));
    return line ? line.split(/\s+/)[0] : null;
  } catch {
    return null;
  }
}

async function sshRun(key, ip, command) {
  const { stdout } = await execFileAsync(
    'ssh',
    [
      '-i',
      key,
      '-o',
      'BatchMode=yes',
      '-o',
      'StrictHostKeyChecking=no',
      '-o',
      'UserKnownHostsFile=/dev/null',
      '-o',
      'LogLevel=ERROR',
      '-o',
      'ConnectTimeout=5',
      `ubuntu@${ip}`,
      command,
    ],
    { timeout: 15_000 },
  );
  return stdout.trim();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const envPath = args.env ?? resolve(scriptDir, '../../../../.devchain/proxmox/.env');
  const cfg = loadEnv(envPath);
  SECRET = cfg.tokenSecret;
  const api = makeApi(cfg, await buildTlsOptions(cfg));
  const node = encodeURIComponent(cfg.node);
  const image = args.image ? publishedImage(args.image) : STOCK_IMAGE;
  const cloneSpec = args.claim
    ? { cores: 2, memory: args.claimMemory, diskBytes: 30 * 1024 ** 3 }
    : CLONE_SPEC;
  const importVolid = `${cfg.importStorage}:import/${image.filename}`;
  const created = [];
  let templateVmid = null;
  let cloneVmid = null;
  let agentPresent = 'unknown';
  let failed = false;
  let keyDir = null;
  let keyPath = null;
  let sshPublicKey = null;
  let agentIp = null;

  out(`Proxmox lifecycle proof on node ${cfg.node}, pool ${cfg.pool}, token ${cfg.tokenId}`);

  try {
    if (args.checkCloudInit) {
      keyDir = mkdtempSync(join(tmpdir(), 'devchain-proxmox-proof-'));
      keyPath = join(keyDir, 'id_ed25519');
      await execFileAsync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', keyPath]);
      sshPublicKey = readFileSync(`${keyPath}.pub`, 'utf8').trim();
    }
    await step('GET /version', async () => {
      const { http, data } = await api('GET', '/version');
      return { http, note: `PVE ${data?.version}` };
    });

    await step('pick VMIDs (GET /cluster/nextid?vmid=N)', async () => {
      [templateVmid, cloneVmid] = await pickVmids(api, cfg, 2);
      return { http: 200, note: `template=${templateVmid} clone=${cloneVmid}` };
    });

    const imagePresent = await step(
      `GET /nodes/${cfg.node}/storage/${cfg.importStorage}/content?content=import`,
      async () => {
        const { http, data } = await api(
          'GET',
          `/nodes/${node}/storage/${encodeURIComponent(cfg.importStorage)}/content`,
          {
            content: 'import',
          },
        );
        const present = (data ?? []).some((v) => v.volid === importVolid);
        return {
          http,
          present,
          note: present ? `${importVolid} already present` : 'image not present',
        };
      },
    );

    if (!imagePresent.present) {
      const sha256 = args.imageSha256 ?? (await fetchImageSha256(image));
      if (args.claim && !sha256) {
        throw new Error('A published image checksum is required for the claim proof.');
      }
      await step(
        `POST /nodes/${cfg.node}/storage/${cfg.importStorage}/download-url (content=import)`,
        async () => {
          const r = await runTask(
            api,
            cfg,
            'POST',
            `/nodes/${node}/storage/${encodeURIComponent(cfg.importStorage)}/download-url`,
            {
              content: 'import',
              filename: image.filename,
              url: image.url,
              ...(sha256 ? { 'checksum-algorithm': 'sha256', checksum: sha256 } : {}),
            },
            30 * 60_000,
          );
          return { ...r, note: sha256 ? 'sha256 verified by Proxmox' : 'no checksum available' };
        },
      );
    }

    const tplName = `${cfg.namePrefix}proof-tpl`;
    created.push({ vmid: templateVmid, label: 'template' });
    await step(`POST /nodes/${cfg.node}/qemu (import-from, vmid=${templateVmid})`, async () => {
      const r = await runTask(
        api,
        cfg,
        'POST',
        `/nodes/${node}/qemu`,
        {
          vmid: templateVmid,
          name: tplName,
          pool: cfg.pool,
          tags: cfg.tag,
          ostype: 'l26',
          cores: TEMPLATE_SPEC.cores,
          memory: TEMPLATE_SPEC.memory,
          ...(args.claim ? { cpu: 'host' } : {}),
          scsihw: 'virtio-scsi-single',
          scsi0: `${cfg.storage}:0,import-from=${importVolid}`,
          ide2: `${cfg.storage}:cloudinit`,
          boot: 'order=scsi0',
          net0: `virtio,bridge=${cfg.bridge}`,
          serial0: 'socket',
          vga: 'serial0',
          agent: 'enabled=1',
          ipconfig0: 'ip=dhcp',
          // Proxmox expects this value URL-encoded inside the form-encoded request.
          ...(sshPublicKey ? { ciuser: 'ubuntu', sshkeys: encodeURIComponent(sshPublicKey) } : {}),
        },
        20 * 60_000,
      );
      return r;
    });

    await step(`POST /nodes/${cfg.node}/qemu/${templateVmid}/template`, () =>
      runTask(api, cfg, 'POST', `/nodes/${node}/qemu/${templateVmid}/template`),
    );

    const vmName = `${cfg.namePrefix}proof-vm`;
    created.push({ vmid: cloneVmid, label: 'clone' });
    await step(
      `POST /nodes/${cfg.node}/qemu/${templateVmid}/clone (full, pool=${cfg.pool}, newid=${cloneVmid})`,
      async () => {
        const r = await runTask(
          api,
          cfg,
          'POST',
          `/nodes/${node}/qemu/${templateVmid}/clone`,
          {
            newid: cloneVmid,
            name: vmName,
            full: 1,
            pool: cfg.pool,
            storage: cfg.storage,
          },
          20 * 60_000,
        );
        return r;
      },
    );

    await step(
      `PUT /nodes/${cfg.node}/qemu/${cloneVmid}/config (cores=${cloneSpec.cores}, memory=${cloneSpec.memory})`,
      async () => {
        const r = await runTask(api, cfg, 'PUT', `/nodes/${node}/qemu/${cloneVmid}/config`, {
          cores: cloneSpec.cores,
          memory: cloneSpec.memory,
        });
        return r;
      },
    );

    await step(
      `PUT /nodes/${cfg.node}/qemu/${cloneVmid}/resize (scsi0 -> ${cloneSpec.diskBytes / 1024 ** 3}G)`,
      () =>
        runTask(api, cfg, 'PUT', `/nodes/${node}/qemu/${cloneVmid}/resize`, {
          disk: 'scsi0',
          size: `${cloneSpec.diskBytes / 1024 ** 3}G`,
        }),
    );

    await step(`GET /nodes/${cfg.node}/qemu/${cloneVmid}/config (verify clone)`, async () => {
      const { http, data } = await api('GET', `/nodes/${node}/qemu/${cloneVmid}/config`);
      const note = `cores=${data.cores} memory=${data.memory} scsi0=${data.scsi0} tags=${data.tags}`;
      if (Number(data.cores) !== cloneSpec.cores || Number(data.memory) !== cloneSpec.memory) {
        throw new ApiError(`clone config mismatch: ${note}`, http);
      }
      return { http, note };
    });

    await step(`POST /nodes/${cfg.node}/qemu/${cloneVmid}/status/start`, () =>
      runTask(api, cfg, 'POST', `/nodes/${node}/qemu/${cloneVmid}/status/start`),
    );

    try {
      await step(
        `GET /nodes/${cfg.node}/qemu/${cloneVmid}/agent/network-get-interfaces`,
        async () => {
          const r = await readAgentIp(api, cfg, cloneVmid, args.agentTimeoutSec);
          agentIp = r.ip;
          agentPresent = 'yes';
          return r;
        },
      );
    } catch (err) {
      agentPresent = err.http === 403 ? 'unknown (403)' : 'no (agent did not respond)';
      failed = true;
    }
    if (args.claim && agentIp) {
      if (args.checkCloudInit)
        await step('cloud-init hostname, SSH key and DHCP', async () => {
          const deadline = Date.now() + 180_000;
          let lastError = 'SSH did not answer';
          while (Date.now() < deadline) {
            try {
              const host = await sshRun(keyPath, agentIp, 'hostname');
              const address = await sshRun(keyPath, agentIp, 'hostname -I');
              if (host !== vmName || !address.split(/\s+/).includes(agentIp)) {
                throw new Error(`hostname or DHCP mismatch (hostname=${host}, ip=${address})`);
              }
              return { note: `hostname=${host}, ssh-key=accepted, dhcp-ip=${agentIp}` };
            } catch (error) {
              lastError = error.message;
              await sleep(3_000);
            }
          }
          throw new Error(`cloud-init did not apply within 180s: ${lastError}`);
        });
      const packageVersion =
        args.claimVersion ??
        JSON.parse(readFileSync(resolve(scriptDir, '../../../../package.json'), 'utf8')).version;
      const port = args.port ?? Number(process.env.PORT ?? 3000);
      if (!Number.isInteger(port) || port < 1024 || port > 65535) {
        throw new Error('The claimed DevChain port must be between 1024 and 65535.');
      }
      const bootstrapUrl = `https://${agentIp}:3000`;
      const hostUrl = `https://${agentIp}:${port}`;
      const certificate = await step(
        `GET /nodes/${cfg.node}/qemu/${cloneVmid}/agent/file-read (VM certificate)`,
        () => readAgentCertificate(api, cfg, cloneVmid, 60),
      );
      const vmFetch = pinnedVmFetch(certificate.pem);
      const providerAuth = { env: {}, files: [] };
      if (args.verifyCodexLogin) {
        const authFile = join(homedir(), '.codex/auth.json');
        providerAuth.files.push({
          path: authFile,
          mode: '0600',
          contentBase64: readFileSync(authFile).toString('base64'),
        });
      }
      let claimCliVersions = null;
      await step('GET bootstrap runtime', async () => {
        const response = await vmFetch(`${bootstrapUrl}/api/runtime`, {
          signal: AbortSignal.timeout(10_000),
        });
        const runtime = await response.json();
        if (!response.ok || runtime.state !== 'unclaimed') {
          throw new Error('The image did not answer as an unclaimed DevChain VM.');
        }
        return { http: response.status, note: `imageVersion=${runtime.imageVersion ?? 'unknown'}` };
      });
      await step('POST bootstrap claim', async () => {
        let record;
        let http = 200;
        try {
          const response = await vmFetch(`${bootstrapUrl}/api/host/claim`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              userName: userInfo().username,
              homePath: homedir(),
              version: packageVersion,
              port,
              providerAuth,
            }),
            signal: AbortSignal.timeout(45 * 60_000),
          });
          if (!response.ok) throw new Error(`Bootstrap refused the claim (${response.status}).`);
          http = response.status;
          record = await response.json();
        } catch (error) {
          if (error.message.startsWith('Bootstrap refused')) throw error;
          // The bootstrap and DevChain trade the same port during handover.
          const deadline = Date.now() + 180_000;
          while (Date.now() < deadline) {
            try {
              const response = await vmFetch(`${hostUrl}/api/runtime`, {
                signal: AbortSignal.timeout(5_000),
              });
              const runtime = response.ok ? await response.json() : null;
              if (runtime?.version === packageVersion) {
                record = { cliVersions: runtime.cliVersions };
                break;
              }
            } catch {
              // The host may still be starting.
            }
            await sleep(3_000);
          }
          if (!record) throw error;
        }
        claimCliVersions = record.cliVersions;
        const pins = JSON.parse(
          readFileSync(resolve(scriptDir, '../../../../scripts/host-cli-pins.json'), 'utf8'),
        );
        for (const name of ['claude', 'codex', 'copilot', 'opencode']) {
          if (claimCliVersions?.[name] !== pins[name].version) {
            throw new Error(`Claimed ${name} version differs from its pin.`);
          }
        }
        if (!claimCliVersions?.agy) throw new Error('The claim did not record an agy version.');
        return {
          http,
          note: `DevChain ${packageVersion}; clis=${JSON.stringify(claimCliVersions)}`,
        };
      });
      await step('GET claimed DevChain runtime', async () => {
        const deadline = Date.now() + 3 * 60_000;
        while (Date.now() < deadline) {
          let runtime = null;
          try {
            const response = await vmFetch(`${hostUrl}/api/runtime`, {
              signal: AbortSignal.timeout(5_000),
            });
            runtime = response.ok ? await response.json() : null;
          } catch {
            // The claim restarts the service before DevChain answers.
          }
          if (runtime?.version === packageVersion) {
            // A host without a claim record (the fake-backed test) reports null.
            const reported = runtime.cliVersions ?? null;
            if (reported && JSON.stringify(reported) !== JSON.stringify(claimCliVersions)) {
              throw new Error('Runtime CLI versions differ from the claim record.');
            }
            return {
              http: 200,
              note: `DevChain ${packageVersion} ready${reported ? '' : '; runtime reports no CLI versions'}`,
            };
          }
          await sleep(5_000);
        }
        throw new Error('Claimed DevChain did not become ready within 180 seconds.');
      });
      if (args.verifyCodexLogin) {
        await step('verify_providers: codex', async () => {
          const response = await vmFetch(`${hostUrl}/api/host/provider-auth/verify`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ provider: 'codex', opencodeProviderIds: [] }),
            signal: AbortSignal.timeout(100_000),
          });
          const result = response.ok ? await response.json() : null;
          if (!result?.ok) throw new Error(`Codex login check failed (HTTP ${response.status}).`);
          return { http: response.status, note: 'Codex login verified' };
        });
      }
      if (args.updateVersion) {
        await step('POST host update', async () => {
          const response = await vmFetch(`${hostUrl}/api/host/update`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ version: args.updateVersion }),
            signal: AbortSignal.timeout(15_000),
          });
          if (response.status !== 202) throw new Error(`Host update refused (${response.status}).`);
          return { http: response.status, note: `target=${args.updateVersion}` };
        });
        await step('wait for changed CLI pin before activation', async () => {
          const deadline = Date.now() + 45 * 60_000;
          let sawBeforeActivation = false;
          while (Date.now() < deadline) {
            let runtime = null;
            let status = null;
            try {
              const response = await vmFetch(`${hostUrl}/api/runtime`, {
                signal: AbortSignal.timeout(5_000),
              });
              if (response.ok) runtime = await response.json();
            } catch {
              // The host restarts after activation.
            }
            try {
              const response = await vmFetch(`${hostUrl}/api/host/update`, {
                signal: AbortSignal.timeout(5_000),
              });
              if (response.ok) status = (await response.json()).status;
            } catch {
              // The host restarts after activation.
            }
            if (status?.state === 'failed') throw new Error(`Host update failed: ${status.error}`);
            if (status?.state === 'installing_clis' && runtime?.version === packageVersion) {
              sawBeforeActivation = true;
            }
            if (status?.state === 'done' && runtime?.version === args.updateVersion) {
              const next = runtime.cliVersions;
              if (!sawBeforeActivation)
                throw new Error('CLI install was not observed before activation.');
              if (!next?.codex || next.codex === claimCliVersions.codex) {
                throw new Error('The update did not change the Codex pin.');
              }
              return {
                http: 200,
                note: `old DevChain observed during CLI install; codex ${claimCliVersions.codex} -> ${next.codex}`,
              };
            }
            await sleep(1_000);
          }
          throw new Error('Host update did not finish within 45 minutes.');
        });
      }
    }
  } catch {
    failed = true;
    if (args.claim && agentIp && keyPath) {
      try {
        await step('guest bootstrap diagnostics', async () => {
          const record = await sshRun(
            keyPath,
            agentIp,
            'test -f /etc/devchain-host/claim.json && echo recorded || echo unrecorded',
          );
          const journal = await sshRun(
            keyPath,
            agentIp,
            'sudo journalctl -u devchain-bootstrap -n 50 --no-pager -o cat',
          );
          const lines = journal
            .split('\n')
            .filter((line) => /claim step|claim failed|error|timeout|killed/i.test(line))
            .slice(-12);
          const kernel = await sshRun(
            keyPath,
            agentIp,
            'sudo journalctl -k -n 100 --no-pager -o cat',
          );
          const memory = kernel
            .split('\n')
            .filter((line) => /out of memory|killed process|oom-kill/i.test(line))
            .slice(-4);
          return {
            note: `${record}; ${lines.join(' | ')}; kernel=${memory.join(' | ') || 'no OOM event'}`,
          };
        });
      } catch {
        // Cleanup still runs when diagnostics are unavailable.
      }
    }
  } finally {
    for (const vm of [...created].reverse()) {
      if (vm.label === 'template' && args.keepTemplate) continue;
      try {
        await destroyVm(api, cfg, vm.vmid, vm.label);
      } catch {
        failed = true;
      }
    }

    if (args.deleteImage) {
      try {
        await step(
          `DELETE /nodes/${cfg.node}/storage/${cfg.importStorage}/content/${importVolid}`,
          () =>
            runTask(
              api,
              cfg,
              'DELETE',
              `/nodes/${node}/storage/${encodeURIComponent(cfg.importStorage)}/content/${encodeURIComponent(importVolid)}`,
            ),
        );
      } catch {
        failed = true;
      }
    }

    try {
      await step(`GET /nodes/${cfg.node}/qemu (leftover check)`, async () => {
        const { http, data } = await api('GET', `/nodes/${node}/qemu`);
        const ours = new Set(created.map((c) => c.vmid));
        const leftovers = (data ?? []).filter((v) => ours.has(Number(v.vmid)));
        const expectedKept = args.keepTemplate ? [templateVmid] : [];
        const unexpected = leftovers.filter((v) => !expectedKept.includes(Number(v.vmid)));
        if (unexpected.length) {
          throw new ApiError(
            `leftover proof VMs: ${unexpected.map((v) => `${v.vmid}/${v.name}`).join(', ')}`,
            http,
          );
        }
        const visible = (data ?? []).map((v) => `${v.vmid}/${v.name}`).join(', ') || 'none';
        return { http, note: `visible VMs: ${visible}` };
      });
    } catch {
      failed = true;
    }
    try {
      await step(`GET /pools/${cfg.pool} (guest check)`, async () => {
        const { http, data } = await api('GET', `/pools/${encodeURIComponent(cfg.pool)}`);
        const guests = (data?.members ?? []).filter((member) => member.type === 'qemu');
        const unexpected = guests.filter(
          (member) => !args.keepTemplate || Number(member.vmid) !== templateVmid,
        );
        if (unexpected.length) {
          throw new ApiError(`pool still has ${unexpected.length} unexpected VM(s)`, http);
        }
        return {
          http,
          note: args.keepTemplate ? 'pool has only the kept template' : 'pool has no VMs',
        };
      });
    } catch {
      failed = true;
    }
    if (keyDir) rmSync(keyDir, { recursive: true, force: true });
  }

  out('');
  out(`Guest agent present in ${args.image ? 'published' : 'stock'} image: ${agentPresent}`);
  out(`Template kept: ${args.keepTemplate ? `yes (${templateVmid})` : 'no'}`);
  out(
    `Result: ${failed ? 'FAILED' : 'PASSED'} (${records.filter((r) => r.ok).length}/${records.length} steps ok)`,
  );
  process.exitCode = failed ? 1 : 0;
}

main().catch((err) => {
  out(`fatal: ${err.message}`);
  process.exitCode = 1;
});
