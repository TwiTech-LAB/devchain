import { useCallback, useState } from 'react';

interface ActiveSessionConfirmState {
  open: boolean;
  agentNames: string;
  onConfirm: (() => void) | null;
}

const INITIAL_STATE: ActiveSessionConfirmState = {
  open: false,
  agentNames: '',
  onConfirm: null,
};

export function useActiveSessionConfirm() {
  const [state, setState] = useState<ActiveSessionConfirmState>(INITIAL_STATE);

  const confirmIfActiveSessions = useCallback(
    (activeAgentNames: string[], onConfirm: () => void) => {
      if (activeAgentNames.length === 0) {
        onConfirm();
        return;
      }
      setState({
        open: true,
        agentNames: activeAgentNames.join(', '),
        onConfirm,
      });
    },
    [],
  );

  const handleConfirm = useCallback(() => {
    const { onConfirm } = state;
    setState(INITIAL_STATE);
    onConfirm?.();
  }, [state]);

  const handleOpenChange = useCallback((open: boolean) => {
    if (!open) {
      setState(INITIAL_STATE);
    }
  }, []);

  return {
    confirmIfActiveSessions,
    dialogProps: {
      open: state.open,
      onOpenChange: handleOpenChange,
      onConfirm: handleConfirm,
      title: 'Active sessions detected',
      description: `The following agents have active sessions: ${state.agentNames}. Changing their provider configuration may affect running sessions.`,
      confirmText: 'Continue',
      variant: 'default' as const,
    },
  };
}
