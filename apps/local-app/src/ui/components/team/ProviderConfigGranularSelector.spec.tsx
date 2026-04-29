import { fireEvent, render, screen, within } from '@testing-library/react';
import { ProviderConfigGranularSelector } from './ProviderConfigGranularSelector';
import type { ConfigItem, ProfileSelection } from './selector-types';

const claudeConfigs: ConfigItem<string>[] = [
  { key: 'c1', label: 'Claude Opus', providerName: 'claude' },
  { key: 'c2', label: 'Claude Sonnet', providerName: 'claude' },
];

const codexConfigs: ConfigItem<string>[] = [
  { key: 'x1', label: 'Codex Mini', providerName: 'codex' },
];

const allConfigs = [...claudeConfigs, ...codexConfigs];

const configsByProfile: Record<string, ConfigItem<string>[]> = {
  'profile-1': allConfigs,
};

function renderSelector(
  selections: ProfileSelection<string, string>[],
  onChange?: jest.Mock,
  focusedProfileKey: string | null = 'profile-1',
) {
  const onChangeMock = onChange ?? jest.fn();
  render(
    <ProviderConfigGranularSelector
      focusedProfileKey={focusedProfileKey}
      configsByProfile={configsByProfile}
      selections={selections}
      onChange={onChangeMock}
    />,
  );
  return onChangeMock;
}

describe('ProviderConfigGranularSelector', () => {
  it('renders provider headers and per-config checkboxes', () => {
    renderSelector([{ profileKey: 'profile-1', mode: 'allow-all' }]);

    expect(screen.getByLabelText('Select all claude configs')).toBeInTheDocument();
    expect(screen.getByLabelText('Select all codex configs')).toBeInTheDocument();

    const claudeGroup = screen.getByTestId('provider-group-claude');
    expect(within(claudeGroup).getByLabelText('Claude Opus')).toBeInTheDocument();
    expect(within(claudeGroup).getByLabelText('Claude Sonnet')).toBeInTheDocument();

    const codexGroup = screen.getByTestId('provider-group-codex');
    expect(within(codexGroup).getByLabelText('Codex Mini')).toBeInTheDocument();
  });

  it('allow-all: all per-config and provider checkboxes are checked', () => {
    renderSelector([{ profileKey: 'profile-1', mode: 'allow-all' }]);

    expect(screen.getByLabelText('Select all claude configs')).toHaveAttribute(
      'data-state',
      'checked',
    );
    expect(screen.getByLabelText('Select all codex configs')).toHaveAttribute(
      'data-state',
      'checked',
    );
    expect(screen.getByLabelText('Claude Opus')).toHaveAttribute('data-state', 'checked');
    expect(screen.getByLabelText('Claude Sonnet')).toHaveAttribute('data-state', 'checked');
    expect(screen.getByLabelText('Codex Mini')).toHaveAttribute('data-state', 'checked');
  });

  it('subset: only selected configs checked, provider header shows indeterminate', () => {
    renderSelector([{ profileKey: 'profile-1', mode: 'subset', configKeys: ['c1'] }]);

    expect(screen.getByLabelText('Claude Opus')).toHaveAttribute('data-state', 'checked');
    expect(screen.getByLabelText('Claude Sonnet')).toHaveAttribute('data-state', 'unchecked');
    expect(screen.getByLabelText('Codex Mini')).toHaveAttribute('data-state', 'unchecked');

    expect(screen.getByLabelText('Select all claude configs')).toHaveAttribute(
      'data-state',
      'indeterminate',
    );
    expect(screen.getByLabelText('Select all codex configs')).toHaveAttribute(
      'data-state',
      'unchecked',
    );
  });

  it('remove: all checkboxes unchecked', () => {
    renderSelector([{ profileKey: 'profile-1', mode: 'remove' }]);

    expect(screen.getByLabelText('Claude Opus')).toHaveAttribute('data-state', 'unchecked');
    expect(screen.getByLabelText('Claude Sonnet')).toHaveAttribute('data-state', 'unchecked');
    expect(screen.getByLabelText('Codex Mini')).toHaveAttribute('data-state', 'unchecked');
    expect(screen.getByLabelText('Select all claude configs')).toHaveAttribute(
      'data-state',
      'unchecked',
    );
    expect(screen.getByLabelText('Select all codex configs')).toHaveAttribute(
      'data-state',
      'unchecked',
    );
  });

  it('provider toggle bulk-select: selects all configs of that provider', () => {
    const onChange = renderSelector([
      { profileKey: 'profile-1', mode: 'subset', configKeys: ['x1'] },
    ]);

    fireEvent.click(screen.getByLabelText('Select all claude configs'));

    expect(onChange).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          profileKey: 'profile-1',
          mode: 'allow-all',
        }),
      ]),
    );
  });

  it('provider toggle bulk-clear: deselects all configs of that provider', () => {
    const onChange = renderSelector([{ profileKey: 'profile-1', mode: 'allow-all' }]);

    fireEvent.click(screen.getByLabelText('Select all codex configs'));

    expect(onChange).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          profileKey: 'profile-1',
          mode: 'subset',
          configKeys: expect.arrayContaining(['c1', 'c2']),
        }),
      ]),
    );
  });

  it('per-config toggle on: adds config to selection', () => {
    const onChange = renderSelector([
      { profileKey: 'profile-1', mode: 'subset', configKeys: ['c1'] },
    ]);

    fireEvent.click(screen.getByLabelText('Codex Mini'));

    expect(onChange).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          profileKey: 'profile-1',
          mode: 'subset',
          configKeys: expect.arrayContaining(['c1', 'x1']),
        }),
      ]),
    );
  });

  it('per-config toggle off: removes config from selection', () => {
    const onChange = renderSelector([
      { profileKey: 'profile-1', mode: 'subset', configKeys: ['c1', 'x1'] },
    ]);

    fireEvent.click(screen.getByLabelText('Claude Opus'));

    expect(onChange).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          profileKey: 'profile-1',
          mode: 'subset',
          configKeys: ['x1'],
        }),
      ]),
    );
  });

  it('per-config toggle: provider header shows indeterminate after partial selection', () => {
    renderSelector([{ profileKey: 'profile-1', mode: 'subset', configKeys: ['c1'] }]);

    expect(screen.getByLabelText('Select all claude configs')).toHaveAttribute(
      'data-state',
      'indeterminate',
    );
  });

  it('per-config toggle: provider header shows checked when all its configs selected', () => {
    renderSelector([{ profileKey: 'profile-1', mode: 'subset', configKeys: ['c1', 'c2'] }]);

    expect(screen.getByLabelText('Select all claude configs')).toHaveAttribute(
      'data-state',
      'checked',
    );
  });

  it('Rule 1: emits allow-all when all configs become checked', () => {
    const onChange = renderSelector([
      { profileKey: 'profile-1', mode: 'subset', configKeys: ['c1', 'c2'] },
    ]);

    fireEvent.click(screen.getByLabelText('Codex Mini'));

    expect(onChange).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          profileKey: 'profile-1',
          mode: 'allow-all',
        }),
      ]),
    );
  });

  it('Rule 2: subset emits explicit configKeys', () => {
    const onChange = renderSelector([{ profileKey: 'profile-1', mode: 'allow-all' }]);

    fireEvent.click(screen.getByLabelText('Codex Mini'));

    expect(onChange).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          profileKey: 'profile-1',
          mode: 'subset',
          configKeys: expect.arrayContaining(['c1', 'c2']),
        }),
      ]),
    );
  });

  it('Rule 3 REGRESSION: unchecking all configs one-by-one emits remove', () => {
    const onChange = jest.fn();
    render(
      <ProviderConfigGranularSelector
        focusedProfileKey="profile-1"
        configsByProfile={configsByProfile}
        selections={[{ profileKey: 'profile-1', mode: 'subset', configKeys: ['c1'] }]}
        onChange={onChange}
      />,
    );

    fireEvent.click(screen.getByLabelText('Claude Opus'));

    expect(onChange).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          profileKey: 'profile-1',
          mode: 'remove',
        }),
      ]),
    );
  });

  it('Rule 3 via provider header: unchecking last remaining provider emits remove', () => {
    const onChange = renderSelector([
      { profileKey: 'profile-1', mode: 'subset', configKeys: ['x1'] },
    ]);

    fireEvent.click(screen.getByLabelText('Select all codex configs'));

    expect(onChange).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          profileKey: 'profile-1',
          mode: 'remove',
        }),
      ]),
    );
  });

  it('renders placeholder when focusedProfileKey is null', () => {
    renderSelector([], undefined, null);

    expect(screen.getByText('Select a profile')).toBeInTheDocument();
  });

  it('renders placeholder when profile has no configs', () => {
    render(
      <ProviderConfigGranularSelector
        focusedProfileKey="empty-profile"
        configsByProfile={{ 'empty-profile': [] }}
        selections={[]}
        onChange={jest.fn()}
      />,
    );

    expect(screen.getByText('No provider configs')).toBeInTheDocument();
  });
});
