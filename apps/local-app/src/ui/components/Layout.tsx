import { ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useSelectedProject } from '../hooks/useProjectSelection';
import { preloadReviewsPage } from '../pages/ReviewsPage.lazy';
import { Button } from './ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import { Badge } from './ui/badge';
import { Breadcrumbs, ToastHost, EpicSearchInput, type BreadcrumbItem } from './shared';
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
import { AutoCompactEnableModal } from './shared/AutoCompactEnableModal';
import { BreadcrumbsProvider, useBreadcrumbs } from '../hooks/useBreadcrumbs';
import { useRuntime } from '../hooks/useRuntime';
import { useOptionalWorktreeTab } from '../hooks/useWorktreeTab';
import { cn } from '../lib/utils';
import { fetchPreflightChecks } from '../lib/preflight';
import type { ActiveSession } from '../lib/sessions';
import type { WsEnvelope } from '../lib/socket';
import {
  Menu,
  X,
  ChevronDown,
  ChevronLeft,
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
  Sparkles,
  GitCompareArrows,
  GitBranch,
} from 'lucide-react';
import { ThemeSelect, type ThemeValue, getStoredTheme } from '@/ui/components/ThemeSelect';
import { Popover, PopoverContent, PopoverTrigger } from '@/ui/components/ui/popover';
import { listWorktrees, type WorktreeSummary } from '@/modules/orchestrator/ui/app/lib/worktrees';
import {
  WORKTREE_PROXY_UNAVAILABLE_EVENT,
  type WorktreeProxyUnavailableDetail,
} from '@/ui/lib/worktree-fetch-interceptor';

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

interface RegistryUpdateStatusResult {
  hasUpdate: boolean;
}

interface RegistryUpdateStatusResponse {
  state: 'pending' | 'complete' | 'skipped';
  results?: RegistryUpdateStatusResult[];
}

interface KeyboardShortcut {
  keys: string;
  description: string;
  hideInMainMode?: boolean;
}

// Grouped navigation sections for collapsible sidebar
const navSections: NavSection[] = [
  {
    id: 'core',
    collapsible: false,
    items: [
      { label: 'Projects', path: '/projects', icon: FolderOpen },
      { label: 'Worktrees', path: '/worktrees', icon: GitBranch },
      { label: 'Chat', path: '/chat', icon: MessageSquare },
      { label: 'Board', path: '/board', icon: LayoutGrid },
      { label: 'Reviews', path: '/reviews', icon: GitCompareArrows },
      { label: 'Registry', path: '/registry', icon: Package },
      { label: 'Skills', path: '/skills', icon: Sparkles },
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

const SHORTCUTS: KeyboardShortcut[] = [
  { keys: 'g p', description: 'Go to Projects' },
  { keys: 'g w', description: 'Go to Worktrees' },
  { keys: 'g c', description: 'Go to Chat' },
  { keys: 'g b', description: 'Go to Board' },
  { keys: 'g r', description: 'Go to Reviews' },
  { keys: 't', description: 'Toggle terminal dock', hideInMainMode: true },
  { keys: 'Alt+Shift+X', description: 'Toggle all terminal windows', hideInMainMode: true },
  { keys: 'Alt + `', description: 'Cycle terminal windows', hideInMainMode: true },
  { keys: 'Enter', description: 'Focus active terminal input', hideInMainMode: true },
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

const SIDEBAR_COLLAPSED_STORAGE_KEY = 'devchain:sidebarCollapsed';
const DOCK_EXPANDED_STORAGE_KEY = 'devchain:dockExpanded';
const OPEN_SESSIONS_STORAGE_KEY = 'devchain:terminalOpenSessionIds';
const WORKTREE_TAB_REFRESH_MS = 15_000;

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
const PROXYABLE_WORKTREE_STATUSES = new Set(['running', 'completed']);

interface WorktreeVisualStatus {
  label: string;
  badgeClassName: string;
  showSpinner?: boolean;
}

interface WorktreeStatusBanner {
  title: string;
  message: string;
  tone: 'warning' | 'error';
}

function getWorktreeVisualStatus(status: string): WorktreeVisualStatus {
  const normalized = status.toLowerCase();
  if (normalized === 'running') {
    return {
      label: 'Running',
      badgeClassName:
        'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
    };
  }
  if (normalized === 'stopped') {
    return {
      label: 'Stopped',
      badgeClassName: 'border-slate-400/40 bg-slate-500/10 text-slate-700 dark:text-slate-300',
    };
  }
  if (normalized === 'error') {
    return {
      label: 'Error',
      badgeClassName: 'border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-300',
    };
  }
  if (normalized === 'creating') {
    return {
      label: 'Creating',
      badgeClassName: 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300',
      showSpinner: true,
    };
  }
  return {
    label: normalized.charAt(0).toUpperCase() + normalized.slice(1),
    badgeClassName: 'border-slate-400/40 bg-slate-500/10 text-slate-700 dark:text-slate-300',
  };
}

export function Layout(props: LayoutProps) {
  const { isMainMode } = useRuntime();

  return (
    <BreadcrumbsProvider>
      <TerminalWindowsProvider>
        <LayoutShell {...props} isMainMode={isMainMode} />
        <TerminalWindowsLayer />
      </TerminalWindowsProvider>
    </BreadcrumbsProvider>
  );
}

function LayoutShell({ children, isMainMode }: LayoutProps & { isMainMode: boolean }) {
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
  const { activeWorktree, setActiveWorktree } = useOptionalWorktreeTab();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    if (typeof window === 'undefined') return false;
    if (window.innerWidth < 1024) return false;
    return window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === 'true';
  });
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

  // Section collapse state - collapsible sections start collapsed
  const [collapsedSections, setCollapsedSections] = useState<Record<string, boolean>>({
    'project-config': true,
    system: true,
  });

  // Registry update indicator state
  const [hasRegistryUpdates, setHasRegistryUpdates] = useState(false);
  const [proxyUnavailableDetail, setProxyUnavailableDetail] =
    useState<WorktreeProxyUnavailableDetail | null>(null);
  const [autoCompactRec, setAutoCompactRec] = useState<{
    providerId: string;
    providerName: string;
    bootId: string;
  } | null>(null);
  const switchedAwayWorktreeRef = useRef<string | null>(null);

  useAppSocket({
    message: (envelope: WsEnvelope) => {
      if (envelope.topic !== 'system' || envelope.type !== 'session_recommendation') {
        return;
      }

      const payload =
        envelope.payload && typeof envelope.payload === 'object'
          ? (envelope.payload as Record<string, unknown>)
          : null;
      if (!payload || payload.reason !== 'claude_auto_compact_disabled') {
        return;
      }
      if (payload.silent === true) {
        return;
      }

      const providerId = typeof payload.providerId === 'string' ? payload.providerId : '';
      if (!providerId) return;

      const providerName =
        typeof payload.providerName === 'string' ? payload.providerName : 'Claude';
      const bootId = typeof payload.bootId === 'string' ? payload.bootId : '';

      // Show-once: check localStorage to avoid repeat recommendations.
      // When bootId is present, suppress only if stored value matches current bootId
      // (server restart generates a new bootId → modal re-appears).
      // When bootId is absent (backward compat), fall back to any-truthy check.
      const storageKey = `devchain:autoCompact:recommended:${providerId}`;
      if (bootId && localStorage.getItem(storageKey) === bootId) return;
      if (!bootId && localStorage.getItem(storageKey)) return;

      setAutoCompactRec({ providerId, providerName, bootId });
    },
  });

  // Fetch backend-computed registry update status.
  const { data: registryUpdateStatus } = useQuery({
    queryKey: ['registry-update-status'],
    queryFn: async (): Promise<RegistryUpdateStatusResponse> => {
      const response = await fetch('/api/registry/update-status');
      if (!response.ok) {
        return { state: 'skipped', results: [] };
      }

      const data = (await response.json()) as Partial<RegistryUpdateStatusResponse>;
      if (data.state !== 'pending' && data.state !== 'complete' && data.state !== 'skipped') {
        return { state: 'skipped', results: [] };
      }

      return {
        state: data.state,
        results: Array.isArray(data.results)
          ? data.results.filter(
              (result): result is RegistryUpdateStatusResult =>
                !!result && typeof result === 'object' && typeof result.hasUpdate === 'boolean',
            )
          : [],
      };
    },
    refetchInterval: (query) => {
      const data = query.state.data as RegistryUpdateStatusResponse | undefined;
      return data?.state === 'pending' ? 5000 : false;
    },
  });

  // Apply backend result to nav badge state.
  useEffect(() => {
    if (!registryUpdateStatus || registryUpdateStatus.state !== 'complete') {
      return;
    }

    setHasRegistryUpdates(
      registryUpdateStatus.results?.some((result) => result.hasUpdate) ?? false,
    );
  }, [registryUpdateStatus]);

  // Clear update indicator when navigating to Registry page
  useEffect(() => {
    if (location.pathname === '/registry' || location.pathname.startsWith('/registry/')) {
      setHasRegistryUpdates(false);
    }
  }, [location.pathname]);

  // Redirect away from hidden pages when worktree tab becomes active
  useEffect(() => {
    if (!activeWorktree) return;
    const path = location.pathname;
    if (
      path === '/worktrees' ||
      path.startsWith('/worktrees/') ||
      path === '/registry' ||
      path.startsWith('/registry/')
    ) {
      navigate('/board', { replace: true });
    }
  }, [activeWorktree, location.pathname, navigate]);

  const availableShortcuts = useMemo(
    () =>
      SHORTCUTS.filter((shortcut) => {
        if (isMainMode && shortcut.hideInMainMode) return false;
        if (activeWorktree && shortcut.keys === 'g w') return false;
        return true;
      }),
    [isMainMode, activeWorktree],
  );
  const visibleNavSections = useMemo(() => {
    if (!activeWorktree) return navSections;
    const hiddenPaths = new Set(['/worktrees', '/registry']);
    return navSections.map((section) => {
      const filtered = section.items.filter((item) => !hiddenPaths.has(item.path));
      return filtered.length === section.items.length ? section : { ...section, items: filtered };
    });
  }, [activeWorktree]);
  const {
    data: worktreesData,
    isLoading: worktreesLoading,
    error: worktreesError,
  } = useQuery({
    queryKey: ['worktree-tabs-worktrees'],
    queryFn: () => listWorktrees(),
    enabled: isMainMode,
    refetchInterval: isMainMode ? WORKTREE_TAB_REFRESH_MS : false,
    refetchOnWindowFocus: true,
  });
  const worktreeTabs = useMemo(() => worktreesData ?? [], [worktreesData]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const handleProxyUnavailable = (event: Event) => {
      const detail = (event as CustomEvent<WorktreeProxyUnavailableDetail>).detail;
      if (
        !detail ||
        typeof detail !== 'object' ||
        typeof detail.worktreeName !== 'string' ||
        detail.worktreeName.trim().length === 0
      ) {
        return;
      }

      setProxyUnavailableDetail(detail);
    };

    window.addEventListener(WORKTREE_PROXY_UNAVAILABLE_EVENT, handleProxyUnavailable);
    return () => {
      window.removeEventListener(WORKTREE_PROXY_UNAVAILABLE_EVENT, handleProxyUnavailable);
    };
  }, []);

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
    for (const section of visibleNavSections) {
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
  }, [location.pathname, collapsedSections, visibleNavSections]);

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

  const handleAutoCompactEnabled = useCallback(() => {
    if (autoCompactRec) {
      localStorage.setItem(
        `devchain:autoCompact:recommended:${autoCompactRec.providerId}`,
        autoCompactRec.bootId || 'true',
      );
    }
    toast({
      title: 'Auto-compact enabled',
      description: 'Future Claude sessions will use auto-compact for better context management.',
    });
    setAutoCompactRec(null);
  }, [autoCompactRec, toast]);

  const handleAutoCompactSkipped = useCallback(() => {
    if (autoCompactRec) {
      localStorage.setItem(
        `devchain:autoCompact:recommended:${autoCompactRec.providerId}`,
        autoCompactRec.bootId || 'true',
      );
    }
    setAutoCompactRec(null);
  }, [autoCompactRec]);

  // Persist sidebar collapsed state
  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, sidebarCollapsed ? 'true' : 'false');
  }, [sidebarCollapsed]);

  // Force-expand sidebar on small screens to prevent mobile UX trap
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mql = window.matchMedia('(min-width: 1024px)');
    const handler = (e: MediaQueryListEvent) => {
      if (!e.matches) setSidebarCollapsed(false);
    };
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, []);

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
    if (isMainMode) {
      return;
    }
    const handleOpenDock = () => setDockExpanded(true);
    window.addEventListener(OPEN_TERMINAL_DOCK_EVENT, handleOpenDock);
    return () => {
      window.removeEventListener(OPEN_TERMINAL_DOCK_EVENT, handleOpenDock);
    };
  }, [isMainMode, setDockExpanded]);

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
        !isMainMode &&
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

      if (!isMainMode && event.altKey && !event.metaKey && !event.ctrlKey && event.key === '`') {
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
          if (!isMainMode && focusedWindow?.handle?.focus) {
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
        if (!isMainMode && focusedWindow?.handle?.focus) {
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
        (event.key === 'p' ||
          event.key === 'w' ||
          event.key === 'b' ||
          event.key === 'c' ||
          event.key === 'r') &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey
      ) {
        if (lastKeyRef.current?.key === 'g' && now - lastKeyRef.current.timestamp < 1000) {
          event.preventDefault();
          if (event.key === 'p') {
            navigate('/projects');
            announceShortcut('nav-projects', 'Navigated to Projects (shortcut g p)');
          } else if (event.key === 'w' && !activeWorktree) {
            navigate('/worktrees');
            announceShortcut('nav-worktrees', 'Navigated to Worktrees (shortcut g w)');
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

      if (!isMainMode && event.key === 't' && !event.metaKey && !event.ctrlKey && !event.altKey) {
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
    activeWorktree,
    announceShortcut,
    focusPrimarySearch,
    focusWindow,
    focusedWindowId,
    minimizeWindow,
    navigate,
    isMainMode,
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

  const activeWorktreeName = activeWorktree?.name ?? null;
  const activeWorktreeSummary = useMemo(
    () =>
      activeWorktreeName
        ? (worktreeTabs.find((worktree) => worktree.name === activeWorktreeName) ?? null)
        : null,
    [activeWorktreeName, worktreeTabs],
  );
  const isProjectSelectorLocked = Boolean(activeWorktree);
  const lockedProjectLabel =
    selectedProject?.name ?? activeWorktree?.devchainProjectId ?? 'Worktree project';

  const isWorktreeTabEnabled = useCallback((worktree: WorktreeSummary): boolean => {
    const status = String(worktree.status).toLowerCase();
    return (
      PROXYABLE_WORKTREE_STATUSES.has(status) &&
      typeof worktree.devchainProjectId === 'string' &&
      worktree.devchainProjectId.trim().length > 0 &&
      typeof worktree.containerPort === 'number' &&
      worktree.containerPort > 0
    );
  }, []);

  const selectMainTab = useCallback(() => {
    setActiveWorktree(null);
    setProxyUnavailableDetail(null);
  }, [setActiveWorktree]);

  const selectWorktreeTab = useCallback(
    (worktree: WorktreeSummary) => {
      setProxyUnavailableDetail(null);
      setActiveWorktree({
        id: worktree.id,
        name: worktree.name,
        devchainProjectId: worktree.devchainProjectId ?? null,
        status: worktree.status,
      });
    },
    [setActiveWorktree],
  );

  useEffect(() => {
    if (!activeWorktreeName) {
      return;
    }
    if (worktreesLoading) {
      return;
    }

    const stillExists = worktreeTabs.some((worktree) => worktree.name === activeWorktreeName);
    if (stillExists) {
      return;
    }

    setActiveWorktree(null);
    setProxyUnavailableDetail(null);
    if (switchedAwayWorktreeRef.current !== activeWorktreeName) {
      switchedAwayWorktreeRef.current = activeWorktreeName;
      toast({
        title: 'Switched to Main',
        description: `Worktree "${activeWorktreeName}" was removed and is no longer available.`,
      });
    }
  }, [activeWorktreeName, setActiveWorktree, toast, worktreeTabs, worktreesLoading]);

  useEffect(() => {
    if (!activeWorktreeName || !proxyUnavailableDetail) {
      return;
    }
    if (proxyUnavailableDetail.worktreeName !== activeWorktreeName) {
      return;
    }
    if (proxyUnavailableDetail.statusCode !== 404) {
      return;
    }

    setActiveWorktree(null);
    setProxyUnavailableDetail(null);
    if (switchedAwayWorktreeRef.current !== activeWorktreeName) {
      switchedAwayWorktreeRef.current = activeWorktreeName;
      toast({
        title: 'Switched to Main',
        description: `Worktree "${activeWorktreeName}" was removed and is no longer available.`,
      });
    }
  }, [activeWorktreeName, proxyUnavailableDetail, setActiveWorktree, toast]);

  const activeWorktreeBanner = useMemo<WorktreeStatusBanner | null>(() => {
    if (!activeWorktreeName) {
      return null;
    }

    if (proxyUnavailableDetail && proxyUnavailableDetail.worktreeName === activeWorktreeName) {
      if (proxyUnavailableDetail.statusCode === 503) {
        return {
          tone: 'warning',
          title: 'Worktree unavailable',
          message:
            proxyUnavailableDetail.message ??
            `Worktree "${activeWorktreeName}" is temporarily unavailable.`,
        };
      }

      if (proxyUnavailableDetail.statusCode === 404) {
        return {
          tone: 'error',
          title: 'Worktree removed',
          message:
            proxyUnavailableDetail.message ??
            `Worktree "${activeWorktreeName}" no longer exists and this tab cannot be used.`,
        };
      }
    }

    if (!activeWorktreeSummary) {
      return null;
    }

    const normalizedStatus = String(activeWorktreeSummary.status).trim().toLowerCase();
    if (normalizedStatus === 'error') {
      return {
        tone: 'error',
        title: 'Worktree error',
        message:
          activeWorktreeSummary.errorMessage?.trim() ||
          `Worktree "${activeWorktreeName}" is in an error state.`,
      };
    }

    if (!PROXYABLE_WORKTREE_STATUSES.has(normalizedStatus)) {
      return {
        tone: 'warning',
        title: 'Worktree unavailable',
        message: `Worktree "${activeWorktreeName}" is ${normalizedStatus} and cannot serve proxied requests.`,
      };
    }

    return null;
  }, [activeWorktreeName, activeWorktreeSummary, proxyUnavailableDetail]);

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
            sidebarCollapsed ? 'w-20' : 'w-64',
          )}
          aria-label="Sidebar navigation"
        >
          {/* Sidebar Header */}
          <div
            className={cn(
              'flex h-16 items-center border-b border-border',
              sidebarCollapsed ? 'justify-center px-1' : 'justify-between px-4',
            )}
          >
            {sidebarCollapsed ? (
              <button
                onClick={toggleCollapse}
                className={cn(
                  'relative flex h-8 w-8 items-center justify-center rounded-md border transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2',
                  preflightBadgeClass,
                )}
                title={`Expand sidebar\n${preflightTooltip}`}
                aria-label="Expand sidebar"
              >
                <span className="text-xs font-bold">DC</span>
                {preflightFetching && (
                  <Loader2
                    className="absolute top-0 right-0 h-2.5 w-2.5 animate-spin"
                    aria-hidden="true"
                  />
                )}
              </button>
            ) : (
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
            {!sidebarCollapsed && (
              <Button
                variant="ghost"
                size="sm"
                className="hidden lg:flex"
                onClick={toggleCollapse}
                aria-label="Collapse sidebar"
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
            )}
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
            {visibleNavSections.map((section, sectionIndex) => {
              const isCollapsed = collapsedSections[section.id] ?? false;
              const showItems = !isCollapsed || !section.collapsible;

              return (
                <div key={section.id}>
                  {/* Visual separator between sections (not before first) */}
                  {sectionIndex > 0 && !sidebarCollapsed && (
                    <div className="my-2 border-t border-border" aria-hidden="true" />
                  )}

                  {/* Compact section toggle (sidebar collapsed + collapsible section) */}
                  {sidebarCollapsed && section.collapsible && (
                    <button
                      type="button"
                      onClick={() => toggleSection(section.id)}
                      className="my-1 flex w-full items-center justify-center gap-1 py-1 text-muted-foreground hover:text-foreground transition-colors rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      aria-expanded={!isCollapsed}
                      aria-controls={`${section.id}-items`}
                      title={isCollapsed ? `Show ${section.title}` : `Hide ${section.title}`}
                    >
                      <div className="h-px flex-1 bg-border" />
                      <ChevronDown
                        className={cn(
                          'h-3 w-3 shrink-0 transition-transform',
                          isCollapsed && '-rotate-90',
                        )}
                        aria-hidden="true"
                      />
                      <div className="h-px flex-1 bg-border" />
                    </button>
                  )}

                  {/* Expanded section header (sidebar open + collapsible section) */}
                  {!sidebarCollapsed && section.collapsible && section.title && (
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

                  {/* Items */}
                  {showItems && (
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
                                'flex items-center rounded-md text-sm font-medium transition-colors',
                                'hover:bg-muted',
                                active
                                  ? 'bg-secondary text-secondary-foreground'
                                  : 'text-muted-foreground',
                                sidebarCollapsed
                                  ? 'flex-col gap-0.5 px-1 py-1.5 text-center'
                                  : 'gap-3 px-3 py-2',
                              )}
                              aria-current={active ? 'page' : undefined}
                              title={item.label}
                            >
                              <Icon
                                className={cn('h-5 w-5', hasUpdates && 'text-blue-500')}
                                aria-hidden="true"
                              />
                              <span
                                className={cn(
                                  sidebarCollapsed &&
                                    'w-full truncate text-[10px] leading-tight font-normal',
                                )}
                              >
                                {item.label}
                              </span>
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
          <div
            className={cn(
              'flex h-12 items-center border-t border-border',
              sidebarCollapsed ? 'justify-center px-1' : 'justify-between px-4',
            )}
          >
            <div
              className={cn(
                'flex items-center text-sm',
                sidebarCollapsed ? 'flex-col gap-0.5' : 'gap-2',
              )}
            >
              <div className={cn('h-2 w-2 rounded-full', preflightDotClass)} aria-hidden="true" />
              {sidebarCollapsed ? (
                <span
                  className={cn('truncate text-[10px] leading-tight', preflightFooterTextClass)}
                >
                  {preflightStatus?.toUpperCase() ?? '...'}
                </span>
              ) : (
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
                isProjectSelectorLocked ? (
                  <div
                    data-testid="project-selector-locked"
                    className="flex h-10 w-64 items-center rounded-md border border-input bg-muted/30 px-3 text-sm text-muted-foreground"
                    aria-label="Worktree project locked"
                  >
                    <span className="truncate">{lockedProjectLabel}</span>
                  </div>
                ) : (
                  <Select value={selectedProjectId} onValueChange={handleProjectChange}>
                    <SelectTrigger
                      data-testid="project-selector-select"
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
                )
              ) : isProjectSelectorLocked ? (
                <span
                  data-testid="project-selector-locked"
                  className="text-sm text-muted-foreground"
                  aria-label="Worktree project locked"
                >
                  {lockedProjectLabel}
                </span>
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

          {isMainMode && (worktreeTabs.length > 0 || worktreesLoading) && (
            <div className="border-b border-border bg-card/80">
              <div
                className="flex items-center gap-2 overflow-x-auto px-4 py-2 lg:px-6"
                role="tablist"
                aria-label="Worktree tabs"
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={activeWorktreeName === null}
                  onClick={selectMainTab}
                  className={cn(
                    'inline-flex shrink-0 items-center gap-2 rounded-md border px-3 py-1.5 text-sm font-medium transition-colors',
                    activeWorktreeName === null
                      ? 'border-primary/50 bg-primary/10 text-primary'
                      : 'border-border bg-background text-foreground hover:bg-muted',
                  )}
                >
                  <span>Main</span>
                  <Badge className="border-blue-500/40 bg-blue-500/10 text-blue-700 dark:text-blue-300">
                    Main
                  </Badge>
                </button>

                {worktreesLoading && worktreeTabs.length === 0 && (
                  <div className="inline-flex shrink-0 items-center gap-2 rounded-md border border-border bg-background px-3 py-1.5 text-sm text-muted-foreground">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    Loading worktrees...
                  </div>
                )}

                {worktreesError instanceof Error && (
                  <div className="inline-flex shrink-0 items-center gap-2 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-1.5 text-sm text-red-700 dark:text-red-300">
                    <AlertCircle className="h-3.5 w-3.5" />
                    Failed to load worktrees
                  </div>
                )}

                {worktreeTabs.map((worktree) => {
                  const isActive = activeWorktreeName === worktree.name;
                  const enabled = isWorktreeTabEnabled(worktree);
                  const visualStatus = getWorktreeVisualStatus(String(worktree.status));

                  return (
                    <button
                      key={worktree.id}
                      type="button"
                      role="tab"
                      aria-selected={isActive}
                      disabled={!enabled}
                      onClick={() => selectWorktreeTab(worktree)}
                      className={cn(
                        'inline-flex shrink-0 items-center gap-2 rounded-md border px-3 py-1.5 text-sm font-medium transition-colors',
                        isActive
                          ? 'border-primary/50 bg-primary/10 text-primary'
                          : 'border-border bg-background text-foreground',
                        enabled ? 'hover:bg-muted' : 'cursor-not-allowed opacity-60',
                      )}
                    >
                      <span className="max-w-[180px] truncate">{worktree.name}</span>
                      <Badge className={visualStatus.badgeClassName}>
                        <span className="inline-flex items-center gap-1.5">
                          {visualStatus.showSpinner && <Loader2 className="h-3 w-3 animate-spin" />}
                          {visualStatus.label}
                        </span>
                      </Badge>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {isMainMode && activeWorktreeBanner && (
            <div
              data-testid="worktree-status-banner"
              className={cn(
                'border-b px-4 py-2 lg:px-6',
                activeWorktreeBanner.tone === 'error'
                  ? 'border-red-500/30 bg-red-500/10'
                  : 'border-amber-500/30 bg-amber-500/10',
              )}
            >
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex min-w-0 items-start gap-2">
                  {activeWorktreeBanner.tone === 'error' ? (
                    <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-600 dark:text-red-300" />
                  ) : (
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-300" />
                  )}
                  <div className="min-w-0">
                    <p
                      className={cn(
                        'text-sm font-semibold',
                        activeWorktreeBanner.tone === 'error'
                          ? 'text-red-700 dark:text-red-300'
                          : 'text-amber-700 dark:text-amber-300',
                      )}
                    >
                      {activeWorktreeBanner.title}
                    </p>
                    <p
                      className={cn(
                        'text-xs',
                        activeWorktreeBanner.tone === 'error'
                          ? 'text-red-700/90 dark:text-red-200'
                          : 'text-amber-700/90 dark:text-amber-200',
                      )}
                    >
                      {activeWorktreeBanner.message}
                    </p>
                  </div>
                </div>
                <Button variant="outline" size="sm" onClick={selectMainTab} className="shrink-0">
                  Switch to Main
                </Button>
              </div>
            </div>
          )}

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
      <Dialog open={showShortcuts} onOpenChange={setShowShortcuts}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Keyboard Shortcuts</DialogTitle>
            <DialogDescription>
              Use these shortcuts to navigate quickly and control the terminal dock.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            {availableShortcuts.map((shortcut) => (
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
      <AutoCompactEnableModal
        open={autoCompactRec !== null}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) setAutoCompactRec(null);
        }}
        providerId={autoCompactRec?.providerId ?? ''}
        providerName={autoCompactRec?.providerName ?? ''}
        onEnabled={handleAutoCompactEnabled}
        onSkipped={handleAutoCompactSkipped}
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
