import { ZodError } from 'zod';
import { CreateLocalSourceSchema } from './local-sources.dto';

describe('CreateLocalSourceSchema - existingProjects', () => {
  it('defaults to mode none when the field is absent', () => {
    expect(CreateLocalSourceSchema.parse({ name: 'Local', folderPath: '/tmp/local' })).toEqual({
      name: 'local',
      folderPath: '/tmp/local',
      existingProjects: { mode: 'none' },
    });
  });

  it('accepts all and selected choices', () => {
    expect(
      CreateLocalSourceSchema.parse({
        name: 'local',
        folderPath: '/tmp/local',
        existingProjects: { mode: 'all' },
      }).existingProjects,
    ).toEqual({ mode: 'all' });
    expect(
      CreateLocalSourceSchema.parse({
        name: 'local',
        folderPath: '/tmp/local',
        existingProjects: {
          mode: 'selected',
          projectIds: ['00000000-0000-0000-0000-000000000001'],
        },
      }).existingProjects,
    ).toEqual({ mode: 'selected', projectIds: ['00000000-0000-0000-0000-000000000001'] });
  });

  it('rejects empty selections, non-uuid ids, unknown modes, and extra keys', () => {
    const base = { name: 'local', folderPath: '/tmp/local' };
    expect(() =>
      CreateLocalSourceSchema.parse({
        ...base,
        existingProjects: { mode: 'selected', projectIds: [] },
      }),
    ).toThrow(ZodError);
    expect(() =>
      CreateLocalSourceSchema.parse({
        ...base,
        existingProjects: { mode: 'selected', projectIds: ['not-a-uuid'] },
      }),
    ).toThrow(ZodError);
    expect(() =>
      CreateLocalSourceSchema.parse({ ...base, existingProjects: { mode: 'everywhere' } }),
    ).toThrow(ZodError);
    expect(() =>
      CreateLocalSourceSchema.parse({
        ...base,
        existingProjects: { mode: 'all', extra: true },
      }),
    ).toThrow(ZodError);
  });
});
