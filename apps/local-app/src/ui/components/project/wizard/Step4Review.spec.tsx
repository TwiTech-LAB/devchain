import { render, screen, within } from '@testing-library/react';
import { Step4Review, hasUnmappedStatuses, type ImportDryRunReview } from './Step4Review';

// Radix Select primitives need these in JSDOM (unused unless the status section renders).
(global as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
Element.prototype.scrollIntoView = jest.fn();

const REVIEW: ImportDryRunReview = {
  counts: { toImport: { agents: 3, epics: 2 }, toDelete: { agents: 1 } },
  promptTransfer: { imported: 2, deleted: 1, preserved: 3, skipped: 4 },
};

describe('Step4Review', () => {
  it('renders a loading placeholder while the dry-run is in flight', () => {
    render(
      <Step4Review review={null} isLoading statusMappings={{}} onStatusMappingChange={jest.fn()} />,
    );
    expect(screen.getByTestId('wizard-review-loading')).toBeInTheDocument();
    expect(screen.queryByTestId('wizard-review-step')).not.toBeInTheDocument();
  });

  it('always shows the to-import and will-delete counts', () => {
    render(
      <Step4Review
        review={REVIEW}
        isLoading={false}
        statusMappings={{}}
        onStatusMappingChange={jest.fn()}
      />,
    );
    const importCounts = screen.getByTestId('wizard-review-import-counts');
    expect(within(importCounts).getByText('agents')).toBeInTheDocument();
    expect(within(importCounts).getByText('3')).toBeInTheDocument();
    const deleteCounts = screen.getByTestId('wizard-review-delete-counts');
    expect(within(deleteCounts).getByText('agents')).toBeInTheDocument();
    // No unmatched statuses → no status-mapping section.
    expect(screen.queryByTestId('wizard-review-status-mappings')).not.toBeInTheDocument();
    const promptTransfer = screen.getByTestId('wizard-review-prompt-transfer');
    expect(within(promptTransfer).getByText('preserved')).toBeInTheDocument();
    expect(within(promptTransfer).getByText('skipped')).toBeInTheDocument();
    expect(within(promptTransfer).getByText('3')).toBeInTheDocument();
    expect(within(promptTransfer).getByText('4')).toBeInTheDocument();
  });

  it('renders the status-mapping section only when there are unmatched statuses', () => {
    const review: ImportDryRunReview = {
      ...REVIEW,
      unmatchedStatuses: [{ id: 's1', label: 'Backlog', color: '#111', epicCount: 4 }],
      templateStatuses: [{ label: 'Todo', color: '#222' }],
    };
    render(
      <Step4Review
        review={review}
        isLoading={false}
        statusMappings={{}}
        onStatusMappingChange={jest.fn()}
      />,
    );
    expect(screen.getByTestId('wizard-review-status-mappings')).toBeInTheDocument();
    expect(screen.getByTestId('wizard-status-map-s1')).toBeInTheDocument();
  });
});

describe('hasUnmappedStatuses', () => {
  const review: ImportDryRunReview = {
    counts: { toImport: {}, toDelete: {} },
    unmatchedStatuses: [
      { id: 's1', label: 'Backlog', color: '#111', epicCount: 1 },
      { id: 's2', label: 'Done', color: '#222', epicCount: 2 },
    ],
  };

  it('is true until every unmatched status is mapped', () => {
    expect(hasUnmappedStatuses(review, {})).toBe(true);
    expect(hasUnmappedStatuses(review, { s1: 'Todo' })).toBe(true);
    expect(hasUnmappedStatuses(review, { s1: 'Todo', s2: 'Done' })).toBe(false);
  });

  it('is false when there are no unmatched statuses', () => {
    expect(hasUnmappedStatuses({ counts: { toImport: {}, toDelete: {} } }, {})).toBe(false);
    expect(hasUnmappedStatuses(null, {})).toBe(false);
  });
});
