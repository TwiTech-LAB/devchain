import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { ProviderGroupedConfigSelector } from './ProviderGroupedConfigSelector';
import type { ConfigItem, ProfileSelection } from './selector-types';

const coderConfigs: ConfigItem<string>[] = [
  { key: 'opus', label: 'opus', providerName: 'claude' },
  { key: 'opus46', label: 'opus46', providerName: 'claude' },
  { key: 'sonnet', label: 'sonnet', providerName: 'claude' },
  { key: 'glm', label: 'glm', providerName: 'claude' },
  { key: 'gpt', label: 'gpt', providerName: 'codex' },
  { key: 'codex-high', label: 'codex-high', providerName: 'codex' },
  { key: 'codex-medium', label: 'codex-medium', providerName: 'codex' },
  { key: 'opencode', label: 'opencode', providerName: 'opencode' },
];

const configsByProfile: Record<string, ConfigItem<string>[]> = { Coder: coderConfigs };

function StatefulHarness({
  initial,
  templateSelections,
  onChangeSpy,
}: {
  initial: ProfileSelection<string, string>[];
  templateSelections?: ProfileSelection<string, string>[];
  onChangeSpy?: jest.Mock;
}) {
  const [selections, setSelections] = React.useState(initial);
  return (
    <ProviderGroupedConfigSelector
      focusedProfileKey="Coder"
      configsByProfile={configsByProfile}
      selections={selections}
      templateSelections={templateSelections}
      onChange={(next) => {
        onChangeSpy?.(next);
        setSelections(next);
      }}
    />
  );
}

function renderWithTemplate(
  selections: ProfileSelection<string, string>[],
  templateSelections: ProfileSelection<string, string>[],
) {
  const onChange = jest.fn();
  render(
    <ProviderGroupedConfigSelector
      focusedProfileKey="Coder"
      configsByProfile={configsByProfile}
      selections={selections}
      templateSelections={templateSelections}
      onChange={onChange}
    />,
  );
  return onChange;
}

describe('ProviderGroupedConfigSelector — templateSelections', () => {
  const templateSubset: ProfileSelection<string, string>[] = [
    { profileKey: 'Coder', mode: 'subset', configKeys: ['sonnet', 'opus46'] },
  ];

  it('toggling a provider OFF then ON preserves the template subset (does not expand to all)', () => {
    // initial: subset {sonnet, opus46} ← matches template baseline
    const onChange = renderWithTemplate(templateSubset, templateSubset);

    // claude shows as fully checked because all of its template-subset is in current
    expect(screen.getByLabelText('Provider claude')).toHaveAttribute('data-state', 'checked');

    // Toggle claude off
    fireEvent.click(screen.getByLabelText('Provider claude'));

    expect(onChange).toHaveBeenLastCalledWith([{ profileKey: 'Coder', mode: 'remove' }]);
  });

  it('toggling a previously-removed provider ON re-adds the template subset, not all configs', () => {
    // Current: claude removed; template still says {sonnet, opus46}
    const onChange = renderWithTemplate([{ profileKey: 'Coder', mode: 'remove' }], templateSubset);

    fireEvent.click(screen.getByLabelText('Provider claude'));

    // Re-adds only sonnet + opus46 (NOT opus or glm)
    expect(onChange).toHaveBeenLastCalledWith([
      {
        profileKey: 'Coder',
        mode: 'subset',
        configKeys: expect.arrayContaining(['sonnet', 'opus46']),
      },
    ]);
    const lastCall = onChange.mock.calls[onChange.mock.calls.length - 1][0];
    expect(lastCall[0].configKeys).toHaveLength(2);
    expect(lastCall[0].configKeys).not.toContain('opus');
    expect(lastCall[0].configKeys).not.toContain('glm');
  });

  it('shows only providers and configs in the template subset', () => {
    renderWithTemplate(templateSubset, templateSubset);
    {
      expect(screen.queryByLabelText('Provider codex')).not.toBeInTheDocument();
      expect(screen.queryByLabelText('Provider opencode')).not.toBeInTheDocument();
      expect(screen.getByLabelText('Provider claude')).toBeInTheDocument();
    }
    {
      expect(screen.getByText('sonnet')).toBeInTheDocument();
      expect(screen.getByText('opus46')).toBeInTheDocument();
      expect(screen.queryByText('opus')).not.toBeInTheDocument();
      expect(screen.queryByText('glm')).not.toBeInTheDocument();
    }
  });

  it('toggling provider OFF struck-throughs the visible template configs (does not hide them)', () => {
    // Current selection is empty (provider was toggled off); template still subset
    renderWithTemplate([{ profileKey: 'Coder', mode: 'remove' }], templateSubset);

    // Visible configs = template subset, but current selection is empty → strikethrough
    const sonnetRow = screen.getByText('sonnet').closest('label');
    expect(sonnetRow?.className).toContain('line-through');
    const opus46Row = screen.getByText('opus46').closest('label');
    expect(opus46Row?.className).toContain('line-through');
  });

  it('falls back to all-of-provider toggling when no templateSelections is provided (legacy)', () => {
    const onChange = jest.fn();
    render(
      <ProviderGroupedConfigSelector
        focusedProfileKey="Coder"
        configsByProfile={configsByProfile}
        selections={[{ profileKey: 'Coder', mode: 'remove' }]}
        onChange={onChange}
      />,
    );

    fireEvent.click(screen.getByLabelText('Provider claude'));

    // Without templateSelections, toggling claude adds ALL 4 of its configs (legacy)
    const lastCall = onChange.mock.calls[onChange.mock.calls.length - 1][0];
    expect(lastCall[0].configKeys).toHaveLength(4);
  });
});

describe('ProviderGroupedConfigSelector — per-config toggles', () => {
  it('(a) toggling one config ON from mode:remove emits subset and provider becomes indeterminate', () => {
    const spy = jest.fn();
    render(
      <StatefulHarness initial={[{ profileKey: 'Coder', mode: 'remove' }]} onChangeSpy={spy} />,
    );

    fireEvent.click(screen.getByLabelText('Config opus'));

    expect(spy).toHaveBeenLastCalledWith([
      expect.objectContaining({ mode: 'subset', configKeys: ['opus'] }),
    ]);
    // After state update via StatefulHarness, provider checkbox is indeterminate
    expect(screen.getByLabelText('Provider claude')).toHaveAttribute('data-state', 'indeterminate');
  });

  it('(b) toggling the last selected config OFF emits mode:remove', () => {
    const spy = jest.fn();
    render(
      <StatefulHarness
        initial={[{ profileKey: 'Coder', mode: 'subset', configKeys: ['opus'] }]}
        onChangeSpy={spy}
      />,
    );

    fireEvent.click(screen.getByLabelText('Config opus'));

    expect(spy).toHaveBeenLastCalledWith([expect.objectContaining({ mode: 'remove' })]);
  });

  it('(c) starting in mode:allow-all, clicking one config emits subset with all except the clicked one', () => {
    const spy = jest.fn();
    render(
      <StatefulHarness initial={[{ profileKey: 'Coder', mode: 'allow-all' }]} onChangeSpy={spy} />,
    );

    // All visible configs are shown as checked; uncheck 'opus'
    fireEvent.click(screen.getByLabelText('Config opus'));

    const emitted = spy.mock.calls[spy.mock.calls.length - 1][0][0];
    expect(emitted.mode).toBe('subset');
    expect(emitted.configKeys).not.toContain('opus');
    // All other visible configs (opus46, sonnet, glm, gpt, codex-high, codex-medium, opencode) still in
    expect(emitted.configKeys).toContain('opus46');
    expect(emitted.configKeys).toContain('sonnet');
  });

  it('(d) with templateSelections subset {sonnet, opus46}, onChange payload never contains template-hidden keys', () => {
    const templateSubset: ProfileSelection<string, string>[] = [
      { profileKey: 'Coder', mode: 'subset', configKeys: ['sonnet', 'opus46'] },
    ];
    const spy = jest.fn();
    render(
      <StatefulHarness
        initial={[{ profileKey: 'Coder', mode: 'remove' }]}
        templateSelections={templateSubset}
        onChangeSpy={spy}
      />,
    );

    // Only sonnet and opus46 are visible; toggle sonnet ON
    fireEvent.click(screen.getByLabelText('Config sonnet'));

    const emitted = spy.mock.calls[spy.mock.calls.length - 1][0][0];
    expect(emitted.configKeys).not.toContain('opus');
    expect(emitted.configKeys).not.toContain('glm');
    expect(emitted.configKeys).not.toContain('gpt');
    expect(emitted.configKeys).not.toContain('codex-high');
    expect(emitted.configKeys).not.toContain('codex-medium');
    expect(emitted.configKeys).not.toContain('opencode');
  });
});
