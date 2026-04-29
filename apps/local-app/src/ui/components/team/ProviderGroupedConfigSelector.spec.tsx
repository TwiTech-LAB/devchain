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

  it('hides providers that have no configs in the template subset', () => {
    renderWithTemplate(templateSubset, templateSubset);

    // codex + opencode are not in the template subset → entire provider hidden
    expect(screen.queryByLabelText('Provider codex')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Provider opencode')).not.toBeInTheDocument();
    // claude IS in the template → still visible
    expect(screen.getByLabelText('Provider claude')).toBeInTheDocument();
  });

  it('hides individual configs that are not in the template subset', () => {
    renderWithTemplate(templateSubset, templateSubset);

    // sonnet + opus46 are visible (template-selected)
    expect(screen.getByText('sonnet')).toBeInTheDocument();
    expect(screen.getByText('opus46')).toBeInTheDocument();
    // opus + glm are NOT in template subset → hidden entirely
    expect(screen.queryByText('opus')).not.toBeInTheDocument();
    expect(screen.queryByText('glm')).not.toBeInTheDocument();
  });

  it('toggling provider OFF struck-throughs the visible template configs (does not hide them)', () => {
    // Current selection is empty (provider was toggled off); template still subset
    renderWithTemplate([{ profileKey: 'Coder', mode: 'remove' }], templateSubset);

    // Visible configs = template subset, but current selection is empty → strikethrough
    const sonnetRow = screen.getByText('sonnet').closest('div');
    expect(sonnetRow?.className).toContain('line-through');
    const opus46Row = screen.getByText('opus46').closest('div');
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
