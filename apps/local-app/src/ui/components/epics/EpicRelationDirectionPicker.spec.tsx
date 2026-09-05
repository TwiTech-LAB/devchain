import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { EpicRelationDirectionPicker } from '@/ui/components/epics/EpicRelationDirectionPicker';
import type { EpicRelationDirectionDraft } from '@/ui/lib/epic-relations';

// Layer: component unit. The picker is presentational; direction semantics
// and warning text live in the lib spec, and dialog flows in the dialog
// suites.
describe('EpicRelationDirectionPicker', () => {
  const source = { id: 'epic-source', title: 'Source Epic' };
  const target = { id: 'epic-target', title: 'Target Epic', subtitle: 'Project' };

  function setup({
    draft = { type: 'related', sourceIsFocal: true } as EpicRelationDirectionDraft,
    eligible = true,
    ineligibilityCause,
    legacyNeutral = false,
    sourceLinked = false,
    targetLinked = false,
  }: {
    draft?: EpicRelationDirectionDraft;
    eligible?: boolean;
    ineligibilityCause?: 'child' | 'cross-project';
    legacyNeutral?: boolean;
    sourceLinked?: boolean;
    targetLinked?: boolean;
  } = {}) {
    const onChange = jest.fn();
    const view = render(
      <EpicRelationDirectionPicker
        source={source}
        target={target}
        value={draft}
        onChange={onChange}
        eligible={eligible}
        ineligibilityCause={ineligibilityCause}
        legacyNeutral={legacyNeutral}
        sourceLinked={sourceLinked}
        targetLinked={targetLinked}
      />,
    );
    return { ...view, onChange };
  }

  it('renders no time-route fieldset or route-mode buttons', () => {
    setup();

    expect(screen.queryByText('Time route')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'No time route' })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Route time to related Epic' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Route related time here' }),
    ).not.toBeInTheDocument();
  });

  it('uses the same focusable arrow for Related and Blocks and swaps source and target', async () => {
    const user = userEvent.setup();
    const { onChange } = setup();

    const swap = screen.getByRole('button', { name: /Swap source and target/i });
    expect(swap).toBeVisible();
    swap.focus();
    expect(swap).toHaveFocus();
    await user.click(swap);
    expect(onChange).toHaveBeenCalledWith({ type: 'related', sourceIsFocal: false });

    // The same arrow control drives Blocks drafts.
    await user.click(screen.getByRole('button', { name: 'Blocks' }));
    expect(onChange).toHaveBeenLastCalledWith({ type: 'blocks', sourceIsFocal: true });
  });

  it('marks the eligible target card and states that it logs time with the source', () => {
    setup({ draft: { type: 'related', sourceIsFocal: true }, eligible: true });

    expect(screen.getAllByLabelText('Logs time')).toHaveLength(1);
    expect(screen.getByTestId('relation-direction-summary')).toHaveTextContent(
      /“Target Epic” logs time with “Source Epic”\./,
    );
  });

  it('moves the logging copy with the arrow when the target swaps', () => {
    setup({ draft: { type: 'related', sourceIsFocal: false }, eligible: true });

    expect(screen.getByTestId('relation-direction-summary')).toHaveTextContent(
      /“Source Epic” logs time with “Target Epic”\./,
    );
  });

  it('states that ineligible Related links do not affect Epic time', () => {
    setup({ draft: { type: 'related', sourceIsFocal: true }, eligible: false });

    expect(screen.getByTestId('relation-direction-summary')).toHaveTextContent(
      /does not affect Epic time/i,
    );
    expect(screen.queryByLabelText('Logs time')).not.toBeInTheDocument();
  });

  it('names the child cause and never claims time logging for ineligible links', () => {
    const { container } = setup({
      draft: { type: 'related', sourceIsFocal: true },
      eligible: false,
      ineligibilityCause: 'child',
    });

    const summary = screen.getByTestId('relation-direction-summary');
    expect(summary).toHaveTextContent(/child Epics never route time\./);
    // The entire picker — summary, center label, live region — stays free of
    // time-logging claims for an ineligible Related draft.
    expect(container.textContent).not.toContain('logs time');
    expect(screen.getByText('no time route')).toBeInTheDocument();
  });

  it('names the cross-project cause for cross-project links', () => {
    const { container } = setup({
      draft: { type: 'related', sourceIsFocal: true },
      eligible: false,
      ineligibilityCause: 'cross-project',
    });

    expect(screen.getByTestId('relation-direction-summary')).toHaveTextContent(
      /only Epics in one project route time\./,
    );
    expect(container.textContent).not.toContain('logs time');
    expect(screen.getByText('no time route')).toBeInTheDocument();
  });

  it('keeps the logs-time center label for eligible Related drafts', () => {
    setup({ draft: { type: 'related', sourceIsFocal: true }, eligible: true });

    expect(screen.getByText('logs time')).toBeInTheDocument();
  });

  it('summarizes Blocks direction without time claims', () => {
    setup({ draft: { type: 'blocks', sourceIsFocal: true } });

    expect(screen.getByTestId('relation-direction-summary')).toHaveTextContent(
      /“Source Epic” blocks “Target Epic”\./,
    );
  });

  it('notes legacy neutral rows without offering a none option', () => {
    setup({ legacyNeutral: true });

    expect(
      screen.getByText(
        /This pair has no direction yet\. Saving stores the direction shown above\./,
      ),
    ).toBeInTheDocument();
  });

  it('shows linked badges for the two endpoints only', () => {
    setup({ sourceLinked: true, targetLinked: true });

    expect(screen.getAllByLabelText('Linked to an external task')).toHaveLength(2);
  });

  it('passes composed accessibility checks', async () => {
    const { container } = setup();
    expect(await axe(container)).toHaveNoViolations();
  });
});
