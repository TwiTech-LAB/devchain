import { useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { FamilyAlternative } from '@/ui/components/project/ProviderMappingModal';

type ToastFn = (args: { title: string; description: string; variant?: 'destructive' }) => void;

export interface ImportTemplateOption {
  slug: string;
  source: 'bundled' | 'registry' | 'file';
  versions: string[] | null;
  latestVersion: string | null;
}

export interface ImportTarget {
  id: string;
  name: string;
}

export interface ProviderMappingRequired {
  missingProviders: string[];
  familyAlternatives: FamilyAlternative[];
  canImport: boolean;
}

export interface ImportDryRunResult {
  dryRun: true;
  missingProviders: string[];
  unmatchedStatuses?: Array<{ id: string; label: string; color: string; epicCount: number }>;
  templateStatuses?: Array<{ label: string; color: string }>;
  counts: { toImport: Record<string, number>; toDelete: Record<string, number> };
  providerMappingRequired?: ProviderMappingRequired;
}

export interface ImportResult {
  success: boolean;
  counts: { imported: Record<string, number>; deleted: Record<string, number> };
  mappings: Record<string, Record<string, string>>;
  initialPromptSet?: boolean;
  message?: string;
}

interface UseProjectImportArgs {
  templates?: ImportTemplateOption[];
  setShowImportModal: (open: boolean) => void;
  toast: ToastFn;
}

interface UseProjectImportResult {
  importingProjectId: string | null;
  importTarget: ImportTarget | null;
  dryRunResult: ImportDryRunResult | null;
  showMissingProviders: boolean;
  setShowMissingProviders: React.Dispatch<React.SetStateAction<boolean>>;
  showImportConfirm: boolean;
  setShowImportConfirm: React.Dispatch<React.SetStateAction<boolean>>;
  showImportResult: boolean;
  setShowImportResult: React.Dispatch<React.SetStateAction<boolean>>;
  importResult: ImportResult | null;
  statusMappings: Record<string, string>;
  setStatusMappings: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  selectedTemplateId: string;
  selectedImportVersion: string;
  setSelectedImportVersion: React.Dispatch<React.SetStateAction<string>>;
  selectedImportTemplateSource: 'bundled' | 'registry' | 'file' | undefined;
  sortedImportVersions: string[];
  fileInputRef: React.RefObject<HTMLInputElement>;
  showImportProviderMappingModal: boolean;
  importProviderMappingData: ProviderMappingRequired | null;
  startImport: (project: ImportTarget) => void;
  handleImportFromFile: () => void;
  handleImportFromTemplate: () => Promise<void>;
  onFileSelected: React.ChangeEventHandler<HTMLInputElement>;
  confirmImport: () => Promise<void>;
  handleImportTemplateChange: (slug: string) => void;
  handleImportProviderMappingConfirm: (mappings: Record<string, string>) => void;
  handleImportProviderMappingCancel: () => void;
}

export function useProjectImport({
  templates,
  setShowImportModal,
  toast,
}: UseProjectImportArgs): UseProjectImportResult {
  const queryClient = useQueryClient();
  const [importingProjectId, setImportingProjectId] = useState<string | null>(null);
  const [importTarget, setImportTarget] = useState<ImportTarget | null>(null);
  const [importPayload, setImportPayload] = useState<unknown | null>(null);
  const [dryRunResult, setDryRunResult] = useState<ImportDryRunResult | null>(null);
  const [statusMappings, setStatusMappings] = useState<Record<string, string>>({});
  const [showMissingProviders, setShowMissingProviders] = useState(false);
  const [showImportConfirm, setShowImportConfirm] = useState(false);
  const [showImportResult, setShowImportResult] = useState(false);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>('');
  const [selectedImportVersion, setSelectedImportVersion] = useState<string>('');
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [showImportProviderMappingModal, setShowImportProviderMappingModal] = useState(false);
  const [importProviderMappingData, setImportProviderMappingData] =
    useState<ProviderMappingRequired | null>(null);
  const [importFamilyProviderMappings, setImportFamilyProviderMappings] = useState<Record<
    string,
    string
  > | null>(null);

  const selectedImportTemplate = useMemo(() => {
    return templates?.find((t) => t.slug === selectedTemplateId);
  }, [templates, selectedTemplateId]);

  const sortedImportVersions = useMemo(() => {
    if (!selectedImportTemplate?.versions) return [];
    return [...selectedImportTemplate.versions].sort((a, b) => {
      const parseVersion = (v: string) => v.split('.').map(Number);
      const [aMajor, aMinor, aPatch] = parseVersion(a);
      const [bMajor, bMinor, bPatch] = parseVersion(b);
      if (bMajor !== aMajor) return bMajor - aMajor;
      if (bMinor !== aMinor) return bMinor - aMinor;
      return bPatch - aPatch;
    });
  }, [selectedImportTemplate?.versions]);

  const handleImportTemplateChange = (slug: string) => {
    const template = templates?.find((t) => t.slug === slug);
    setSelectedTemplateId(slug);
    setSelectedImportVersion(template?.latestVersion || '');
  };

  const startImport = (project: ImportTarget) => {
    setImportTarget(project);
    setDryRunResult(null);
    setImportResult(null);
    setImportPayload(null);
    setStatusMappings({});
    setSelectedTemplateId('');
    setSelectedImportVersion('');
    setImportProviderMappingData(null);
    setImportFamilyProviderMappings(null);
    setShowImportProviderMappingModal(false);
    setShowImportConfirm(false);
    setShowMissingProviders(false);
    setShowImportModal(true);
  };

  const handleImportFromFile = () => {
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
      fileInputRef.current.click();
    }
  };

  const applyDryRunResponse = (body: ImportDryRunResult) => {
    setDryRunResult(body);
    if (body.providerMappingRequired) {
      setImportProviderMappingData(body.providerMappingRequired);
      setShowImportProviderMappingModal(true);
    } else if (Array.isArray(body.missingProviders) && body.missingProviders.length > 0) {
      setShowMissingProviders(true);
    } else {
      setShowImportConfirm(true);
    }
  };

  const handleImportFromTemplate = async () => {
    if (!selectedTemplateId || !importTarget) return;
    try {
      setImportingProjectId(importTarget.id);
      setShowImportModal(false);
      const templateUrl =
        selectedImportTemplate?.source === 'registry' && selectedImportVersion
          ? `/api/templates/${selectedTemplateId}/versions/${selectedImportVersion}`
          : `/api/templates/${selectedTemplateId}`;
      const res = await fetch(templateUrl);
      if (!res.ok) {
        throw new Error('Failed to fetch template');
      }
      const json = await res.json();
      const content = json.content;
      setImportPayload(content);
      const dryRes = await fetch(`/api/projects/${importTarget.id}/import?dryRun=true`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(content),
      });
      if (!dryRes.ok) {
        const error = await dryRes.json().catch(() => ({}));
        throw new Error(error.message || 'Precheck failed');
      }
      const body = await dryRes.json();
      applyDryRunResponse(body);
    } catch (error) {
      toast({
        title: 'Import precheck failed',
        description: error instanceof Error ? error.message : 'Unable to load template',
        variant: 'destructive',
      });
      setImportTarget(null);
      setImportPayload(null);
    } finally {
      setImportingProjectId(null);
    }
  };

  const onFileSelected: React.ChangeEventHandler<HTMLInputElement> = async (event) => {
    const file = event.target.files?.[0];
    if (!file || !importTarget) return;
    try {
      setShowImportModal(false);
      setImportingProjectId(importTarget.id);
      const text = await file.text();
      const json = JSON.parse(text);
      setImportPayload(json);
      const res = await fetch(`/api/projects/${importTarget.id}/import?dryRun=true`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(json),
      });
      if (!res.ok) {
        const error = await res.json().catch(() => ({}));
        throw new Error(error.message || 'Precheck failed');
      }
      const body = await res.json();
      applyDryRunResponse(body);
    } catch (error) {
      toast({
        title: 'Import precheck failed',
        description: error instanceof Error ? error.message : 'Unable to read/validate JSON',
        variant: 'destructive',
      });
      setImportTarget(null);
      setImportPayload(null);
    } finally {
      setImportingProjectId(null);
    }
  };

  const confirmImport = async () => {
    if (!importTarget || !importPayload) return;
    try {
      setImportingProjectId(importTarget.id);
      let requestBody = importPayload;
      if (Object.keys(statusMappings).length > 0 || importFamilyProviderMappings) {
        requestBody = {
          ...(importPayload as object),
          ...(Object.keys(statusMappings).length > 0 && { statusMappings }),
          ...(importFamilyProviderMappings && {
            familyProviderMappings: importFamilyProviderMappings,
          }),
        };
      }
      const res = await fetch(`/api/projects/${importTarget.id}/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
      });

      if (!res.ok) {
        let errorMessage = 'Import failed';
        try {
          const errorBody = await res.json();
          errorMessage = errorBody.message || errorMessage;
        } catch {
          errorMessage = `Import failed with status ${res.status}`;
        }
        throw new Error(errorMessage);
      }

      const body = await res.json();
      setImportResult(body);
      setShowImportConfirm(false);
      setShowImportResult(true);
      setStatusMappings({});
      setImportFamilyProviderMappings(null);
      toast({ title: 'Import complete', description: body.message || 'Project replaced.' });
      queryClient.invalidateQueries({ queryKey: ['projects'] });
    } catch (error) {
      setShowImportConfirm(false);
      setStatusMappings({});
      setImportFamilyProviderMappings(null);
      toast({
        title: 'Import failed',
        description: error instanceof Error ? error.message : 'Unable to import project',
        variant: 'destructive',
      });
    } finally {
      setImportingProjectId(null);
    }
  };

  const handleImportProviderMappingConfirm = (mappings: Record<string, string>) => {
    setImportFamilyProviderMappings(mappings);
    setShowImportProviderMappingModal(false);
    setImportProviderMappingData(null);
    setShowImportConfirm(true);
  };

  const handleImportProviderMappingCancel = () => {
    setShowImportProviderMappingModal(false);
    setImportProviderMappingData(null);
    setImportFamilyProviderMappings(null);
    setShowImportModal(true);
  };

  return {
    importingProjectId,
    importTarget,
    dryRunResult,
    showMissingProviders,
    setShowMissingProviders,
    showImportConfirm,
    setShowImportConfirm,
    showImportResult,
    setShowImportResult,
    importResult,
    statusMappings,
    setStatusMappings,
    selectedTemplateId,
    selectedImportVersion,
    setSelectedImportVersion,
    selectedImportTemplateSource: selectedImportTemplate?.source,
    sortedImportVersions,
    fileInputRef,
    showImportProviderMappingModal,
    importProviderMappingData,
    startImport,
    handleImportFromFile,
    handleImportFromTemplate,
    onFileSelected,
    confirmImport,
    handleImportTemplateChange,
    handleImportProviderMappingConfirm,
    handleImportProviderMappingCancel,
  };
}
