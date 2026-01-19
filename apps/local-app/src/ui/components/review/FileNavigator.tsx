import { useState, useMemo, useEffect, useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Input } from '@/ui/components/ui/input';
import { ScrollArea } from '@/ui/components/ui/scroll-area';
import { Badge } from '@/ui/components/ui/badge';
import { Search, ChevronRight, ChevronDown, Folder, FileCode, MessageSquare } from 'lucide-react';
import { cn } from '@/ui/lib/utils';
import type { ChangedFile } from '@/ui/lib/reviews';

// Consistent row height for flat view virtualization (py-2 = 8px * 2 + content ~24px)
const FLAT_ITEM_HEIGHT = 40;

export interface FileCommentCounts {
  [filePath: string]: number;
}

export interface FileNavigatorProps {
  files: ChangedFile[];
  selectedFile: string | null;
  onSelectFile: (path: string) => void;
  commentCounts?: FileCommentCounts;
  isLoading?: boolean;
}

// Status badge colors and labels (iconColor used for VS Code-style file icon coloring)
const STATUS_CONFIG = {
  added: {
    label: 'A',
    className: 'bg-green-500 text-white',
    iconColor: 'text-green-600 dark:text-green-400',
  },
  modified: {
    label: 'M',
    className: 'bg-yellow-500 text-white',
    iconColor: 'text-amber-700 dark:text-amber-400',
  },
  deleted: {
    label: 'D',
    className: 'bg-red-500 text-white',
    iconColor: 'text-red-600 dark:text-red-400',
  },
  renamed: {
    label: 'R',
    className: 'bg-blue-500 text-white',
    iconColor: 'text-blue-600 dark:text-blue-400',
  },
  copied: {
    label: 'C',
    className: 'bg-purple-500 text-white',
    iconColor: 'text-purple-600 dark:text-purple-400',
  },
} as const;

interface TreeNode {
  name: string;
  path: string;
  isFolder: boolean;
  children?: TreeNode[];
  file?: ChangedFile;
}

function buildFileTreeRaw(files: ChangedFile[]): TreeNode[] {
  const root: TreeNode[] = [];
  const folderMap = new Map<string, TreeNode>();

  // Sort files by path for consistent ordering
  const sortedFiles = [...files].sort((a, b) => a.path.localeCompare(b.path));

  for (const file of sortedFiles) {
    const parts = file.path.split('/');
    let currentPath = '';
    let currentLevel = root;

    // Create folder nodes for each directory in the path
    for (let i = 0; i < parts.length - 1; i++) {
      const folderName = parts[i];
      currentPath = currentPath ? `${currentPath}/${folderName}` : folderName;

      let folderNode = folderMap.get(currentPath);
      if (!folderNode) {
        folderNode = {
          name: folderName,
          path: currentPath,
          isFolder: true,
          children: [],
        };
        folderMap.set(currentPath, folderNode);
        currentLevel.push(folderNode);
      }
      currentLevel = folderNode.children!;
    }

    // Add the file node
    const fileName = parts[parts.length - 1];
    currentLevel.push({
      name: fileName,
      path: file.path,
      isFolder: false,
      file,
    });
  }

  return root;
}

/**
 * Collapse consecutive single-child folder chains into combined labels.
 * e.g., src -> modules -> core becomes "src/modules/core"
 * Only collapses folder->folder chains, not folder->file.
 */
function collapseSingleChildFolders(nodes: TreeNode[]): TreeNode[] {
  return nodes.map((node) => {
    if (!node.isFolder || !node.children) return node;

    // Recurse first to collapse nested structures
    let children = collapseSingleChildFolders(node.children);

    // Merge folder->folder chains where parent has single folder child
    let collapsedNode = { ...node };
    while (children.length === 1 && children[0].isFolder) {
      const child = children[0];
      collapsedNode = {
        ...collapsedNode,
        name: `${collapsedNode.name}/${child.name}`,
        path: child.path, // Keep path as the deepest folder path for expand/collapse
        children: child.children,
      };
      children = child.children ? collapseSingleChildFolders(child.children) : [];
    }

    return { ...collapsedNode, children };
  });
}

function buildFileTree(files: ChangedFile[]): TreeNode[] {
  const rawTree = buildFileTreeRaw(files);
  return collapseSingleChildFolders(rawTree);
}

function LineChanges({ additions, deletions }: { additions: number; deletions: number }) {
  const label = [
    additions > 0 ? `${additions} additions` : null,
    deletions > 0 ? `${deletions} deletions` : null,
  ]
    .filter(Boolean)
    .join(', ');

  return (
    <span className="text-xs shrink-0 font-mono" aria-label={label || 'No changes'}>
      {additions > 0 && (
        <span className="text-green-600" aria-hidden="true">
          +{additions}
        </span>
      )}
      {additions > 0 && deletions > 0 && (
        <span className="text-muted-foreground" aria-hidden="true">
          /
        </span>
      )}
      {deletions > 0 && (
        <span className="text-red-600" aria-hidden="true">
          -{deletions}
        </span>
      )}
    </span>
  );
}

function TreeNodeItem({
  node,
  depth,
  selectedFile,
  onSelectFile,
  expandedFolders,
  onToggleFolder,
  commentCounts,
  searchQuery,
}: {
  node: TreeNode;
  depth: number;
  selectedFile: string | null;
  onSelectFile: (path: string) => void;
  expandedFolders: Set<string>;
  onToggleFolder: (path: string) => void;
  commentCounts?: FileCommentCounts;
  searchQuery: string;
}) {
  const isExpanded = expandedFolders.has(node.path);
  const paddingLeft = 8 + depth * 16;

  if (node.isFolder) {
    const query = searchQuery.toLowerCase();
    // Show folder if: folder name/path matches query OR has matching descendants
    const folderNameMatches = searchQuery
      ? node.name.toLowerCase().includes(query) || node.path.toLowerCase().includes(query)
      : false;
    const hasMatchingChildren = searchQuery
      ? folderNameMatches ||
        node.children?.some(
          (child) =>
            child.path.toLowerCase().includes(query) ||
            (child.isFolder && hasMatchingDescendants(child, searchQuery)),
        )
      : true;

    if (!hasMatchingChildren) return null;

    return (
      <div role="treeitem" aria-expanded={isExpanded}>
        <button
          className={cn(
            'w-full text-left px-2 py-1.5 flex items-center gap-1.5 hover:bg-accent rounded-sm transition-colors',
          )}
          style={{ paddingLeft }}
          onClick={() => onToggleFolder(node.path)}
          aria-expanded={isExpanded}
          aria-label={`${node.name} folder, ${isExpanded ? 'expanded' : 'collapsed'}`}
          title={node.path}
        >
          {isExpanded ? (
            <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          ) : (
            <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          )}
          <Folder className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className="truncate text-sm font-medium">{node.name}</span>
        </button>
        {isExpanded && (
          <div role="group">
            {node.children?.map((child) => (
              <TreeNodeItem
                key={child.path}
                node={child}
                depth={depth + 1}
                selectedFile={selectedFile}
                onSelectFile={onSelectFile}
                expandedFolders={expandedFolders}
                onToggleFolder={onToggleFolder}
                commentCounts={commentCounts}
                searchQuery={searchQuery}
              />
            ))}
          </div>
        )}
      </div>
    );
  }

  // File node
  const file = node.file!;
  const isSelected = selectedFile === node.path;
  const commentCount = commentCounts?.[node.path] ?? 0;

  // If searching, only show files that match (check full path, not just basename)
  if (searchQuery && !node.path.toLowerCase().includes(searchQuery.toLowerCase())) {
    return null;
  }

  return (
    <button
      className={cn(
        'w-full text-left px-2 py-1.5 flex items-center gap-1.5 rounded-sm transition-colors',
        isSelected ? 'bg-accent' : 'hover:bg-accent/50',
      )}
      style={{ paddingLeft: paddingLeft + 20 }} // Extra indent for files to align with folder content
      onClick={() => onSelectFile(node.path)}
      role="treeitem"
      aria-selected={isSelected}
      aria-label={`${node.name}, ${file.status}, ${file.additions} additions, ${file.deletions} deletions${commentCount > 0 ? `, ${commentCount} comments` : ''}`}
    >
      <span title={file.status} className="shrink-0">
        <FileCode
          className={cn('h-4 w-4', STATUS_CONFIG[file.status].iconColor)}
          aria-hidden="true"
        />
      </span>
      <span className="sr-only">{file.status}</span>
      <span
        className={cn(
          'truncate flex-1 text-sm',
          isSelected && 'font-medium',
          file.status === 'deleted' && 'opacity-70',
        )}
      >
        {node.name}
      </span>
      <div className="flex items-center gap-1.5 shrink-0">
        {commentCount > 0 && (
          <Badge variant="secondary" className="h-5 px-1.5 text-xs gap-0.5" aria-hidden="true">
            <MessageSquare className="h-3 w-3" />
            {commentCount}
          </Badge>
        )}
        <LineChanges additions={file.additions} deletions={file.deletions} />
      </div>
    </button>
  );
}

function hasMatchingDescendants(node: TreeNode, query: string): boolean {
  if (!node.children) return false;
  const lowerQuery = query.toLowerCase();
  return node.children.some(
    (child) =>
      child.path.toLowerCase().includes(lowerQuery) ||
      child.name.toLowerCase().includes(lowerQuery) ||
      (child.isFolder && hasMatchingDescendants(child, query)),
  );
}

function FlatFileItem({
  file,
  isSelected,
  onSelect,
  commentCount,
}: {
  file: ChangedFile;
  isSelected: boolean;
  onSelect: () => void;
  commentCount: number;
}) {
  return (
    <button
      className={cn(
        'w-full text-left px-3 py-2 flex items-center gap-2 rounded-md transition-colors',
        isSelected ? 'bg-accent' : 'hover:bg-accent/50',
      )}
      onClick={onSelect}
      role="option"
      aria-selected={isSelected}
      aria-label={`${file.path}, ${file.status}, ${file.additions} additions, ${file.deletions} deletions${commentCount > 0 ? `, ${commentCount} comments` : ''}`}
    >
      <span title={file.status} className="shrink-0">
        <FileCode
          className={cn('h-4 w-4', STATUS_CONFIG[file.status].iconColor)}
          aria-hidden="true"
        />
      </span>
      <span className="sr-only">{file.status}</span>
      <span
        className={cn(
          'truncate flex-1 text-sm',
          isSelected && 'font-medium',
          file.status === 'deleted' && 'opacity-70',
        )}
      >
        {file.path}
      </span>
      <div className="flex items-center gap-1.5 shrink-0">
        {commentCount > 0 && (
          <Badge variant="secondary" className="h-5 px-1.5 text-xs gap-0.5" aria-hidden="true">
            <MessageSquare className="h-3 w-3" />
            {commentCount}
          </Badge>
        )}
        <LineChanges additions={file.additions} deletions={file.deletions} />
      </div>
    </button>
  );
}

export function FileNavigator({
  files,
  selectedFile,
  onSelectFile,
  commentCounts,
  isLoading,
}: FileNavigatorProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [viewMode, setViewMode] = useState<'tree' | 'flat'>('tree');
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const [hasInitialized, setHasInitialized] = useState(false);

  // Ref for flat view virtualization scroll container
  const flatListParentRef = useRef<HTMLDivElement>(null);

  // Initialize expanded folders when files are first loaded
  useEffect(() => {
    if (files.length > 0 && !hasInitialized) {
      const folders = new Set<string>();
      for (const file of files) {
        const parts = file.path.split('/');
        let currentPath = '';
        for (let i = 0; i < parts.length - 1; i++) {
          currentPath = currentPath ? `${currentPath}/${parts[i]}` : parts[i];
          folders.add(currentPath);
        }
      }
      setExpandedFolders(folders);
      setHasInitialized(true);
    }
  }, [files, hasInitialized]);

  const fileTree = useMemo(() => buildFileTree(files), [files]);

  const filteredFiles = useMemo(() => {
    if (!searchQuery) return files;
    const query = searchQuery.toLowerCase();
    return files.filter((file) => file.path.toLowerCase().includes(query));
  }, [files, searchQuery]);

  // Virtualizer for flat view - only active when in flat mode
  const flatVirtualizer = useVirtualizer({
    count: filteredFiles.length,
    getScrollElement: () => flatListParentRef.current,
    estimateSize: () => FLAT_ITEM_HEIGHT,
    overscan: 5, // Render 5 extra items above/below viewport for smooth scrolling
  });

  // Scroll selected file into view when selection changes in flat mode
  useEffect(() => {
    if (viewMode === 'flat' && selectedFile) {
      const index = filteredFiles.findIndex((f) => f.path === selectedFile);
      if (index !== -1) {
        flatVirtualizer.scrollToIndex(index, { align: 'auto' });
      }
    }
  }, [viewMode, selectedFile, filteredFiles, flatVirtualizer]);

  const handleToggleFolder = (path: string) => {
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  };

  const handleExpandAll = () => {
    const allFolders = new Set<string>();
    for (const file of files) {
      const parts = file.path.split('/');
      let currentPath = '';
      for (let i = 0; i < parts.length - 1; i++) {
        currentPath = currentPath ? `${currentPath}/${parts[i]}` : parts[i];
        allFolders.add(currentPath);
      }
    }
    setExpandedFolders(allFolders);
  };

  const handleCollapseAll = () => {
    setExpandedFolders(new Set());
  };

  if (isLoading) {
    return (
      <div className="h-full flex flex-col">
        <div className="p-2 border-b">
          <div className="h-9 bg-muted rounded-md animate-pulse" />
        </div>
        <div className="flex-1 p-2 space-y-1">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="h-7 bg-muted rounded-sm animate-pulse" />
          ))}
        </div>
      </div>
    );
  }

  if (files.length === 0) {
    return (
      <div className="h-full flex flex-col items-center justify-center p-4 text-center text-muted-foreground">
        <FileCode className="h-8 w-8 mb-2" />
        <p className="text-sm">No files changed</p>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      {/* Search and controls */}
      <div className="p-2 border-b space-y-2">
        <div className="relative">
          <Search
            className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            placeholder="Filter files..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-8 h-8 text-sm"
            aria-label="Filter files by name"
          />
        </div>
        <div className="flex items-center gap-1 text-xs" role="group" aria-label="View options">
          <button
            className={cn(
              'px-2 py-1 rounded-sm transition-colors',
              viewMode === 'tree' ? 'bg-accent' : 'hover:bg-accent/50',
            )}
            onClick={() => setViewMode('tree')}
            aria-pressed={viewMode === 'tree'}
          >
            Tree
          </button>
          <button
            className={cn(
              'px-2 py-1 rounded-sm transition-colors',
              viewMode === 'flat' ? 'bg-accent' : 'hover:bg-accent/50',
            )}
            onClick={() => setViewMode('flat')}
            aria-pressed={viewMode === 'flat'}
          >
            Flat
          </button>
          {viewMode === 'tree' && (
            <>
              <span className="mx-1 text-muted-foreground" aria-hidden="true">
                |
              </span>
              <button
                className="px-2 py-1 rounded-sm hover:bg-accent/50 transition-colors"
                onClick={handleExpandAll}
                aria-label="Expand all folders"
              >
                Expand
              </button>
              <button
                className="px-2 py-1 rounded-sm hover:bg-accent/50 transition-colors"
                onClick={handleCollapseAll}
                aria-label="Collapse all folders"
              >
                Collapse
              </button>
            </>
          )}
        </div>
      </div>

      {/* File list */}
      {viewMode === 'tree' ? (
        <ScrollArea className="flex-1">
          <div className="py-1">
            <div role="tree" aria-label="Changed files">
              {fileTree.map((node) => (
                <TreeNodeItem
                  key={node.path}
                  node={node}
                  depth={0}
                  selectedFile={selectedFile}
                  onSelectFile={onSelectFile}
                  expandedFolders={expandedFolders}
                  onToggleFolder={handleToggleFolder}
                  commentCounts={commentCounts}
                  searchQuery={searchQuery}
                />
              ))}
            </div>
            {searchQuery && filteredFiles.length === 0 && (
              <div className="p-4 text-center text-sm text-muted-foreground" role="status">
                No files match "{searchQuery}"
              </div>
            )}
          </div>
        </ScrollArea>
      ) : (
        // NOTE: Flat view uses a plain div instead of ScrollArea for virtualization.
        // @tanstack/react-virtual requires direct access to scroll container properties
        // (offsetHeight, scrollTop, etc.) which are abstracted by Radix ScrollArea's
        // viewport element. Using a plain div with overflow-auto ensures the virtualizer
        // can correctly measure and respond to scroll events. The native scrollbar
        // styling differs slightly from ScrollArea but is functionally equivalent.
        // See: https://tanstack.com/virtual/latest/docs/api/virtualizer
        <div
          ref={flatListParentRef}
          className="flex-1 overflow-auto"
          role="listbox"
          aria-label="Changed files"
        >
          {filteredFiles.length > 0 ? (
            <div
              className="relative w-full px-1"
              style={{ height: `${flatVirtualizer.getTotalSize()}px` }}
            >
              {flatVirtualizer.getVirtualItems().map((virtualItem) => {
                const file = filteredFiles[virtualItem.index];
                return (
                  <div
                    key={file.path}
                    className="absolute top-0 left-0 w-full px-1"
                    style={{
                      height: `${virtualItem.size}px`,
                      transform: `translateY(${virtualItem.start}px)`,
                    }}
                  >
                    <FlatFileItem
                      file={file}
                      isSelected={selectedFile === file.path}
                      onSelect={() => onSelectFile(file.path)}
                      commentCount={commentCounts?.[file.path] ?? 0}
                    />
                  </div>
                );
              })}
            </div>
          ) : searchQuery ? (
            <div className="p-4 text-center text-sm text-muted-foreground" role="status">
              No files match "{searchQuery}"
            </div>
          ) : null}
        </div>
      )}

      {/* Summary footer */}
      <div className="p-2 border-t text-xs text-muted-foreground">
        {files.length} file{files.length !== 1 ? 's' : ''} changed
        {searchQuery && filteredFiles.length !== files.length && (
          <span> ({filteredFiles.length} shown)</span>
        )}
      </div>
    </div>
  );
}
