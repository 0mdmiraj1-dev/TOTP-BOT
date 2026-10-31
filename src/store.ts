import {
  open as fsOpen,
  readFile,
  rename,
  mkdir,
  unlink,
} from "node:fs/promises";
import { dirname } from "node:path";
import { seal, open, type Backup, type Box } from "./crypto.js";
import { Fault } from "./model.js";
export type Session = {
  generation: number;
  actor: string;
  expires: number;
  absolute: number;
  key: Box;
  setup?: boolean;
};
export type Job = {
  backup: Backup;
  uploaded?: { fileId: string; messageId: number };
  published: boolean;
  delivered: boolean;
  uploadError?: boolean;
  publicationError?: boolean;
  deliveryError?: boolean;
};
export type State = {
  account?: {
    username: string;
    binding: string;
    generation: number;
    ack: boolean;
    backup: Backup;
  };
  sessions: Record<string, Session>;
  attempts: { count: number; until: number };
  callbacks: Record<
    string,
    {
      actor: string;
      generation: number;
      session: string;
      action: string;
      expires: number;
    }
  >;
  idempotency: Record<string, { hash: string; revision: number }>;
  jobs: Job[];
  manifestMessage?: number;
  prepared?: Backup;
};
export const empty = (): State => ({
  sessions: {},
  attempts: { count: 0, until: 0 },
  callbacks: {},
  idempotency: {},
  jobs: [],
});
export interface Coordinator {
  run<T>(fn: (s: State) => Promise<T> | T): Promise<T>;
}
export class DisabledCoordinator implements Coordinator {
  async run<T>(_fn: (s: State) => Promise<T> | T): Promise<T> {
    throw new Fault(
      503,
      "Production authentication and writes disabled: durable coordinator unavailable",
    );
  }
}
// Test-only coordinator: never selected by the deployment runtime.
export class TestCoordinator implements Coordinator {
  state = empty();
  private queue = Promise.resolve();
  run<T>(fn: (s: State) => Promise<T> | T) {
    const next = this.queue.then(() => fn(this.state));
    this.queue = next.then(
      () => {},
      () => {},
    );
    return next;
  }
}
// Development on one persistent machine only. Exclusive process lease, atomic encrypted file,
// fsync file and directory. A crash leaves a lease requiring explicit operator removal.
export class LocalCoordinator implements Coordinator {
  private queue = Promise.resolve();
  private constructor(
    private path: string,
    private key: Buffer,
  ) {}
  static async create(path: string, key: Buffer) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const lease = await fsOpen(path + ".lockfile", "wx", 0o600);
    await lease.writeFile(String(process.pid));
    await lease.sync();
    await lease.close();
    return new LocalCoordinator(path, key);
  }
  async close() {
    await this.queue;
    await unlink(this.path + ".lockfile");
  }
  run<T>(fn: (s: State) => Promise<T> | T): Promise<T> {
    const task = this.queue.then(async () => {
      let state: State;
      try {
        state = open<State>(
          this.key,
          JSON.parse(await readFile(this.path, "utf8")),
          "local-coordinator-v1",
        );
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        state = empty();
      }
      let result: T | undefined, error: unknown;
      try {
        result = await fn(state);
      } catch (e) {
        error = e;
      }
      const tmp = this.path + ".new";
      const f = await fsOpen(tmp, "w", 0o600);
      try {
        await f.writeFile(
          JSON.stringify(seal(this.key, state, "local-coordinator-v1")),
        );
        await f.sync();
      } finally {
        await f.close();
      }
      await rename(tmp, this.path);
      const dir = await fsOpen(dirname(this.path), "r");
      try {
        await dir.sync();
      } finally {
        await dir.close();
      }
      if (error) throw error;
      return result as T;
    });
    this.queue = task.then(
      () => {},
      () => {},
    );
    return task;
  }
}
