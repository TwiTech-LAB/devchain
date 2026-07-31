import { browserAgentEventBusAnimationDriver } from './animation-driver';

// Layer: pure unit (jsdom DOM adapter). Injecting an element with or without
// animate() is the cheapest reliable proof of delegation and safe cancellation;
// browser rendering is outside this adapter's contract.
describe('browserAgentEventBusAnimationDriver', () => {
  it('safely no-ops when Element.animate is unavailable', () => {
    const element = document.createElement('div');

    const handle = browserAgentEventBusAnimationDriver.animate(
      element,
      [{ opacity: 0 }, { opacity: 1 }],
      { duration: 100 },
    );

    expect(() => handle.cancel()).not.toThrow();
  });

  it('delegates animation and makes repeated cancellation safe', () => {
    const cancel = jest.fn();
    const animate = jest.fn(() => ({ cancel })) as unknown as Element['animate'];
    const element = Object.assign(document.createElement('div'), { animate });

    const handle = browserAgentEventBusAnimationDriver.animate(
      element,
      [{ strokeDashoffset: 100 }, { strokeDashoffset: 0 }],
      { duration: 700 },
    );
    handle.cancel();
    handle.cancel();

    expect(animate).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledTimes(2);
  });
});
