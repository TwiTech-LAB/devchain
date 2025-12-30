import React from 'react';
import { render } from '@testing-library/react';
import { ThemeToggle, getStoredTheme, applyTheme, type ThemeValue } from './ThemeToggle';

describe('ThemeToggle', () => {
  beforeEach(() => {
    document.documentElement.classList.remove('dark');
    document.documentElement.classList.remove('theme-ocean');
    localStorage.clear();
  });

  it('applies classes and persists on value change', () => {
    const Wrapper = ({ value }: { value: ThemeValue }) => (
      <ThemeToggle value={value} onChange={() => {}} />
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
});
