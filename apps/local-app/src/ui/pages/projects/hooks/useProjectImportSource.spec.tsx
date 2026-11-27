import { act, renderHook } from '@testing-library/react';
import type { ProjectTemplate } from '@/ui/pages/projects/lib/project-contracts';
import { useProjectImportSource } from './useProjectImportSource';

const templates: ProjectTemplate[] = [
  {
    slug: 'bundled-template',
    name: 'Bundled template',
    source: 'bundled',
    versions: null,
    latestVersion: null,
  },
  {
    slug: 'registry-template',
    name: 'Registry template',
    source: 'registry',
    versions: ['1.2.0', '2.0.0', '1.10.0'],
    latestVersion: '2.0.0',
  },
];

describe('useProjectImportSource', () => {
  it('owns target and resets the selected source whenever it opens', () => {
    const { result } = renderHook(() => useProjectImportSource(templates));

    act(() => result.current.open({ id: 'project-1', name: 'First project', backend: 'home' }));
    act(() => result.current.selectTemplate('registry-template'));

    expect(result.current.isOpen).toBe(true);
    expect(result.current.target).toEqual({
      id: 'project-1',
      name: 'First project',
      backend: 'home',
    });
    expect(result.current.selectedTemplateSource).toBe('registry');
    expect(result.current.selectedVersion).toBe('2.0.0');
    expect(result.current.sortedVersions).toEqual(['2.0.0', '1.10.0', '1.2.0']);

    act(() => result.current.open({ id: 'project-2', name: 'Second project', backend: 'home' }));

    expect(result.current.target).toEqual({
      id: 'project-2',
      name: 'Second project',
      backend: 'home',
    });
    expect(result.current.selectedTemplateId).toBe('');
    expect(result.current.selectedVersion).toBe('');
  });

  it('closes through either close action and opens the hidden file input from a clean value', () => {
    const { result } = renderHook(() => useProjectImportSource(templates));
    const click = jest.fn();
    const input = { value: 'previous.json', click } as unknown as HTMLInputElement;

    Object.defineProperty(result.current.fileInputRef, 'current', {
      configurable: true,
      value: input,
    });

    act(() => result.current.open({ id: 'project-1', name: 'Project', backend: 'home' }));
    act(() => result.current.openFilePicker());

    expect(input.value).toBe('');
    expect(click).toHaveBeenCalledTimes(1);

    act(() => result.current.onOpenChange(false));
    expect(result.current.isOpen).toBe(false);

    act(() => result.current.open({ id: 'project-2', name: 'Project 2', backend: 'home' }));
    act(() => result.current.close());
    expect(result.current.isOpen).toBe(false);
  });
});
