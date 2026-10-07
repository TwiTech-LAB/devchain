import { renderHook, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { useSubNavSearchParam } from './useSubNavSearchParam';

const KEYS = ['alpha', 'beta', 'gamma'] as const;
type Key = (typeof KEYS)[number];

function wrapper(initialEntries: string[]) {
  return ({ children }: { children: React.ReactNode }) => (
    <MemoryRouter initialEntries={initialEntries}>{children}</MemoryRouter>
  );
}

describe('useSubNavSearchParam', () => {
  it.each([
    { label: 'returns defaultKey when param is absent', path: '/page', expectedKey: 'alpha' },
    { label: 'returns the param value when valid', path: '/page?tab=beta', expectedKey: 'beta' },
    {
      label: 'falls back to defaultKey for invalid param value',
      path: '/page?tab=bogus',
      expectedKey: 'alpha',
    },
  ] as const)('$label', ({ path, expectedKey }) => {
    const { result } = renderHook(() => useSubNavSearchParam<Key>([...KEYS], 'alpha', 'tab'), {
      wrapper: wrapper([path]),
    });
    expect(result.current[0]).toBe(expectedKey);
  });

  it('updates URL when setActiveKey is called', () => {
    const { result } = renderHook(() => useSubNavSearchParam<Key>([...KEYS], 'alpha', 'tab'), {
      wrapper: wrapper(['/page?tab=alpha']),
    });

    act(() => {
      result.current[1]('gamma');
    });

    expect(result.current[0]).toBe('gamma');
  });
});
