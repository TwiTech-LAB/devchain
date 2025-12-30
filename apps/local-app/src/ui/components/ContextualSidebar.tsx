import { ReactNode, useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from './ui/button';
import { cn } from '../lib/utils';
import { ChevronLeft, ChevronRight, ArrowLeft, X } from 'lucide-react';

interface ContextualSidebarProps {
  /**
   * Content for the sidebar header area
   */
  header?: ReactNode;

  /**
   * Content for saved views section
   */
  savedViews?: ReactNode;

  /**
   * Content for facets/filter blocks
   */
  facets?: ReactNode;

  /**
   * Content for quick actions section
   */
  quickActions?: ReactNode;

  /**
   * Additional content to render at the bottom
   */
  footer?: ReactNode;

  /**
   * Whether the sidebar is visible on mobile
   */
  mobileOpen?: boolean;

  /**
   * Callback when mobile sidebar visibility changes
   */
  onMobileOpenChange?: (open: boolean) => void;

  /**
   * Project ID for persisting section states
   */
  projectId?: string;

  /**
   * Route to navigate back to (defaults to /board)
   */
  backRoute?: string;

  /**
   * Additional CSS classes
   */
  className?: string;

  /**
   * ARIA label for the sidebar
   */
  ariaLabel?: string;
}

interface SectionState {
  savedViewsOpen: boolean;
  facetsOpen: boolean;
  quickActionsOpen: boolean;
}

const DEFAULT_SECTION_STATE: SectionState = {
  savedViewsOpen: true,
  facetsOpen: true,
  quickActionsOpen: true,
};

function getStorageKey(projectId?: string): string {
  return projectId
    ? `devchain:contextualSidebar:${projectId}`
    : 'devchain:contextualSidebar:global';
}

function loadSectionState(projectId?: string): SectionState {
  if (typeof window === 'undefined') {
    return DEFAULT_SECTION_STATE;
  }

  try {
    const stored = window.localStorage.getItem(getStorageKey(projectId));
    if (stored) {
      return { ...DEFAULT_SECTION_STATE, ...JSON.parse(stored) };
    }
  } catch (error) {
    console.error('Failed to load contextual sidebar state', error);
  }

  return DEFAULT_SECTION_STATE;
}

function saveSectionState(state: SectionState, projectId?: string): void {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    window.localStorage.setItem(getStorageKey(projectId), JSON.stringify(state));
  } catch (error) {
    console.error('Failed to save contextual sidebar state', error);
  }
}

/**
 * ContextualSidebar provides a reusable left rail that coexists with the main app sidebar.
 * On desktop, it appears to the right of the icon-only main sidebar.
 * On mobile, it can be toggled via an overlay.
 */
export function ContextualSidebar({
  header,
  savedViews,
  facets,
  quickActions,
  footer,
  mobileOpen = false,
  onMobileOpenChange,
  projectId,
  backRoute = '/board',
  className,
  ariaLabel = 'Contextual sidebar',
}: ContextualSidebarProps) {
  const navigate = useNavigate();
  const [sectionState, setSectionState] = useState<SectionState>(() => loadSectionState(projectId));
  const [isCollapsed, setIsCollapsed] = useState(false);

  useEffect(() => {
    const loaded = loadSectionState(projectId);
    setSectionState(loaded);
  }, [projectId]);

  useEffect(() => {
    saveSectionState(sectionState, projectId);
  }, [sectionState, projectId]);

  const toggleSection = useCallback((section: keyof SectionState) => {
    setSectionState((prev) => ({
      ...prev,
      [section]: !prev[section],
    }));
  }, []);

  const handleBack = useCallback(() => {
    const canGoBack = window.history.length > 1;
    if (canGoBack) {
      navigate(-1);
    } else {
      navigate(backRoute);
    }
  }, [navigate, backRoute]);

  const handleCloseMobile = useCallback(() => {
    onMobileOpenChange?.(false);
  }, [onMobileOpenChange]);

  const toggleCollapse = useCallback(() => {
    setIsCollapsed((prev) => !prev);
  }, []);

  return (
    <>
      {/* Mobile Overlay */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/50 lg:hidden"
          onClick={handleCloseMobile}
          aria-hidden="true"
        />
      )}

      {/* Contextual Sidebar */}
      <aside
        className={cn(
          'fixed inset-y-0 left-16 z-50 flex flex-col border-r border-border bg-card transition-all duration-300 lg:relative lg:left-0 lg:translate-x-0',
          mobileOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0',
          isCollapsed ? 'w-0 opacity-0 lg:w-0' : 'w-72',
          className,
        )}
        aria-label={ariaLabel}
        aria-hidden={isCollapsed}
      >
        {!isCollapsed && (
          <>
            {/* Sidebar Header */}
            <div className="flex h-16 items-center justify-between border-b border-border px-4">
              <Button
                variant="ghost"
                size="sm"
                onClick={handleBack}
                className="gap-2"
                aria-label="Go back"
              >
                <ArrowLeft className="h-4 w-4" />
                <span className="text-sm">Back</span>
              </Button>

              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  className="hidden lg:flex"
                  onClick={toggleCollapse}
                  aria-label="Collapse sidebar"
                >
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="lg:hidden"
                  onClick={handleCloseMobile}
                  aria-label="Close sidebar"
                >
                  <X className="h-5 w-5" />
                </Button>
              </div>
            </div>

            {/* Header Content */}
            {header && <div className="border-b border-border px-4 py-3">{header}</div>}

            {/* Scrollable Content */}
            <div className="flex-1 overflow-y-auto">
              {/* Saved Views Section */}
              {savedViews && (
                <div className="border-b border-border">
                  <button
                    type="button"
                    onClick={() => toggleSection('savedViewsOpen')}
                    className="flex w-full items-center justify-between px-4 py-3 text-sm font-medium hover:bg-muted"
                    aria-expanded={sectionState.savedViewsOpen}
                    aria-controls="saved-views-section"
                  >
                    <span>Saved Views</span>
                    <ChevronRight
                      className={cn(
                        'h-4 w-4 transition-transform',
                        sectionState.savedViewsOpen && 'rotate-90',
                      )}
                    />
                  </button>
                  {sectionState.savedViewsOpen && (
                    <div id="saved-views-section" className="px-4 py-3">
                      {savedViews}
                    </div>
                  )}
                </div>
              )}

              {/* Facets Section */}
              {facets && (
                <div className="border-b border-border">
                  <button
                    type="button"
                    onClick={() => toggleSection('facetsOpen')}
                    className="flex w-full items-center justify-between px-4 py-3 text-sm font-medium hover:bg-muted"
                    aria-expanded={sectionState.facetsOpen}
                    aria-controls="facets-section"
                  >
                    <span>Filters</span>
                    <ChevronRight
                      className={cn(
                        'h-4 w-4 transition-transform',
                        sectionState.facetsOpen && 'rotate-90',
                      )}
                    />
                  </button>
                  {sectionState.facetsOpen && (
                    <div id="facets-section" className="px-4 py-3">
                      {facets}
                    </div>
                  )}
                </div>
              )}

              {/* Quick Actions Section */}
              {quickActions && (
                <div className="border-b border-border">
                  <button
                    type="button"
                    onClick={() => toggleSection('quickActionsOpen')}
                    className="flex w-full items-center justify-between px-4 py-3 text-sm font-medium hover:bg-muted"
                    aria-expanded={sectionState.quickActionsOpen}
                    aria-controls="quick-actions-section"
                  >
                    <span>Quick Actions</span>
                    <ChevronRight
                      className={cn(
                        'h-4 w-4 transition-transform',
                        sectionState.quickActionsOpen && 'rotate-90',
                      )}
                    />
                  </button>
                  {sectionState.quickActionsOpen && (
                    <div id="quick-actions-section" className="px-4 py-3">
                      {quickActions}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Footer Content */}
            {footer && <div className="border-t border-border px-4 py-3">{footer}</div>}
          </>
        )}

        {/* Collapsed State - Show Expand Button */}
        {isCollapsed && (
          <div className="hidden lg:flex h-full items-center justify-center border-r border-border bg-card w-6">
            <Button
              variant="ghost"
              size="sm"
              onClick={toggleCollapse}
              className="h-10 w-6 p-0"
              aria-label="Expand sidebar"
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        )}
      </aside>
    </>
  );
}

/**
 * Hook to manage mobile sidebar state for ContextualSidebar
 */
export function useContextualSidebar() {
  const [mobileOpen, setMobileOpen] = useState(false);

  const openMobileSidebar = useCallback(() => setMobileOpen(true), []);
  const closeMobileSidebar = useCallback(() => setMobileOpen(false), []);
  const toggleMobileSidebar = useCallback(() => setMobileOpen((prev) => !prev), []);

  return {
    mobileOpen,
    openMobileSidebar,
    closeMobileSidebar,
    toggleMobileSidebar,
    setMobileOpen,
  };
}
