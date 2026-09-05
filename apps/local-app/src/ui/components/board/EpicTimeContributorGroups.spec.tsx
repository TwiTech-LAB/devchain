import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import type { EpicTimeTaskItem } from '@/modules/epic-time/models/epic-time.models';
import { EpicTimeContributorGroups } from './EpicTimeContributorGroups';

// Layer: UI unit. The component is a pure presentation of task items with a
// local expansion Set; rendering it directly is the cheapest reliable layer.
describe('EpicTimeContributorGroups', () => {
  const groupedItems: EpicTimeTaskItem[] = [
    {
      epicId: 'epic-routed-child-b',
      epicTitle: 'Routed child B',
      isDirect: false,
      minutes: 10,
      groupEpicId: 'epic-routed',
      groupEpicTitle: 'Routed root',
    },
    {
      epicId: 'epic-focal',
      epicTitle: 'Focal task',
      isDirect: true,
      minutes: 30,
      groupEpicId: 'epic-focal',
      groupEpicTitle: 'Focal task',
    },
    {
      epicId: 'epic-routed',
      epicTitle: 'Routed root',
      isDirect: false,
      minutes: 15,
      groupEpicId: 'epic-routed',
      groupEpicTitle: 'Routed root',
    },
    {
      epicId: 'epic-focal-child',
      epicTitle: 'Focal child',
      isDirect: false,
      minutes: 60,
      groupEpicId: 'epic-focal',
      groupEpicTitle: 'Focal task',
    },
    {
      epicId: 'epic-routed-child-a',
      epicTitle: 'Routed child A',
      isDirect: false,
      minutes: 20,
      groupEpicId: 'epic-routed',
      groupEpicTitle: 'Routed root',
    },
  ];

  const degradedItems: EpicTimeTaskItem[] = [
    { epicId: 'epic-focal', epicTitle: 'Focal task', isDirect: true, minutes: 30 },
    {
      epicId: 'epic-child',
      epicTitle: 'Child task',
      isDirect: false,
      minutes: 60,
      groupEpicId: 'epic-focal',
      groupEpicTitle: 'Focal task',
    },
  ];

  function renderGroups(
    taskItems: readonly EpicTimeTaskItem[],
    focalEpicId: string,
  ): ReturnType<typeof render> {
    return render(<EpicTimeContributorGroups taskItems={taskItems} focalEpicId={focalEpicId} />);
  }

  it('renders the focal group first, related groups by title, and their totals', () => {
    const { container } = renderGroups(groupedItems, 'epic-focal');

    expect(
      screen.getByText('Only DevChain activity that rolls into this remote task is shown.'),
    ).toBeVisible();
    expect(screen.getByRole('button', { name: /This task 1h 30m/ })).toBeVisible();
    expect(screen.getByRole('button', { name: /Related: Routed root 45m/ })).toBeVisible();
    // Wire order is scrambled on purpose; group order is derived, not copied.
    const groups = screen.getByRole('list', { name: 'Contributing DevChain task groups' });
    expect(groups.querySelectorAll('li').length).toBe(2);
    expect(
      within(groups.querySelectorAll('li')[0]!).getByRole('button', { name: /This task/ }),
    ).toBeVisible();
    expect(container.querySelectorAll('ul[aria-label="Contributing DevChain tasks"]')).toHaveLength(
      0,
    );
  });

  it('starts collapsed, discloses Own activity first, then sub-Epics by title and Epic ID', async () => {
    const user = userEvent.setup();
    renderGroups(groupedItems, 'epic-focal');

    const focalTrigger = screen.getByRole('button', { name: /This task/ });
    expect(focalTrigger).toHaveAttribute('aria-expanded', 'false');
    expect(focalTrigger).toHaveAttribute('aria-controls');
    expect(screen.queryByText('Own activity')).toBeNull();
    expect(screen.queryByText('Focal child')).toBeNull();

    await user.click(focalTrigger);
    expect(focalTrigger).toHaveAttribute('aria-expanded', 'true');
    const focalRows = screen.getByText('Own activity').closest('ul')!;
    expect(
      within(focalRows)
        .getAllByRole('listitem')
        .map((row) => row.textContent),
    ).toEqual(['Own activity30m', 'Focal child1h']);

    const relatedTrigger = screen.getByRole('button', { name: /Related: Routed root/ });
    expect(relatedTrigger).toHaveAttribute('aria-expanded', 'false');
    await user.click(relatedTrigger);
    const relatedRows = screen.getByText('Routed child A').closest('ul')!;
    expect(
      within(relatedRows)
        .getAllByRole('listitem')
        .map((row) => row.textContent),
    ).toEqual(['Own activity15m', 'Routed child A20m', 'Routed child B10m']);
    expect(screen.getAllByText('Own activity')).toHaveLength(2);
  });

  it('sums every group total exactly to the summary total', () => {
    renderGroups(groupedItems, 'epic-focal');
    const totalMinutes = groupedItems.reduce((total, item) => total + item.minutes, 0);
    const includedTotals = screen.getAllByRole('button').map((button) => button.textContent ?? '');
    const parsed = includedTotals.map((label) => {
      const hours = /(\d+)h/.exec(label)?.[1] ?? '0';
      const minutes = /(\d+)m/.exec(label)?.[1] ?? '0';
      return Number(hours) * 60 + Number(minutes);
    });
    expect(parsed.reduce((total, minutes) => total + minutes, 0)).toBe(totalMinutes);
  });

  it('renders the exact legacy flat list and no relationship claim when a row lacks the pair', () => {
    renderGroups(degradedItems, 'epic-focal');

    const list = screen.getByRole('list', { name: 'Contributing DevChain tasks' });
    expect(list.className).toBe('space-y-1');
    expect(
      within(list)
        .getAllByRole('listitem')
        .map((row) => row.textContent),
    ).toEqual(['Focal task30m', 'Child task1h']);
    expect(screen.queryByText('This task')).toBeNull();
    expect(screen.queryByText(/Related:/)).toBeNull();
    expect(
      screen.queryByText('Only DevChain activity that rolls into this remote task is shown.'),
    ).toBeNull();
  });

  it('keeps an own-only related group as a compact non-disclosure line', () => {
    const { container } = renderGroups(
      [
        {
          epicId: 'epic-solo',
          epicTitle: 'Solo routed',
          isDirect: false,
          minutes: 15,
          groupEpicId: 'epic-solo',
          groupEpicTitle: 'Solo routed',
        },
      ],
      'epic-focal',
    );

    expect(screen.getByText('Related: Solo routed')).toBeVisible();
    expect(screen.getByText('Related: Solo routed').closest('p')).toHaveTextContent('15m');
    expect(container.querySelectorAll('button')).toHaveLength(0);
  });

  it('keeps a child-focal self-only group as a compact This task line', () => {
    const { container } = renderGroups(
      [
        {
          epicId: 'epic-child-focal',
          epicTitle: 'Child focal',
          isDirect: true,
          minutes: 45,
          groupEpicId: 'epic-child-focal',
          groupEpicTitle: 'Child focal',
        },
      ],
      'epic-child-focal',
    );

    // A linked child focal is self-only: one compact "This task" line, no
    // disclosure, no structural-parent claim.
    expect(screen.getByText('This task')).toBeVisible();
    expect(screen.getByText('This task').closest('p')).toHaveTextContent('45m');
    expect(container.querySelectorAll('button')).toHaveLength(0);
  });

  it('sorts related groups by title and Epic ID, not wire order', () => {
    renderGroups(
      [
        {
          epicId: 'epic-zeta',
          epicTitle: 'Zeta root',
          isDirect: false,
          minutes: 5,
          groupEpicId: 'epic-zeta',
          groupEpicTitle: 'Zeta root',
        },
        {
          epicId: 'epic-focal',
          epicTitle: 'Focal task',
          isDirect: true,
          minutes: 30,
          groupEpicId: 'epic-focal',
          groupEpicTitle: 'Focal task',
        },
        {
          epicId: 'epic-alpha',
          epicTitle: 'Alpha root',
          isDirect: false,
          minutes: 10,
          groupEpicId: 'epic-alpha',
          groupEpicTitle: 'Alpha root',
        },
      ],
      'epic-focal',
    );

    const groups = screen.getByRole('list', { name: 'Contributing DevChain task groups' });
    expect(
      [...groups.querySelectorAll('li')].map(
        (item) => item.querySelector('button, p')?.textContent ?? '',
      ),
    ).toEqual([
      expect.stringContaining('This task'),
      expect.stringContaining('Related: Alpha root'),
      expect.stringContaining('Related: Zeta root'),
    ]);
  });

  it('keeps a zero-own routed root disclosable without an Own activity row', async () => {
    const user = userEvent.setup();
    renderGroups(
      [
        {
          epicId: 'epic-focal',
          epicTitle: 'Focal task',
          isDirect: true,
          minutes: 30,
          groupEpicId: 'epic-focal',
          groupEpicTitle: 'Focal task',
        },
        {
          epicId: 'epic-silent-child',
          epicTitle: 'Silent child',
          isDirect: false,
          minutes: 10,
          groupEpicId: 'epic-silent',
          groupEpicTitle: 'Silent routed',
        },
      ],
      'epic-focal',
    );

    const trigger = screen.getByRole('button', {
      name: /Related: Silent routed 10m/,
    });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await user.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    const rows = screen.getByText('Silent child').closest('ul')!;
    expect(
      within(rows)
        .getAllByRole('listitem')
        .map((row) => row.textContent),
    ).toEqual(['Silent child10m']);
    expect(within(rows).queryByText('Own activity')).toBeNull();
  });

  it('hides chevrons from assistive technology and stays axe-clean', async () => {
    const { container } = renderGroups(groupedItems, 'epic-focal');
    const chevron = screen.getByRole('button', { name: /This task/ }).querySelector('svg');
    expect(chevron).toHaveAttribute('aria-hidden', 'true');
    expect(await axe(container)).toHaveNoViolations();
  });

  it('resets expansion only through the focalEpicId remount key, with no reset effect', async () => {
    const user = userEvent.setup();
    function Harness({ focalEpicId }: { focalEpicId: string }) {
      return (
        <EpicTimeContributorGroups
          key={focalEpicId}
          taskItems={groupedItems}
          focalEpicId={focalEpicId}
        />
      );
    }
    const { rerender } = render(<Harness focalEpicId="epic-focal" />);
    const trigger = screen.getByRole('button', { name: /This task/ });
    await user.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');

    // Same focal: the component instance survives and keeps its expansion.
    rerender(<Harness focalEpicId="epic-focal" />);
    expect(screen.getByRole('button', { name: /This task/ })).toHaveAttribute(
      'aria-expanded',
      'true',
    );

    // A relink changes the key: a fresh instance starts collapsed, and the
    // old focal group re-labels as related.
    rerender(<Harness focalEpicId="epic-relLinked" />);
    expect(screen.getByRole('button', { name: /Related: Focal task 1h 30m/ })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    expect(screen.queryByText('Own activity')).toBeNull();
  });

  it('renders nothing without task rows', () => {
    const { container } = renderGroups([], 'epic-focal');
    expect(container).toBeEmptyDOMElement();
  });
});
