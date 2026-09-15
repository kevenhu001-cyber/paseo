import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { Logger } from "pino";

export interface AntigravityProcessLaunch {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
}

export interface AntigravityProcessExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export type AntigravitySpawnFn = (
  launch: AntigravityProcessLaunch,
) => ChildProcessWithoutNullStreams;

export interface SpawnAntigravityProcessOptions {
  launch: AntigravityProcessLaunch;
  logger: Logger;
  spawnFn?: AntigravitySpawnFn;
  stderrTailChars?: number;
}

const DEFAULT_STDERR_TAIL_CHARS = 8192;

function defaultSpawn(launch: AntigravityProcessLaunch): ChildProcessWithoutNullStreams {
  return spawn(launch.command, launch.args, {
    cwd: launch.cwd,
    env: launch.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

/**
 * Thin owner of one `agy --input-format stream-json --output-format stream-json`
 * child process. Splits stdout into newline-delimited JSON frames, keeps a
 * bounded stderr tail for diagnostics, and owns signal escalation.
 *
 * This class knows nothing about the agy event vocabulary; the session maps
 * parsed frames onto agent stream events.
 */
export class AntigravityProcess {
  static spawn(options: SpawnAntigravityProcessOptions): AntigravityProcess {
    const child = (options.spawnFn ?? defaultSpawn)(options.launch);
    return new AntigravityProcess(child, options);
  }

  private readonly logger: Logger;
  private readonly stderrTailChars: number;
  private readonly lineSubscribers = new Set<(value: unknown, raw: string) => void>();
  private readonly malformedLineSubscribers = new Set<(raw: string) => void>();
  private readonly exitSubscribers = new Set<(exit: AntigravityProcessExit) => void>();
  private stdoutRemainder = "";
  private readonly stderrChunks: string[] = [];
  private stderrChars = 0;
  private stdinClosed = false;
  private exitResult: AntigravityProcessExit | null = null;
  private readonly exitWaiters = new Set<{
    resolve: (exit: AntigravityProcessExit) => void;
  }>();

  private constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    options: SpawnAntigravityProcessOptions,
  ) {
    this.logger = options.logger;
    this.stderrTailChars = options.stderrTailChars ?? DEFAULT_STDERR_TAIL_CHARS;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      this.handleStdout(chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      this.handleStderr(chunk);
    });
    child.on("error", (error: Error) => {
      this.logger.debug({ err: error }, "Antigravity child process error");
    });
    child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
      this.settleExit({ code, signal });
    });
  }

  get exited(): boolean {
    return this.exitResult !== null;
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  onLine(callback: (value: unknown, raw: string) => void): () => void {
    this.lineSubscribers.add(callback);
    return () => {
      this.lineSubscribers.delete(callback);
    };
  }

  onMalformedLine(callback: (raw: string) => void): () => void {
    this.malformedLineSubscribers.add(callback);
    return () => {
      this.malformedLineSubscribers.delete(callback);
    };
  }

  onExit(callback: (exit: AntigravityProcessExit) => void): () => void {
    if (this.exitResult) {
      callback(this.exitResult);
      return () => undefined;
    }
    this.exitSubscribers.add(callback);
    return () => {
      this.exitSubscribers.delete(callback);
    };
  }

  getStderrTail(): string {
    return this.stderrChunks.join("");
  }

  async writeLine(value: unknown): Promise<void> {
    if (this.exitResult) {
      throw new Error("Antigravity process already exited");
    }
    if (this.stdinClosed) {
      throw new Error("Antigravity process stdin is closed");
    }
    const line = `${JSON.stringify(value)}\n`;
    await new Promise<void>((resolve, reject) => {
      this.child.stdin.write(line, (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  closeStdin(): void {
    if (this.stdinClosed || this.exitResult) {
      return;
    }
    this.stdinClosed = true;
    this.child.stdin.end();
  }

  interrupt(): void {
    if (this.exitResult) {
      return;
    }
    this.child.kill("SIGINT");
  }

  kill(): void {
    if (this.exitResult) {
      return;
    }
    this.child.kill("SIGKILL");
  }

  waitForExit(): Promise<AntigravityProcessExit> {
    if (this.exitResult) {
      return Promise.resolve(this.exitResult);
    }
    return new Promise<AntigravityProcessExit>((resolve) => {
      this.exitWaiters.add({ resolve });
    });
  }

  private handleStdout(chunk: string): void {
    this.stdoutRemainder += chunk;
    let newlineIndex = this.stdoutRemainder.indexOf("\n");
    while (newlineIndex !== -1) {
      const raw = this.stdoutRemainder.slice(0, newlineIndex);
      this.stdoutRemainder = this.stdoutRemainder.slice(newlineIndex + 1);
      this.handleLine(raw);
      newlineIndex = this.stdoutRemainder.indexOf("\n");
    }
  }

  private handleLine(raw: string): void {
    if (raw.trim().length === 0) {
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(raw) as unknown;
    } catch {
      for (const subscriber of this.malformedLineSubscribers) {
        subscriber(raw);
      }
      this.logger.debug({ line: raw.slice(0, 500) }, "Antigravity stdout line is not JSON");
      return;
    }
    for (const subscriber of this.lineSubscribers) {
      subscriber(value, raw);
    }
  }

  private handleStderr(chunk: string): void {
    this.stderrChunks.push(chunk);
    this.stderrChars += chunk.length;
    while (this.stderrChars > this.stderrTailChars && this.stderrChunks.length > 0) {
      const removed = this.stderrChunks.shift() ?? "";
      this.stderrChars -= removed.length;
    }
  }

  private settleExit(exit: AntigravityProcessExit): void {
    if (this.exitResult) {
      return;
    }
    this.exitResult = exit;
    // A trailing partial line without a newline can still carry a result event
    // when agy dies mid-write; attempt one last parse.
    if (this.stdoutRemainder.trim().length > 0) {
      this.handleLine(this.stdoutRemainder);
      this.stdoutRemainder = "";
    }
    for (const waiter of this.exitWaiters) {
      waiter.resolve(exit);
    }
    this.exitWaiters.clear();
    for (const subscriber of this.exitSubscribers) {
      try {
        subscriber(exit);
      } catch (error) {
        this.logger.debug({ err: error }, "Antigravity exit handler failed");
      }
    }
    this.exitSubscribers.clear();
  }
}
