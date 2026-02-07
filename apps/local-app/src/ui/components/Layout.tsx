import { ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useSelectedProject } from '../hooks/useProjectSelection';
import { fetchCachedTemplates, hasAnyTemplateUpdates } from '../lib/registry-updates';
import { preloadReviewsPage } from '../pages/ReviewsPage.lazy';
import { Button } from './ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import {
  Breadcrumbs,
  ToastHost,
  EpicSearchInput,
  AutoCompactWarningModal,
  type BreadcrumbItem,
} from './shared';
import { TerminalDock, OPEN_TERMINAL_DOCK_EVENT } from './terminal-dock';
import {
  TerminalWindowsProvider,
  TerminalWindowsLayer,
  useTerminalWindowManager,
  useTerminalWindows,
} from '../terminal-windows';
import { useAppSocket } from '../hooks/useAppSocket';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog';
import { useToast } from '../hooks/use-toast';
import { BreadcrumbsProvider, useBreadcrumbs } from '../hooks/useBreadcrumbs';
import { cn } from '../lib/utils';
import { fetchPreflightChecks } from '../lib/preflight';
import type { ActiveSession } from '../lib/sessions';
import type { WsEnvelope } from '../lib/socket';
import {
  Menu,
  X,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  FolderOpen,
  FileText,
  Users,
  Server,
  Bot,
  LayoutGrid,
  Settings,
  Layers,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Loader2,
  AlertCircle,
  Keyboard,
  Activity,
  Inbox,
  MessageSquare,
  Moon,
  Waves,
  Zap,
  Package,
  GitCompareArrows,
} from 'lucide-react';
import { ThemeSelect, type ThemeValue, getStoredTheme } from '@/ui/components/ThemeSelect';
import { Popover, PopoverContent, PopoverTrigger } from '@/ui/components/ui/popover';

interface LayoutProps {
  children: ReactNode;
}

interface NavItem {
  label: string;
  path: string;
  icon: typeof FolderOpen;
}

interface NavSection {
  id: string;
  title?: string;
  collapsible: boolean;
  items: NavItem[];
}

interface AutoCompactBlock {
  agentName: string;
  providerId: string;
  providerName: string;
}

// Grouped navigation sections for collapsible sidebar
const navSections: NavSection[] = [
  {
    id: 'core',
    collapsible: false,
    items: [
      { label: 'Projects', path: '/projects', icon: FolderOpen },
      { label: 'Chat', path: '/chat', icon: MessageSquare },
      { label: 'Board', path: '/board', icon: LayoutGrid },
      { label: 'Reviews', path: '/reviews', icon: GitCompareArrows },
      { label: 'Registry', path: '/registry', icon: Package },
    ],
  },
  {
    id: 'project-config',
    title: 'Project Config',
    collapsible: true,
    items: [
      { label: 'Agents', path: '/agents', icon: Bot },
      { label: 'Profiles', path: '/profiles', icon: Users },
      { label: 'Prompts', path: '/prompts', icon: FileText },
      { label: 'Statuses', path: '/statuses', icon: Layers },
    ],
  },
  {
    id: 'system',
    title: 'System',
    collapsible: true,
    items: [
      { label: 'Providers', path: '/providers', icon: Server },
      { label: 'Events', path: '/events', icon: Activity },
      { label: 'Messages', path: '/messages', icon: Inbox },
      { label: 'Automation', path: '/automation', icon: Zap },
      { label: 'Settings', path: '/settings', icon: Settings },
    ],
  },
];

const SHORTCUTS = [
  { keys: 'g p', description: 'Go to Projects' },
  { keys: 'g b', description: 'Go to Board' },
  { keys: 'g c', description: 'Go to Chat' },
  { keys: 'g r', description: 'Go to Reviews' },
  { keys: 't', description: 'Toggle terminal dock' },
  { keys: 'Alt+Shift+X', description: 'Toggle all terminal windows' },
  { keys: 'Alt + `', description: 'Cycle terminal windows' },
  { keys: 'Enter', description: 'Focus active terminal input' },
  { keys: '/', description: 'Focus page search' },
  { keys: 'Cmd/Ctrl + ?', description: 'Open shortcuts help' },
];

// Derive routeLabelMap from navSections for breadcrumbs
const routeLabelMap = navSections
  .flatMap((section) => section.items)
  .reduce<Record<string, string>>((acc, item) => {
    const key = item.path.replace(/^\//, '');
    acc[key] = item.label;
    return acc;
  }, {});

// Map routes that don't have nav items to their parent/related pages
const routeRedirectMap: Record<string, { label: string; href: string }> = {
  epics: { label: 'Board', href: '/board' },
};

const DOCK_EXPANDED_STORAGE_KEY = 'devchain:dockExpanded';
const OPEN_SESSIONS_STORAGE_KEY = 'devchain:terminalOpenSessionIds';

const preflightStatusStyles = {
  pass: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600 hover:bg-emerald-500/20',
  warn: 'border-amber-500/40 bg-amber-500/10 text-amber-600 hover:bg-amber-500/20',
  fail: 'border-destructive/40 bg-destructive/10 text-destructive hover:bg-destructive/20',
} as const;

const preflightDotStyles = {
  pass: 'bg-emerald-500',
  warn: 'bg-amber-500',
  fail: 'bg-destructive',
} as const;

const preflightIcons = {
  pass: CheckCircle2,
  warn: AlertTriangle,
  fail: XCircle,
} as const;

// Update check constants
const REGISTRY_UPDATES_CHECK_KEY = 'devchain:registryUpdatesLastCheck';
const UPDATE_CHECK_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

export function Layout(props: LayoutProps) {
  return (
    <BreadcrumbsProvider>
      <TerminalWindowsProvider>
        <LayoutShell {...props} />
      </TerminalWindowsProvider>
    </BreadcrumbsProvider>
  );
}

function LayoutShell({ children }: LayoutProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const {
    projects,
    projectsLoading,
    projectsError,
    refetchProjects,
    selectedProjectId,
    selectedProject,
    setSelectedProjectId,
  } = useSelectedProject();
  const { toast } = useToast();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [theme, setTheme] = useState<ThemeValue>(() => {
    if (typeof window === 'undefined') return 'ocean';
    return getStoredTheme() ?? 'ocean';
  });
  const [dockExpanded, setDockExpanded] = useState<boolean>(() => {
    if (typeof window === 'undefined') {
      return false;
    }
    const stored = window.localStorage.getItem(DOCK_EXPANDED_STORAGE_KEY);
    return stored === 'true';
  });
  const [dockSessions, setDockSessions] = useState<ActiveSession[]>([]);
  const [autoCompactBlock, setAutoCompactBlock] = useState<AutoCompactBlock | null>(null);

  // Section collapse state - collapsible sections start collapsed
  const [collapsedSections, setCollapsedSections] = useState<Record<string, boolean>>({
    'project-config': true,
    system: true,
  });

  // Registry update indicator state
  const [hasRegistryUpdates, setHasRegistryUpdates] = useState(false);

  useAppSocket({
    message: (envelope: WsEnvelope) => {
      if (envelope.topic !== 'system' || envelope.type !== 'session_blocked') {
        return;
      }

      const payload =
        envelope.payload && typeof envelope.payload === 'object'
          ? (envelope.payload as Record<string, unknown>)
          : null;
      if (!payload || payload.reason !== 'claude_auto_compact') {
        return;
      }
      if (payload.silent === true) {
        return;
      }

      setAutoCompactBlock((current) => {
        if (current) {
          return current;
        }
        return {
          agentName:
            typeof payload.agentName === 'string' && payload.agentName.trim().length > 0
              ? payload.agentName
              : 'Unknown',
          providerId: typeof payload.providerId === 'string' ? payload.providerId : '',
          providerName:
            typeof payload.providerName === 'string' && payload.providerName.trim().length > 0
              ? payload.providerName
              : 'claude',
        };
      });
    },
  });

  // Check if we should run update check (throttled to every 30 min)
  const shouldCheckUpdates = useMemo(() => {
    if (typeof window === 'undefined') return false;
    const lastCheck = window.localStorage.getItem(REGISTRY_UPDATES_CHECK_KEY);
    if (!lastCheck) return true;
    const lastCheckTime = parseInt(lastCheck, 10);
    return Date.now() - lastCheckTime > UPDATE_CHECK_INTERVAL_MS;
  }, []);

  // Fetch cached templates for update check
  const { data: updateCheckTemplates } = useQuery({
    queryKey: ['templates-for-update-check'],
    queryFn: fetchCachedTemplates,
    enabled: shouldCheckUpdates,
    staleTime: UPDATE_CHECK_INTERVAL_MS,
  });

  // Run update check when templates data is available - compares cached vs remote versions
  useEffect(() => {
    if (!updateCheckTemplates) return;

    let cancelled = false;

    const runCheck = async () => {
      const hasUpdates = await hasAnyTemplateUpdates(updateCheckTemplates);
      if (cancelled) return;

      setHasRegistryUpdates(hasUpdates);

      // Record check timestamp
      if (typeof window !== 'undefined') {
        window.localStorage.setItem(REGISTRY_UPDATES_CHECK_KEY, String(Date.now()));
      }
    };

    runCheck();

    return () => {
      cancelled = true;
    };
  }, [updateCheckTemplates]);

  // Clear update indicator when navigating to Registry page
  useEffect(() => {
    if (location.pathname === '/registry' || location.pathname.startsWith('/registry/')) {
      setHasRegistryUpdates(false);
    }
  }, [location.pathname]);

  // Toggle section collapse state
  const toggleSection = useCallback((sectionId: string) => {
    setCollapsedSections((prev) => ({
      ...prev,
      [sectionId]: !prev[sectionId],
    }));
  }, []);

  // Auto-expand section when child route is active
  useEffect(() => {
    const currentPath = location.pathname;
    // Find section containing the active route
    for (const section of navSections) {
      if (!section.collapsible) continue; // Skip non-collapsible sections
      const hasActiveItem = section.items.some(
        (item) => currentPath === item.path || currentPath.startsWith(item.path + '/'),
      );
      if (hasActiveItem && collapsedSections[section.id]) {
        // Expand the section containing the active route
        setCollapsedSections((prev) => ({
          ...prev,
          [section.id]: false,
        }));
        break; // Only expand one section
      }
    }
  }, [location.pathname, collapsedSections]);

  const openTerminalWindow = useTerminalWindowManager();
  const {
    windows: terminalWindows,
    closeWindow,
    focusedWindowId,
    focusWindow,
    minimizeWindow,
    restoreWindow,
  } = useTerminalWindows();
  const restoredWindowsRef = useRef(false);
  const lastKeyRef = useRef<{ key: string; timestamp: number } | null>(null);
  const usedShortcutsRef = useRef<Set<string>>(new Set());

  const announceShortcut = useCallback(
    (id: string, description: string) => {
      if (usedShortcutsRef.current.has(id)) {
        return;
      }
      usedShortcutsRef.current.add(id);
      toast({
        title: 'Shortcut activated',
        description,
      });
    },
    [toast],
  );

  const toggleTerminalDock = useCallback(() => {
    setDockExpanded((prev) => !prev);
  }, []);

  const focusPrimarySearch = useCallback(() => {
    const searchElement = document.querySelector<HTMLElement>('[data-shortcut="primary-search"]');
    if (searchElement) {
      searchElement.focus();
      announceShortcut('slash-search', 'Focused page search (shortcut /)');
    } else {
      toast({
        title: 'Search unavailable',
        description: 'This page does not expose a primary search input.',
      });
    }
  }, [announceShortcut, toast]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    window.localStorage.setItem(DOCK_EXPANDED_STORAGE_KEY, dockExpanded ? 'true' : 'false');
  }, [dockExpanded]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    const handleOpenDock = () => setDockExpanded(true);
    window.addEventListener(OPEN_TERMINAL_DOCK_EVENT, handleOpenDock);
    return () => {
      window.removeEventListener(OPEN_TERMINAL_DOCK_EVENT, handleOpenDock);
    };
  }, [setDockExpanded]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) {
        return;
      }

      const target = event.target as HTMLElement | null;
      const tagName = target?.tagName ?? '';
      const isEditable =
        target?.isContentEditable ||
        tagName === 'INPUT' ||
        tagName === 'TEXTAREA' ||
        tagName === 'SELECT';

      const visibleWindows = terminalWindows.filter((window) => !window.minimized);
      const focusedWindow = focusedWindowId
        ? terminalWindows.find((window) => window.id === focusedWindowId)
        : null;

      // Alt+Shift+X: Toggle all terminal windows (minimize if any visible, restore if all minimized)
      if (
        !isEditable &&
        event.altKey &&
        event.shiftKey &&
        !event.metaKey &&
        !event.ctrlKey &&
        event.code === 'KeyX'
      ) {
        if (terminalWindows.length === 0) {
          return;
        }

        event.preventDefault();
        const allMinimized = visibleWindows.length === 0;

        if (allMinimized) {
          // All minimized: restore all
          terminalWindows.forEach((w) => restoreWindow(w.id));
        } else {
          // Some visible: minimize all
          visibleWindows.forEach((w) => minimizeWindow(w.id));
        }
        return;
      }

      if (event.altKey && !event.metaKey && !event.ctrlKey && event.key === '`') {
        if (visibleWindows.length > 0) {
          event.preventDefault();
          const sortedWindows = [...visibleWindows].sort((a, b) => a.zIndex - b.zIndex);
          if (!focusedWindow) {
            const nextWindow = sortedWindows[sortedWindows.length - 1];
            focusWindow(nextWindow.id);
            toast({
              title: 'Window focused',
              description: nextWindow.title,
            });
          } else {
            const currentIndex = sortedWindows.findIndex(
              (window) => window.id === focusedWindow.id,
            );
            const nextWindow =
              currentIndex === -1 || currentIndex === sortedWindows.length - 1
                ? sortedWindows[0]
                : sortedWindows[currentIndex + 1];
            focusWindow(nextWindow.id);
            toast({
              title: 'Window focused',
              description: nextWindow.title,
            });
          }
        }
        return;
      }

      const now = Date.now();
      if (lastKeyRef.current && now - lastKeyRef.current.timestamp > 1000) {
        lastKeyRef.current = null;
      }

      if ((event.metaKey || event.ctrlKey) && event.key === '?') {
        event.preventDefault();
        setShowShortcuts(true);
        announceShortcut('open-help', 'Opened keyboard shortcuts (Cmd/Ctrl + ?)');
        return;
      }

      if (isEditable) {
        if (!event.metaKey && !event.ctrlKey && !event.altKey && event.key === 'Enter') {
          if (focusedWindow?.handle?.focus) {
            event.preventDefault();
            focusedWindow.handle.focus();
            toast({
              title: 'Terminal focused',
              description: focusedWindow.title,
            });
          }
        }
        return;
      }

      if (!event.metaKey && !event.ctrlKey && !event.altKey && event.key === 'Enter') {
        if (focusedWindow?.handle?.focus) {
          event.preventDefault();
          focusedWindow.handle.focus();
          toast({
            title: 'Terminal focused',
            description: focusedWindow.title,
          });
          return;
        }
      }

      if (event.key === 'g' && !event.metaKey && !event.ctrlKey && !event.altKey) {
        lastKeyRef.current = { key: 'g', timestamp: now };
        return;
      }

      if (
        (event.key === 'p' || event.key === 'b' || event.key === 'c' || event.key === 'r') &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey
      ) {
        if (lastKeyRef.current?.key === 'g' && now - lastKeyRef.current.timestamp < 1000) {
          event.preventDefault();
          if (event.key === 'p') {
            navigate('/projects');
            announceShortcut('nav-projects', 'Navigated to Projects (shortcut g p)');
          } else if (event.key === 'b') {
            navigate('/board');
            announceShortcut('nav-board', 'Navigated to Board (shortcut g b)');
          } else if (event.key === 'c') {
            navigate('/chat');
            announceShortcut('nav-chat', 'Navigated to Chat (shortcut g c)');
          } else if (event.key === 'r') {
            navigate('/reviews');
            announceShortcut('nav-reviews', 'Navigated to Reviews (shortcut g r)');
          }
        }
        lastKeyRef.current = null;
        return;
      }

      if (event.key === 't' && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault();
        toggleTerminalDock();
        return;
      }

      if (event.key === '/' && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault();
        focusPrimarySearch();
        lastKeyRef.current = null;
        return;
      }

      lastKeyRef.current = null;
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    announceShortcut,
    focusPrimarySearch,
    focusWindow,
    focusedWindowId,
    minimizeWindow,
    navigate,
    restoreWindow,
    terminalWindows,
    toast,
    toggleTerminalDock,
  ]);

  const isActive = (path: string) => {
    if (path === '/board') {
      return location.pathname === path || location.pathname.startsWith('/epics/');
    }
    return location.pathname === path || location.pathname.startsWith(path + '/');
  };

  const toggleSidebar = () => setSidebarOpen(!sidebarOpen);
  const toggleCollapse = () => setSidebarCollapsed(!sidebarCollapsed);
  const hasProjects = projects.length > 0;
  const projectPath = selectedProject?.rootPath;
  const { items: breadcrumbItems } = useBreadcrumbs();
  const breadcrumbs = useMemo(() => {
    if (breadcrumbItems.length) {
      return breadcrumbItems;
    }
    return buildFallbackBreadcrumbs(location.pathname);
  }, [breadcrumbItems, location.pathname]);

  const {
    data: preflightResult,
    isFetching: preflightFetching,
    isError: preflightError,
  } = useQuery({
    queryKey: ['preflight', projectPath ?? 'global'],
    queryFn: () => fetchPreflightChecks(projectPath),
    staleTime: 60000,
  });

  // Fetch app version from health endpoint
  const { data: healthData } = useQuery({
    queryKey: ['health'],
    queryFn: async () => {
      const res = await fetch('/health');
      if (!res.ok) return null;
      return res.json();
    },
    staleTime: Infinity, // Version doesn't change during runtime
  });
  const appVersion = healthData?.version;

  const preflightStatus = preflightResult?.overall;
  const PreflightIcon = preflightStatus ? preflightIcons[preflightStatus] : AlertCircle;
  const preflightBadgeClass = preflightStatus
    ? preflightStatusStyles[preflightStatus]
    : preflightError
      ? 'border-destructive/40 bg-destructive/10 text-destructive hover:bg-destructive/20'
      : 'border-border text-muted-foreground hover:bg-muted';
  const preflightBadgeLabel = preflightStatus
    ? `Preflight ${preflightStatus.toUpperCase()}`
    : preflightError
      ? 'Preflight ERROR'
      : 'Preflight CHECKING';
  const preflightTooltipTarget = selectedProject?.name ?? 'system';
  const preflightTooltip = preflightResult
    ? `Preflight status for ${preflightTooltipTarget} • Checked ${new Date(preflightResult.timestamp).toLocaleTimeString()}`
    : preflightError
      ? `Failed to fetch preflight status for ${preflightTooltipTarget}`
      : `Fetching preflight status for ${preflightTooltipTarget}`;
  const preflightDotClass = preflightStatus
    ? preflightDotStyles[preflightStatus]
    : preflightError
      ? 'bg-destructive'
      : 'bg-muted-foreground';
  const preflightFooterTextClass = preflightStatus
    ? preflightStatus === 'pass'
      ? 'text-emerald-600'
      : preflightStatus === 'warn'
        ? 'text-amber-600'
        : 'text-destructive'
    : preflightError
      ? 'text-destructive'
      : 'text-muted-foreground';

  const handleProjectChange = (projectId: string) => {
    setSelectedProjectId(projectId);
  };

  const handleDockSessionsChange = useCallback(
    (sessionsList: ActiveSession[]) => {
      setDockSessions(sessionsList);
      const sessionIds = new Set(sessionsList.map((session) => session.id));
      terminalWindows.forEach((window) => {
        if (window.sessionId && !sessionIds.has(window.sessionId)) {
          closeWindow(window.id);
        }
      });
    },
    [closeWindow, terminalWindows],
  );

  const handleDockSessionTerminated = useCallback(
    (sessionId: string) => {
      closeWindow(sessionId);
    },
    [closeWindow],
  );

  const openSessionIds = useMemo(
    () =>
      terminalWindows
        .filter((window) => window.sessionId)
        .map((window) => window.sessionId!)
        .sort(),
    [terminalWindows],
  );

  const activeWindowSessionId = useMemo(() => {
    if (!focusedWindowId) {
      return null;
    }
    const focusedWindow = terminalWindows.find((window) => window.id === focusedWindowId);
    return focusedWindow?.sessionId ?? null;
  }, [focusedWindowId, terminalWindows]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    window.localStorage.setItem(OPEN_SESSIONS_STORAGE_KEY, JSON.stringify(openSessionIds));
  }, [openSessionIds]);

  useEffect(() => {
    if (restoredWindowsRef.current) {
      return;
    }
    if (!dockSessions.length) {
      return;
    }
    if (typeof window === 'undefined') {
      return;
    }

    const persisted = window.localStorage.getItem(OPEN_SESSIONS_STORAGE_KEY);
    if (!persisted) {
      restoredWindowsRef.current = true;
      return;
    }

    try {
      const storedSessionIds = JSON.parse(persisted) as string[];
      storedSessionIds.forEach((sessionId) => {
        const session = dockSessions.find((item) => item.id === sessionId);
        if (session && !terminalWindows.some((window) => window.id === sessionId)) {
          openTerminalWindow(session);
        }
      });
    } catch {
      // ignore malformed persistence payloads
    } finally {
      restoredWindowsRef.current = true;
    }
  }, [dockSessions, openTerminalWindow, terminalWindows]);

  return (
    <ToastHost>
      <div
        className={cn(
          'flex h-screen overflow-hidden bg-background',
          sidebarCollapsed && 'sidebar-collapsed',
        )}
      >
        {/* Mobile Sidebar Overlay */}
        {sidebarOpen && (
          <div
            className="fixed inset-0 z-40 bg-black/50 lg:hidden"
            onClick={toggleSidebar}
            aria-hidden="true"
          />
        )}

        {/* Sidebar */}
        <aside
          className={cn(
            'fixed inset-y-0 left-0 z-50 flex flex-col border-r border-border bg-card transition-all duration-300 lg:relative lg:translate-x-0',
            sidebarOpen ? 'translate-x-0' : '-translate-x-full',
            sidebarCollapsed ? 'w-16' : 'w-64',
          )}
          aria-label="Sidebar navigation"
        >
          {/* Sidebar Header */}
          <div className="flex h-16 items-center justify-between border-b border-border px-4">
            {!sidebarCollapsed && (
              <div className="flex items-center gap-2">
                <h1 className="text-xl font-bold">Devchain</h1>
                <Link
                  to="/settings"
                  onClick={() => setSidebarOpen(false)}
                  className={cn(
                    'relative flex h-7 w-7 items-center justify-center rounded-md border transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2',
                    preflightBadgeClass,
                  )}
                  title={preflightTooltip}
                  aria-label={preflightBadgeLabel}
                >
                  <PreflightIcon className="h-3.5 w-3.5" aria-hidden="true" />
                  {preflightFetching && (
                    <Loader2
                      className="absolute top-0 right-0 h-2.5 w-2.5 animate-spin"
                      aria-hidden="true"
                    />
                  )}
                  <span className="sr-only">View preflight details</span>
                </Link>
              </div>
            )}
            <Button
              variant="ghost"
              size="sm"
              className={cn('hidden lg:flex', sidebarCollapsed && 'mx-auto')}
              onClick={toggleCollapse}
              aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            >
              {sidebarCollapsed ? (
                <ChevronRight className="h-4 w-4" />
              ) : (
                <ChevronLeft className="h-4 w-4" />
              )}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="lg:hidden"
              onClick={toggleSidebar}
              aria-label="Close sidebar"
            >
              <X className="h-5 w-5" />
            </Button>
          </div>

          {/* Navigation */}
          <nav className="flex-1 overflow-y-auto p-2" aria-label="Main navigation">
            {navSections.map((section, sectionIndex) => {
              const isCollapsed = collapsedSections[section.id] ?? false;

              return (
                <div key={section.id}>
                  {/* Visual separator between sections (not before first) */}
                  {sectionIndex > 0 && (
                    <div className="my-2 border-t border-border" aria-hidden="true" />
                  )}

                  {/* Section header for collapsible sections (hidden when sidebar collapsed) */}
                  {section.collapsible && section.title && !sidebarCollapsed && (
                    <button
                      type="button"
                      onClick={() => toggleSection(section.id)}
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground transition-colors rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                      aria-expanded={!isCollapsed}
                      aria-controls={`${section.id}-items`}
                    >
                      <ChevronDown
                        className={cn('h-3 w-3 transition-transform', isCollapsed && '-rotate-90')}
                        aria-hidden="true"
                      />
                      {section.title}
                    </button>
                  )}

                  {/* Items: show if expanded, OR sidebar collapsed (icon mode), OR not collapsible */}
                  {(!isCollapsed || sidebarCollapsed || !section.collapsible) && (
                    <ul id={`${section.id}-items`} className="space-y-1">
                      {section.items.map((item) => {
                        const Icon = item.icon;
                        const active = isActive(item.path);
                        const hasUpdates = item.label === 'Registry' && hasRegistryUpdates;

                        // Preload lazy-loaded pages on hover for faster navigation
                        const preloadHandlers =
                          item.path === '/reviews'
                            ? {
                                onMouseEnter: preloadReviewsPage,
                                onFocus: preloadReviewsPage,
                              }
                            : {};

                        return (
                          <li key={item.path}>
                            <Link
                              to={item.path}
                              onClick={() => setSidebarOpen(false)}
                              {...preloadHandlers}
                              className={cn(
                                'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                                'hover:bg-muted',
                                active
                                  ? 'bg-secondary text-secondary-foreground'
                                  : 'text-muted-foreground',
                                sidebarCollapsed && 'justify-center',
                              )}
                              aria-current={active ? 'page' : undefined}
                              title={sidebarCollapsed ? item.label : undefined}
                            >
                              <Icon
                                className={cn('h-5 w-5', hasUpdates && 'text-blue-500')}
                                aria-hidden="true"
                              />
                              {!sidebarCollapsed && <span>{item.label}</span>}
                            </Link>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              );
            })}
          </nav>

          {/* Sidebar Footer - Preflight Status & Version (aligned with dock h-12) */}
          <div className="flex h-12 items-center justify-between border-t border-border px-4">
            <div className="flex items-center gap-2 text-sm">
              <div className={cn('h-2 w-2 rounded-full', preflightDotClass)} aria-hidden="true" />
              {!sidebarCollapsed && (
                <span className={preflightFooterTextClass}>{preflightBadgeLabel}</span>
              )}
            </div>
            {!sidebarCollapsed && appVersion && (
              <span className="text-xs text-muted-foreground">v{appVersion}</span>
            )}
          </div>
        </aside>

        {/* Main Content Area */}
        <div className="flex flex-1 flex-col overflow-hidden">
          {/* Header */}
          <header className="flex h-16 items-center justify-between border-b border-border bg-card px-4 lg:px-6">
            <div className="flex items-center gap-4">
              <Button
                variant="ghost"
                size="sm"
                className="lg:hidden"
                onClick={toggleSidebar}
                aria-label="Open sidebar"
              >
                <Menu className="h-5 w-5" />
              </Button>
              <div className="hidden max-w-[360px] flex-1 truncate md:flex">
                <Breadcrumbs
                  items={breadcrumbs}
                  className="text-muted-foreground [&_a]:text-muted-foreground [&_a:hover]:text-foreground"
                />
              </div>
            </div>

            <div className="flex items-center gap-2">
              {/* Project selector placeholder */}
              {/* Command menu button placeholder */}
              {projectsError ? (
                <div className="flex items-center gap-2">
                  <span className="text-sm text-destructive">Failed to load projects</span>
                  <Button variant="ghost" size="sm" onClick={() => refetchProjects()}>
                    Retry
                  </Button>
                </div>
              ) : projectsLoading ? (
                <span className="text-sm text-muted-foreground">Loading projects...</span>
              ) : hasProjects ? (
                <Select value={selectedProjectId} onValueChange={handleProjectChange}>
                  <SelectTrigger
                    className="w-64"
                    aria-label={selectedProjectId ? 'Selected project' : 'Select a project'}
                  >
                    <SelectValue placeholder="Select a project" />
                  </SelectTrigger>
                  <SelectContent>
                    {projects.map((project) => (
                      <SelectItem key={project.id} value={project.id}>
                        {project.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <Link to="/projects" className="text-sm text-muted-foreground hover:underline">
                  No projects yet? Create one
                </Link>
              )}
              {/* Epic search: available when project selected, hidden on small screens */}
              {selectedProjectId && (
                <EpicSearchInput projectId={selectedProjectId} className="hidden lg:block" />
              )}
              {/* Theme toggle: inline on >=sm, popover on small screens */}
              <div className="hidden sm:block">
                <ThemeSelect value={theme} onChange={setTheme} />
              </div>
              <div className="sm:hidden">
                <Popover>
                  <PopoverTrigger asChild>
                    <Button variant="ghost" size="icon" aria-label="Change theme">
                      {theme === 'dark' ? (
                        <Moon className="h-4 w-4" />
                      ) : (
                        <Waves className="h-4 w-4" />
                      )}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent align="end">
                    <ThemeSelect value={theme} onChange={setTheme} />
                  </PopoverContent>
                </Popover>
              </div>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setShowShortcuts(true)}
                aria-label="Open keyboard shortcuts"
              >
                <Keyboard className="h-4 w-4" />
              </Button>
            </div>
          </header>

          {/* Main Content */}
          <main className="flex-1 overflow-y-auto">
            <div className="flex h-full min-h-0 flex-col px-4 py-3">{children}</div>
          </main>

          <TerminalDock
            expanded={dockExpanded}
            sessions={dockSessions}
            activeSessionId={activeWindowSessionId}
            openSessionIds={openSessionIds}
            onToggle={toggleTerminalDock}
            onOpenSession={(session) => {
              setDockExpanded(true);
              openTerminalWindow(session);
            }}
            onSessionsChange={handleDockSessionsChange}
            onSessionTerminated={handleDockSessionTerminated}
          />
        </div>
      </div>
      <TerminalWindowsLayer />
      <Dialog open={showShortcuts} onOpenChange={setShowShortcuts}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Keyboard Shortcuts</DialogTitle>
            <DialogDescription>
              Use these shortcuts to navigate quickly and control the terminal dock.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            {SHORTCUTS.map((shortcut) => (
              <div
                key={shortcut.keys}
                className="flex items-center justify-between rounded-md border border-border bg-muted/40 px-3 py-2 text-sm"
              >
                <span className="font-mono text-xs uppercase tracking-wide text-muted-foreground">
                  {shortcut.keys}
                </span>
                <span className="text-sm text-foreground">{shortcut.description}</span>
              </div>
            ))}
          </div>
        </DialogContent>
      </Dialog>

      <AutoCompactWarningModal
        open={autoCompactBlock !== null}
        onOpenChange={(open) => {
          if (!open) {
            setAutoCompactBlock(null);
          }
        }}
        providerId={autoCompactBlock?.providerId ?? ''}
        providerName={autoCompactBlock?.providerName ?? 'claude'}
        agentName={autoCompactBlock?.agentName}
        onDisabled={() => {
          setAutoCompactBlock(null);
          toast({
            title: 'Auto-compact disabled',
            description: 'Sessions can now launch normally.',
          });
        }}
      />
    </ToastHost>
  );
}

function buildFallbackBreadcrumbs(pathname: string): BreadcrumbItem[] {
  const segments = pathname.split('/').filter(Boolean);

  if (!segments.length) {
    return [{ label: 'Projects', href: '/projects' }];
  }

  const items: BreadcrumbItem[] = [];

  segments.forEach((segment, index) => {
    const normalized = segment.toLowerCase();
    const defaultHref = `/${segments.slice(0, index + 1).join('/')}`;
    const isLast = index === segments.length - 1;

    // Check for redirect mapping (e.g., /epics → /board)
    const redirect = routeRedirectMap[normalized];
    if (redirect) {
      items.push({
        label: redirect.label,
        href: isLast ? undefined : redirect.href,
      });
      return;
    }

    let label = routeLabelMap[normalized];

    if (!label) {
      if (/^[0-9a-fA-F-]{8,}$/.test(segment) || /^[0-9]+$/.test(segment)) {
        label = 'Details';
      } else {
        label = humanizeSegment(segment);
      }
    }

    items.push({
      label,
      href: isLast ? undefined : defaultHref,
    });
  });

  return items;
}

function humanizeSegment(segment: string) {
  return segment
    .split('-')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}
