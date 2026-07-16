import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryMetricsCard, formatMetricBytes } from './MemoryMetricsCard';
import { useDebugMetrics } from '@/ui/hooks/useDebugMetrics';

jest.mock('@/ui/hooks/useDebugMetrics');
const useDebugMetricsMock = useDebugMetrics as jest.MockedFunction<typeof useDebugMetrics>;

const data = {
  timestamp: '2026-07-12T10:00:00.000Z',
  process: {
    pid: 42,
    memory: {
      rss: 2 * 1024 * 1024,
      heapUsed: 1024,
      heapTotal: 2048,
      external: 512,
      arrayBuffers: 256,
    },
    eventLoopDelay: null,
    listeners: { SIGINT: 1, unhandledRejection: 0 },
  },
  caches: {
    parsed: { entries: 2, bytesEstimated: 1024, hits: 3, misses: 1, hitRate: 0.75 },
    aggregate: {
      entries: 2,
      bytesEstimated: 1024,
      hits: 3,
      misses: 1,
      hitRate: 0.75,
      providersFailed: 1,
    },
  },
  frameBuffers: { sessions: 1, totalFrames: 2, bytesEstimated: 512 },
  pty: { activeSessions: 3 },
  sockets: { connectedClients: 4 },
};

describe('MemoryMetricsCard', () => {
  it('formats byte values in binary units', () => {
    expect(formatMetricBytes(1536)).toBe('1.5 KiB');
    expect(formatMetricBytes(Number.NaN)).toBe('—');
  });

  it('renders metrics, failed-provider warning, deltas, and null event-loop delay', () => {
    useDebugMetricsMock.mockReturnValue({
      data,
      history: [
        {
          ...data,
          process: { ...data.process, memory: { ...data.process.memory, rss: 1024 * 1024 } },
        },
        data,
      ],
      isLoading: false,
      isRefetching: false,
      error: null,
      refetch: jest.fn(),
    } as ReturnType<typeof useDebugMetrics>);
    render(<MemoryMetricsCard />);
    expect(screen.getByText('Memory & Caches')).toBeInTheDocument();
    expect(screen.getByText('2.0 MiB')).toBeInTheDocument();
    expect(screen.getByText('1 provider failed')).toBeInTheDocument();
    expect(screen.getByText('+1.0 MiB since opened')).toBeInTheDocument();
    expect(screen.getByText('Event loop mean / p99').nextElementSibling).toHaveTextContent('—');
  });

  it('keeps the card visible with a retry affordance after endpoint failure', () => {
    const refetch = jest.fn();
    useDebugMetricsMock.mockReturnValue({
      data: undefined,
      history: [],
      isLoading: false,
      isRefetching: false,
      error: new Error('metrics failed'),
      refetch,
    } as ReturnType<typeof useDebugMetrics>);
    render(<MemoryMetricsCard />);
    expect(screen.getByText('Memory metrics unavailable')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });
});
