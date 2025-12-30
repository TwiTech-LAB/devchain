jest.mock('@multiavatar/multiavatar', () => {
  const actual: (
    seed: string,
    sansEnv?: boolean,
    version?: { part: string; theme: string },
  ) => string = jest.requireActual('@multiavatar/multiavatar');
  return {
    __esModule: true,
    default: jest.fn((seed: string, sansEnv?: boolean, version?: { part: string; theme: string }) =>
      actual(seed, sansEnv, version),
    ),
  };
});

import multiavatar from '@multiavatar/multiavatar';
import {
  AgentAvatarOptions,
  clearAvatarCache,
  getAgentAvatarAltText,
  getAgentAvatarDataUri,
  getAgentAvatarSvg,
  getAgentInitials,
} from './multiavatar';

const mockedMultiavatar = multiavatar as jest.MockedFunction<typeof multiavatar>;

describe('multiavatar helpers', () => {
  afterEach(() => {
    clearAvatarCache();
    mockedMultiavatar.mockClear();
  });

  it('returns null for empty or whitespace-only names', () => {
    expect(getAgentAvatarDataUri('')).toBeNull();
    expect(getAgentAvatarSvg('   ')).toBeNull();
    expect(getAgentAvatarDataUri(undefined)).toBeNull();
    expect(mockedMultiavatar).not.toHaveBeenCalled();
  });

  it('generates deterministic svg/data uri with caching', () => {
    const firstSvg = getAgentAvatarSvg('Ada Lovelace');
    const firstDataUri = getAgentAvatarDataUri('Ada Lovelace');

    expect(firstSvg).toBeTruthy();
    expect(firstDataUri).toBeTruthy();
    expect(firstDataUri?.startsWith('data:image/svg+xml;utf8,')).toBe(true);
    expect(mockedMultiavatar).toHaveBeenCalledTimes(1);

    const secondSvg = getAgentAvatarSvg('Ada Lovelace');
    const secondDataUri = getAgentAvatarDataUri('Ada Lovelace');
    expect(secondSvg).toEqual(firstSvg);
    expect(secondDataUri).toEqual(firstDataUri);
    // cache hit should not call the generator again
    expect(mockedMultiavatar).toHaveBeenCalledTimes(1);
  });

  it('supports optional style overrides', () => {
    const defaultAvatar = getAgentAvatarSvg('Memo Styles') ?? '';
    const sansBackground = getAgentAvatarSvg('Memo Styles', { omitBackground: true });

    expect(defaultAvatar).toBeTruthy();
    expect(sansBackground).toBeTruthy();
    expect(sansBackground).not.toEqual(defaultAvatar);
    // two distinct cache keys -> two renders
    expect(mockedMultiavatar).toHaveBeenCalledTimes(2);
  });

  it('uses overrides as part of cache key', () => {
    const options: AgentAvatarOptions = {
      omitBackground: true,
      version: { part: '01', theme: 'B' },
    };

    getAgentAvatarSvg('Cache Key', options);
    getAgentAvatarDataUri('Cache Key', options);
    expect(mockedMultiavatar).toHaveBeenCalledTimes(1);
  });

  it('provides accessible alt text and initials', () => {
    expect(getAgentAvatarAltText('Agent Smith')).toBe('Avatar for agent Agent Smith');
    expect(getAgentAvatarAltText('')).toBe('Agent avatar placeholder');
    expect(getAgentInitials('Agent Smith')).toBe('AS');
    expect(getAgentInitials('agent')).toBe('A');
    expect(getAgentInitials('')).toBe('??');
  });
});
