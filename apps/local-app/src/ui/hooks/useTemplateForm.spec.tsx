import { act, renderHook, waitFor } from '@testing-library/react';
import { useTemplateForm } from './useTemplateForm';
import { InMemoryProjectsPageApi } from '../../../test/helpers/in-memory-projects-page-api';

describe('useTemplateForm — handleTemplateFilePathChange', () => {
  const setShowTemplateDialog = jest.fn();
  const toast = jest.fn();

  function renderForm(api: InMemoryProjectsPageApi) {
    return renderHook(() => useTemplateForm({ templates: [], setShowTemplateDialog, api, toast }));
  }

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('marks an existing file as valid with no error', async () => {
    const api = new InMemoryProjectsPageApi({
      pathStats: { '/abs/path/template.json': { exists: true, isFile: true } },
    });
    const { result } = renderForm(api);

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
    expect(api.calls.statPath).toEqual([['/abs/path/template.json']]);
  });

  it('reports "Path must be a file, not a directory" for an existing directory', async () => {
    const api = new InMemoryProjectsPageApi({
      pathStats: { '/abs/path/somedir': { exists: true, isFile: false } },
    });
    const { result } = renderForm(api);

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
    const api = new InMemoryProjectsPageApi();
    const { result } = renderForm(api);

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
    const api = new InMemoryProjectsPageApi();
    const { result } = renderForm(api);

    await act(async () => {
      await result.current.handleTemplateFilePathChange('relative/path.json');
    });

    expect(result.current.templateFilePathValidation).toMatchObject({
      isAbsolute: false,
      checked: true,
      error: 'Path must be absolute (start with / or drive letter)',
    });
    expect(api.calls.statPath).toHaveLength(0);
  });

  it('keeps root-path validation fail-soft when stat rejects', async () => {
    const api = new InMemoryProjectsPageApi({
      overrides: { statPath: new Error('offline') },
    });
    const { result } = renderForm(api);

    await act(async () => {
      await result.current.handleTemplatePathChange('/abs/project');
    });

    expect(result.current.templatePathValidation).toEqual({
      isAbsolute: true,
      exists: false,
      checked: true,
    });
  });

  it('honors an explicit absent result for root-path validation', async () => {
    const api = new InMemoryProjectsPageApi({
      pathStats: { '/abs/missing-project': { exists: false, isFile: false } },
    });
    const { result } = renderForm(api);

    await act(async () => {
      await result.current.handleTemplatePathChange('/abs/missing-project');
    });

    expect(result.current.templatePathValidation).toEqual({
      isAbsolute: true,
      exists: false,
      checked: true,
    });
  });

  it('uses the template-file rejection copy when stat rejects', async () => {
    const api = new InMemoryProjectsPageApi({
      overrides: { statPath: new Error('offline') },
    });
    const { result } = renderForm(api);

    await act(async () => {
      await result.current.handleTemplateFilePathChange('/abs/template.json');
    });

    expect(result.current.templateFilePathValidation.error).toBe('Failed to validate path');
  });

  it('ignores a stale template-file stat result', async () => {
    let resolveOld: ((result: { exists: boolean; isFile: boolean }) => void) | undefined;
    const oldResult = new Promise<{ exists: boolean; isFile: boolean }>((resolve) => {
      resolveOld = resolve;
    });
    const api = new InMemoryProjectsPageApi({
      overrides: {
        statPath: (path) => (path === '/abs/old.json' ? oldResult : { exists: true, isFile: true }),
      },
    });
    const { result } = renderForm(api);
    let oldRequest = Promise.resolve();

    act(() => {
      oldRequest = result.current.handleTemplateFilePathChange('/abs/old.json');
    });
    await act(async () => {
      await result.current.handleTemplateFilePathChange('/abs/current.json');
    });
    await act(async () => {
      resolveOld?.({ exists: false, isFile: false });
      await oldRequest;
    });

    expect(result.current.templateFormData.templatePath).toBe('/abs/current.json');
    expect(result.current.templateFilePathValidation).toMatchObject({
      exists: true,
      isFile: true,
      error: undefined,
    });
  });
});

describe('useTemplateForm — name from the project folder', () => {
  type Step = { folder: string } | { name: string };

  it.each<[string, Step[], string]>([
    [
      'takes the last segment and drops a trailing slash',
      [{ folder: '/home/me/code/checkout-service/' }],
      'checkout-service',
    ],
    ['supports backslash separators', [{ folder: 'C:\\work\\shop\\' }], 'shop'],
    [
      'follows later folder changes while automatic',
      [{ folder: '/a/one' }, { folder: '/a/two' }],
      'two',
    ],
    [
      'keeps a typed name when the folder changes',
      [{ folder: '/a/one' }, { name: 'Mine' }, { folder: '/a/two' }],
      'Mine',
    ],
    ['keeps a typed name when the folder is cleared', [{ name: 'Mine' }, { folder: '' }], 'Mine'],
  ])('%s', async (_case, steps, expectedName) => {
    const api = new InMemoryProjectsPageApi();
    const { result } = renderHook(() =>
      useTemplateForm({ templates: [], setShowTemplateDialog: jest.fn(), api, toast: jest.fn() }),
    );
    for (const step of steps) {
      await act(async () => {
        if ('folder' in step) await result.current.handleTemplatePathChange(step.folder);
        else result.current.handleNameChange(step.name);
      });
    }
    expect(result.current.templateFormData.name).toBe(expectedName);
  });
});
