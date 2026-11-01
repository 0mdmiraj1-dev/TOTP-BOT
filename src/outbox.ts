import { digest } from "./crypto.js";
import { requireThat } from "./model.js";
import {
  pruneSecurity,
  type Coordinator,
  type Job,
  type State,
} from "./store.js";
import type { Transport } from "./telegram.js";
export const LEASE_MS = 45000;
type Stage = "upload" | "publish" | "deliver";
type Claim = {
  id: string;
  token: string;
  stage: Stage;
  generation: number;
  actor: string;
  job: Job;
};

export function enqueue(s: State, backup: Job["backup"]) {
  // Only pending ciphertext + the most recent receipt remain in the coordinator.
  // Telegram files/manifests are never deleted. History below is references only.
  compact(s);
  requireThat(
    s.jobs.filter((j) => !j.delivered).length < 5,
    409,
    "Resolve pending backups before another change",
  );
  s.jobs.push({
    id: crypto.randomUUID(),
    backup,
    published: false,
    delivered: false,
  });
}
function compact(s: State) {
  const newest = s.jobs.at(-1);
  s.jobs = s.jobs.filter((j) => !j.published || !j.delivered || j === newest);
}
export class Outbox {
  constructor(
    private db: Coordinator,
    private transport: Transport,
    private clock = () => Date.now(),
  ) {}
  private claim(s: State): Claim | undefined {
    pruneSecurity(s, this.clock());
    compact(s);
    // Prioritize channel publication; a failed older private delivery cannot stall
    // a newly saved revision's channel upload/publication.
    const job =
      s.jobs.find((j) => !j.published) ?? s.jobs.find((j) => !j.delivered);
    if (!job || !s.account?.ack) return;
    if (job.lease && job.lease.until > this.clock()) return;
    const stage: Stage = !job.uploaded
      ? "upload"
      : !job.published
        ? "publish"
        : "deliver";
    job.id ??= crypto.randomUUID();
    const token = crypto.randomUUID(),
      actor = s.account.binding,
      generation = s.account.generation;
    job.lease = {
      token,
      stage,
      actor,
      generation,
      until: this.clock() + LEASE_MS,
    };
    return {
      id: job.id,
      token,
      stage,
      actor,
      generation,
      job: structuredClone(job),
    };
  }
  async drain(authorize: (s: State) => void = () => {}, maxStages = 3) {
    // Each stage: short SQL claim transaction -> awaited immutable remote effect
    // -> short fenced receipt transaction. No network I/O inside a SQL callback.
    const deadline = Date.now() + 30000;
    for (let i = 0; i < maxStages && Date.now() < deadline; i++) {
      const claim = await this.db.run((s) => {
        authorize(s);
        return this.claim(s);
      });
      if (!claim) break;
      let result: { fileId: string; messageId: number } | number | undefined,
        failed = false;
      try {
        if (claim.stage === "upload")
          result = await this.transport.upload(claim.job.backup);
        else if (claim.stage === "publish")
          result = await this.transport.publish(
            claim.job.backup,
            claim.job.uploaded!,
          );
        else await this.transport.deliver(claim.job.backup, claim.actor);
      } catch {
        failed = true;
      }
      const accepted = await this.db.run((s) => {
        const j = s.jobs.find((j) => j.id === claim.id);
        if (
          !j ||
          j.lease?.token !== claim.token ||
          s.account?.generation !== claim.generation ||
          s.account.binding !== claim.actor
        )
          return false;
        // An expired owner cannot advance the authoritative current reference.
        if (j.lease.until <= this.clock()) return false;
        delete j.lease;
        if (claim.stage === "upload") {
          j.uploadError = failed;
          if (!failed)
            j.uploaded = result as { fileId: string; messageId: number };
        } else if (claim.stage === "publish") {
          j.publicationError = failed;
          if (!failed) {
            requireThat(
              !s.published || s.published.revision < j.backup.revision,
              409,
              "Stale publication receipt",
            );
            j.published = true;
            j.manifestMessage = result as number;
            const hash = digest(JSON.stringify(j.backup));
            s.published = {
              revision: j.backup.revision,
              vaultId: j.backup.vaultId,
              fileId: j.uploaded!.fileId,
              manifestMessage: j.manifestMessage,
              sha256: hash,
            };
            (s.history ??= []).push({
              revision: j.backup.revision,
              fileId: j.uploaded!.fileId,
              manifestMessage: j.manifestMessage,
              sha256: hash,
              created: j.backup.created,
            });
          }
        } else {
          j.deliveryError = failed;
          if (!failed) j.delivered = true;
        }
        compact(s);
        return true;
      });
      // Pins are only discovery hints. Never edit an existing manifest: a timed-out
      // worker may still finish a Telegram request after its database lease expires.
      // Its immutable orphan cannot replace the durable authoritative pointer.
      if (
        accepted &&
        !failed &&
        claim.stage === "publish" &&
        this.transport.pin
      ) {
        let pinError = false;
        try {
          await this.transport.pin(result as number);
        } catch {
          pinError = true;
        }
        await this.db.run((s) => {
          const j = s.jobs.find((j) => j.id === claim.id);
          if (j) j.pinError = pinError;
        });
      }
      if (!accepted || failed) break;
    }
  }
}
