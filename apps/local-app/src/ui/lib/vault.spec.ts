import { fetchAgents } from './agents';
import { apiFetch } from './api-transport';
import { fetchProfiles } from './profiles';
import { fetchVaultProjectContext, listVaultGrants, setVaultProjectGrants } from './vault';

jest.mock('./api-transport', () => ({
  ...jest.requireActual('./api-transport'),
  apiFetch: jest.fn(),
}));

jest.mock('./agents', () => ({ fetchAgents: jest.fn() }));
jest.mock('./profiles', () => ({ fetchProfiles: jest.fn() }));

describe('fetchVaultProjectContext', () => {
  it('lists roles with profile and agent names', async () => {
    (fetchProfiles as jest.Mock).mockResolvedValue({
      items: [
        { id: 'prof1', name: 'Coder (Claude)', familySlug: ' Coder ' },
        { id: 'prof2', name: 'Coder (Codex)', familySlug: 'coder' },
        { id: 'prof3', name: 'Reviewer', familySlug: 'reviewer' },
        { id: 'prof4', name: 'Helper', familySlug: null },
        { id: 'prof5', name: 'Scratch', familySlug: '  ' },
      ],
    });
    (fetchAgents as jest.Mock).mockResolvedValue({
      items: [
        { id: 'a1', name: 'Coder 2', profileId: 'prof2' },
        { id: 'a2', name: 'Coder 1', profileId: 'prof1' },
        { id: 'a3', name: 'Helper 1', profileId: 'prof4' },
      ],
    });

    await expect(fetchVaultProjectContext('p1')).resolves.toEqual({
      roles: [
        {
          familySlug: 'coder',
          profileNames: ['Coder (Claude)', 'Coder (Codex)'],
          agentNames: ['Coder 1', 'Coder 2'],
        },
        { familySlug: 'reviewer', profileNames: ['Reviewer'], agentNames: [] },
      ],
      profilesWithoutRole: 2,
    });
    expect(fetchAgents).toHaveBeenCalledWith(expect.any(Function), 'p1');
  });
});

describe('project grant calls', () => {
  it('reads grants of one project and saves several entries in one home request', async () => {
    const calls: Array<[string, RequestInit | undefined, unknown]> = [];
    (apiFetch as jest.Mock).mockImplementation(async (url: string, init, options) => {
      calls.push([url, init, options]);
      return { ok: true, json: async () => [] };
    });

    await listVaultGrants('p 1');
    await setVaultProjectGrants('p 1', [
      { entryId: 'e1', mode: 'none' },
      { entryId: 'e2', mode: 'families', familySlugs: ['coder'] },
    ]);

    expect(calls.map(([url, init]) => [url, init?.method, init?.body])).toEqual([
      ['/api/vault/grants?projectId=p%201', undefined, undefined],
      [
        '/api/vault/projects/p%201/grants',
        'PUT',
        JSON.stringify({
          entries: [
            { entryId: 'e1', mode: 'none' },
            { entryId: 'e2', mode: 'families', familySlugs: ['coder'] },
          ],
        }),
      ],
    ]);
    expect(
      calls.every(([, , options]) => (options as { backend: string }).backend === 'home'),
    ).toBe(true);
  });
});
