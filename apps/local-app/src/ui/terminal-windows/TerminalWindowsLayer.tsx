import { createPortal } from 'react-dom';
import { useEffect, useMemo, useState } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Rnd } from 'react-rnd';
import { MoreVertical } from 'lucide-react';
import { cn } from '@/ui/lib/utils';
import { useTerminalWindows, type TerminalWindowState } from './TerminalWindowsContext';
import { SessionSwitcher } from './SessionSwitcher';
import { TerminalSessionWindowContent } from './TerminalSessionWindow';
import { type ActiveSession } from '@/ui/lib/sessions';

const SAFE_MARGIN = 16;

function useViewportSize() {
  const [size, setSize] = useState(() => ({
    width: typeof window === 'undefined' ? 1280 : window.innerWidth,
    height: typeof window === 'undefined' ? 720 : window.innerHeight,
  }));

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handle = () => {
      setSize({
        width: window.innerWidth,
        height: window.innerHeight,
      });
    };
    window.addEventListener('resize', handle);
    return () => window.removeEventListener('resize', handle);
  }, []);

  return size;
}

interface FloatingWindowProps {
  window: TerminalWindowState;
  isFocused: boolean;
  bounds: { width: number; height: number; x: number; y: number };
  onFocus: () => void;
  onMinimize: () => void;
  onToggleMaximize: () => void;
  onClose: () => void;
  onUpdateBounds: (bounds: { width: number; height: number; x: number; y: number }) => void;
  onSessionSwitch?: (session: ActiveSession) => void;
}

function FloatingWindow({
  window,
  isFocused,
  bounds,
  onFocus,
  onMinimize,
  onToggleMaximize,
  onClose,
  onUpdateBounds,
  onSessionSwitch,
}: FloatingWindowProps) {
  // Trigger terminal fit when bounds change (maximize/restore/resize)
  useEffect(() => {
    if (window.handle?.fit) {
      // Small delay to ensure the DOM has updated
      const timer = setTimeout(() => {
        window.handle?.fit?.();
      }, 50);
      return () => clearTimeout(timer);
    }
  }, [bounds.width, bounds.height, window.handle]);

  // When this floating window gains focus, also focus its terminal to claim resize authority
  useEffect(() => {
    if (isFocused && window.handle?.focus) {
      const timer = setTimeout(() => {
        window.handle?.focus?.();
      }, 0);
      return () => clearTimeout(timer);
    }
  }, [isFocused, window.handle]);

  return (
    <Rnd
      key={window.id}
      size={{ width: bounds.width, height: bounds.height }}
      position={{ x: bounds.x, y: bounds.y }}
      minWidth={480}
      minHeight={280}
      bounds="parent"
      onDragStop={(_, data) => {
        onUpdateBounds({
          width: bounds.width,
          height: bounds.height,
          x: data.x,
          y: data.y,
        });
      }}
      onResizeStop={(_, __, ref, ___, position) => {
        onUpdateBounds({
          width: ref.offsetWidth,
          height: ref.offsetHeight,
          x: position.x,
          y: position.y,
        });
      }}
      enableResizing={!window.maximized}
      disableDragging={window.maximized}
      dragHandleClassName="terminal-window__header"
      style={{ zIndex: window.zIndex, pointerEvents: 'auto' }}
      className="pointer-events-auto"
      onMouseDown={onFocus}
    >
      <div
        className={cn(
          'flex h-full flex-col overflow-hidden rounded-md border border-border bg-background shadow-lg transition-shadow',
          isFocused ? 'shadow-[0_20px_45px_rgba(0,0,0,0.35)]' : 'opacity-90',
        )}
      >
        <header
          className={cn(
            'terminal-window__header flex items-center gap-3 border-b border-border bg-muted px-3 py-2 select-none',
          )}
          onDoubleClick={onToggleMaximize}
        >
          <div className="flex items-center gap-2">
            <button
              type="button"
              aria-label="Minimize window"
              title="Minimize"
              className="flex h-3 w-3 items-center justify-center rounded-full bg-amber-400 text-white"
              onClick={(event) => {
                event.stopPropagation();
                onMinimize();
              }}
            />
            <button
              type="button"
              aria-label={window.maximized ? 'Restore window' : 'Maximize window'}
              title={window.maximized ? 'Restore' : 'Maximize'}
              className="flex h-3 w-3 items-center justify-center rounded-full bg-emerald-500 text-white"
              onClick={(event) => {
                event.stopPropagation();
                onToggleMaximize();
              }}
            />
            <button
              type="button"
              aria-label="Close window"
              title="Close"
              className="flex h-3 w-3 items-center justify-center rounded-full bg-destructive text-white"
              onClick={(event) => {
                event.stopPropagation();
                onClose();
              }}
            />
          </div>
          <div className="flex flex-1 flex-col items-center justify-center text-center">
            <span className="sr-only">{window.title}</span>
            {window.subtitle && <span className="sr-only">{window.subtitle}</span>}
            {window.details &&
            window.details.some(
              (detail) => !detail.hidden && !['Session', 'Epic'].includes(detail.label),
            ) ? (
              <div className="mt-1 flex flex-wrap justify-center gap-1">
                {window.details
                  .filter((detail) => !detail.hidden && !['Session', 'Epic'].includes(detail.label))
                  .map((detail) => (
                    <span
                      key={`${window.id}-${detail.label}`}
                      className="rounded bg-muted px-2 py-0.5 text-[11px] text-muted-foreground"
                      title={detail.title ?? detail.value}
                    >
                      {detail.label !== 'Agent' && (
                        <span className="mr-1 text-muted-foreground/70">{detail.label}:</span>
                      )}
                      <span className="font-medium text-foreground">{detail.value}</span>
                    </span>
                  ))}
              </div>
            ) : null}
          </div>
          {/* Session switcher for terminal windows */}
          {window.sessionId && onSessionSwitch && (
            <SessionSwitcher
              currentSessionId={window.sessionId}
              onSessionSwitch={onSessionSwitch}
            />
          )}
          <div className="flex items-center">
            {window.menuItems && window.menuItems.length > 0 ? (
              <DropdownMenu.Root>
                <DropdownMenu.Trigger asChild>
                  <button
                    type="button"
                    aria-label="Open terminal actions"
                    className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    onClick={(event) => event.stopPropagation()}
                  >
                    <MoreVertical className="h-4 w-4" />
                  </button>
                </DropdownMenu.Trigger>
                <DropdownMenu.Content
                  sideOffset={6}
                  align="end"
                  className="z-[120] min-w-[200px] rounded-md border border-border bg-popover p-1 text-sm shadow-lg focus:outline-none"
                >
                  {window.menuItems.map((item) => (
                    <DropdownMenu.Item
                      key={item.id}
                      className={cn(
                        'flex cursor-pointer select-none items-center justify-between gap-4 rounded-sm px-2 py-1.5 text-sm outline-none focus:bg-muted',
                        item.tone === 'destructive' && 'text-destructive focus:bg-destructive/10',
                        item.disabled && 'cursor-not-allowed opacity-50',
                      )}
                      disabled={item.disabled}
                      onSelect={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        if (item.disabled) {
                          return;
                        }
                        item.onSelect();
                      }}
                    >
                      <span>{item.label}</span>
                      {item.shortcut && (
                        <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
                          {item.shortcut}
                        </span>
                      )}
                    </DropdownMenu.Item>
                  ))}
                </DropdownMenu.Content>
              </DropdownMenu.Root>
            ) : null}
          </div>
        </header>
        <div className="flex-1 overflow-hidden bg-card">{window.content}</div>
      </div>
    </Rnd>
  );
}

export function TerminalWindowsLayer() {
  const {
    windows,
    focusedWindowId,
    focusWindow,
    minimizeWindow,
    toggleMaximizeWindow,
    closeWindow,
    updateWindowBounds,
    updateWindowContent,
    updateWindowMeta,
  } = useTerminalWindows();
  const { width: viewportWidth, height: viewportHeight } = useViewportSize();
  const [portalNode, setPortalNode] = useState<HTMLElement | null>(null);

  const handleSessionSwitch = (windowId: string, newSession: ActiveSession) => {
    console.log('TerminalWindowsLayer: handleSessionSwitch called', {
      windowId,
      newSessionId: newSession.id,
      newSessionAgent: newSession.agentId,
    });

    console.log('TerminalWindowsLayer: Creating new content for session', newSession.id);

    // Update window content with new session
    const newContent = (
      <TerminalSessionWindowContent
        key={newSession.id}
        session={newSession}
        onRequestClose={() => closeWindow(windowId)}
      />
    );

    console.log('TerminalWindowsLayer: Updating window content');
    updateWindowContent(windowId, newContent);

    // Update window sessionId using proper React state management
    console.log('TerminalWindowsLayer: Updating window sessionId to', newSession.id);
    updateWindowMeta(windowId, { sessionId: newSession.id });
  };

  useEffect(() => {
    if (typeof document === 'undefined') return undefined;
    const node = document.createElement('div');
    node.className = 'fixed inset-0 z-[80] pointer-events-none';
    document.body.appendChild(node);
    setPortalNode(node);

    return () => {
      document.body.removeChild(node);
    };
  }, []);

  const sortedWindows = useMemo(
    () => [...windows].filter((window) => !window.minimized).sort((a, b) => a.zIndex - b.zIndex),
    [windows],
  );

  if (!portalNode) {
    return null;
  }

  const maximizedBounds = {
    width: Math.max(viewportWidth - SAFE_MARGIN * 2, 640),
    height: Math.max(viewportHeight - SAFE_MARGIN * 2, 360),
    x: SAFE_MARGIN,
    y: SAFE_MARGIN,
  };

  return createPortal(
    <div className="pointer-events-none fixed inset-0">
      {sortedWindows.map((window) => {
        const isFocused = focusedWindowId === window.id;
        const bounds = window.maximized ? maximizedBounds : window.bounds;

        return (
          <FloatingWindow
            key={window.id}
            window={window}
            isFocused={isFocused}
            bounds={bounds}
            onFocus={() => focusWindow(window.id)}
            onMinimize={() => minimizeWindow(window.id)}
            onToggleMaximize={() => toggleMaximizeWindow(window.id)}
            onClose={() => closeWindow(window.id)}
            onUpdateBounds={(bounds) => updateWindowBounds(window.id, bounds)}
            onSessionSwitch={(session) => handleSessionSwitch(window.id, session)}
          />
        );
      })}
    </div>,
    portalNode,
  );
}
