import { backupSchema, payloadAad } from "./crypto-schema.js";
import { dataSchema } from "./model.js";
const form = document.querySelector("form")!,
  output = document.querySelector("#result")!;
function bytes(s: string) {
  return Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) =>
    c.charCodeAt(0),
  );
}
async function open(
  key: CryptoKey,
  box: { iv: string; tag: string; ct: string },
  aad: string,
) {
  const ct = bytes(box.ct),
    tag = bytes(box.tag);
  const encrypted = new Uint8Array(ct.length + tag.length);
  encrypted.set(ct);
  encrypted.set(tag, ct.length);
  const raw = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: bytes(box.iv),
      additionalData: new TextEncoder().encode(aad),
      tagLength: 128,
    },
    key,
    encrypted,
  );
  return JSON.parse(new TextDecoder().decode(raw));
}
form.onsubmit = async (e) => {
  e.preventDefault();
  output.textContent = "Authenticating backup locally…";
  try {
    const file = (document.querySelector("#backup") as HTMLInputElement)
        .files?.[0],
      recovery = (
        document.querySelector("#key") as HTMLInputElement
      ).value.trim();
    if (!file || file.size > 3000000 || !/^[a-f0-9]{64}$/i.test(recovery))
      throw Error();
    const b = backupSchema.parse(JSON.parse(await file.text())),
      keyBytes = Uint8Array.from(recovery.match(/../g)!, (v) =>
        parseInt(v, 16),
      );
    const wrapping = await crypto.subtle.importKey(
      "raw",
      keyBytes,
      "AES-GCM",
      false,
      ["decrypt"],
    );
    keyBytes.fill(0);
    const context = `personal-vault:${b.vaultId}:${b.schema}`,
      dek = bytes(await open(wrapping, b.recovery, context + ":recovery")),
      key = await crypto.subtle.importKey("raw", dek, "AES-GCM", false, [
        "decrypt",
      ]);
    dek.fill(0);
    const data = dataSchema.parse(await open(key, b.payload, payloadAad(b)));
    (document.querySelector("#key") as HTMLInputElement).value = "";
    output.textContent = `Authenticated: ${data.records.filter((r) => r.type === "password").length} passwords and ${data.records.filter((r) => r.type === "totp").length} 2FA records. Export contains plaintext credentials; protect it.`;
    const blob = new Blob([JSON.stringify(data, null, 2)], {
        type: "application/json",
      }),
      url = URL.createObjectURL(blob),
      a = document.createElement("a");
    a.textContent = "Download recovered plaintext JSON";
    a.href = url;
    a.download = "recovered-vault.json";
    output.append(document.createElement("br"), a);
    setTimeout(() => {
      URL.revokeObjectURL(url);
      a.remove();
    }, 60000);
  } catch {
    output.textContent =
      "Recovery failed. Check the backup format, integrity, schema, and recovery key.";
  }
};
