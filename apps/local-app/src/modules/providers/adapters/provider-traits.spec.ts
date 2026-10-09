import { ProviderAdapterFactory } from './provider-adapter.factory';
import { ClaudeAdapter } from './claude.adapter';
import { CodexAdapter } from './codex.adapter';
import { OpencodeAdapter } from './opencode.adapter';
import { AntigravityAdapter } from './antigravity.adapter';
import { CopilotAdapter } from './copilot.adapter';
import { PROVIDER_TRAITS, providerTraits } from './provider-traits';
import { SessionReaderAdapterFactory } from '../../session-reader/adapters/session-reader-adapter.factory';
import { ClaudeSessionReaderAdapter } from '../../session-reader/adapters/claude-session-reader.adapter';
import { CodexSessionReaderAdapter } from '../../session-reader/adapters/codex-session-reader.adapter';
import { OpenCodeSessionReaderAdapter } from '../../session-reader/adapters/opencode-session-reader.adapter';
import { AntigravitySessionReaderAdapter } from '../../session-reader/adapters/antigravity-session-reader.adapter';
import { CopilotSessionReaderAdapter } from '../../session-reader/adapters/copilot-session-reader.adapter';
import { SessionReaderModule } from '../../session-reader/session-reader.module';

// Unit coverage compares the real adapter registries without booting Nest or reading transcripts.
describe('provider traits consistency', () => {
  let launchFactory: ProviderAdapterFactory;
  let readerFactory: SessionReaderAdapterFactory;

  beforeEach(() => {
    launchFactory = new ProviderAdapterFactory(
      {} as never,
      new ClaudeAdapter(),
      new CodexAdapter(),
      new OpencodeAdapter(),
      new AntigravityAdapter({ ensure: jest.fn() } as never),
      new CopilotAdapter({ ensure: jest.fn() } as never, { isAuthenticated: jest.fn() } as never),
    );
    readerFactory = new SessionReaderAdapterFactory();
    new SessionReaderModule(
      readerFactory,
      new ClaudeSessionReaderAdapter({} as never),
      new CodexSessionReaderAdapter({} as never),
      new OpenCodeSessionReaderAdapter({} as never),
      new AntigravitySessionReaderAdapter({} as never),
      new CopilotSessionReaderAdapter({} as never),
    ).onModuleInit();
  });

  it('has exactly the provider keys supported by the launch factory', () => {
    expect(Object.keys(PROVIDER_TRAITS).sort()).toEqual(
      launchFactory.getSupportedProviders().sort(),
    );
  });

  it.each(Object.keys(PROVIDER_TRAITS))(
    'exposes the same frozen traits for %s in either case',
    (name) => {
      const traits = providerTraits(name);

      expect(launchFactory.getAdapter(name).traits).toBe(traits);
      expect(providerTraits(name.toUpperCase())).toBe(traits);
      expect(Object.isFrozen(traits)).toBe(true);
      expect(Object.isFrozen(traits.draftClearKeys)).toBe(true);
    },
  );

  it('enables transcript turns exactly for reader adapters with turnState', () => {
    const turnProviders = readerFactory
      .getSupportedProviders()
      .filter((name) => typeof readerFactory.getAdapter(name)?.turnState === 'function');
    const traitTurnProviders = Object.entries(PROVIDER_TRAITS)
      .filter(([, traits]) => traits.transcriptTurns)
      .map(([name]) => name);

    expect(traitTurnProviders.sort()).toEqual(turnProviders.sort());
  });

  it.each([null, undefined, '', 'unknown', '__proto__', 'constructor', ' claude '])(
    'uses output defaults for %s',
    (name) => {
      expect(providerTraits(name)).toEqual({
        activity: 'output',
        transcriptTurns: false,
        draftClearKeys: [],
      });
    },
  );
});
