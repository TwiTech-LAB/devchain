import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { DensityToggle } from './DensityToggle';

describe('DensityToggle', () => {
  it('renders comfortable and compact buttons', () => {
    render(<DensityToggle value="comfortable" onChange={jest.fn()} />);
    expect(screen.getByRole('radio', { name: 'Comfortable density' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Compact density' })).toBeInTheDocument();
  });

  it('marks the current value as pressed', () => {
    render(<DensityToggle value="compact" onChange={jest.fn()} />);
    expect(screen.getByRole('radio', { name: 'Compact density' })).toHaveAttribute(
      'data-state',
      'on',
    );
    expect(screen.getByRole('radio', { name: 'Comfortable density' })).toHaveAttribute(
      'data-state',
      'off',
    );
  });

  it('calls onChange with new value when toggled', () => {
    const onChange = jest.fn();
    render(<DensityToggle value="comfortable" onChange={onChange} />);
    fireEvent.click(screen.getByRole('radio', { name: 'Compact density' }));
    expect(onChange).toHaveBeenCalledWith('compact');
  });

  it('has accessible toggle group label', () => {
    render(<DensityToggle value="comfortable" onChange={jest.fn()} />);
    expect(screen.getByRole('group', { name: 'Table density' })).toBeInTheDocument();
  });
});
