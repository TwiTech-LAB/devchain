/** @jest-environment jsdom */

import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { useProjectImport } from './useProjectImport';
import type { ImportTemplateOption } from './useProjectImport';

const originalFetch = global.fetch;

function makeFetch(body: unknown, ok = true): jest.Mock {
  return jest.fn(async () => ({ ok, json: async () => body }) as Response) as jest.Mock;
}

const templates: ImportTemplateOption[] = [
  { slug: 'team-tpl', source: 'bundled', versions: null, latestVersion: null },
  { slug: 'plain-tpl', source: 'bundled', versions: null, latestVersion: null },
];

const importTarget = { id: 'proj-1', name: 'Test Project' };

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

function renderImportHook() {
  const setShowImportModal = jest.fn();
  const toast = jest.fn();
  const { result } = renderHook(() => useProjectImport({ templates, setShowImportModal, toast }), {
    wrapper,
  });
  return { result, setShowImportModal, toast };
}

afterEach(() => {
  global.fetch = originalFetch;
  jest.clearAllMocks();
});

describe('useProjectImport — preconfig dialog flow', () => {
  it('opens preconfig dialog when template has configurable teams', async () => {
    const content = {
      teams: [{ name: 'Backend', maxMembers: 3, allowTeamLeadCreateAgents: true }],
      profiles: [{ name: 'dev' }],
    };
    global.fetch = makeFetch({ content });

    const { result, setShowImportModal } = renderImportHook();

    act(() => {
      result.current.startImport(importTarget);
    });
    act(() => {
      result.current.handleImportTemplateChange('team-tpl');
    });
    await act(async () => {
      await result.current.handleImportFromTemplate();
    });

    expect(result.current.preconfigOpen).toBe(true);
    expect(result.current.preconfigTeams).toHaveLength(1);
    expect(result.current.preconfigTeams[0]).toMatchObject({ name: 'Backend' });
    expect(result.current.preconfigProfiles).toHaveLength(1);
    // dry-run should NOT have been called yet (only the template fetch)
    expect(setShowImportModal).toHaveBeenCalledWith(false);
  });

  it('skips preconfig dialog and goes to dry-run for no-teams template', async () => {
    const content = { epics: [] };
    const dryRunBody = {
      dryRun: true,
      missingProviders: [],
      counts: { toImport: {}, toDelete: {} },
    };
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ content }) } as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => dryRunBody } as Response) as jest.Mock;

    const { result } = renderImportHook();

    act(() => {
      result.current.startImport(importTarget);
    });
    act(() => {
      result.current.handleImportTemplateChange('plain-tpl');
    });
    await act(async () => {
      await result.current.handleImportFromTemplate();
    });

    expect(result.current.preconfigOpen).toBe(false);
    expect(result.current.showImportConfirm).toBe(true);
  });

  it('cancel clears preconfig state', async () => {
    const content = {
      teams: [{ name: 'Ops', maxMembers: 2, allowTeamLeadCreateAgents: true }],
      profiles: [],
    };
    global.fetch = makeFetch({ content });

    const { result } = renderImportHook();

    act(() => result.current.startImport(importTarget));
    act(() => result.current.handleImportTemplateChange('team-tpl'));
    await act(async () => {
      await result.current.handleImportFromTemplate();
    });

    expect(result.current.preconfigOpen).toBe(true);

    act(() => {
      result.current.handlePreconfigCancel();
    });

    expect(result.current.preconfigOpen).toBe(false);
    expect(result.current.preconfigTeams).toHaveLength(0);
    expect(result.current.preconfigProfiles).toHaveLength(0);
  });

  it('confirm forwards overrides to dry-run and proceeds to import confirm', async () => {
    const content = {
      teams: [{ name: 'Alpha', maxMembers: 3, allowTeamLeadCreateAgents: true }],
      profiles: [],
    };
    const dryRunBody = {
      dryRun: true,
      missingProviders: [],
      counts: { toImport: {}, toDelete: {} },
    };
    const overrides = [{ teamName: 'Alpha', maxMembers: 5 }];

    global.fetch = jest
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ content }) } as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => dryRunBody } as Response) as jest.Mock;

    const { result } = renderImportHook();

    act(() => result.current.startImport(importTarget));
    act(() => result.current.handleImportTemplateChange('team-tpl'));
    await act(async () => {
      await result.current.handleImportFromTemplate();
    });

    expect(result.current.preconfigOpen).toBe(true);

    await act(async () => {
      await result.current.handlePreconfigConfirm(overrides as never);
    });

    await waitFor(() => expect(result.current.showImportConfirm).toBe(true));
    expect(result.current.preconfigOpen).toBe(false);

    const dryRunCall = (global.fetch as jest.Mock).mock.calls[1];
    const dryRunBody2 = JSON.parse(dryRunCall[1].body as string);
    expect(dryRunBody2.teamOverrides).toEqual(overrides);
  });

  it('confirmImport includes teamOverrides in request body', async () => {
    const content = {
      teams: [{ name: 'Gamma', maxMembers: 2, allowTeamLeadCreateAgents: true }],
      profiles: [],
    };
    const dryRunBody = {
      dryRun: true,
      missingProviders: [],
      counts: { toImport: {}, toDelete: {} },
    };
    const importResultBody = {
      success: true,
      counts: { imported: {}, deleted: {} },
      mappings: {},
      message: 'Done',
    };
    const overrides = [{ teamName: 'Gamma', maxMembers: 4 }];

    global.fetch = jest
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ content }) } as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => dryRunBody } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => importResultBody,
      } as Response) as jest.Mock;

    const { result } = renderImportHook();

    act(() => result.current.startImport(importTarget));
    act(() => result.current.handleImportTemplateChange('team-tpl'));
    await act(async () => {
      await result.current.handleImportFromTemplate();
    });
    await act(async () => {
      await result.current.handlePreconfigConfirm(overrides as never);
    });
    await waitFor(() => expect(result.current.showImportConfirm).toBe(true));

    await act(async () => {
      await result.current.confirmImport();
    });

    const importCall = (global.fetch as jest.Mock).mock.calls[2];
    const importBody = JSON.parse(importCall[1].body as string);
    expect(importBody.teamOverrides).toEqual(overrides);
    expect(result.current.showImportResult).toBe(true);
  });

  it('skips preconfig dialog when all teams have allowTeamLeadCreateAgents: false or unset', async () => {
    // Template has teams, but none are configurable — dialog should not open.
    const content = {
      teams: [
        { name: 'ReadOnly', maxMembers: 2, allowTeamLeadCreateAgents: false },
        { name: 'NoFlag', maxMembers: 1 },
      ],
    };
    const dryRunBody = {
      dryRun: true,
      missingProviders: [],
      counts: { toImport: {}, toDelete: {} },
    };
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ content }) } as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => dryRunBody } as Response) as jest.Mock;

    const { result } = renderImportHook();

    act(() => result.current.startImport(importTarget));
    act(() => result.current.handleImportTemplateChange('team-tpl'));
    await act(async () => {
      await result.current.handleImportFromTemplate();
    });

    expect(result.current.preconfigOpen).toBe(false);
    expect(result.current.showImportConfirm).toBe(true);
  });

  it('opens preconfig dialog from the file-picker path when JSON has configurable teams', async () => {
    const fileContent = {
      teams: [{ name: 'Backend', maxMembers: 3, allowTeamLeadCreateAgents: true }],
      profiles: [{ name: 'dev' }],
    };
    global.fetch = jest.fn() as jest.Mock;

    const { result } = renderImportHook();

    act(() => result.current.startImport(importTarget));

    const file = {
      name: 'team-template.json',
      text: jest.fn(async () => JSON.stringify(fileContent)),
    } as unknown as File;
    const event = {
      target: { files: [file] },
    } as unknown as React.ChangeEvent<HTMLInputElement>;

    await act(async () => {
      await result.current.onFileSelected(event);
    });

    expect(result.current.preconfigOpen).toBe(true);
    expect(result.current.preconfigTeams).toHaveLength(1);
    expect(result.current.preconfigTeams[0]).toMatchObject({ name: 'Backend' });
    expect(result.current.preconfigProfiles).toHaveLength(1);
    // Dry-run must NOT have been called yet — preconfig blocks it.
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('file-picker path falls through to dry-run when JSON has no configurable teams', async () => {
    const fileContent = { epics: [] };
    const dryRunBody = {
      dryRun: true,
      missingProviders: [],
      counts: { toImport: {}, toDelete: {} },
    };
    global.fetch = jest.fn(
      async () => ({ ok: true, json: async () => dryRunBody }) as Response,
    ) as jest.Mock;

    const { result } = renderImportHook();

    act(() => result.current.startImport(importTarget));

    const file = {
      name: 'plain.json',
      text: jest.fn(async () => JSON.stringify(fileContent)),
    } as unknown as File;
    const event = {
      target: { files: [file] },
    } as unknown as React.ChangeEvent<HTMLInputElement>;

    await act(async () => {
      await result.current.onFileSelected(event);
    });

    expect(result.current.preconfigOpen).toBe(false);
    expect(result.current.showImportConfirm).toBe(true);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});
