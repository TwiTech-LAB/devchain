import { describe, expect, it } from 'vitest';
import { HostSkillSettingsSchema } from './host-skill-settings.js';

const body = {
  revision: 'revision',
  communitySources: [{ name: 'Home', repoOwner: 'OWNER', repoName: 'REPO', branch: 'main' }],
  localSources: [],
  sourcesEnabled: { home: true },
  projectIds: ['project'],
  projectSourceSwitches: [{ projectId: 'project', sourceName: 'Home', enabled: false }],
};

describe('Host skill settings wire contract', () => {
  // Pure schema tests cover boundary rejection without booting either HTTP implementation.
  it('normalizes source names and repository identity to stored values', () => {
    const parsed = HostSkillSettingsSchema.parse(body);
    expect(parsed.communitySources[0]).toEqual({
      name: 'home',
      repoOwner: 'owner',
      repoName: 'repo',
      branch: 'main',
    });
    expect(parsed.projectSourceSwitches[0].sourceName).toBe('home');
  });
  it.each(['../escape', '/absolute', 'has/slash', 'has\\slash'])(
    'rejects unsafe source segment %s',
    (name) => {
      expect(
        HostSkillSettingsSchema.safeParse({
          ...body,
          communitySources: [{ ...body.communitySources[0], name }],
        }).success,
      ).toBe(false);
    },
  );
  it('rejects duplicate source names across kinds, missing effective switches and foreign project rows', () => {
    expect(
      HostSkillSettingsSchema.safeParse({
        ...body,
        localSources: [{ name: 'home', folderPath: '/folder', contentHash: 'hash' }],
      }).success,
    ).toBe(false);
    expect(HostSkillSettingsSchema.safeParse({ ...body, sourcesEnabled: {} }).success).toBe(false);
    expect(HostSkillSettingsSchema.safeParse({ ...body, projectIds: [] }).success).toBe(false);
  });
});
