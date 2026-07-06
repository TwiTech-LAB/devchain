import { type ChangeEventHandler, useCallback, useState } from 'react';
import { DeleteProjectDialog } from '@/ui/components/project/DeleteProjectDialog';
import { ImportResultDialog } from '@/ui/components/project/ImportResultDialog';
import { UpgradeDialog } from '@/ui/components/project/UpgradeDialog';
import { ExportDialog } from '@/ui/components/project/ExportDialog';
import { ProjectConfigurationModal } from '@/ui/components/project/ProjectConfigurationModal';
import { EditProjectDialog } from '@/ui/components/project/EditProjectDialog';
import { ImportSourceModal } from '@/ui/components/project/ImportSourceModal';
import { CreateProjectDialog } from '@/ui/components/project/CreateProjectDialog';
import { ProviderMappingModal } from '@/ui/components/project/ProviderMappingModal';
import { ProviderMismatchWarningModal } from '@/ui/components/project/ProviderMismatchWarningModal';
import { ProjectSetupWizard } from '@/ui/components/project/ProjectSetupWizard';
import { useCreateProjectWizard } from '@/ui/hooks/useCreateProjectWizard';
import { useImportProjectWizard, type ImportResult } from '@/ui/hooks/useImportProjectWizard';
import { useToast } from '@/ui/hooks/use-toast';
import type { SetupPreviewRequest } from '@/ui/pages/projects/lib/project-api';
import type { ProjectsPageController } from '@/ui/hooks/useProjectsPageController';

interface ProjectsDialogsProps {
  controller: ProjectsPageController;
}

export function ProjectsDialogs({ controller }: ProjectsDialogsProps) {
  const {
    showDialog,
    setShowDialog,
    formData,
    setFormData,
    pathValidation,
    handlePathChange,
    handleSubmit,
    resetForm,
    updateMutation,
    deleteConfirm,
    setDeleteConfirm,
    confirmDelete,
    deleteMutation,
    fileInputRef,
    showImportModal,
    setShowImportModal,
    importTarget,
    selectedTemplateId,
    handleImportTemplateChange,
    templates,
    selectedImportTemplateSource,
    sortedImportVersions,
    selectedImportVersion,
    setSelectedImportVersion,
    handleImportFromFile,
    showTemplateDialog,
    setShowTemplateDialog,
    handleTemplateSubmit,
    templateSourceTab,
    setTemplateSourceTab,
    templateFormData,
    setTemplateFormData,
    selectedTemplate,
    sortedVersions,
    handleTemplateChange,
    handleTemplatePathChange,
    handleTemplateFilePathChange,
    templatePathValidation,
    templateFilePathValidation,
    resetTemplateForm,
    createFromTemplateMutation,
    upgradeTarget,
    handleCloseUpgradeDialog,
    exportTarget,
    isLoadingExportManifest,
    exportManifest,
    handleCloseExportDialog,
    configureTarget,
    setConfigureTarget,
    providerMappingData,
    showProviderMappingModal,
    handleProviderMappingCancel,
    handleProviderMappingConfirm,
    showProviderWarningModal,
    providerWarnings,
    handleWarningModalNavigate,
  } = controller;

  const { toast } = useToast();

  // Create flow: the setup wizard replaces the legacy single-step team-preconfig sequencing.
  // Nothing is created until the wizard's final Create (one atomic mutation).
  const createWizard = useCreateProjectWizard(createFromTemplateMutation);

  // Import flow: the SAME wizard (Providers → Agents → Teams → Review) replaces the legacy
  // MissingProviders / ProviderMapping / ImportConfirm / TeamPreconfig dialog chain. The destructive
  // commit fires only from the wizard's final Review step. The result lands here for the result dialog.
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const importWizard = useImportProjectWizard({
    onImported: setImportResult,
    toast,
  });

  // Source pick → open the import wizard. Template imports resolve via slug/version; file imports read
  // the JSON and pass it as setup-preview `rawContent` (Task 1's file mode).
  const startImportFromTemplate = useCallback(() => {
    if (!importTarget || !selectedTemplateId) return;
    const request: SetupPreviewRequest = {
      slug: selectedTemplateId,
      ...(selectedImportTemplateSource === 'registry' && selectedImportVersion
        ? { version: selectedImportVersion }
        : {}),
    };
    setShowImportModal(false);
    importWizard.openImportWizard(importTarget, request);
  }, [
    importTarget,
    selectedTemplateId,
    selectedImportTemplateSource,
    selectedImportVersion,
    setShowImportModal,
    importWizard,
  ]);

  const onImportFileSelected: ChangeEventHandler<HTMLInputElement> = useCallback(
    async (event) => {
      const file = event.target.files?.[0];
      if (!file || !importTarget) return;
      setShowImportModal(false);
      try {
        const rawContent = JSON.parse(await file.text());
        importWizard.openImportWizard(importTarget, { rawContent });
      } catch {
        toast({
          title: 'Import failed',
          description: 'Unable to read or parse the selected JSON file.',
          variant: 'destructive',
        });
      }
    },
    [importTarget, setShowImportModal, importWizard, toast],
  );

  return (
    <>
      {/* Edit Project Dialog */}
      <EditProjectDialog
        open={showDialog}
        onOpenChange={setShowDialog}
        formData={formData}
        setFormData={setFormData}
        pathValidation={pathValidation}
        onPathChange={handlePathChange}
        onSubmit={handleSubmit}
        onCancel={() => {
          setShowDialog(false);
          resetForm();
        }}
        isSubmitting={updateMutation.isPending}
      />

      {/* Delete Confirmation Dialog */}
      <DeleteProjectDialog
        projectName={deleteConfirm?.name}
        open={!!deleteConfirm}
        onOpenChange={(open) => !open && setDeleteConfirm(null)}
        onConfirm={confirmDelete}
        isDeleting={deleteMutation.isPending}
      />

      {/* Hidden file picker for Import — reads JSON and opens the import wizard via rawContent. */}
      <input
        ref={fileInputRef}
        type="file"
        accept="application/json,.json"
        className="hidden"
        onChange={onImportFileSelected}
      />

      {/* Import Source Modal — picks a template/file source, then opens the import wizard. */}
      <ImportSourceModal
        open={showImportModal}
        onOpenChange={setShowImportModal}
        importTargetName={importTarget?.name}
        selectedTemplateId={selectedTemplateId}
        onTemplateChange={handleImportTemplateChange}
        templates={templates}
        selectedImportTemplateSource={selectedImportTemplateSource}
        sortedImportVersions={sortedImportVersions}
        selectedImportVersion={selectedImportVersion}
        onSelectedImportVersionChange={setSelectedImportVersion}
        onImportFromTemplate={startImportFromTemplate}
        onImportFromFile={handleImportFromFile}
        isImporting={importWizard.isOpen}
      />

      {/* Project Setup Wizard (import flow): Providers → Agents → Teams → Review, single destructive
          commit fired only from the Review step. */}
      <ProjectSetupWizard
        open={importWizard.isOpen}
        onOpenChange={importWizard.onOpenChange}
        controller={importWizard.controller}
        title={
          importWizard.importTarget
            ? `Import into ${importWizard.importTarget.name}`
            : 'Import into project'
        }
        description="Configure providers, agents, and teams, then review the changes before replacing the project."
        submitLabel="Replace Project"
        isLoading={importWizard.isLoading}
        isSubmitting={importWizard.isSubmitting}
        errorContent={
          importWizard.isError ? (
            <div className="rounded-md border border-destructive/50 p-4 text-sm text-destructive">
              Failed to load the template preview. Close and try again.
            </div>
          ) : undefined
        }
      />

      {/* Import Result Dialog — driven by the wizard's commit result. */}
      <ImportResultDialog
        open={importResult !== null}
        onOpenChange={(open) => !open && setImportResult(null)}
        importResult={importResult}
      />

      {/* Create Project Dialog (template-based or file-based) — "Continue" opens the setup wizard. */}
      <CreateProjectDialog
        open={showTemplateDialog}
        onOpenChange={setShowTemplateDialog}
        onSubmit={(event) =>
          handleTemplateSubmit(event, (payload) => {
            setShowTemplateDialog(false);
            createWizard.openWizard(payload);
          })
        }
        templateSourceTab={templateSourceTab}
        onTemplateSourceTabChange={setTemplateSourceTab}
        templateFormData={templateFormData}
        setTemplateFormData={setTemplateFormData}
        templates={templates}
        selectedTemplateSource={selectedTemplate?.source}
        sortedVersions={sortedVersions}
        onTemplateChange={handleTemplateChange}
        onTemplatePathChange={handleTemplatePathChange}
        onTemplateFilePathChange={handleTemplateFilePathChange}
        templatePathValidation={templatePathValidation}
        templateFilePathValidation={templateFilePathValidation}
        onCancel={() => {
          setShowTemplateDialog(false);
          resetTemplateForm();
        }}
        isSubmitting={createFromTemplateMutation.isPending}
      />

      {/* Project Setup Wizard (create flow): Providers → Agents → Teams, single final mutation. */}
      <ProjectSetupWizard
        open={createWizard.isOpen}
        onOpenChange={createWizard.onOpenChange}
        controller={createWizard.controller}
        title="Set up project"
        description="Configure providers, agents, and teams before creating the project."
        isLoading={createWizard.isLoading}
        isSubmitting={createWizard.isSubmitting}
        errorContent={
          createWizard.isError ? (
            <div className="rounded-md border border-destructive/50 p-4 text-sm text-destructive">
              Failed to load the template preview. Close and try again.
            </div>
          ) : undefined
        }
      />

      {/* Upgrade Dialog */}
      {upgradeTarget && upgradeTarget.project.templateMetadata && (
        <UpgradeDialog
          projectId={upgradeTarget.project.id}
          projectName={upgradeTarget.project.name}
          templateSlug={upgradeTarget.project.templateMetadata.slug}
          currentVersion={upgradeTarget.project.templateMetadata.version || ''}
          targetVersion={upgradeTarget.targetVersion}
          source={upgradeTarget.project.templateMetadata.source}
          open={true}
          onClose={handleCloseUpgradeDialog}
        />
      )}

      {/* Export Dialog - waits for manifest fetch before rendering */}
      {exportTarget && !isLoadingExportManifest && (
        <ExportDialog
          projectId={exportTarget.id}
          projectName={exportTarget.name}
          existingManifest={exportManifest ?? undefined}
          open={true}
          onClose={handleCloseExportDialog}
        />
      )}

      {/* Configuration Modal */}
      {configureTarget && (
        <ProjectConfigurationModal
          projectId={configureTarget.id}
          open={true}
          onOpenChange={(open) => !open && setConfigureTarget(null)}
        />
      )}

      {/* Provider Mapping Modal for create-from-template */}
      {providerMappingData && (
        <ProviderMappingModal
          open={showProviderMappingModal}
          onOpenChange={(open) => {
            if (!open) {
              handleProviderMappingCancel();
            }
          }}
          missingProviders={providerMappingData.missingProviders}
          familyAlternatives={providerMappingData.familyAlternatives}
          canImport={providerMappingData.canImport}
          onConfirm={handleProviderMappingConfirm}
          loading={createFromTemplateMutation.isPending}
        />
      )}

      <ProviderMismatchWarningModal
        open={showProviderWarningModal}
        warnings={providerWarnings ?? []}
        onNavigate={handleWarningModalNavigate}
      />
    </>
  );
}
