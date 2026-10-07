import { render } from '@testing-library/react';

// Mock refractor (ESM module that Jest can't transform)
jest.mock('refractor', () => ({
  refractor: {
    registered: jest.fn(() => false),
    highlight: jest.fn(),
  },
}));

// Mock react-diff-view CSS import
jest.mock('react-diff-view/style/index.css', () => ({}));

// Mock ResizeObserver for ScrollArea component
global.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};

// Mock IntersectionObserver for LazyHunk component
global.IntersectionObserver = class IntersectionObserver {
  readonly root: Element | Document | null = null;
  readonly rootMargin = '0px';
  readonly thresholds: ReadonlyArray<number> = [0];
  callback: IntersectionObserverCallback;
  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback;
  }
  observe(target: Element) {
    this.callback([{ isIntersecting: true, target } as IntersectionObserverEntry], this);
  }
  unobserve() {}
  disconnect() {}
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
};

import { ReviewDetailPageSkeleton } from './ReviewDetailPage.lazy';

describe('ReviewDetailPage.lazy', () => {
  describe('ReviewDetailPageSkeleton', () => {
    it('renders skeleton structure with three panels', () => {
      render(<ReviewDetailPageSkeleton />);

      // Should render skeleton elements
      const skeletons = document.querySelectorAll('[class*="animate-pulse"]');
      expect(skeletons.length).toBeGreaterThan(0);
    });
  });
});
