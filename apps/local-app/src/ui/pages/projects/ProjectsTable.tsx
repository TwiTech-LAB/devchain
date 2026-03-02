import { Button } from '@/ui/components/ui/button';
import { Input } from '@/ui/components/ui/input';
import { Badge } from '@/ui/components/ui/badge';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/ui/components/ui/dropdown-menu';
import { Card } from '@/ui/components/ui/card';
import {
  Plus,
  Search,
  Edit,
  Trash2,
  ArrowUpDown,
  FolderOpen,
  Users,
  ClipboardList,
  Loader2,
  Download,
  Upload,
  ArrowUp,
  Settings,
  MoreHorizontal,
} from 'lucide-react';
import type { ProjectsPageController } from '@/ui/hooks/useProjectsPageController';

interface ProjectsTableProps {
  controller: ProjectsPageController;
}

export function ProjectsTable({ controller }: ProjectsTableProps) {
  const {
    searchQuery,
    setSearchQuery,
    isLoading,
    data,
    filteredAndSortedProjects,
    sortField,
    sortOrder,
    toggleSort,
    handleOpenProject,
    handleOpenTemplateDialog,
    getUpgradeAvailable,
    handleOpenUpgradeDialog,
    handleEdit,
    handleDelete,
    startImport,
    importingProjectId,
    handleExport,
    setConfigureTarget,
  } = controller;

  return (
    <>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-3xl font-bold">Projects</h1>
        <Button onClick={handleOpenTemplateDialog}>
          <Plus className="h-4 w-4 mr-2" />
          Create Project
        </Button>
      </div>

      {/* Search */}
      <Card className="mb-4 p-3">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            type="text"
            placeholder="Search projects by name, path, or description..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            data-shortcut="primary-search"
            className="pl-10"
          />
        </div>
      </Card>

      {isLoading && (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      )}

      {data && filteredAndSortedProjects.length === 0 && (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <FolderOpen className="h-16 w-16 text-muted-foreground mb-4" />
          <h2 className="text-xl font-semibold mb-2">No Projects Found</h2>
          <p className="text-muted-foreground mb-4">
            {searchQuery
              ? 'Try a different search term or create a new project.'
              : 'Get started by creating your first project.'}
          </p>
          {!searchQuery && (
            <Button onClick={handleOpenTemplateDialog}>
              <Plus className="h-4 w-4 mr-2" />
              Create Project
            </Button>
          )}
        </div>
      )}

      {data && filteredAndSortedProjects.length > 0 && (
        <Card>
          <div className="px-4 py-3 border-b flex items-center justify-between">
            <span className="font-medium">All Projects</span>
            <span className="text-sm text-muted-foreground">
              {filteredAndSortedProjects.length} found
            </span>
          </div>
          <table className="w-full">
            <thead className="bg-muted">
              <tr>
                <th
                  className="px-4 py-3 text-left text-sm font-medium cursor-pointer hover:bg-muted/80"
                  onClick={() => toggleSort('name')}
                >
                  <div className="flex items-center gap-2">
                    Name
                    <ArrowUpDown className="h-4 w-4" />
                    {sortField === 'name' && <span>{sortOrder === 'asc' ? '↑' : '↓'}</span>}
                  </div>
                </th>
                <th
                  className="px-4 py-3 text-left text-sm font-medium cursor-pointer hover:bg-muted/80"
                  onClick={() => toggleSort('rootPath')}
                >
                  <div className="flex items-center gap-2">
                    Path
                    <ArrowUpDown className="h-4 w-4" />
                    {sortField === 'rootPath' && <span>{sortOrder === 'asc' ? '↑' : '↓'}</span>}
                  </div>
                </th>
                <th className="px-4 py-3 text-left text-sm font-medium">Description</th>
                <th className="px-4 py-3 text-left text-sm font-medium">Template</th>
                <th className="px-4 py-3 text-center text-sm font-medium">
                  <div className="flex items-center justify-center gap-1">
                    <ClipboardList className="h-4 w-4" />
                    Epics
                  </div>
                </th>
                <th className="px-4 py-3 text-center text-sm font-medium">
                  <div className="flex items-center justify-center gap-1">
                    <Users className="h-4 w-4" />
                    Agents
                  </div>
                </th>
                <th className="px-4 py-3 text-right text-sm font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredAndSortedProjects.map((project) => (
                <tr key={project.id} className="border-t hover:bg-muted/50">
                  <td className="px-4 py-3">
                    <Button
                      variant="link"
                      className="p-0 h-auto font-medium"
                      onClick={() => handleOpenProject(project)}
                    >
                      {project.name}
                    </Button>
                    {project.isTemplate ? (
                      <Badge variant="outline" className="ml-2" aria-label="Template project">
                        Template
                      </Badge>
                    ) : null}
                  </td>
                  <td className="px-4 py-3">
                    <code className="text-xs text-muted-foreground bg-muted px-2 py-1 rounded">
                      {project.rootPath}
                    </code>
                  </td>
                  <td className="px-4 py-3 text-sm text-muted-foreground">
                    {project.description || '—'}
                  </td>
                  <td className="px-4 py-3 text-sm">
                    {project.templateMetadata ? (
                      <span className="flex items-center gap-1.5 flex-wrap">
                        <span className="text-muted-foreground">
                          {project.templateMetadata.slug}
                        </span>
                        {project.templateMetadata.source === 'bundled' ? (
                          <>
                            <Badge variant="outline" className="text-xs text-muted-foreground">
                              Built-in
                            </Badge>
                            {project.templateMetadata.version && (
                              <Badge
                                variant="outline"
                                className="text-xs text-blue-600 border-blue-600/50"
                              >
                                v{project.templateMetadata.version}
                              </Badge>
                            )}
                          </>
                        ) : project.templateMetadata.version ? (
                          <Badge
                            variant="outline"
                            className="text-xs text-blue-600 border-blue-600/50"
                          >
                            v{project.templateMetadata.version}
                          </Badge>
                        ) : null}
                        {(() => {
                          const upgradeVersion = getUpgradeAvailable(project);
                          if (upgradeVersion) {
                            return (
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-5 px-1.5 text-xs text-green-600 hover:text-green-700 hover:bg-green-50"
                                onClick={() => handleOpenUpgradeDialog(project, upgradeVersion)}
                                title={`Upgrade to v${upgradeVersion}`}
                              >
                                <ArrowUp className="h-3 w-3 mr-0.5" />v{upgradeVersion}
                              </Button>
                            );
                          }
                          return null;
                        })()}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-center">
                    <Badge variant="secondary">{project.stats?.epicsCount ?? 0}</Badge>
                  </td>
                  <td className="px-4 py-3 text-center">
                    <Badge variant="secondary">{project.stats?.agentsCount ?? 0}</Badge>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex gap-2 justify-end">
                      {project.isConfigurable && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setConfigureTarget(project)}
                          title="Configure project"
                        >
                          <Settings className="h-4 w-4" />
                        </Button>
                      )}
                      <Button variant="ghost" size="sm" onClick={() => handleEdit(project)}>
                        <Edit className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleDelete(project)}
                        className="text-destructive hover:text-destructive"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="sm">
                            <MoreHorizontal className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem
                            onClick={() => startImport(project)}
                            disabled={importingProjectId === project.id}
                          >
                            {importingProjectId === project.id ? (
                              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                            ) : (
                              <Download className="h-4 w-4 mr-2" />
                            )}
                            Import
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => handleExport(project)}>
                            <Upload className="h-4 w-4 mr-2" />
                            Export
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </>
  );
}
