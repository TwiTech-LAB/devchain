export type TerminalTheme = {
  background: string;
  foreground: string;
  cursor: string;
  selection: string;
  fontFamily: string;
  fontSize: number;
};

export interface ITerminalAdapter {
  open(container: HTMLElement): void;
  write(data: string): void;
  reset(): void;
  clear(): void;
  focus(): void;
  onData(cb: (data: string) => void): void;
  getSize(): { rows: number; cols: number };
  applyTheme(theme: TerminalTheme): void;
  dispose(): void;
}
