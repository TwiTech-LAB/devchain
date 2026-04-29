import React from 'react';
import { render, screen } from '@testing-library/react';
import { LoadingSkeleton } from './LoadingSkeleton';

describe('LoadingSkeleton', () => {
  it('renders card variant', () => {
    render(<LoadingSkeleton variant="card" />);
    expect(screen.getByTestId('skeleton-card')).toBeInTheDocument();
  });

  it('card variant contains multiple skeleton lines', () => {
    const { container } = render(<LoadingSkeleton variant="card" />);
    const skeletons = container.querySelectorAll('.animate-pulse');
    expect(skeletons.length).toBeGreaterThan(1);
  });

  it('renders table-row variant', () => {
    render(<LoadingSkeleton variant="table-row" />);
    expect(screen.getByTestId('skeleton-table-row')).toBeInTheDocument();
  });

  it('table-row variant has multiple skeleton segments', () => {
    const { container } = render(<LoadingSkeleton variant="table-row" />);
    const skeletons = container.querySelectorAll('.animate-pulse');
    expect(skeletons.length).toBeGreaterThanOrEqual(2);
  });

  it('renders list-item variant', () => {
    render(<LoadingSkeleton variant="list-item" />);
    expect(screen.getByTestId('skeleton-list-item')).toBeInTheDocument();
  });

  it('each variant renders without console errors', () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    render(<LoadingSkeleton variant="card" />);
    render(<LoadingSkeleton variant="table-row" />);
    render(<LoadingSkeleton variant="list-item" />);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
