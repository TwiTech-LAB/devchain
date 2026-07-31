import {
  EVENT_BUS_REDUCE_MOTION_STORAGE_KEY,
  readAgentEventBusReduceMotion,
  writeAgentEventBusReduceMotion,
  type AgentEventBusPreferenceStorage,
} from './preference';

// Layer: pure unit. A minimal storage seam is the cheapest reliable proof of
// parsing, persistence, and failure defaults without mounting React or using
// browser-owned localStorage.
describe('agent event-bus reduce-motion preference', () => {
  it.each([null, 'not-json', '"true"', '1', '{}', '[]'])(
    'defaults malformed or missing storage value %p to full motion',
    (storedValue) => {
      const storage: AgentEventBusPreferenceStorage = {
        getItem: jest.fn(() => storedValue),
        setItem: jest.fn(),
      };

      expect(readAgentEventBusReduceMotion(storage)).toBe(false);
    },
  );

  it('reads and writes only a global boolean value', () => {
    const storage: AgentEventBusPreferenceStorage = {
      getItem: jest.fn(() => 'true'),
      setItem: jest.fn(),
    };

    expect(readAgentEventBusReduceMotion(storage)).toBe(true);
    expect(writeAgentEventBusReduceMotion(false, storage)).toBe(true);
    expect(storage.setItem).toHaveBeenCalledWith(EVENT_BUS_REDUCE_MOTION_STORAGE_KEY, 'false');
  });

  it('fails closed to full motion when storage is unavailable', () => {
    const storage: AgentEventBusPreferenceStorage = {
      getItem: () => {
        throw new Error('unavailable');
      },
      setItem: () => {
        throw new Error('unavailable');
      },
    };

    expect(readAgentEventBusReduceMotion(storage)).toBe(false);
    expect(writeAgentEventBusReduceMotion(true, storage)).toBe(false);
  });
});
