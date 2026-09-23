interface BunTerminal {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  close(): void;
}

interface BunSubprocess {
  stdout?: { text(): Promise<string> };
  stderr?: { text(): Promise<string> };
  exited: Promise<number>;
  terminal?: BunTerminal;
  killed: boolean;
  kill(signal: string): void;
}

interface BunRuntime {
  spawn(
    command: string[],
    options: {
      env?: NodeJS.ProcessEnv;
      stdout?: "pipe";
      stderr?: "pipe";
      terminal?: {
        cols: number;
        rows: number;
        name: string;
        data(terminal: BunTerminal, output: string): void;
      };
    },
  ): BunSubprocess;
}

export function getBunRuntime(): BunRuntime {
  const runtime = (globalThis as typeof globalThis & { Bun?: BunRuntime }).Bun;
  if (!runtime) throw new Error("This operation requires the Bun runtime.");
  return runtime;
}

export type { BunSubprocess, BunTerminal };
