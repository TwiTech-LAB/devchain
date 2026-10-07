import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { SessionNavigationToolbar } from './SessionNavigationToolbar';
import { SessionViewModeProvider } from '@/ui/hooks/useSessionViewMode';

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

function renderToolbar(
  overrides: Partial<React.ComponentProps<typeof SessionNavigationToolbar>> = {},
) {
  return render(
    <SessionViewModeProvider>
      <SessionNavigationToolbar {...makeProps(overrides)} />
    </SessionViewModeProvider>,
  );
}

describe('SessionNavigationToolbar', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('renders top/end buttons regardless of hasChunks', () => {
    renderToolbar({ hasChunks: false });

    expect(screen.getByTestId('nav-jump-top')).toBeInTheDocument();
    expect(screen.getByTestId('nav-jump-end')).toBeInTheDocument();
  });

  it('hides semantic nav buttons when hasChunks is false', () => {
    renderToolbar({ hasChunks: false });

    expect(screen.queryByTestId('nav-prev-thinking')).not.toBeInTheDocument();
    expect(screen.queryByTestId('nav-next-thinking')).not.toBeInTheDocument();
    expect(screen.queryByTestId('nav-next-response')).not.toBeInTheDocument();
    expect(screen.queryByTestId('nav-prev-hotspot')).not.toBeInTheDocument();
    expect(screen.queryByTestId('nav-next-hotspot')).not.toBeInTheDocument();
    expect(screen.queryByTestId('nav-toggle-hotspot-filter')).not.toBeInTheDocument();
  });

  it('shows semantic nav buttons when hasChunks is true', () => {
    renderToolbar({ hasChunks: true });

    expect(screen.getByTestId('nav-prev-thinking')).toBeInTheDocument();
    expect(screen.getByTestId('nav-next-thinking')).toBeInTheDocument();
    expect(screen.getByTestId('nav-next-response')).toBeInTheDocument();
    expect(screen.getByTestId('nav-toggle-hotspot-filter')).toBeInTheDocument();
    // Prev/next hotspot only visible when filter active
    expect(screen.queryByTestId('nav-prev-hotspot')).not.toBeInTheDocument();
    expect(screen.queryByTestId('nav-next-hotspot')).not.toBeInTheDocument();
  });

  it('shows prev/next hotspot buttons when filter is active', () => {
    renderToolbar({ hasChunks: true, hotspotFilterActive: true });

    expect(screen.getByTestId('nav-prev-hotspot')).toBeInTheDocument();
    expect(screen.getByTestId('nav-next-hotspot')).toBeInTheDocument();
  });

  it('calls onTop when jump-to-top button is clicked', () => {
    const onTop = jest.fn();
    renderToolbar({ onTop });

    fireEvent.click(screen.getByTestId('nav-jump-top'));
    expect(onTop).toHaveBeenCalledTimes(1);
  });

  it.each([
    { label: 'onEnd', prop: 'onEnd', id: 'nav-jump-end', hotspotFilterActive: false },
    {
      label: 'onPrevThinking',
      prop: 'onPrevThinking',
      id: 'nav-prev-thinking',
      hotspotFilterActive: false,
    },
    {
      label: 'onNextThinking',
      prop: 'onNextThinking',
      id: 'nav-next-thinking',
      hotspotFilterActive: false,
    },
    {
      label: 'onNextResponse',
      prop: 'onNextResponse',
      id: 'nav-next-response',
      hotspotFilterActive: false,
    },
    {
      label: 'onPrevHotspot',
      prop: 'onPrevHotspot',
      id: 'nav-prev-hotspot',
      hotspotFilterActive: true,
    },
    {
      label: 'onNextHotspot',
      prop: 'onNextHotspot',
      id: 'nav-next-hotspot',
      hotspotFilterActive: true,
    },
    {
      label: 'onToggleHotspotFilter',
      prop: 'onToggleHotspotFilter',
      id: 'nav-toggle-hotspot-filter',
      hotspotFilterActive: false,
    },
  ] as const)('calls $label from its button', ({ prop, id, hotspotFilterActive }) => {
    const handler = jest.fn();
    renderToolbar({ [prop]: handler, hotspotFilterActive });
    fireEvent.click(screen.getByTestId(id));
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('disables semantic buttons when handlers are null', () => {
    renderToolbar({
      onPrevThinking: null,
      onNextThinking: null,
      onNextResponse: null,
    });

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
    renderToolbar();

    const buttons = screen.getAllByRole('button');
    for (const button of buttons) {
      expect(button).toHaveAttribute('aria-label');
    }
    // top, prev-thinking, next-thinking, next-response, filter-toggle, R, D, end
    expect(buttons).toHaveLength(8);
  });

  it('all buttons have aria-label attributes (filter active)', () => {
    renderToolbar({ hotspotFilterActive: true });

    const buttons = screen.getAllByRole('button');
    for (const button of buttons) {
      expect(button).toHaveAttribute('aria-label');
    }
    // top, prev-thinking, next-thinking, next-response, filter-toggle, prev-hotspot, next-hotspot, R, D, end
    expect(buttons).toHaveLength(10);
  });

  it('disables hotspot buttons when handlers are null', () => {
    renderToolbar({
      hotspotFilterActive: true,
      onPrevHotspot: null,
      onNextHotspot: null,
      onToggleHotspotFilter: null,
    });

    expect(screen.getByTestId('nav-prev-hotspot')).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByTestId('nav-next-hotspot')).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByTestId('nav-toggle-hotspot-filter')).toHaveAttribute(
      'aria-disabled',
      'true',
    );
  });

  it('shows hotspot count badge when filter active and hotspots exist', () => {
    renderToolbar({ hotspotFilterActive: true, hotspotCount: 3 });

    expect(screen.getByTestId('nav-hotspot-count')).toHaveTextContent('3');
  });

  it('hides visible-count hint when filter inactive', () => {
    renderToolbar({ hotspotFilterActive: false, hotspotCount: 3 });

    expect(screen.queryByTestId('nav-hotspot-count')).not.toBeInTheDocument();
  });

  it('highlights filter button when active', () => {
    renderToolbar({
      hotspotFilterActive: true,
      onToggleHotspotFilter: jest.fn(),
    });

    const filterBtn = screen.getByTestId('nav-toggle-hotspot-filter');
    expect(filterBtn).toHaveAttribute('aria-pressed', 'true');
    expect(filterBtn).toHaveClass('bg-status-warn/10');
  });

  // ---------------------------------------------------------------------------
  // View mode toggle
  // ---------------------------------------------------------------------------

  it('shows view mode toggle with Reader active by default', () => {
    renderToolbar();

    expect(screen.getByTestId('view-mode-toggle')).toBeInTheDocument();
    expect(screen.getByTestId('view-mode-reader')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('view-mode-diagnostic')).toHaveAttribute('aria-pressed', 'false');
  });

  it('clicking Diagnostic button switches mode', () => {
    renderToolbar();

    fireEvent.click(screen.getByTestId('view-mode-diagnostic'));

    expect(screen.getByTestId('view-mode-diagnostic')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('view-mode-reader')).toHaveAttribute('aria-pressed', 'false');
  });
});
