/** Keep cached output from generating terminal replies for a second time. */
export class TmuxTerminalReplayGuard {
  private generation = 0;
  private replaying = false;

  public constructor(
    private readonly terminal: { write(data: string, callback?: () => void): void },
    private readonly onChange: (replaying: boolean) => void,
  ) {}

  public get active(): boolean {
    return this.replaying;
  }

  public start(): void {
    this.generation += 1;
    this.replaying = true;
    this.onChange(true);
  }

  public finish(): void {
    const generation = this.generation;
    // xterm parses writes asynchronously. Queue the boundary after every
    // cached chunk so new live output is parsed with replies enabled again.
    this.terminal.write("", () => {
      if (!this.replaying || generation !== this.generation) return;
      this.replaying = false;
      this.onChange(false);
    });
  }
}
