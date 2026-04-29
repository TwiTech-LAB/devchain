import React from 'react';
import { render, screen } from '@testing-library/react';
import { FileX } from 'lucide-react';
import { EmptyState } from './EmptyState';

describe('EmptyState', () => {
  it('renders the headline', () => {
    render(<EmptyState icon={FileX} headline="No data available" />);
    expect(screen.getByText('No data available')).toBeInTheDocument();
  });

  it('renders the reason when provided', () => {
    render(<EmptyState icon={FileX} headline="No data" reason="Try again later" />);
    expect(screen.getByText('Try again later')).toBeInTheDocument();
  });

  it('does not render reason when omitted', () => {
    const { container } = render(<EmptyState icon={FileX} headline="No data" />);
    expect(container.querySelectorAll('p').length).toBe(1);
  });

  it('renders the icon with aria-hidden', () => {
    render(<EmptyState icon={FileX} headline="No data" />);
    const svg = document.querySelector('svg');
    expect(svg).toHaveAttribute('aria-hidden', 'true');
  });
});
