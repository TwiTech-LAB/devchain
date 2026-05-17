import { useCallback, useEffect } from 'react';
import type { Socket } from 'socket.io-client';
import type { ThemeValue } from '@/ui/components/ThemeSelect';
import { resolveTerminalTheme } from '../terminal-themes';
import { resolveTerminalSocket } from '../socket';

const sessionThemeCache = new Map<string, { foregroundHex: string; backgroundHex: string }>();

export function _resetThemeCacheForTesting(): void {
  sessionThemeCache.clear();
}

export function useTerminalThemeSync(
  sessionId: string,
  appTheme: ThemeValue,
  isSubscribedRef: React.MutableRefObject<boolean>,
  socket?: Socket | null,
) {
  const { tmuxStyle } = resolveTerminalTheme(appTheme);
  const foregroundHex = tmuxStyle.foreground;
  const backgroundHex = tmuxStyle.background;

  const emitTheme = useCallback(() => {
    if (!isSubscribedRef.current) return;
    const activeSocket = resolveTerminalSocket(socket);
    if (!activeSocket.connected) return;

    const cached = sessionThemeCache.get(sessionId);
    if (cached?.foregroundHex === foregroundHex && cached?.backgroundHex === backgroundHex) return;

    activeSocket.emit('terminal:theme', { foregroundHex, backgroundHex });
    sessionThemeCache.set(sessionId, { foregroundHex, backgroundHex });
  }, [sessionId, foregroundHex, backgroundHex, isSubscribedRef, socket]);

  // Re-emit on theme change while subscribed (effect fires when emitTheme ref changes)
  useEffect(() => {
    emitTheme();
  }, [emitTheme]);

  // Called when server confirms subscription — clears per-session cache so reconnect always emits
  const notifySubscribed = useCallback(() => {
    sessionThemeCache.delete(sessionId);
    emitTheme();
  }, [sessionId, emitTheme]);

  return { notifySubscribed };
}
