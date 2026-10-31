import { readFile, open as fsOpen } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { parseBackup, unwrap, decrypt } from "./crypto.js";
// Offline, dependency-local recovery. Credential input never goes in argv or URLs.
const [input, output] = process.argv.slice(2);
if (!input || !output) {
  console.error(
    "Usage: npm run recover -- encrypted-backup.json recovered.json (key is read from stdin)",
  );
  process.exit(1);
}
const terminal = process.stdin.isTTY;
let recovery = "";
if (terminal) {
  process.stderr.write("Recovery key (hidden): ");
  process.stdin.setRawMode(true);
  process.stdin.resume();
  recovery = await new Promise<string>((resolve, reject) => {
    let value = "";
    const receive = (chunk: Buffer) => {
      for (const char of chunk.toString()) {
        if (char === "\u0003") {
          process.stdin.off("data", receive);
          reject(Error("Cancelled"));
          return;
        }
        if (char === "\r" || char === "\n") {
          process.stdin.off("data", receive);
          resolve(value);
          return;
        }
        if (char === "\u007f") value = value.slice(0, -1);
        else value += char;
      }
    };
    process.stdin.on("data", receive);
  }).finally(() => {
    process.stdin.setRawMode(false);
    process.stdin.pause();
    process.stderr.write("\n");
  });
} else {
  const rl = createInterface({ input: process.stdin });
  for await (const line of rl) {
    recovery = line.trim();
    break;
  }
  rl.close();
}
try {
  const source = await readFile(input);
  if (source.length > 3000000) throw Error("Backup too large");
  const b = parseBackup(JSON.parse(source.toString())),
    key = unwrap(b, recovery, "recovery");
  recovery = "";
  try {
    const data = decrypt(b, key);
    const file = await fsOpen(output, "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify(data, null, 2));
      await file.sync();
    } finally {
      await file.close();
    }
    console.error(
      `Recovered ${data.records.length} records. Output contains plaintext credentials; protect it and remove it when finished.`,
    );
  } finally {
    key.fill(0);
  }
} catch {
  console.error(
    "Recovery failed: invalid key/backup/schema, unreadable input, or output already exists.",
  );
  process.exitCode = 1;
}
