import { BadRequestException } from '@nestjs/common';
import { createSecureContext } from 'node:tls';
import { z } from 'zod';

const PveIdentifierSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/);
const FingerprintSchema = z
  .string()
  .regex(/^([0-9a-fA-F]{2}:){31}[0-9a-fA-F]{2}$|^[0-9a-fA-F]{64}$/);
const QUERY_FIELDS = new Set(['pool', 'storage', 'imageStorage', 'bridge', 'fp', 'token', 'ca']);

export const ConnectProxmoxRequestSchema = z
  .object({
    connectionString: z.string().trim().min(1).max(64_000),
    confirmFingerprint: z.boolean().optional(),
  })
  .strict();

export interface ParsedProxmoxConnectionString {
  kind: 'proxmox';
  name: string;
  apiUrl: string;
  node: string;
  pool: string;
  storage: string;
  imageStorage: string;
  bridge: string;
  vmidMin: number;
  vmidMax: number;
  namePrefix: string;
  tag: string;
  sslFingerprint: string;
  caPem?: string;
  tokenId: string;
  tokenSecret: string;
}

function invalidConnectionString(): never {
  throw new BadRequestException('Invalid Proxmox connection string.');
}

function oneParameter(url: URL, name: string, required = true): string | undefined {
  const values = url.searchParams.getAll(name);
  if (values.length === 0 && !required) return undefined;
  if (values.length !== 1) return invalidConnectionString();
  return values[0];
}

function parseCa(encoded: string | undefined): string | undefined {
  if (encoded === undefined) return undefined;
  if (!encoded || encoded.length > 48_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    return invalidConnectionString();
  }
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.toString('base64') !== encoded) return invalidConnectionString();
  const caPem = bytes.toString('utf8');
  if (
    !caPem.includes('-----BEGIN CERTIFICATE-----') ||
    !caPem.includes('-----END CERTIFICATE-----')
  ) {
    return invalidConnectionString();
  }
  try {
    createSecureContext({ ca: caPem });
  } catch {
    return invalidConnectionString();
  }
  return caPem;
}

export function normalizeProxmoxFingerprint(fingerprint: string): string {
  const normalized = fingerprint.replace(/:/g, '').toUpperCase();
  return normalized.match(/.{2}/g)?.join(':') ?? normalized;
}

export function parseProxmoxConnectionString(input: string): ParsedProxmoxConnectionString {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return invalidConnectionString();
  }
  if (
    url.protocol !== 'devchain-proxmox:' ||
    !url.hostname ||
    !url.port ||
    url.username ||
    url.password ||
    url.hash
  ) {
    return invalidConnectionString();
  }

  const path = url.pathname.startsWith('/') ? url.pathname.slice(1) : url.pathname;
  let node: string;
  try {
    node = decodeURIComponent(path);
  } catch {
    return invalidConnectionString();
  }
  const parsedNode = PveIdentifierSchema.safeParse(node);
  if (!parsedNode.success) return invalidConnectionString();

  for (const key of url.searchParams.keys()) {
    if (!QUERY_FIELDS.has(key)) return invalidConnectionString();
  }
  const pool = PveIdentifierSchema.safeParse(oneParameter(url, 'pool'));
  const storage = PveIdentifierSchema.safeParse(oneParameter(url, 'storage'));
  const imageStorage = PveIdentifierSchema.safeParse(oneParameter(url, 'imageStorage'));
  const bridge = PveIdentifierSchema.safeParse(oneParameter(url, 'bridge'));
  const fingerprint = FingerprintSchema.safeParse(oneParameter(url, 'fp'));
  const tokenValue = oneParameter(url, 'token');
  if (
    !pool.success ||
    !storage.success ||
    !imageStorage.success ||
    !bridge.success ||
    !fingerprint.success ||
    !tokenValue
  ) {
    return invalidConnectionString();
  }

  const tokenSeparator = tokenValue.indexOf(':');
  const tokenId = tokenSeparator > 0 ? tokenValue.slice(0, tokenSeparator) : '';
  const tokenSecret = tokenSeparator > 0 ? tokenValue.slice(tokenSeparator + 1) : '';
  if (
    tokenId !== 'devchain@pve!agent' ||
    !tokenSecret ||
    tokenSecret.length > 4096 ||
    /[\u0000-\u001f\u007f]/.test(tokenSecret)
  ) {
    return invalidConnectionString();
  }

  const caPem = parseCa(oneParameter(url, 'ca', false));
  const hostLabel = url.hostname.replace(/^\[|\]$/g, '');
  return {
    kind: 'proxmox',
    name: `Proxmox ${hostLabel}`,
    apiUrl: `https://${url.host}`,
    node,
    pool: pool.data,
    storage: storage.data,
    imageStorage: imageStorage.data,
    bridge: bridge.data,
    vmidMin: 100,
    vmidMax: 999_999_999,
    namePrefix: 'devchain-',
    tag: 'devchain',
    sslFingerprint: normalizeProxmoxFingerprint(fingerprint.data),
    ...(caPem ? { caPem } : {}),
    tokenId,
    tokenSecret,
  };
}
