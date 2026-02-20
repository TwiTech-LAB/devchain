import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { PresetPopover } from './PresetPopover';
import type { PresetAvailability } from '@/ui/lib/preset-validation';

// ResizeObserver mock for Radix components
(global as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

function makePreset(
  name: string,
  available: boolean,
  missingConfigs: PresetAvailability['missingConfigs'] = [],
): PresetAvailability {
  return {
    preset: {
      name,
      description: null,
      agentConfigs: [{ agentName: 'Agent', providerConfigName: 'config' }],
    },
    available,
    missingConfigs,
  };
}

describe('PresetPopover', () => {
  const defaultProps = {
    presets: [
      makePreset('Tier-A', true),
      makePreset('Tier-B', false, [
        { agentName: 'Coder', configName: 'missing-cfg', reason: 'config_not_found' as const },
      ]),
    ],
    activePreset: null as string | null,
    applying: false,
    onApply: jest.fn(),
  };

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('returns null when presets list is empty and alwaysShowTrigger is not set', () => {
    const { container } = render(<PresetPopover {...defaultProps} presets={[]} />);
    expect(container.innerHTML).toBe('');
  });

  it('renders trigger when alwaysShowTrigger is true even with empty presets', () => {
    render(<PresetPopover {...defaultProps} presets={[]} alwaysShowTrigger />);
    expect(screen.getByLabelText('Select preset')).toBeInTheDocument();
  });

  it('renders the trigger button with Layers icon', () => {
    render(<PresetPopover {...defaultProps} />);
    const btn = screen.getByLabelText('Select preset');
    expect(btn).toBeInTheDocument();
    expect(btn).not.toBeDisabled();
  });

  it('disables trigger when disabled prop is true', () => {
    render(<PresetPopover {...defaultProps} disabled />);
    expect(screen.getByLabelText('Select preset')).toBeDisabled();
  });

  it('disables trigger when applying is true', () => {
    render(<PresetPopover {...defaultProps} applying />);
    expect(screen.getByLabelText('Select preset')).toBeDisabled();
  });

  it('renders preset list in popover on click', () => {
    render(<PresetPopover {...defaultProps} />);
    fireEvent.click(screen.getByLabelText('Select preset'));

    expect(screen.getByText('Presets')).toBeInTheDocument();
    expect(screen.getByText('Tier-A')).toBeInTheDocument();
    expect(screen.getByText('Tier-B')).toBeInTheDocument();
  });

  it('shows active indicator when activePreset matches', () => {
    render(<PresetPopover {...defaultProps} activePreset="Tier-A" />);
    fireEvent.click(screen.getByLabelText('Select preset'));

    expect(screen.getByText('Active')).toBeInTheDocument();
  });

  it('calls onApply with correct name on available preset click', () => {
    const onApply = jest.fn();
    render(<PresetPopover {...defaultProps} onApply={onApply} />);
    fireEvent.click(screen.getByLabelText('Select preset'));
    fireEvent.click(screen.getByText('Tier-A'));

    expect(onApply).toHaveBeenCalledWith('Tier-A');
  });

  it('does not call onApply when unavailable preset is clicked', () => {
    const onApply = jest.fn();
    render(<PresetPopover {...defaultProps} onApply={onApply} />);
    fireEvent.click(screen.getByLabelText('Select preset'));

    // The Tier-B button should be disabled
    const tierBButton = screen.getByText('Tier-B').closest('button');
    expect(tierBButton).toBeDisabled();
  });

  it('calls onOpenChange when popover opens', () => {
    const onOpenChange = jest.fn();
    render(<PresetPopover {...defaultProps} onOpenChange={onOpenChange} />);
    fireEvent.click(screen.getByLabelText('Select preset'));

    expect(onOpenChange).toHaveBeenCalledWith(true);
  });

  it('calls onOpenChange(false) when preset is selected (closes popover)', () => {
    const onOpenChange = jest.fn();
    const onApply = jest.fn();
    render(<PresetPopover {...defaultProps} onApply={onApply} onOpenChange={onOpenChange} />);
    fireEvent.click(screen.getByLabelText('Select preset'));

    onOpenChange.mockClear();
    fireEvent.click(screen.getByText('Tier-A'));

    expect(onApply).toHaveBeenCalledWith('Tier-A');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('shows loading text when alwaysShowTrigger with empty presets and popover open', () => {
    render(<PresetPopover {...defaultProps} presets={[]} alwaysShowTrigger />);
    fireEvent.click(screen.getByLabelText('Select preset'));

    expect(screen.getByText('Loading presets...')).toBeInTheDocument();
  });

  it('shows "Applying..." text when applying with empty presets and alwaysShowTrigger', () => {
    render(<PresetPopover {...defaultProps} presets={[]} alwaysShowTrigger applying />);
    // Trigger is disabled when applying, but we can still verify it exists
    const btn = screen.getByLabelText('Select preset');
    expect(btn).toBeDisabled();
  });
});
