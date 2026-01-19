// Ensure React uses development build for testing (must be before React imports)
// This fixes "act(...) is not supported in production builds of React" error
process.env.NODE_ENV = 'test';

import '@testing-library/jest-dom';
import { toHaveNoViolations } from 'jest-axe';

import { TextEncoder, TextDecoder } from 'util';

import { Logger } from '@nestjs/common';

/**
 * Mock HTMLCanvasElement.getContext() to suppress xterm.js canvas warnings.
 * xterm.js uses canvas for rendering, which jsdom doesn't fully support.
 * This mock provides a minimal 2D context stub to prevent "getContext not implemented" errors.
 */
HTMLCanvasElement.prototype.getContext = jest.fn(function (
  this: HTMLCanvasElement,
  contextId: string,
) {
  if (contextId === '2d') {
    return {
      fillRect: jest.fn(),
      clearRect: jest.fn(),
      getImageData: jest.fn(() => ({ data: new Array(4) })),
      putImageData: jest.fn(),
      createImageData: jest.fn(() => []),
      setTransform: jest.fn(),
      drawImage: jest.fn(),
      save: jest.fn(),
      restore: jest.fn(),
      beginPath: jest.fn(),
      moveTo: jest.fn(),
      lineTo: jest.fn(),
      closePath: jest.fn(),
      stroke: jest.fn(),
      fill: jest.fn(),
      translate: jest.fn(),
      scale: jest.fn(),
      rotate: jest.fn(),
      arc: jest.fn(),
      measureText: jest.fn(() => ({ width: 0 })),
      transform: jest.fn(),
      rect: jest.fn(),
      clip: jest.fn(),
      fillText: jest.fn(),
      strokeText: jest.fn(),
      createLinearGradient: jest.fn(() => ({
        addColorStop: jest.fn(),
      })),
      createRadialGradient: jest.fn(() => ({
        addColorStop: jest.fn(),
      })),
      createPattern: jest.fn(),
      canvas: this,
    } as unknown as CanvasRenderingContext2D;
  }
  if (contextId === 'webgl' || contextId === 'webgl2') {
    // Return null for WebGL contexts - xterm falls back to canvas 2D
    return null;
  }
  return null;
}) as unknown as typeof HTMLCanvasElement.prototype.getContext;

// Extend Jest matchers with jest-axe accessibility testing matchers
expect.extend(toHaveNoViolations);

// Enable React 18 act() environment for testing-library
// @ts-expect-error React 18 testing environment flag
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// Silence NestJS Logger output during tests to keep logs readable.
Logger.overrideLogger(false);

// Polyfill for libraries that rely on TextEncoder/TextDecoder (e.g., react-router)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
if (!(global as any).TextEncoder) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (global as any).TextEncoder = TextEncoder;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
if (!(global as any).TextDecoder) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (global as any).TextDecoder = TextDecoder as unknown as typeof globalThis.TextDecoder;
}

// Polyfill setImmediate for libraries (e.g., pino/thread-stream) in Jest environment
// eslint-disable-next-line @typescript-eslint/no-explicit-any
if (!(global as any).setImmediate) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (global as any).setImmediate = (fn: (...args: any[]) => void, ...args: any[]) =>
    setTimeout(fn, 0, ...args);
}

/**
 * Centralized fetch mock for test isolation (Q2: Global Fetch Mock Hygiene)
 *
 * This provides a default fetch mock that:
 * - Prevents real network requests during tests
 * - Resets between tests to avoid cross-test pollution
 * - Can be customized per test via global.fetch = jest.fn().mockImplementation(...)
 *
 * Pattern for test files:
 * - No need to save/restore originalFetch manually
 * - Just override global.fetch in beforeEach or individual tests
 * - Mock is automatically reset after each test
 */
const fetchMock = jest.fn(() =>
  Promise.resolve({
    ok: true,
    json: () => Promise.resolve({}),
    text: () => Promise.resolve(''),
    status: 200,
  } as Response),
);
global.fetch = fetchMock as unknown as typeof fetch;

// Reset fetch mock after each test to prevent cross-test pollution
// Q1 (Phase 1.0.4): Restore original mock reference AND reset state
afterEach(() => {
  // Restore original mock reference (in case test reassigned global.fetch)
  global.fetch = fetchMock as unknown as typeof fetch;
  // Reset all mock state (calls, return values, and implementations)
  fetchMock.mockReset();
  // Re-apply default implementation after reset
  fetchMock.mockImplementation(() =>
    Promise.resolve({
      ok: true,
      json: () => Promise.resolve({}),
      text: () => Promise.resolve(''),
      status: 200,
    } as Response),
  );
});
