import { describe, expect, it } from 'vitest';
import {
  HOST_VAULT_VALUE_MAX_BYTES,
  HostVaultPushSchema,
  HostVaultRequestResolveSchema,
  type HostVaultPush,
} from './host-vault.js';

const entry = {
  id: 'e1',
  projectId: 'p1',
  name: 'API_TOKEN',
  kind: 'secret' as const,
  description: 'Token',
  revision: 2,
  approvalRequired: true,
};
const body: HostVaultPush = {
  revision: 'a'.repeat(64),
  entries: [entry],
  grants: [{ entryId: 'e1', projectId: 'p1', familySlug: 'coder' }],
  access: [{ projectId: 'p1', familySlug: null }],
  approvals: [{ entryId: 'e1', projectId: 'p1', familySlug: 'coder' }],
  values: [{ entryId: 'e1', revision: 2, valueBase64: 'dmFsdWU=' }],
};

describe('Host Vault push wire contract', () => {
  // Pure schema tests: the cross-field rules hold for home and VM without booting either.
  it('accepts a consistent push', () => {
    expect(HostVaultPushSchema.safeParse(body).success).toBe(true);
  });

  it.each<[string, Partial<HostVaultPush>]>([
    ['a value at another revision', { values: [{ ...body.values[0], revision: 1 }] }],
    ['an entry without its value', { values: [] }],
    [
      'a value of an unlisted entry',
      { values: [...body.values, { ...body.values[0], entryId: 'x' }] },
    ],
    [
      'a grant of an unlisted entry',
      { grants: [{ entryId: 'x', projectId: 'p1', familySlug: null }] },
    ],
    [
      'a project entry granted in another project',
      { grants: [{ entryId: 'e1', projectId: 'p2', familySlug: null }] },
    ],
    [
      'a family slug that is not lowercase',
      { grants: [{ ...body.grants[0], familySlug: 'Coder' }] },
    ],
    ['the same access row twice', { access: [body.access[0], body.access[0]] }],
    [
      'an access slug that is not lowercase',
      { access: [{ projectId: 'p1', familySlug: 'Coder' }] },
    ],
    ['a push without access rows', { access: undefined }],
    ['a push without approvals', { approvals: undefined }],
    [
      'an approval of an unlisted entry',
      { approvals: [{ entryId: 'x', projectId: 'p1', familySlug: 'coder' }] },
    ],
    [
      'a project entry approved in another project',
      { approvals: [{ entryId: 'e1', projectId: 'p2', familySlug: 'coder' }] },
    ],
    [
      'an approval without a family',
      { approvals: [{ entryId: 'e1', projectId: 'p1', familySlug: null as unknown as string }] },
    ],
    ['the same approval twice', { approvals: [body.approvals[0], body.approvals[0]] }],
    [
      'an entry without its approval flag',
      { entries: [{ ...entry, approvalRequired: undefined as unknown as boolean }] },
    ],
    [
      'two entries with one name for one owner',
      {
        entries: [entry, { ...entry, id: 'e2' }],
        values: [...body.values, { ...body.values[0], entryId: 'e2' }],
      },
    ],
  ])('rejects %s', (_name, change) => {
    expect(HostVaultPushSchema.safeParse({ ...body, ...change }).success).toBe(false);
  });
});

describe('Host Vault request wire contract', () => {
  it.each<[string, unknown]>([
    ['a stored or granted answer', { status: 'fulfilled' }],
    ['a session-only answer', { status: 'fulfilled', sessionValue: { value: 'v' } }],
    [
      'a session-only value at the size limit',
      { status: 'fulfilled', sessionValue: { value: 'a'.repeat(HOST_VAULT_VALUE_MAX_BYTES) } },
    ],
    ['a denial', { status: 'denied' }],
    ['a denial with a reason', { status: 'denied', reason: 'Not now' }],
    ['a session approval', { status: 'approved', decision: 'session' }],
    ['a family approval', { status: 'approved', decision: 'family' }],
  ])('accepts %s', (_name, body) => {
    expect(HostVaultRequestResolveSchema.safeParse(body).success).toBe(true);
  });

  it.each<[string, unknown]>([
    ['a reason on a fulfilled answer', { status: 'fulfilled', reason: 'x' }],
    ['a session value on a denial', { status: 'denied', sessionValue: { value: 'v' } }],
    ['a reason over 200 characters', { status: 'denied', reason: 'x'.repeat(201) }],
    ['an empty session value', { status: 'fulfilled', sessionValue: { value: '' } }],
    [
      'a session value over the size limit',
      { status: 'fulfilled', sessionValue: { value: 'a'.repeat(HOST_VAULT_VALUE_MAX_BYTES + 1) } },
    ],
    [
      'a session value over the limit in UTF-8 bytes only',
      {
        status: 'fulfilled',
        sessionValue: { value: '\u00e9'.repeat(HOST_VAULT_VALUE_MAX_BYTES / 2 + 1) },
      },
    ],
    ['an approval without a decision', { status: 'approved' }],
    ['an unknown decision', { status: 'approved', decision: 'forever' }],
    ['a value on an approval', { status: 'approved', decision: 'once', sessionValue: { value: 'v' } }],
    ['an unknown status', { status: 'expired' }],
    ['an unknown key', { status: 'fulfilled', extra: true }],
    ['an unknown session value key', { status: 'fulfilled', sessionValue: { value: 'v', x: 1 } }],
  ])('rejects %s', (_name, body) => {
    expect(HostVaultRequestResolveSchema.safeParse(body).success).toBe(false);
  });
});
