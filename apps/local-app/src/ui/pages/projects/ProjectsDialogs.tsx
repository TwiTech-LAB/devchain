import { DeleteProjectDialog } from '@/ui/components/project/DeleteProjectDialog';
import { MissingProvidersDialog } from '@/ui/components/project/MissingProvidersDialog';
import { ImportResultDialog } from '@/ui/components/project/ImportResultDialog';
import { UpgradeDialog } from '@/ui/components/project/UpgradeDialog';
import { ExportDialog } from '@/ui/components/project/ExportDialog';
import { ProjectConfigurationModal } from '@/ui/components/project/ProjectConfigurationModal';
import { EditProjectDialog } from '@/ui/components/project/EditProjectDialog';
import { ImportSourceModal } from '@/ui/components/project/ImportSourceModal';
import { ImportConfirmDialog } from '@/ui/components/project/ImportConfirmDialog';
import { CreateProjectDialog } from '@/ui/components/project/CreateProjectDialog';
import { ProviderMappingModal } from '@/ui/components/project/ProviderMappingModal';
import { ProviderMismatchWarningModal } from '@/ui/components/project/ProviderMismatchWarningModal';
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
    onFileSelected,
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
    handleImportFromTemplate,
    handleImportFromFile,
    importingProjectId,
    showMissingProviders,
    setShowMissingProviders,
    dryRunResult,
    showImportConfirm,
    setShowImportConfirm,
    statusMappings,
    setStatusMappings,
    confirmImport,
    showImportResult,
    setShowImportResult,
    importResult,
    showTemplateDialog,
    setShowTemplateDialog,
    handleTemplateSubmit,
    templateSourceTab,
    setTemplateSourceTab,
    templateFormData,
    setTemplateFormData,
    selectedTemplate,
    sortedVersions,
    availablePresets,
    selectedPreset,
    setSelectedPreset,
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
    importProviderMappingData,
    showImportProviderMappingModal,
    handleImportProviderMappingCancel,
    handleImportProviderMappingConfirm,
  } = controller;

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

      {/* Hidden file picker for Import */}
      <input
        ref={fileInputRef}
        type="file"
        accept="application/json,.json"
        className="hidden"
        onChange={onFileSelected}
      />

      {/* Import Source Modal */}
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
        onImportFromTemplate={handleImportFromTemplate}
        onImportFromFile={handleImportFromFile}
        isImporting={importingProjectId === importTarget?.id}
      />

      {/* Missing Providers Dialog */}
      <MissingProvidersDialog
        open={showMissingProviders}
        onOpenChange={setShowMissingProviders}
        missingProviders={dryRunResult?.missingProviders}
      />

      {/* Confirm Import Dialog */}
      <ImportConfirmDialog
        open={showImportConfirm}
        onOpenChange={setShowImportConfirm}
        dryRunResult={dryRunResult}
        statusMappings={statusMappings}
        setStatusMappings={setStatusMappings}
        onConfirm={confirmImport}
        isImporting={!!importingProjectId}
      />

      {/* Import Result Dialog */}
      <ImportResultDialog
        open={showImportResult}
        onOpenChange={setShowImportResult}
        importResult={importResult}
      />

      {/* Create Project Dialog (template-based or file-based) */}
      <CreateProjectDialog
        open={showTemplateDialog}
        onOpenChange={setShowTemplateDialog}
        onSubmit={(event) =>
          handleTemplateSubmit(event, (payload) => createFromTemplateMutation.mutate(payload))
        }
        templateSourceTab={templateSourceTab}
        onTemplateSourceTabChange={setTemplateSourceTab}
        templateFormData={templateFormData}
        setTemplateFormData={setTemplateFormData}
        templates={templates}
        selectedTemplateSource={selectedTemplate?.source}
        sortedVersions={sortedVersions}
        availablePresets={availablePresets}
        selectedPreset={selectedPreset}
        onSelectedPresetChange={setSelectedPreset}
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

      {/* Provider Mapping Modal for import flow */}
      {importProviderMappingData && (
        <ProviderMappingModal
          open={showImportProviderMappingModal}
          onOpenChange={(open) => {
            if (!open) {
              handleImportProviderMappingCancel();
            }
          }}
          missingProviders={importProviderMappingData.missingProviders}
          familyAlternatives={importProviderMappingData.familyAlternatives}
          canImport={importProviderMappingData.canImport}
          onConfirm={handleImportProviderMappingConfirm}
          loading={!!importingProjectId}
        />
      )}
    </>
  );
}
