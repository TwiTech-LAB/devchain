import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AnalysisWarning } from '@devchain/codebase-overview';
import { WarningsBar } from './WarningsBar';

describe('WarningsBar', () => {
  it('renders nothing when warnings array is empty', () => {
    const { container } = render(<WarningsBar warnings={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when warnings empty and excludedAuthorCount is 0', () => {
    const { container } = render(<WarningsBar warnings={[]} excludedAuthorCount={0} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders the bar when warnings are present', () => {
    const warnings: AnalysisWarning[] = [
      { code: 'shallow_git_history', message: 'Shallow history' },
    ];
    render(<WarningsBar warnings={warnings} />);
    expect(screen.getByTestId('warnings-bar')).toBeInTheDocument();
  });

  describe('excluded authors', () => {
    it('renders the bar when only excludedAuthorCount > 0 and no warnings', () => {
      render(<WarningsBar warnings={[]} excludedAuthorCount={3} />);
      expect(screen.getByTestId('warnings-bar')).toBeInTheDocument();
      expect(screen.getByTestId('warnings-excluded-authors')).toBeInTheDocument();
    });

    it('shows singular "contributor" for count of 1', () => {
      render(<WarningsBar warnings={[]} excludedAuthorCount={1} />);
      expect(screen.getByText(/1 contributor excluded/)).toBeInTheDocument();
    });

    it('shows plural "contributors" for count > 1', () => {
      render(<WarningsBar warnings={[]} excludedAuthorCount={5} />);
      expect(screen.getByText(/5 contributors excluded/)).toBeInTheDocument();
    });

    it('renders "Configure scope" link when onNavigateToScope is provided', () => {
      render(<WarningsBar warnings={[]} excludedAuthorCount={2} onNavigateToScope={jest.fn()} />);
      expect(screen.getByRole('button', { name: /configure scope/i })).toBeInTheDocument();
    });

    it('does not render "Configure scope" link when onNavigateToScope is absent', () => {
      render(<WarningsBar warnings={[]} excludedAuthorCount={2} />);
      expect(screen.queryByRole('button', { name: /configure scope/i })).not.toBeInTheDocument();
    });

    it('Configure scope button has inline-flex, min-h-[40px], and focus-visible ring classes', () => {
      render(<WarningsBar warnings={[]} excludedAuthorCount={2} onNavigateToScope={jest.fn()} />);
      const btn = screen.getByRole('button', { name: /configure scope/i });
      expect(btn.className).toContain('inline-flex');
      expect(btn.className).toContain('min-h-[40px]');
      expect(btn.className).toContain('focus-visible:ring-2');
      expect(btn.className).toContain('focus-visible:ring-ring');
    });

    it('clicking "Configure scope" calls onNavigateToScope', async () => {
      const user = userEvent.setup();
      const onNavigateToScope = jest.fn();
      render(
        <WarningsBar warnings={[]} excludedAuthorCount={2} onNavigateToScope={onNavigateToScope} />,
      );
      await user.click(screen.getByRole('button', { name: /configure scope/i }));
      expect(onNavigateToScope).toHaveBeenCalledTimes(1);
    });

    it('shows excluded-author alert alongside regular warnings', () => {
      const warnings: AnalysisWarning[] = [
        { code: 'shallow_git_history', message: 'Shallow history' },
      ];
      render(<WarningsBar warnings={warnings} excludedAuthorCount={4} />);
      expect(screen.getByTestId('warnings-excluded-authors')).toBeInTheDocument();
      expect(screen.getByTestId('warnings-group-unavailable')).toBeInTheDocument();
    });
  });

  describe('severity grouping', () => {
    it('renders only the unavailable group for unavailable warnings', () => {
      const warnings: AnalysisWarning[] = [
        { code: 'shallow_git_history', message: 'Shallow history' },
        { code: 'missing_dependency_data', message: 'No deps' },
      ];
      render(<WarningsBar warnings={warnings} />);
      expect(screen.getByTestId('warnings-group-unavailable')).toBeInTheDocument();
      expect(screen.queryByTestId('warnings-group-degraded')).toBeNull();
      expect(screen.queryByTestId('warnings-group-informational')).toBeNull();
    });

    it('renders only the degraded group for degraded warnings', () => {
      const warnings: AnalysisWarning[] = [{ code: 'loc_unavailable', message: 'LOC unavailable' }];
      render(<WarningsBar warnings={warnings} />);
      expect(screen.queryByTestId('warnings-group-unavailable')).toBeNull();
      expect(screen.getByTestId('warnings-group-degraded')).toBeInTheDocument();
      expect(screen.queryByTestId('warnings-group-informational')).toBeNull();
    });

    it('renders only the informational group for informational warnings', () => {
      const warnings: AnalysisWarning[] = [
        { code: 'partial_test_detection', message: 'Partial test detection' },
      ];
      render(<WarningsBar warnings={warnings} />);
      expect(screen.queryByTestId('warnings-group-unavailable')).toBeNull();
      expect(screen.queryByTestId('warnings-group-degraded')).toBeNull();
      expect(screen.getByTestId('warnings-group-informational')).toBeInTheDocument();
    });

    it('renders all three groups when all severities are present', () => {
      const warnings: AnalysisWarning[] = [
        { code: 'shallow_git_history', message: 'Shallow' },
        { code: 'loc_unavailable', message: 'LOC' },
        { code: 'partial_test_detection', message: 'Tests' },
      ];
      render(<WarningsBar warnings={warnings} />);
      expect(screen.getByTestId('warnings-group-unavailable')).toBeInTheDocument();
      expect(screen.getByTestId('warnings-group-degraded')).toBeInTheDocument();
      expect(screen.getByTestId('warnings-group-informational')).toBeInTheDocument();
    });
  });

  describe('"Why?" affordance', () => {
    it('renders a Why? button for each warning', () => {
      const warnings: AnalysisWarning[] = [
        { code: 'missing_dependency_data', message: 'No deps' },
        { code: 'loc_unavailable', message: 'LOC unavailable' },
      ];
      render(<WarningsBar warnings={warnings} />);
      const buttons = screen.getAllByRole('button', { name: /why:/i });
      expect(buttons).toHaveLength(2);
    });

    it('Why? button has correct aria-label', () => {
      const warnings: AnalysisWarning[] = [
        { code: 'coupling_unavailable', message: 'No coupling' },
      ];
      render(<WarningsBar warnings={warnings} />);
      expect(screen.getByRole('button', { name: 'Why: coupling_unavailable' })).toBeInTheDocument();
    });
  });

  describe('loc_unavailable data payload', () => {
    it('formats message with counted/eligible/skipped when data is present', () => {
      const warnings: AnalysisWarning[] = [
        {
          code: 'loc_unavailable',
          message: 'LOC unavailable',
          data: { counted: 1245, eligible: 1500, skipped: 255 },
        },
      ];
      render(<WarningsBar warnings={warnings} />);
      expect(
        screen.getByText(/LOC counted for 1245\/1500 files \(255 skipped: large or binary\)/),
      ).toBeInTheDocument();
    });

    it('falls back to plain message when data payload is absent', () => {
      const warnings: AnalysisWarning[] = [
        { code: 'loc_unavailable', message: 'LOC data unavailable' },
      ];
      render(<WarningsBar warnings={warnings} />);
      expect(screen.getByText('LOC data unavailable')).toBeInTheDocument();
    });

    it('falls back to plain message when data fields are partial', () => {
      const warnings: AnalysisWarning[] = [
        {
          code: 'loc_unavailable',
          message: 'LOC data unavailable',
          data: { counted: 10 },
        },
      ];
      render(<WarningsBar warnings={warnings} />);
      expect(screen.getByText('LOC data unavailable')).toBeInTheDocument();
    });
  });
});
