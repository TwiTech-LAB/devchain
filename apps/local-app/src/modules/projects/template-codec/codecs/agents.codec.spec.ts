import { ImportContext } from '../import-context';
import type { CodecApplyRuntime } from '../template-section-codec';
import { agentsCodec } from './agents.codec';

// The codec boundary can reproduce a missing persisted option with another option still available.
it('refuses to substitute an option for a preserved agent when the planned option cannot be bound', async () => {
  const ctx = new ImportContext({
    selectedProfilesByFamily: {
      profilesToCreate: [],
      agentProfileMap: new Map([['planned-agent', 'source-profile']]),
      profileNameRemapMap: new Map(),
      providerSubstitutions: new Map(),
    },
    profileIdMap: { 'source-profile': 'new-profile' },
    selectionEligibleConfigLookupMap: new Map([['new-profile:alternative', 'alternate-id']]),
  });
  const createAgent = jest.fn().mockResolvedValue({ id: 'new-agent' });
  const rt: CodecApplyRuntime = {
    projectId: 'project',
    storage: { createAgent } as unknown as CodecApplyRuntime['storage'],
    applyPreservedRoster: true,
  };

  await expect(
    agentsCodec.apply(
      [
        {
          id: 'planned-agent',
          name: 'Worker',
          profileId: 'source-profile',
          providerConfigName: 'planned-option',
          isProjectOwner: false,
        },
      ],
      ctx,
      'replace',
      rt,
    ),
  ).rejects.toThrow('No provider config available for agent Worker');
  expect(createAgent).not.toHaveBeenCalled();
});
