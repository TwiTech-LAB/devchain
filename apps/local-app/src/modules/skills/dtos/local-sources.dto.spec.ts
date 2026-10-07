import { CreateLocalSourceSchema } from './local-sources.dto';

describe('CreateLocalSourceSchema - existingProjects', () => {
  it('defaults to mode none when the field is absent', () => {
    expect(CreateLocalSourceSchema.parse({ name: 'Local', folderPath: '/tmp/local' })).toEqual({
      name: 'local',
      folderPath: '/tmp/local',
      existingProjects: { mode: 'none' },
    });
  });
});
