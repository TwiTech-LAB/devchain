import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { ThemeSelect, getStoredTheme, applyTheme, type ThemeValue } from './ThemeSelect';

describe('ThemeSelect', () => {
  beforeEach(() => {
    document.documentElement.classList.remove('dark');
    document.documentElement.classList.remove('theme-ocean');
    localStorage.clear();
  });

  it('applies classes and persists on value change', () => {
    const Wrapper = ({ value }: { value: ThemeValue }) => (
      <ThemeSelect value={value} onChange={() => {}} />
    );

    const { rerender } = render(<Wrapper value="ocean" />);
    expect(document.documentElement.classList.contains('dark')).toBe(false);
    expect(document.documentElement.classList.contains('theme-ocean')).toBe(true);
    expect(localStorage.getItem('devchain:theme')).toBe('ocean');

    rerender(<Wrapper value="dark" />);
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(document.documentElement.classList.contains('theme-ocean')).toBe(false);
    expect(localStorage.getItem('devchain:theme')).toBe('dark');
  });

  it('applyTheme helper updates DOM and storage', () => {
    applyTheme('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(localStorage.getItem('devchain:theme')).toBe('dark');

    applyTheme('ocean');
    expect(document.documentElement.classList.contains('theme-ocean')).toBe(true);
    expect(document.documentElement.classList.contains('dark')).toBe(false);
    expect(localStorage.getItem('devchain:theme')).toBe('ocean');
  });

  it('getStoredTheme reads valid values and migrates light→ocean', () => {
    expect(getStoredTheme()).toBeNull();
    localStorage.setItem('devchain:theme', 'dark');
    expect(getStoredTheme()).toBe('dark');
    localStorage.setItem('devchain:theme', 'ocean');
    expect(getStoredTheme()).toBe('ocean');
    localStorage.setItem('devchain:theme', 'light');
    expect(getStoredTheme()).toBe('ocean');
    expect(localStorage.getItem('devchain:theme')).toBe('ocean');
    localStorage.setItem('devchain:theme', 'weird');
    expect(getStoredTheme()).toBeNull();
  });

  it('renders only Ocean and Dark options', () => {
    render(<ThemeSelect value="ocean" onChange={() => {}} />);
    const trigger = screen.getByRole('combobox', { name: /select theme/i });
    fireEvent.click(trigger);
    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(2);
    expect(options[0]).toHaveTextContent('Ocean');
    expect(options[1]).toHaveTextContent('Dark');
  });

  it('defaults to Ocean when no stored theme exists', () => {
    localStorage.removeItem('devchain:theme');
    applyTheme(getStoredTheme() ?? 'ocean');
    expect(document.documentElement.classList.contains('theme-ocean')).toBe(true);
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });
});
