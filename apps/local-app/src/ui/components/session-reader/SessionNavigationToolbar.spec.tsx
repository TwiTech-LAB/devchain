import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { SessionNavigationToolbar } from './SessionNavigationToolbar';

function makeProps(overrides: Partial<React.ComponentProps<typeof SessionNavigationToolbar>> = {}) {
  return {
    onTop: jest.fn(),
    onEnd: jest.fn(),
    onPrevThinking: jest.fn() as (() => void) | null,
    onNextThinking: jest.fn() as (() => void) | null,
    onNextResponse: jest.fn() as (() => void) | null,
    onPrevHotspot: jest.fn() as (() => void) | null,
    onNextHotspot: jest.fn() as (() => void) | null,
    onToggleHotspotFilter: jest.fn() as (() => void) | null,
    hotspotFilterActive: false,
    hotspotCount: 0,
    hasChunks: true,
    ...overrides,
  };
}

describe('SessionNavigationToolbar', () => {
  it('renders top/end buttons regardless of hasChunks', () => {
    render(<SessionNavigationToolbar {...makeProps({ hasChunks: false })} />);

    expect(screen.getByTestId('nav-jump-top')).toBeInTheDocument();
    expect(screen.getByTestId('nav-jump-end')).toBeInTheDocument();
  });

  it('hides semantic nav buttons when hasChunks is false', () => {
    render(<SessionNavigationToolbar {...makeProps({ hasChunks: false })} />);

    expect(screen.queryByTestId('nav-prev-thinking')).not.toBeInTheDocument();
    expect(screen.queryByTestId('nav-next-thinking')).not.toBeInTheDocument();
    expect(screen.queryByTestId('nav-next-response')).not.toBeInTheDocument();
    expect(screen.queryByTestId('nav-prev-hotspot')).not.toBeInTheDocument();
    expect(screen.queryByTestId('nav-next-hotspot')).not.toBeInTheDocument();
    expect(screen.queryByTestId('nav-toggle-hotspot-filter')).not.toBeInTheDocument();
  });

  it('shows semantic nav buttons when hasChunks is true', () => {
    render(<SessionNavigationToolbar {...makeProps({ hasChunks: true })} />);

    expect(screen.getByTestId('nav-prev-thinking')).toBeInTheDocument();
    expect(screen.getByTestId('nav-next-thinking')).toBeInTheDocument();
    expect(screen.getByTestId('nav-next-response')).toBeInTheDocument();
    expect(screen.getByTestId('nav-toggle-hotspot-filter')).toBeInTheDocument();
    // Prev/next hotspot only visible when filter active
    expect(screen.queryByTestId('nav-prev-hotspot')).not.toBeInTheDocument();
    expect(screen.queryByTestId('nav-next-hotspot')).not.toBeInTheDocument();
  });

  it('shows prev/next hotspot buttons when filter is active', () => {
    render(
      <SessionNavigationToolbar {...makeProps({ hasChunks: true, hotspotFilterActive: true })} />,
    );

    expect(screen.getByTestId('nav-prev-hotspot')).toBeInTheDocument();
    expect(screen.getByTestId('nav-next-hotspot')).toBeInTheDocument();
  });

  it('calls onTop when jump-to-top button is clicked', () => {
    const props = makeProps();
    render(<SessionNavigationToolbar {...props} />);

    fireEvent.click(screen.getByTestId('nav-jump-top'));
    expect(props.onTop).toHaveBeenCalledTimes(1);
  });

  it('calls onEnd when jump-to-end button is clicked', () => {
    const props = makeProps();
    render(<SessionNavigationToolbar {...props} />);

    fireEvent.click(screen.getByTestId('nav-jump-end'));
    expect(props.onEnd).toHaveBeenCalledTimes(1);
  });

  it('calls onPrevThinking when prev-thinking button is clicked', () => {
    const onPrevThinking = jest.fn();
    render(<SessionNavigationToolbar {...makeProps({ onPrevThinking })} />);

    fireEvent.click(screen.getByTestId('nav-prev-thinking'));
    expect(onPrevThinking).toHaveBeenCalledTimes(1);
  });

  it('calls onNextThinking when next-thinking button is clicked', () => {
    const onNextThinking = jest.fn();
    render(<SessionNavigationToolbar {...makeProps({ onNextThinking })} />);

    fireEvent.click(screen.getByTestId('nav-next-thinking'));
    expect(onNextThinking).toHaveBeenCalledTimes(1);
  });

  it('calls onNextResponse when next-response button is clicked', () => {
    const onNextResponse = jest.fn();
    render(<SessionNavigationToolbar {...makeProps({ onNextResponse })} />);

    fireEvent.click(screen.getByTestId('nav-next-response'));
    expect(onNextResponse).toHaveBeenCalledTimes(1);
  });

  it('disables semantic buttons when handlers are null', () => {
    render(
      <SessionNavigationToolbar
        {...makeProps({
          onPrevThinking: null,
          onNextThinking: null,
          onNextResponse: null,
        })}
      />,
    );

    const prevThinking = screen.getByTestId('nav-prev-thinking');
    const nextThinking = screen.getByTestId('nav-next-thinking');
    const nextResponse = screen.getByTestId('nav-next-response');

    expect(prevThinking).toHaveAttribute('aria-disabled', 'true');
    expect(nextThinking).toHaveAttribute('aria-disabled', 'true');
    expect(nextResponse).toHaveAttribute('aria-disabled', 'true');

    expect(prevThinking).toHaveClass('pointer-events-none');
    expect(nextThinking).toHaveClass('pointer-events-none');
    expect(nextResponse).toHaveClass('pointer-events-none');
  });

  it('all buttons have aria-label attributes (filter inactive)', () => {
    render(<SessionNavigationToolbar {...makeProps()} />);

    const buttons = screen.getAllByRole('button');
    for (const button of buttons) {
      expect(button).toHaveAttribute('aria-label');
    }
    // top, prev-thinking, next-thinking, next-response, filter-toggle, end
    expect(buttons).toHaveLength(6);
  });

  it('all buttons have aria-label attributes (filter active)', () => {
    render(<SessionNavigationToolbar {...makeProps({ hotspotFilterActive: true })} />);

    const buttons = screen.getAllByRole('button');
    for (const button of buttons) {
      expect(button).toHaveAttribute('aria-label');
    }
    // top, prev-thinking, next-thinking, next-response, filter-toggle, prev-hotspot, next-hotspot, end
    expect(buttons).toHaveLength(8);
  });

  it('calls onPrevHotspot when prev-hotspot button is clicked', () => {
    const onPrevHotspot = jest.fn();
    render(
      <SessionNavigationToolbar {...makeProps({ onPrevHotspot, hotspotFilterActive: true })} />,
    );

    fireEvent.click(screen.getByTestId('nav-prev-hotspot'));
    expect(onPrevHotspot).toHaveBeenCalledTimes(1);
  });

  it('calls onNextHotspot when next-hotspot button is clicked', () => {
    const onNextHotspot = jest.fn();
    render(
      <SessionNavigationToolbar {...makeProps({ onNextHotspot, hotspotFilterActive: true })} />,
    );

    fireEvent.click(screen.getByTestId('nav-next-hotspot'));
    expect(onNextHotspot).toHaveBeenCalledTimes(1);
  });

  it('calls onToggleHotspotFilter when filter button is clicked', () => {
    const onToggleHotspotFilter = jest.fn();
    render(<SessionNavigationToolbar {...makeProps({ onToggleHotspotFilter })} />);

    fireEvent.click(screen.getByTestId('nav-toggle-hotspot-filter'));
    expect(onToggleHotspotFilter).toHaveBeenCalledTimes(1);
  });

  it('disables hotspot buttons when handlers are null', () => {
    render(
      <SessionNavigationToolbar
        {...makeProps({
          hotspotFilterActive: true,
          onPrevHotspot: null,
          onNextHotspot: null,
          onToggleHotspotFilter: null,
        })}
      />,
    );

    expect(screen.getByTestId('nav-prev-hotspot')).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByTestId('nav-next-hotspot')).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByTestId('nav-toggle-hotspot-filter')).toHaveAttribute(
      'aria-disabled',
      'true',
    );
  });

  it('shows hotspot count badge when filter active and hotspots exist', () => {
    render(
      <SessionNavigationToolbar {...makeProps({ hotspotFilterActive: true, hotspotCount: 3 })} />,
    );

    expect(screen.getByTestId('nav-hotspot-count')).toHaveTextContent('3');
  });

  it('hides visible-count hint when filter inactive', () => {
    render(
      <SessionNavigationToolbar {...makeProps({ hotspotFilterActive: false, hotspotCount: 3 })} />,
    );

    expect(screen.queryByTestId('nav-hotspot-count')).not.toBeInTheDocument();
  });

  it('highlights filter button when active', () => {
    render(
      <SessionNavigationToolbar
        {...makeProps({
          hotspotFilterActive: true,
          onToggleHotspotFilter: jest.fn(),
        })}
      />,
    );

    const filterBtn = screen.getByTestId('nav-toggle-hotspot-filter');
    expect(filterBtn).toHaveAttribute('aria-pressed', 'true');
    expect(filterBtn).toHaveClass('bg-amber-500/10');
  });
});
