import { DockerCopyBackExclusions } from './docker-copy-back-exclusions';

// Service units exercise the operation/revision fences and installed readback, independent of Docker.
function setup(initial: string[] = []) {
  let stored = [...initial];
  let revision = 3;
  let homeInstalled: string[] = [];
  let vmInstalled: string[] = [];
  const binding = { remoteId: 'vm', state: 'detaching' };
  const files = {
    getIgnores: () => [...stored],
    getIgnoresRevision: () => revision,
    setIgnores: jest.fn((_project: string, lines: string[], expected: number) => {
      if (expected !== revision) throw new Error('revision changed');
      stored = [...lines];
      revision++;
      return stored;
    }),
    updateFolder: jest.fn(async (_folder: string, input: { ignores: string[] }) => {
      homeInstalled = [...input.ignores];
    }),
    installedIgnores: jest.fn(async () => ({ ignore: homeInstalled })),
  };
  const host = {
    syncFolderType: jest.fn(
      async (_remote: string, _folder: string, input: { ignores: string[] }) => {
        vmInstalled = [...input.ignores];
      },
    ),
    syncFolderIgnores: jest.fn(async () => ({ ignore: vmInstalled })),
  };
  const suggestions = {
    vmSuggestions: jest.fn(async () => ({
      groups: [
        { path: 'data', patterns: ['(?d)/data'], selected: true, patternChecksPassed: true },
        {
          path: 'unselected',
          patterns: ['(?d)/unselected'],
          selected: false,
          patternChecksPassed: true,
        },
        {
          path: 'unrelated',
          patterns: ['(?d)/unrelated'],
          selected: true,
          patternChecksPassed: true,
        },
      ],
    })),
  };
  const service = new DockerCopyBackExclusions(
    files as never,
    host as never,
    suggestions as never,
    { get: () => ['/managed'] } as never,
    { get: async () => binding } as never,
  );
  const controller = new AbortController();
  const prepare = () =>
    service.prepare('p', 'vm', '/checkout', ['/checkout/data'], controller.signal);
  return {
    service,
    files,
    host,
    suggestions,
    binding,
    controller,
    prepare,
    edit: (lines: string[]) => {
      stored = lines;
      revision++;
    },
  };
}

describe('Disconnect Docker file-sync barrier', () => {
  it.each(['/checkout/.git', '/checkout/.git/data', '/checkout', '/'])(
    'refuses Git-share overlap %s even when the code share excludes it',
    async (target) => {
      const s = setup();
      s.files.installedIgnores.mockResolvedValue({ ignore: ['/.git', '*'] });
      s.host.syncFolderIgnores.mockResolvedValue({ ignore: ['/.git', '*'] });
      expect(
        await s.service.prepare('p', 'vm', '/checkout', [target], s.controller.signal),
      ).toMatchObject({ confirmed: [] });
      expect(
        await s.service.confirm(
          'p',
          'vm',
          '/checkout',
          [target],
          s.files.getIgnoresRevision(),
          s.controller.signal,
        ),
      ).toEqual([]);
      expect(s.files.setIgnores).not.toHaveBeenCalled();
      expect(s.suggestions.vmSuggestions).toHaveBeenCalledWith('p', 'vm', []);
    },
  );
  it('stores a selected target with CAS while detaching, applies both peers, reads installed lines, and repeats without duplicates', async () => {
    const s = setup(['existing']);
    expect(await s.prepare()).toEqual({
      revision: 4,
      confirmed: ['/checkout/data'],
      pending: true,
    });
    expect(s.suggestions.vmSuggestions).toHaveBeenCalledWith('p', 'vm', ['data']);
    expect(s.files.setIgnores).toHaveBeenCalledWith('p', ['existing', '(?d)/data'], 3);
    const input = { ignores: ['/.git', '/managed', 'existing', '(?d)/data'] };
    expect(s.host.syncFolderType).toHaveBeenCalledWith('vm', 'code:p', input);
    expect(s.files.updateFolder).toHaveBeenCalledWith('code:p', input);
    expect(s.files.installedIgnores).toHaveBeenCalledWith('code:p');
    expect(s.host.syncFolderIgnores).toHaveBeenCalledWith('vm', 'code:p');
    expect(await s.prepare()).toMatchObject({ revision: 4, confirmed: ['/checkout/data'] });
    expect(s.files.setIgnores).toHaveBeenCalledTimes(1);
    expect(s.suggestions.vmSuggestions).toHaveBeenCalledTimes(2);
  });

  it.each(['home', 'vm'])(
    'refuses when the %s apply fails and safely retries the stored list',
    async (side) => {
      const s = setup();
      const apply = side === 'home' ? s.files.updateFolder : s.host.syncFolderType;
      apply.mockRejectedValueOnce(new Error('offline'));
      expect(await s.prepare()).toMatchObject({ confirmed: [] });
      expect(s.files.getIgnores()).toEqual(['(?d)/data']);
      expect(await s.prepare()).toMatchObject({ confirmed: ['/checkout/data'] });
      expect(s.files.setIgnores).toHaveBeenCalledTimes(1);
    },
  );

  it.each(
    [
      ['!/data/keep', '/data'],
      ['/data', '!/data/keep'],
      ['/data', '#include extra'],
      [],
      ['/other'],
    ].map((lines) => ({ lines })),
  )('refuses unsafe installed lines $lines even after a successful apply', async ({ lines }) => {
    const s = setup();
    s.host.syncFolderIgnores.mockResolvedValue({ ignore: lines });
    expect(await s.prepare()).toMatchObject({ confirmed: [] });
  });

  it('never upgrades a builder proposal with tracked keep exceptions to a whole-subtree exclusion', async () => {
    const s = setup();
    s.suggestions.vmSuggestions.mockResolvedValue({
      groups: [
        {
          path: 'data',
          patterns: ['!/data/keep', '/data'],
          selected: true,
          patternChecksPassed: true,
        },
      ],
    });
    expect(await s.prepare()).toMatchObject({ confirmed: [] });
    expect(s.files.setIgnores).toHaveBeenCalledWith('p', ['!/data/keep', '/data'], 3);
  });

  it('protects an ignore edit made during the ownership scan', async () => {
    const s = setup();
    const scan = s.suggestions.vmSuggestions.getMockImplementation()!;
    s.suggestions.vmSuggestions.mockImplementation(async () => {
      s.edit(['!/data/keep']);
      return scan();
    });
    expect(await s.prepare()).toMatchObject({ confirmed: [] });
    expect(s.files.getIgnores()).toEqual(['!/data/keep']);
    expect(s.files.setIgnores).not.toHaveBeenCalled();
    expect(s.files.updateFolder).not.toHaveBeenCalled();
  });

  it('refuses an edit during installed-ignore readback', async () => {
    const s = setup();
    s.host.syncFolderIgnores.mockImplementation(async () => {
      s.edit(['!/data/keep']);
      return { ignore: ['/data'] };
    });
    expect(await s.prepare()).toMatchObject({ confirmed: [] });
  });

  it('keeps readback failures closed without authorizing root or ancestor replacement', async () => {
    const s = setup();
    s.files.installedIgnores.mockRejectedValue(new Error('invalid REST response'));
    const proof = await s.service.prepare(
      'p',
      'vm',
      '/checkout',
      ['/checkout', '/', '/checkout/data', '/external/data'],
      s.controller.signal,
    );
    expect(proof.confirmed).toEqual(['/external/data']);
  });

  it('refuses an unsupported literal backslash path instead of confirming a different subtree', async () => {
    if (process.platform === 'win32') return;
    const s = setup();
    s.files.installedIgnores.mockResolvedValue({ ignore: ['/data/keep'] });
    s.host.syncFolderIgnores.mockResolvedValue({ ignore: ['/data/keep'] });
    expect(
      await s.service.confirm(
        'p',
        'vm',
        '/checkout',
        ['/checkout/data\\keep'],
        3,
        s.controller.signal,
      ),
    ).toEqual([]);
  });

  it.each(['remote', 'other-remote'])(
    'refuses a changed operation binding (%s)',
    async (change) => {
      const s = setup();
      s.host.syncFolderIgnores.mockImplementation(async () => {
        if (change === 'remote') s.binding.state = 'remote';
        else s.binding.remoteId = 'other-remote';
        return { ignore: ['/data'] };
      });
      await expect(s.prepare()).rejects.toMatchObject({ code: 'FILE_SYNC_COPY_BACK_CHANGED' });
    },
  );

  it('honors interruption during a failing scan', async () => {
    const s = setup();
    s.suggestions.vmSuggestions.mockImplementation(async () => {
      s.controller.abort();
      throw new Error('offline');
    });
    await expect(s.prepare()).rejects.toThrow();
    expect(s.files.setIgnores).not.toHaveBeenCalled();
  });

  it('leaves a failed scan unconfirmed and allows the next attempt without a new edit', async () => {
    const s = setup();
    s.suggestions.vmSuggestions.mockRejectedValueOnce(new Error('offline'));
    expect(await s.prepare()).toMatchObject({ confirmed: [] });
    expect(s.files.updateFolder).not.toHaveBeenCalled();
    expect(await s.prepare()).toMatchObject({ confirmed: ['/checkout/data'] });
  });
});

it.each(['confirmed', 'keep', 'peer failure', 'revision change', 'binding change', 'state change'])(
  'previews %s without consuming or preparing a copy attempt',
  async (condition) => {
    const s = setup();
    s.binding.state = 'remote';
    s.files.installedIgnores.mockResolvedValue({ ignore: ['/data'] });
    s.host.syncFolderIgnores.mockImplementation(async () => {
      if (condition === 'peer failure') throw new Error('offline');
      if (condition === 'revision change') s.edit(['/data']);
      if (condition === 'binding change') s.binding.remoteId = 'other';
      if (condition === 'state change') s.binding.state = 'home';
      return { ignore: condition === 'keep' ? ['!/data/keep', '/data'] : ['/data'] };
    });
    expect(
      await s.service.preview(
        'p',
        'vm',
        '/checkout',
        ['/checkout/data', '/checkout/.git/data'],
        s.controller.signal,
      ),
    ).toEqual(condition === 'confirmed' ? ['/checkout/data'] : []);
    expect(s.suggestions.vmSuggestions).not.toHaveBeenCalled();
    expect(s.files.setIgnores).not.toHaveBeenCalled();
    expect(s.files.updateFolder).not.toHaveBeenCalled();
    expect(s.host.syncFolderType).not.toHaveBeenCalled();
  },
);
