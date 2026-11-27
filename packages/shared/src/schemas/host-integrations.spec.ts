import { describe, expect, it } from 'vitest';
import { HostIntegrationsPushSchema } from './host-integrations.js';

const revision = 'a'.repeat(64);
const connection = { id: 'c1', projectId: 'A', provider: 'jira', generation: 2 } as const;
const credentials = {
  provider: 'jira',
  siteUrl: 'https://acme.atlassian.net',
  email: 'user@example.com',
  token: 'secret',
} as const;

describe('HostIntegrationsPushSchema', () => {
  it('accepts metadata alone and metadata with matching credentials', () => {
    expect(
      HostIntegrationsPushSchema.safeParse({ revision, connections: [connection] }).success,
    ).toBe(true);
    const withSecret = {
      revision,
      connections: [connection],
      secrets: [{ connectionId: 'c1', generation: 2, credentials }],
    };
    expect(HostIntegrationsPushSchema.safeParse(withSecret).success).toBe(true);
  });

  it.each([
    ['another generation', { connectionId: 'c1', generation: 1, credentials }],
    ['an unlisted connection', { connectionId: 'c2', generation: 2, credentials }],
    [
      'another provider',
      { connectionId: 'c1', generation: 2, credentials: { provider: 'clickup', token: 't' } },
    ],
  ])('refuses a secret for %s', (_label, secret) => {
    expect(
      HostIntegrationsPushSchema.safeParse({
        revision,
        connections: [connection],
        secrets: [secret],
      }).success,
    ).toBe(false);
  });

  it('refuses two connections of one project and provider', () => {
    const push = { revision, connections: [connection, { ...connection, id: 'c2' }] };
    expect(HostIntegrationsPushSchema.safeParse(push).success).toBe(false);
  });

  it('takes a seed only of links of its own project, and one seed per project', () => {
    const link = {
      id: 'link-1',
      epic_id: 'epic-1',
      project_id: 'A',
      connection_id: 'c1',
      provider: 'jira',
      remote_scope_key: 'site',
      remote_task_id: 'J-1',
      source_snapshot: '{}',
      created_at: 'T',
      updated_at: 'T',
    };
    const push = (seed: unknown) =>
      HostIntegrationsPushSchema.safeParse({ revision, connections: [connection], seed }).success;

    expect(push([{ projectId: 'A', links: [link] }])).toBe(true);
    expect(push([{ projectId: 'B', links: [link] }])).toBe(false);
    expect(
      push([
        { projectId: 'A', links: [] },
        { projectId: 'A', links: [] },
      ]),
    ).toBe(false);
  });
});
