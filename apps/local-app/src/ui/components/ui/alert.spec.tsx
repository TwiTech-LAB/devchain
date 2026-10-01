import { render, screen } from '@testing-library/react';
import { Alert, AlertDescription } from './alert';

describe('Alert status variants', () => {
  it.each([
    ['warn', 'status-warn'],
    ['ok', 'status-ok'],
  ] as const)('the %s variant colors the border, the text and the icon', (variant, token) => {
    render(
      <Alert variant={variant}>
        <svg />
        <AlertDescription>Message</AlertDescription>
      </Alert>,
    );

    const alert = screen.getByRole('alert');
    expect(alert).toHaveClass(
      'bg-background',
      `border-${token}/40`,
      `text-${token}`,
      `[&>svg]:text-${token}`,
    );
    // The base icon color would win over an icon class, so the variant must replace it.
    expect(alert).not.toHaveClass('[&>svg]:text-foreground');
  });

  it('lets a tint class replace the surface background', () => {
    render(<Alert variant="warn" className="bg-status-warn/10" />);

    const alert = screen.getByRole('alert');
    expect(alert).toHaveClass('bg-status-warn/10');
    expect(alert).not.toHaveClass('bg-background');
  });
});
