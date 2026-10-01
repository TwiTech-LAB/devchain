import { renderHook } from '@testing-library/react';
import { useIntegrationAvailability } from './useIntegrationAvailability';

const useRuntimeMock = jest.fn();

jest.mock('./useRuntime', () => ({ useRuntime: () => useRuntimeMock() }));

describe('useIntegrationAvailability', () => {
  beforeEach(() => {
    useRuntimeMock.mockReturnValue({
      runtimeInfo: { integrationAdmission: { allowed: true, reason: null } },
      runtimeLoading: false,
    });
  });

  it('allows integrations only once the runtime has resolved with admission granted', () => {
    expect(renderHook(() => useIntegrationAvailability()).result.current).toEqual({
      canUseIntegrations: true,
      runtimeResolved: true,
      reason: null,
    });
  });

  it('reports resolving while the runtime info is still loading', () => {
    useRuntimeMock.mockReturnValue({ runtimeInfo: undefined, runtimeLoading: true });

    expect(renderHook(() => useIntegrationAvailability()).result.current).toEqual({
      canUseIntegrations: false,
      runtimeResolved: false,
      reason: 'resolving',
    });
  });

  it('fails closed as runtime_disabled when admission is denied', () => {
    useRuntimeMock.mockReturnValue({
      runtimeInfo: { integrationAdmission: { allowed: false, reason: 'child_runtime' } },
      runtimeLoading: false,
    });

    expect(renderHook(() => useIntegrationAvailability()).result.current).toEqual({
      canUseIntegrations: false,
      runtimeResolved: true,
      reason: 'runtime_disabled',
    });
  });

  it('fails closed as runtime_disabled when resolved runtime info is missing', () => {
    useRuntimeMock.mockReturnValue({ runtimeInfo: undefined, runtimeLoading: false });

    expect(renderHook(() => useIntegrationAvailability()).result.current).toEqual({
      canUseIntegrations: false,
      runtimeResolved: true,
      reason: 'runtime_disabled',
    });
  });
});
