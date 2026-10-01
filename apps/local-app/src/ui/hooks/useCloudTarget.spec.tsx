/** @jest-environment jsdom */

import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useCloudTarget } from './useCloudTarget';
import { CLOUD_TARGET_STORAGE_KEY } from '@/ui/lib/cloud-target';
import type { RemoteListItemDto } from '@/modules/remotes/dtos/remote.dto';

jest.mock('./useRemotes', () => ({
  useRemotes: () => ({ remotes: mockRemotes, remotesLoading: false }),
}));

let mockRemotes: RemoteListItemDto[];

function remote(id: string, name: string, online = true, versionMatches = true): RemoteListItemDto {
  return {
    id,
    name,
    baseUrl: `http://${id}:4000`,
    kind: 'address',
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    online,
    version: '1.0.0',
    versionMatches,
    stats: null,
    lastSeenAt: null,
  } as RemoteListItemDto;
}

function renderTarget() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return renderHook(() => useCloudTarget(), { wrapper });
}

describe('useCloudTarget', () => {
  beforeEach(() => {
    window.localStorage.clear();
    mockRemotes = [];
  });

  it('defaults to This PC and hides the selector without usable remotes', () => {
    mockRemotes = [remote('r-off', 'offline-vm', false), remote('r-old', 'old-vm', true, false)];

    const { result } = renderTarget();

    expect(result.current.backend).toBe('home');
    expect(result.current.remoteName).toBeNull();
    expect(result.current.eligible).toEqual([]);
    expect(result.current.selectorVisible).toBe(false);
  });

  it("offers only online, version-matching remotes that accept this PC's API key", () => {
    mockRemotes = [
      remote('r-1', 'lab-vm'),
      remote('r-off', 'offline-vm', false),
      remote('r-old', 'old-vm', true, false),
      { ...remote('r-key', 'key-vm'), apiKeyRejected: true },
    ];

    const { result } = renderTarget();

    expect(result.current.eligible.map((r) => r.id)).toEqual(['r-1']);
    expect(result.current.selectorVisible).toBe(true);
  });

  it('honors a persisted remote selection', () => {
    mockRemotes = [remote('r-1', 'lab-vm')];
    window.localStorage.setItem(
      CLOUD_TARGET_STORAGE_KEY,
      JSON.stringify({ backend: 'r-1', remoteName: 'stale-name' }),
    );

    const { result } = renderTarget();

    expect(result.current.backend).toBe('r-1');
    // The live remotes list is the name authority, not the persisted copy.
    expect(result.current.remoteName).toBe('lab-vm');
  });

  it('falls back to This PC when the selected remote goes offline', () => {
    mockRemotes = [remote('r-1', 'lab-vm')];
    window.localStorage.setItem(
      CLOUD_TARGET_STORAGE_KEY,
      JSON.stringify({ backend: 'r-1', remoteName: 'lab-vm' }),
    );

    const { result, rerender } = renderTarget();
    expect(result.current.backend).toBe('r-1');

    mockRemotes = [remote('r-1', 'lab-vm', false)];
    rerender();

    expect(result.current.backend).toBe('home');
    expect(result.current.remoteName).toBeNull();
  });

  it('selecting a remote persists id and name; This PC clears them', () => {
    mockRemotes = [remote('r-1', 'lab-vm')];
    const { result } = renderTarget();

    act(() => result.current.selectTarget('r-1'));
    expect(result.current.backend).toBe('r-1');
    expect(window.localStorage.getItem(CLOUD_TARGET_STORAGE_KEY)).toBe(
      JSON.stringify({ backend: 'r-1', remoteName: 'lab-vm' }),
    );

    act(() => result.current.selectTarget('home'));
    expect(window.localStorage.getItem(CLOUD_TARGET_STORAGE_KEY)).toBe(
      JSON.stringify({ backend: 'home', remoteName: null }),
    );
  });
});
