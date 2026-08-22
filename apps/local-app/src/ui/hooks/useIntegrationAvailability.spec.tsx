import { renderHook } from '@testing-library/react';
import { useIntegrationAvailability } from './useIntegrationAvailability';

const useRuntimeMock = jest.fn();
const useOptionalWorktreeTabMock = jest.fn();

jest.mock('./useRuntime', () => ({ useRuntime: () => useRuntimeMock() }));
jest.mock('./useWorktreeTab', () => ({
  useOptionalWorktreeTab: () => useOptionalWorktreeTabMock(),
}));

describe('useIntegrationAvailability', () => {
  beforeEach(() => {
    useRuntimeMock.mockReturnValue({
      runtimeInfo: { integrationAdmission: { allowed: true, reason: null } },
    });
    useOptionalWorktreeTabMock.mockReturnValue({ runtimeResolved: true, apiBase: '' });
  });

  it('allows integrations only after runtime resolution with capability and main apiBase', () => {
    expect(renderHook(() => useIntegrationAvailability()).result.current).toEqual({
      canUseIntegrations: true,
      runtimeResolved: true,
      reason: null,
    });
  });

  it.each([
    [false, '', true, 'resolving'],
    [true, '', false, 'runtime_disabled'],
    [true, '/wt/feature', true, 'worktree'],
  ] as const)(
    'fails closed for runtimeResolved=%s apiBase=%s capability=%s',
    (runtimeResolved, apiBase, allowed, reason) => {
      useRuntimeMock.mockReturnValue({
        runtimeInfo: {
          integrationAdmission: { allowed, reason: allowed ? null : 'child_runtime' },
        },
      });
      useOptionalWorktreeTabMock.mockReturnValue({ runtimeResolved, apiBase });

      expect(renderHook(() => useIntegrationAvailability()).result.current).toEqual({
        canUseIntegrations: false,
        runtimeResolved,
        reason,
      });
    },
  );
});
