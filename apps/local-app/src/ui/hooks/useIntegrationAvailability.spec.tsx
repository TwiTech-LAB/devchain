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

  it.each([
    {
      label: 'allows integrations only once the runtime has resolved with admission granted',
      runtime: {
        runtimeInfo: { integrationAdmission: { allowed: true, reason: null } },
        runtimeLoading: false,
      },
      expected: {
        canUseIntegrations: true,
        runtimeResolved: true,
        reason: null,
      },
    },
    {
      label: 'reports resolving while the runtime info is still loading',
      runtime: { runtimeInfo: undefined, runtimeLoading: true },
      expected: {
        canUseIntegrations: false,
        runtimeResolved: false,
        reason: 'resolving',
      },
    },
    {
      label: 'fails closed as runtime_disabled when admission is denied',
      runtime: {
        runtimeInfo: { integrationAdmission: { allowed: false, reason: 'child_runtime' } },
        runtimeLoading: false,
      },
      expected: {
        canUseIntegrations: false,
        runtimeResolved: true,
        reason: 'runtime_disabled',
      },
    },
    {
      label: 'fails closed as runtime_disabled when resolved runtime info is missing',
      runtime: { runtimeInfo: undefined, runtimeLoading: false },
      expected: {
        canUseIntegrations: false,
        runtimeResolved: true,
        reason: 'runtime_disabled',
      },
    },
  ])('$label', ({ runtime, expected }) => {
    useRuntimeMock.mockReturnValue(runtime);
    expect(renderHook(() => useIntegrationAvailability()).result.current).toEqual(expected);
  });
});
