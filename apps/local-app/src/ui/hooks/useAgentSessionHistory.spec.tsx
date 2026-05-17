import { renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { useAgentSessionHistory } from './useAgentSessionHistory';

jest.mock('./useAgentSessionHistory', () => {
  const original = jest.requireActual('./useAgentSessionHistory');
  return original;
});

function createWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
}

describe('useAgentSessionHistory', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('resets to page 1 when agentId changes', () => {
    const wrapper = createWrapper();
    const { result, rerender } = renderHook(
      ({ agentId }: { agentId: string }) => useAgentSessionHistory(agentId, 'project-1'),
      { wrapper, initialProps: { agentId: 'agent-1' } },
    );

    expect(result.current.currentPage).toBe(1);

    rerender({ agentId: 'agent-2' });

    expect(result.current.currentPage).toBe(1);
  });

  it('resets to page 1 when projectId changes', () => {
    const wrapper = createWrapper();
    const { result, rerender } = renderHook(
      ({ projectId }: { projectId: string }) => useAgentSessionHistory('agent-1', projectId),
      { wrapper, initialProps: { projectId: 'project-1' } },
    );

    expect(result.current.currentPage).toBe(1);

    rerender({ projectId: 'project-2' });

    expect(result.current.currentPage).toBe(1);
  });
});
