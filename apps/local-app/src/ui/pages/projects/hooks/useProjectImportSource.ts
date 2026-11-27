import { useCallback, useMemo, useRef, useState } from 'react';
import type { ProjectTemplate } from '@/ui/pages/projects/lib/project-contracts';
import type { BackendId } from '@/ui/lib/api-transport';

export interface ProjectImportTarget {
  id: string;
  name: string;
  /** Instance that runs the import, fixed when the Import dialog opens. */
  backend: BackendId;
}

export function useProjectImportSource(templates?: ProjectTemplate[]) {
  const [isOpen, setIsOpen] = useState(false);
  const [target, setTarget] = useState<ProjectImportTarget | null>(null);
  const [selectedTemplateId, setSelectedTemplateId] = useState('');
  const [selectedVersion, setSelectedVersion] = useState('');
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const selectedTemplate = useMemo(
    () => templates?.find((template) => template.slug === selectedTemplateId),
    [selectedTemplateId, templates],
  );

  const sortedVersions = useMemo(() => {
    if (!selectedTemplate?.versions) return [];

    return [...selectedTemplate.versions].sort((left, right) => {
      const [leftMajor, leftMinor, leftPatch] = left.split('.').map(Number);
      const [rightMajor, rightMinor, rightPatch] = right.split('.').map(Number);

      if (rightMajor !== leftMajor) return rightMajor - leftMajor;
      if (rightMinor !== leftMinor) return rightMinor - leftMinor;
      return rightPatch - leftPatch;
    });
  }, [selectedTemplate?.versions]);

  const open = useCallback((nextTarget: ProjectImportTarget) => {
    setTarget(nextTarget);
    setSelectedTemplateId('');
    setSelectedVersion('');
    setIsOpen(true);
  }, []);

  const close = useCallback(() => {
    setIsOpen(false);
  }, []);

  const onOpenChange = useCallback(
    (openState: boolean) => {
      if (!openState) close();
    },
    [close],
  );

  const selectTemplate = useCallback(
    (slug: string) => {
      const template = templates?.find((candidate) => candidate.slug === slug);
      setSelectedTemplateId(slug);
      setSelectedVersion(template?.latestVersion ?? '');
    },
    [templates],
  );

  const openFilePicker = useCallback(() => {
    if (!fileInputRef.current) return;
    fileInputRef.current.value = '';
    fileInputRef.current.click();
  }, []);

  return {
    isOpen,
    target,
    selectedTemplateId,
    selectedVersion,
    selectedTemplateSource: selectedTemplate?.source,
    sortedVersions,
    fileInputRef,
    open,
    close,
    onOpenChange,
    selectTemplate,
    selectVersion: setSelectedVersion,
    openFilePicker,
  };
}
