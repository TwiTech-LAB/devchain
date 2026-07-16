import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { Terminal } from '@xterm/xterm';
import {
  TerminalWritePump,
  type TerminalWriteOptions,
  type TerminalWritePumpApi,
  type TerminalWritePumpConfig,
} from './terminal-write-pump';

type PumpOptions = Pick<TerminalWritePumpConfig, 'queueBytes' | 'batchBytes'>;

export function useTerminalWritePump(
  xtermRef: React.RefObject<Terminal | null>,
  onOverflow: () => void,
  options: PumpOptions = {},
): TerminalWritePumpApi {
  const overflowRef = useRef(onOverflow);
  overflowRef.current = onOverflow;
  const pumpRef = useRef<TerminalWritePump | null>(null);
  if (!pumpRef.current) {
    pumpRef.current = new TerminalWritePump({
      ...options,
      onOverflow: () => overflowRef.current(),
    });
  }
  const pump = pumpRef.current;

  const setTerminal = useCallback(
    (terminal: Terminal | null) => pump.setTerminal(terminal),
    [pump],
  );
  const write = useCallback(
    (data: string, writeOptions?: TerminalWriteOptions) => {
      if (xtermRef.current !== null) pump.setTerminal(xtermRef.current);
      return pump.write(data, writeOptions);
    },
    [pump, xtermRef],
  );
  const flush = useCallback(() => pump.flush(), [pump]);
  const discardPending = useCallback(() => pump.discardPending(), [pump]);
  const beginSeed = useCallback(() => {
    if (xtermRef.current !== null) pump.setTerminal(xtermRef.current);
    pump.beginSeed();
  }, [pump, xtermRef]);
  const beginRecovery = useCallback(() => {
    if (xtermRef.current !== null) pump.setTerminal(xtermRef.current);
    pump.beginRecovery();
  }, [pump, xtermRef]);
  const completeRecovery = useCallback(() => pump.completeRecovery(), [pump]);
  const isDesynchronized = useCallback(() => pump.isDesynchronized(), [pump]);
  const getSnapshot = useCallback(() => pump.getSnapshot(), [pump]);
  const dispose = useCallback(() => pump.dispose(), [pump]);

  useEffect(
    () => () => {
      pump.dispose();
    },
    [pump],
  );

  return useMemo(
    () => ({
      setTerminal,
      write,
      flush,
      discardPending,
      beginSeed,
      beginRecovery,
      completeRecovery,
      isDesynchronized,
      getSnapshot,
      dispose,
    }),
    [
      beginRecovery,
      beginSeed,
      completeRecovery,
      discardPending,
      dispose,
      flush,
      getSnapshot,
      isDesynchronized,
      setTerminal,
      write,
    ],
  );
}
