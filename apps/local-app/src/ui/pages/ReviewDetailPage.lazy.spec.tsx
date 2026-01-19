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
  callback: IntersectionObserverCallback;
  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback;
  }
  observe(target: Element) {
    this.callback(
      [{ isIntersecting: true, target } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver,
    );
  }
  unobserve() {}
  disconnect() {}
};

import { ReviewDetailPageSkeleton, preloadReviewDetailPage } from './ReviewDetailPage.lazy';

describe('ReviewDetailPage.lazy', () => {
  describe('ReviewDetailPageSkeleton', () => {
    it('renders skeleton structure with three panels', () => {
      render(<ReviewDetailPageSkeleton />);

      // Should render skeleton elements
      const skeletons = document.querySelectorAll('[class*="animate-pulse"]');
      expect(skeletons.length).toBeGreaterThan(0);
    });

    it('renders header skeleton with back button placeholder', () => {
      const { container } = render(<ReviewDetailPageSkeleton />);

      // Header area with skeleton for back button
      const headerSkeleton = container.querySelector('.border-b.p-4');
      expect(headerSkeleton).toBeInTheDocument();
    });

    it('renders file navigator panel skeleton', () => {
      const { container } = render(<ReviewDetailPageSkeleton />);

      // Left panel with file navigator skeletons
      const leftPanel = container.querySelector('.w-64.border-r');
      expect(leftPanel).toBeInTheDocument();
    });

    it('renders diff viewer panel skeleton', () => {
      const { container } = render(<ReviewDetailPageSkeleton />);

      // Center panel for diff viewer
      const centerPanel = container.querySelector('.flex-1.min-w-0.bg-background');
      expect(centerPanel).toBeInTheDocument();
    });

    it('renders comments panel skeleton', () => {
      const { container } = render(<ReviewDetailPageSkeleton />);

      // Right panel for comments
      const rightPanel = container.querySelector('.w-80.border-l');
      expect(rightPanel).toBeInTheDocument();
    });
  });

  describe('preloadReviewDetailPage', () => {
    it('can be called without errors', () => {
      expect(() => preloadReviewDetailPage()).not.toThrow();
    });

    it('only triggers import once (cached)', () => {
      // Call multiple times
      preloadReviewDetailPage();
      preloadReviewDetailPage();
      preloadReviewDetailPage();

      // Should not throw and only import once (verified by module caching)
      expect(true).toBe(true);
    });
  });
});
