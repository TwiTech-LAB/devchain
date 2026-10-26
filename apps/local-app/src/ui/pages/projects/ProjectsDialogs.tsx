import { CreateProjectDialog } from '@/ui/components/project/CreateProjectDialog';
import { DeleteProjectDialog } from '@/ui/components/project/DeleteProjectDialog';
import { EditProjectDialog } from '@/ui/components/project/EditProjectDialog';
import { ExportDialog } from '@/ui/components/project/ExportDialog';
import { ImportResultDialog } from '@/ui/components/project/ImportResultDialog';
import { ImportSourceModal } from '@/ui/components/project/ImportSourceModal';
import { ProjectConfigurationModal } from '@/ui/components/project/ProjectConfigurationModal';
import { ProjectSetupWizard } from '@/ui/components/project/ProjectSetupWizard';
import { ProviderMappingModal } from '@/ui/components/project/ProviderMappingModal';
import { ProviderMismatchWarningModal } from '@/ui/components/project/ProviderMismatchWarningModal';
import { UpgradeDialog } from '@/ui/components/project/UpgradeDialog';
import { ConfirmDialog } from '@/ui/components/shared/ConfirmDialog';
import { Button } from '@/ui/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/ui/components/ui/dialog';
import { Input } from '@/ui/components/ui/input';
import { Label } from '@/ui/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/ui/components/ui/select';
import type { ProjectsDialogsModel, ProjectWizardModel } from './projects-page-presentation';

interface ProjectsDialogsProps {
  model: ProjectsDialogsModel;
}

function SetupWizard({ model }: { model: ProjectWizardModel }) {
  return (
    <ProjectSetupWizard
      open={model.open}
      onOpenChange={model.onOpenChange}
      controller={model.controller}
      title={model.title}
      description={model.description}
      submitLabel={model.submitLabel}
      isLoading={model.isLoading}
      isSubmitting={model.isSubmitting}
      errorContent={
        model.errorMessage ? (
          <div className="rounded-md border border-destructive/50 p-4 text-sm text-destructive">
            {model.errorMessage}
          </div>
        ) : undefined
      }
    />
  );
}

function ProjectMoveDescription({ model }: { model: ProjectsDialogsModel['move'] }) {
  let impactMessage: string;
  if (model.pairedDeviceImpact.unavailable || model.pairedDeviceImpact.isLoading) {
    impactMessage =
      'Paired-device impact is unavailable. This move may change device access and will close any matching active mobile view.';
  } else if (model.pairedDeviceImpact.devices.length > 0) {
    const deviceCount = model.pairedDeviceImpact.devices.length;
    const deviceLabel = deviceCount === 1 ? 'device' : 'devices';
    impactMessage = `This may change access for ${deviceCount} paired ${deviceLabel} and will close any matching active mobile view.`;
  } else {
    impactMessage =
      'No paired devices are currently connected. The project workspace will still change immediately.';
  }

  return (
    <span className="space-y-2">
      <span className="block">
        Move from {model.sourceWorkspaceName ?? 'the current workspace'} to{' '}
        {model.destinationWorkspaceName ?? 'the selected workspace'}.
      </span>
      <span className="block">{impactMessage}</span>
    </span>
  );
}

function WorkspaceDialogs({ model }: { model: ProjectsDialogsModel['workspaces'] }) {
  return (
    <>
      <Dialog open={model.create.open} onOpenChange={model.create.onOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create Workspace</DialogTitle>
            <DialogDescription>
              Add an independent workspace for organizing projects.
            </DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              model.create.submit();
            }}
            className="space-y-4"
          >
            <div>
              <Label htmlFor="new-workspace-name">Name</Label>
              <Input
                id="new-workspace-name"
                name="newWorkspaceName"
                autoComplete="off"
                value={model.create.name}
                onChange={(event) => model.create.changeName(event.target.value)}
                required
                autoFocus
              />
            </div>
            {model.create.secondWorkspaceImpact.required && (
              <div className="space-y-3 rounded-md border border-border p-3 text-sm">
                <p className="font-medium">Paired devices affected by multi-workspace mode</p>
                {model.create.secondWorkspaceImpact.isLoading ? (
                  <p className="text-muted-foreground">Checking paired devices…</p>
                ) : model.create.secondWorkspaceImpact.error ? (
                  <p className="text-destructive">{model.create.secondWorkspaceImpact.error}</p>
                ) : model.create.secondWorkspaceImpact.devices.length === 0 ? (
                  <p className="text-muted-foreground">No paired devices are currently affected.</p>
                ) : (
                  <ul className="list-disc space-y-1 pl-5">
                    {model.create.secondWorkspaceImpact.devices.map((device) => (
                      <li key={device.kid}>
                        <span className="block">
                          {device.localAlias ?? device.label ?? `Device ${device.kid.slice(0, 8)}`}
                        </span>
                        {device.localAlias !== undefined && device.label !== undefined && (
                          <span className="block text-xs text-muted-foreground">
                            Reported name: {device.label}
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
                {model.create.secondWorkspaceImpact.devices.length > 0 && (
                  <p>
                    <span className="font-medium">Phone compatibility:</span> Workspace features
                    require the latest mobile app. Update and re-pair your phone before using
                    multiple workspaces.
                  </p>
                )}
                <p>
                  <span className="font-medium">Local App E2EE:</span> update or restart the Local
                  App if it reports that desktop encryption is unavailable.
                </p>
                <p className="text-muted-foreground">
                  Existing devices initially keep Default-only access. You can change each exact
                  subset in Paired devices after creating the workspace.
                </p>
              </div>
            )}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => model.create.onOpenChange(false)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={
                  model.create.isSubmitting ||
                  !model.create.name.trim() ||
                  (model.create.secondWorkspaceImpact.required &&
                    (model.create.secondWorkspaceImpact.isLoading ||
                      model.create.secondWorkspaceImpact.error !== null))
                }
              >
                Create
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={model.rename.open} onOpenChange={model.rename.onOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename Workspace</DialogTitle>
            <DialogDescription>Projects stay assigned to the same workspace.</DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              model.rename.submit();
            }}
            className="space-y-4"
          >
            <div>
              <Label htmlFor="rename-workspace-name">Name</Label>
              <Input
                id="rename-workspace-name"
                name="workspaceName"
                autoComplete="off"
                value={model.rename.name}
                onChange={(event) => model.rename.changeName(event.target.value)}
                required
              />
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => model.rename.onOpenChange(false)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={model.rename.isSubmitting || !model.rename.name.trim()}
              >
                Rename
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={model.delete.open} onOpenChange={model.delete.onOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete {model.delete.workspaceName ?? 'workspace'}?</DialogTitle>
            <DialogDescription>
              This will move {model.delete.projectCount} project(s) and remap{' '}
              {model.delete.deviceGrantCount} paired-device grant(s). Choose a replacement
              workspace.
            </DialogDescription>
          </DialogHeader>
          <div>
            <Label htmlFor="replacement-workspace">Replacement workspace</Label>
            <Select
              name="replacementWorkspaceId"
              value={model.delete.replacementWorkspaceId}
              onValueChange={model.delete.changeReplacement}
            >
              <SelectTrigger id="replacement-workspace">
                <SelectValue placeholder="Select a replacement" />
              </SelectTrigger>
              <SelectContent>
                {model.delete.replacementOptions.map((workspace) => (
                  <SelectItem key={workspace.id} value={workspace.id}>
                    {workspace.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => model.delete.onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={model.delete.confirm}
              disabled={model.delete.isDeleting || !model.delete.replacementWorkspaceId}
            >
              Delete and move
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function ProjectsDialogs({ model }: ProjectsDialogsProps) {
  const createMapping = model.create.providerMapping;
  const upgradeResult = model.upgrade.result;

  return (
    <>
      <EditProjectDialog
        open={model.edit.open}
        onOpenChange={model.edit.onOpenChange}
        formData={model.edit.values}
        onNameChange={model.edit.changeName}
        onDescriptionChange={model.edit.changeDescription}
        onIsTemplateChange={model.edit.changeIsTemplate}
        pathValidation={model.edit.pathValidation}
        onPathChange={model.edit.changeRootPath}
        onSubmit={(event) => {
          event.preventDefault();
          model.edit.submit();
        }}
        onCancel={model.edit.cancel}
        isSubmitting={model.edit.isSubmitting}
      />

      <ConfirmDialog
        open={model.move.open}
        onOpenChange={model.move.onOpenChange}
        onConfirm={model.move.confirm}
        title={`Move ${model.move.projectName ?? 'project'}?`}
        confirmText="Move Project"
        loading={model.move.isMoving}
        description={<ProjectMoveDescription model={model.move} />}
      />

      <DeleteProjectDialog
        projectName={model.delete.projectName}
        open={model.delete.open}
        onOpenChange={model.delete.onOpenChange}
        onConfirm={model.delete.confirm}
        isDeleting={model.delete.isDeleting}
      />

      <input
        ref={model.import.fileInputRef}
        type="file"
        accept="application/json,.json"
        className="hidden"
        onChange={(event) => model.import.selectFile(event.target.files?.[0])}
      />

      <ImportSourceModal
        open={model.import.source.open}
        onOpenChange={model.import.source.onOpenChange}
        importTargetName={model.import.source.targetName}
        selectedTemplateId={model.import.source.selectedTemplateId}
        onTemplateChange={model.import.source.selectTemplate}
        templates={model.import.source.templates}
        selectedImportTemplateSource={model.import.source.selectedTemplateSource}
        sortedImportVersions={model.import.source.sortedVersions}
        selectedImportVersion={model.import.source.selectedVersion}
        onSelectedImportVersionChange={model.import.source.selectVersion}
        onImportFromTemplate={model.import.source.importTemplate}
        onImportFromFile={model.import.source.openFilePicker}
        isImporting={model.import.source.isImporting}
      />

      <SetupWizard model={model.import.wizard} />

      <SetupWizard model={model.upgrade.wizard} />

      <ImportResultDialog
        open={model.import.result !== null}
        onOpenChange={(open) => !open && model.import.closeResult()}
        importResult={model.import.result}
      />

      <CreateProjectDialog
        open={model.create.source.open}
        onOpenChange={model.create.source.onOpenChange}
        onSubmit={(event) => {
          event.preventDefault();
          model.create.source.submit();
        }}
        templateSourceTab={model.create.source.sourceTab}
        onTemplateSourceTabChange={model.create.source.changeSourceTab}
        templateFormData={model.create.source.values}
        onNameChange={model.create.source.changeName}
        onDescriptionChange={model.create.source.changeDescription}
        onVersionChange={model.create.source.changeVersion}
        workspaces={model.create.source.workspaces}
        showWorkspaceSelector={model.create.source.showWorkspaceSelector}
        onWorkspaceChange={model.create.source.changeWorkspace}
        templates={model.create.source.templates}
        selectedTemplateSource={model.create.source.selectedTemplateSource}
        sortedVersions={model.create.source.sortedVersions}
        onTemplateChange={model.create.source.selectTemplate}
        onTemplatePathChange={model.create.source.changeRootPath}
        onTemplateFilePathChange={model.create.source.changeTemplateFilePath}
        templatePathValidation={model.create.source.pathValidation}
        templateFilePathValidation={model.create.source.filePathValidation}
        onCancel={model.create.source.cancel}
        isSubmitting={model.create.source.isSubmitting}
      />

      <SetupWizard model={model.create.wizard} />

      {upgradeResult && (
        <UpgradeDialog
          projectId={upgradeResult.projectId}
          projectName={upgradeResult.projectName}
          targetVersion={upgradeResult.targetVersion}
          source={upgradeResult.source}
          result={upgradeResult.result}
          backend={upgradeResult.backend}
          open={true}
          onClose={upgradeResult.close}
          onRestored={upgradeResult.restored}
        />
      )}

      {model.export && (
        <ExportDialog
          projectId={model.export.projectId}
          projectName={model.export.projectName}
          existingManifest={model.export.existingManifest}
          open={true}
          onClose={model.export.close}
        />
      )}

      {model.configuration && (
        <ProjectConfigurationModal
          projectId={model.configuration.projectId}
          open={true}
          onOpenChange={(open) => !open && model.configuration?.close()}
        />
      )}

      {createMapping && (
        <ProviderMappingModal
          open={createMapping.open}
          onOpenChange={(open) => !open && createMapping.cancel()}
          missingProviders={createMapping.missingProviders}
          familyAlternatives={createMapping.familyAlternatives}
          canImport={createMapping.canImport}
          onConfirm={createMapping.confirm}
          loading={createMapping.isSubmitting}
        />
      )}

      <ProviderMismatchWarningModal
        open={model.create.warning.open}
        warnings={model.create.warning.warnings}
        onNavigate={model.create.warning.navigate}
      />

      {model.workspaces && <WorkspaceDialogs model={model.workspaces} />}
    </>
  );
}
