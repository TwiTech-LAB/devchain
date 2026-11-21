import { useEffect, useId, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ArrowUp, Folder, Link2 } from 'lucide-react';
import { useHomeQueryClient } from '@/ui/components/BackendBoundary';
import { Button } from '@/ui/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/ui/components/ui/dialog';
import { Label } from '@/ui/components/ui/label';
import { BusyStatus } from '@/ui/components/ui/spinner';
import { Switch } from '@/ui/components/ui/switch';
import { useRemoteVmApi } from './lib/remote-vm-api-context';
import { folderListQueryKey } from './lib/remote-vm-query-keys';

function parentOf(path: string): string {
  const cut = path.replace(/\/+$/, '').lastIndexOf('/');
  return cut > 0 ? path.slice(0, cut) : '/';
}

function under(path: string, home: string): boolean {
  return path === home || path.startsWith(`${home}/`);
}

/** Home, then one crumb per folder from home down to `path`. */
function crumbs(path: string, home: string | null): Array<{ label: string; path: string }> {
  if (!home || !under(path, home)) return [{ label: path, path }];
  const parts = path.slice(home.length).split('/').filter(Boolean);
  return [
    { label: 'Home', path: home },
    ...parts.map((part, index) => ({
      label: part,
      path: `${home}/${parts.slice(0, index + 1).join('/')}`,
    })),
  ];
}

/**
 * Picks a folder under this PC's home. Lists through this PC even when a
 * remote project is selected; the server refuses paths outside home.
 */
export function FolderBrowserDialog({
  startPath,
  homePath,
  onSelect,
  onClose,
}: {
  /** An absolute path to open first; a path that cannot be listed opens home instead. */
  startPath: string | null;
  homePath: string | null;
  onSelect: (path: string) => void;
  onClose: () => void;
}) {
  const api = useRemoteVmApi();
  const hiddenId = useId();
  // Null lists home. The start path falls back to home once if it cannot be listed.
  const [path, setPath] = useState<string | null>(startPath);
  const [startFailed, setStartFailed] = useState(false);
  const [showHidden, setShowHidden] = useState(false);
  // The server's canonical home: it can differ from `homePath` when home is a link.
  const [listedHome, setListedHome] = useState<string | null>(null);
  const home = listedHome ?? homePath;

  const listing = useQuery(
    {
      queryKey: folderListQueryKey(path, showHidden),
      queryFn: ({ signal }) =>
        api.listFolders(path ? { path, showHidden } : { showHidden }, signal),
      placeholderData: keepPreviousData,
      retry: false,
    },
    useHomeQueryClient(),
  );

  const failed = listing.isError && !listing.isFetching;
  useEffect(() => {
    if (failed && path !== null && path === startPath && !startFailed) {
      setStartFailed(true);
      setPath(null);
    }
  }, [failed, path, startPath, startFailed]);

  const data = listing.isPlaceholderData || failed ? null : listing.data;
  useEffect(() => {
    if (data && data.parent === null) setListedHome(data.path);
  }, [data]);

  // An unreadable folder has no listing, so its parent comes from the requested path.
  const current = data?.path ?? path ?? home;
  const atHome = data ? data.parent === null : path === null || (!!home && current === home);
  const up = () => {
    if (data?.parent) return setPath(data.parent);
    if (!current) return;
    const parent = parentOf(current);
    setPath(home && !under(parent, home) ? null : parent);
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex flex-col overflow-hidden">
        <DialogHeader className="shrink-0">
          <DialogTitle>Choose a folder</DialogTitle>
          <DialogDescription>Folders in the home folder of this PC.</DialogDescription>
        </DialogHeader>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={atHome}
            onClick={up}
            aria-label="Up"
          >
            <ArrowUp aria-hidden="true" className="h-4 w-4" />
            Up
          </Button>
          {current && (
            <nav aria-label="Folder path" className="min-w-0 flex-1">
              <ol className="flex flex-wrap items-center gap-1 text-sm">
                {crumbs(current, home).map((crumb, index, all) => (
                  <li key={crumb.path} className="flex items-center gap-1">
                    {index > 0 && <span className="text-muted-foreground">/</span>}
                    {index === all.length - 1 ? (
                      <span aria-current="page" className="break-all font-medium">
                        {crumb.label}
                      </span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setPath(crumb.path)}
                        className="break-all text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        {crumb.label}
                      </button>
                    )}
                  </li>
                ))}
              </ol>
            </nav>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2 text-sm">
          <Switch id={hiddenId} checked={showHidden} onCheckedChange={setShowHidden} />
          <Label htmlFor={hiddenId}>Show hidden folders</Label>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto rounded-md border">
          {failed ? (
            <p role="alert" className="break-words p-3 text-sm text-destructive">
              {listing.error.message}
            </p>
          ) : !data ? (
            <BusyStatus className="p-3">Loading folders…</BusyStatus>
          ) : data.entries.length === 0 ? (
            <p className="p-3 text-sm text-muted-foreground">No subfolders.</p>
          ) : (
            <ul aria-label="Subfolders" className="divide-y">
              {data.entries.map((entry) => (
                <li key={entry.path}>
                  <button
                    type="button"
                    onClick={() => setPath(entry.path)}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                  >
                    {entry.link ? (
                      <Link2 aria-label="Link" className="h-4 w-4 shrink-0 text-muted-foreground" />
                    ) : (
                      <Folder
                        aria-hidden="true"
                        className="h-4 w-4 shrink-0 text-muted-foreground"
                      />
                    )}
                    <span className="break-all">{entry.name}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <DialogFooter className="shrink-0">
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" disabled={!data} onClick={() => data && onSelect(data.path)}>
            Select this folder
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
