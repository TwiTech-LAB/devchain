import type { ProviderAuthEntryItem } from '@/ui/hooks/useProviderAuth';
import {
  changedProviderAuth,
  defaultLoginChoice,
  heldElsewhere,
  loginOptions,
  setupProviderAuth,
  type LoginContext,
} from './login-choices';

function entry(
  partial: Partial<ProviderAuthEntryItem> & { id: string; provider: string },
): ProviderAuthEntryItem {
  return {
    kind: 'static',
    label: 'Entry',
    payloadKind: 'env',
    checkedOutRemoteId: null,
    createdAt: '2026-09-24T00:00:00.000Z',
    updatedAt: '2026-09-24T00:00:00.000Z',
    lastVerifiedAt: null,
    lastWritebackAt: null,
    ...partial,
  };
}

const remoteNames = new Map([['r-lab', 'vm-lab']]);
const newVm: LoginContext = { targetRemoteId: null, remoteNames };

describe('login choices', () => {
  // One Codex family is checked out to vm-lab; a new VM must not get it.
  describe('a login another VM holds', () => {
    const family = entry({
      id: 'f1',
      provider: 'codex',
      kind: 'family',
      label: 'Codex family',
      checkedOutRemoteId: 'r-lab',
    });

    it('shows disabled with the VM holding it', () => {
      expect(loginOptions('codex', [family], newVm)).toEqual([
        { value: 'skip', label: 'None', disabledReason: null },
        {
          value: 'reuse:f1',
          label: 'Codex family · Login · on vm-lab',
          disabledReason: 'In use on vm-lab',
        },
        { value: 'generate', label: 'New login (sign in during setup)', disabledReason: null },
      ]);
    });

    it('is never preselected for a new VM', () => {
      expect(defaultLoginChoice('codex', [family], newVm)).toBe('skip');
    });

    it('stays usable and preselected for the VM that holds it', () => {
      const lab: LoginContext = { targetRemoteId: 'r-lab', remoteNames };
      expect(heldElsewhere(family, lab)).toBeNull();
      expect(loginOptions('codex', [family], lab)[1]).toEqual({
        value: 'reuse:f1',
        label: 'Codex family · Login',
        disabledReason: null,
      });
      expect(defaultLoginChoice('codex', [family], lab)).toBe('reuse:f1');
    });

    it('names an unknown holder "another VM"', () => {
      const orphan = { ...family, checkedOutRemoteId: 'r-gone' };
      expect(heldElsewhere(orphan, newVm)).toBe('another VM');
    });
  });

  it('preselects the only usable entry, a token or a free login', () => {
    const token = entry({ id: 't1', provider: 'claude', label: 'Main token' });
    expect(defaultLoginChoice('claude', [token], newVm)).toBe('reuse:t1');

    const free = entry({ id: 'f2', provider: 'agy', kind: 'family' });
    const held = entry({ id: 'f3', provider: 'agy', kind: 'family', checkedOutRemoteId: 'r-lab' });
    expect(defaultLoginChoice('agy', [free, held], newVm)).toBe('reuse:f2');
  });

  it('defaults to None with no usable entry or more than one', () => {
    expect(defaultLoginChoice('claude', [], newVm)).toBe('skip');
    const both = [entry({ id: 't1', provider: 'claude' }), entry({ id: 't2', provider: 'claude' })];
    expect(defaultLoginChoice('claude', both, newVm)).toBe('skip');
  });

  // Pure unit: the picker uses entry metadata, so no UI or payload decryption is needed.
  it('preselects one usable OpenCode group and submits it as one choice for setup and changes', () => {
    const group = entry({
      id: 'group',
      provider: 'opencode',
      payloadKind: 'opencode-entries',
      label: 'anthropic, github, zai-coding-plan',
    });
    const held = entry({
      id: 'held',
      provider: 'opencode',
      kind: 'family',
      checkedOutRemoteId: 'r-lab',
    });
    const choice = defaultLoginChoice('opencode', [group, held], newVm);
    expect(choice).toBe('reuse:group');
    expect(loginOptions('opencode', [group, held], newVm)[1]).toEqual({
      value: choice,
      label: 'anthropic, github, zai-coding-plan · Token',
      disabledReason: null,
    });
    expect(setupProviderAuth({ opencode: choice })).toEqual({ opencode: 'reuse:group' });
    expect(changedProviderAuth({ opencode: choice })).toEqual({ opencode: 'reuse:group' });
    expect(
      defaultLoginChoice(
        'opencode',
        [group, entry({ id: 'other', provider: 'opencode', payloadKind: 'opencode-entry' })],
        newVm,
      ),
    ).toBe('skip');
  });

  it('labels tokens and lists only the provider’s entries', () => {
    const options = loginOptions(
      'claude',
      [
        entry({ id: 't1', provider: 'claude', label: 'Main token' }),
        entry({ id: 'x1', provider: 'codex' }),
      ],
      newVm,
    );
    expect(options.map((option) => option.label)).toEqual(['None', 'Main token · Token']);
  });

  it('offers a new login only for providers that can sign in during setup', () => {
    const hasNewLogin = (provider: string) =>
      loginOptions(provider, [], newVm).some((option) => option.value === 'generate');
    expect(['codex', 'agy', 'opencode', 'copilot'].every(hasNewLogin)).toBe(true);
    expect(hasNewLogin('claude')).toBe(false);
  });

  it('sends setup choices without None, and changes with None as a removal', () => {
    const choices = {
      claude: 'skip',
      codex: 'generate',
      agy: 'keep',
      opencode: 'reuse:o1',
    } as const;
    expect(setupProviderAuth(choices)).toEqual({ codex: 'generate', opencode: 'reuse:o1' });
    expect(changedProviderAuth(choices)).toEqual({
      claude: 'skip',
      codex: 'generate',
      opencode: 'reuse:o1',
    });
  });
});
