import { readFileSync } from 'fs';
import { join } from 'path';

describe('main.ts mode bootstrap', () => {
  it('selects only normal/main root modules', () => {
    const source = readFileSync(join(__dirname, '..', 'main.ts'), 'utf8');

    expect(source).toMatch(
      /process\.env\.DEVCHAIN_MODE\s*===\s*'main'\s*\?\s*'main'\s*:\s*'normal'/,
    );
    expect(source).toMatch(/import\('\.\/app\.main\.module'\)/);
    expect(source).toMatch(/import\('\.\/app\.normal\.module'\)/);
    expect(source).not.toMatch(/'orchestrator'/);
  });
});
