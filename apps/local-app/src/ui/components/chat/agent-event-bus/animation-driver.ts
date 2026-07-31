import type { AgentEventBusAnimationDriver, AgentEventBusAnimationHandle } from './types';

const NOOP_HANDLE: AgentEventBusAnimationHandle = {
  cancel: () => undefined,
};

export const browserAgentEventBusAnimationDriver: AgentEventBusAnimationDriver = {
  animate(element, keyframes, options) {
    const animate = (element as Element & { animate?: Element['animate'] }).animate;
    if (typeof animate !== 'function') return NOOP_HANDLE;

    const animation = animate.call(element, keyframes, options);
    return {
      cancel: () => {
        try {
          animation.cancel();
        } catch {
          // A detached element or already-finished animation needs no further cleanup.
        }
      },
    };
  },
};
