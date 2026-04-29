import { act, renderHook, waitFor } from '@testing-library/react';
import { useTemplateForm } from './useTemplateForm';

describe('useTemplateForm — handleTemplateFilePathChange', () => {
  const originalFetch = global.fetch;
  const setShowTemplateDialog = jest.fn();
  const validatePath = jest.fn(async () => ({ exists: false }));
  const toast = jest.fn();

  function mockStat(body: unknown, ok = true): jest.Mock {
    const fetchMock = jest.fn(
      async () => ({ ok, json: async () => body }) as Response,
    ) as jest.Mock;
    global.fetch = fetchMock as unknown as typeof fetch;
    return fetchMock;
  }

  afterEach(() => {
    global.fetch = originalFetch;
    jest.clearAllMocks();
  });

  it('marks an existing file as valid with no error', async () => {
    mockStat({ exists: true, isFile: true, isDirectory: false });

    const { result } = renderHook(() =>
      useTemplateForm({ templates: [], setShowTemplateDialog, validatePath, toast }),
    );

    await act(async () => {
      await result.current.handleTemplateFilePathChange('/abs/path/template.json');
    });

    await waitFor(() => expect(result.current.templateFilePathValidation.checked).toBe(true));
    expect(result.current.templateFilePathValidation).toMatchObject({
      isAbsolute: true,
      exists: true,
      isFile: true,
      error: undefined,
    });
  });

  it('reports "Path must be a file, not a directory" for an existing directory', async () => {
    mockStat({ exists: true, isFile: false, isDirectory: true });

    const { result } = renderHook(() =>
      useTemplateForm({ templates: [], setShowTemplateDialog, validatePath, toast }),
    );

    await act(async () => {
      await result.current.handleTemplateFilePathChange('/abs/path/somedir');
    });

    await waitFor(() => expect(result.current.templateFilePathValidation.checked).toBe(true));
    expect(result.current.templateFilePathValidation).toMatchObject({
      isAbsolute: true,
      exists: true,
      isFile: false,
      error: 'Path must be a file, not a directory',
    });
  });

  it('reports "File does not exist" when stat returns exists: false', async () => {
    mockStat({ exists: false });

    const { result } = renderHook(() =>
      useTemplateForm({ templates: [], setShowTemplateDialog, validatePath, toast }),
    );

    await act(async () => {
      await result.current.handleTemplateFilePathChange('/abs/path/missing.json');
    });

    await waitFor(() => expect(result.current.templateFilePathValidation.checked).toBe(true));
    expect(result.current.templateFilePathValidation).toMatchObject({
      isAbsolute: true,
      exists: false,
      isFile: false,
      error: 'File does not exist',
    });
  });

  it('rejects relative paths without hitting the network', async () => {
    const fetchMock = mockStat({ exists: true, isFile: true });

    const { result } = renderHook(() =>
      useTemplateForm({ templates: [], setShowTemplateDialog, validatePath, toast }),
    );

    await act(async () => {
      await result.current.handleTemplateFilePathChange('relative/path.json');
    });

    expect(result.current.templateFilePathValidation).toMatchObject({
      isAbsolute: false,
      checked: true,
      error: 'Path must be absolute (start with / or drive letter)',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
