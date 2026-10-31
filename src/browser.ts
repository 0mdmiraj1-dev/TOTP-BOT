import { hostname, type RecordItem } from "./model.js";
const root = document.querySelector("#app")!;
const launch = new URLSearchParams(location.hash.slice(1));
let initData = launch.get("tgWebAppData") ?? "";
// Telegram launch data is validated server-side; never use initDataUnsafe.
if (initData) history.replaceState(null, "", location.pathname);
let session = "",
  records: any[] = [],
  revision = 0,
  tab = "password",
  query = "",
  favorites = false,
  page = 0,
  status: any = {},
  mode = "login",
  busy = false;
const codes = new Map<
  string,
  { code: string; expiresAt: number; serverTime: number; received: number }
>();
const escape = (s: unknown) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
const el = (s: string) => document.querySelector(s) as HTMLElement;
function button(text: string, fn: () => void, cls = "") {
  const b = document.createElement("button");
  b.textContent = text;
  b.className = cls;
  b.onclick = fn;
  return b;
}
function message(text: string, error = false) {
  const old = document.querySelector("#message");
  old?.remove();
  const d = document.createElement("div");
  d.id = "message";
  d.className = "notice" + (error ? " error" : "");
  d.setAttribute("role", "status");
  d.textContent = text;
  (
    document.querySelector(".modal") ??
    document.querySelector(".shell") ??
    root
  ).prepend(d);
}
async function api(action: string, body: any = {}) {
  const res = await fetch("/api", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer " + session,
      "x-telegram-init-data": initData,
    },
    body: JSON.stringify({ action, ...body }),
  });
  const data = await res.json();
  if (!res.ok) {
    if (res.status === 401 && session) {
      session = "";
      mode = "login";
      records = [];
      codes.clear();
      document.querySelector(".backdrop")?.remove();
      render();
    }
    throw Error(data.error ?? "Request failed");
  }
  return data;
}
function download(value: unknown, name: string) {
  const blob = new Blob(
      [typeof value === "string" ? value : JSON.stringify(value, null, 2)],
      { type: "application/json" },
    ),
    url = URL.createObjectURL(blob),
    a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function modal(
  title: string,
  body: string,
  onSubmit?: (f: FormData) => Promise<void>,
) {
  document.querySelector(".backdrop")?.remove();
  const d = document.createElement("div");
  d.className = "backdrop";
  d.innerHTML = `<form class="modal" role="dialog" aria-modal="true" aria-label="${escape(title)}"><h2>${escape(title)}</h2>${body}<div class="actions"><button type="button" id="cancel">Cancel</button>${onSubmit ? '<button class="primary" type="submit">Continue</button>' : ""}</div></form>`;
  root.append(d);
  const close = () => d.remove();
  d.querySelector("#cancel")!.addEventListener("click", close);
  d.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
    if (e.key === "Tab") {
      const focus = [
        ...d.querySelectorAll<HTMLElement>("input,select,textarea,button,a"),
      ].filter((x) => !x.hasAttribute("disabled"));
      if (e.shiftKey && document.activeElement === focus[0]) {
        e.preventDefault();
        focus.at(-1)?.focus();
      } else if (!e.shiftKey && document.activeElement === focus.at(-1)) {
        e.preventDefault();
        focus[0]?.focus();
      }
    }
  });
  d.querySelector("form")!.onsubmit = async (e) => {
    e.preventDefault();
    const submit = d.querySelector<HTMLButtonElement>("button[type=submit]")!;
    submit.disabled = true;
    try {
      await onSubmit?.(new FormData(e.target as HTMLFormElement));
    } catch (e) {
      message((e as Error).message, true);
    } finally {
      submit.disabled = false;
    }
  };
  (d.querySelector("input,button") as HTMLElement)?.focus();
  return { close, element: d };
}
const field = (
  label: string,
  name: string,
  value = "",
  type = "text",
  required = false,
) =>
  `<label for="${name}">${label}</label><input id="${name}" name="${name}" type="${type}" value="${escape(value)}" ${required ? "required" : ""} autocomplete="off">`;
function shell(content: string) {
  root.innerHTML = `<main class="shell"><header><div class="brand"><span class="logo">▣</span> still <span class="tag">Personal vault</span></div><div id="header-actions" class="row"></div></header>${content}<footer>YOUR PRIVATE SPACE · Encrypted snapshots. Keep a backup outside Telegram.</footer></main>`;
}
function auth() {
  shell(
    `<section class="auth"><div class="eyebrow">A little peace of mind</div><h1>${mode === "setup" ? "Create your private vault" : mode === "rebind" ? "Reconnect your vault" : mode === "recover-password" ? "Recover access" : "Welcome back."}</h1><p class="muted">${mode === "login" ? "Your passwords and one-time codes, together. Unlock to continue." : "Use this HTTPS form. Never send your master password or recovery key in chat."}</p>${status.writesEnabled === false ? '<div class="notice">Experimental channel mode. Authentication and writes are disabled until a durable coordinator is configured.</div>' : ""}<form id="auth-form">${mode === "setup" ? field("One-time setup token", "token", "", "password", true) : ""}${field("Vault username", "username", "", "text", true)}${mode !== "recover-password" ? field(mode === "setup" ? "Master password · at least 14 characters" : "Master password", "password", "", "password", true) : ""}${mode === "rebind" || mode === "recover-password" ? field("Recovery key", "recovery", "", "password", true) : ""}${mode === "recover-password" ? field("New master password · at least 14 characters", "newPassword", "", "password", true) : ""}${mode === "rebind" || mode === "recover-password" ? '<label class="check"><input name="confirm" type="checkbox" required> Revoke the old Telegram binding, sessions, and pending privileged actions.</label>' : ""}<button class="primary" type="submit">${mode === "login" ? "Unlock vault" : mode === "setup" ? "Create vault" : mode === "rebind" ? "Rebind Telegram account" : "Recover master password"}</button></form><div class="auth-links" id="auth-links"></div><p class="small muted">Have an encrypted backup? <a href="/recovery.html">Open standalone offline recovery</a></p>${status.localIdentity ? '<p class="notice">Local development · synthetic Telegram identity 10001. Use synthetic credentials only.</p>' : ""}</section>`,
  );
  for (const [id, label] of [
    ["login", "Sign in"],
    ["setup", "Initial setup"],
    ["rebind", "Rebind"],
    ["recover-password", "Forgot password"],
  ])
    if (id !== mode)
      el("#auth-links").append(
        button(
          label,
          () => {
            mode = id;
            auth();
          },
          "plain",
        ),
      );
  el("#auth-form").onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target as HTMLFormElement),
      body = Object.fromEntries(f);
    const b = (e.target as HTMLFormElement).querySelector("button")!;
    b.disabled = true;
    try {
      const result = await api(mode, { ...body, confirm: f.has("confirm") });
      session = result.token;
      (e.target as HTMLFormElement).reset();
      if (result.recovery) showRecovery(result.recovery);
      else if (result.acknowledgementRequired) showRecovery();
      else await reload();
    } catch (e) {
      message((e as Error).message, true);
    } finally {
      b.disabled = false;
    }
  };
}
function showRecovery(key?: string) {
  shell(
    '<section class="auth"><h1>Store your recovery key.</h1><p class="muted">This key unlocks downloaded backups without Telegram or this deployment. Store it separately from your backups.</p><div id="recovery-controls"></div></section>',
  );
  const controls = el("#recovery-controls");
  if (key) {
    const box = document.createElement("div");
    box.className = "recovery-key";
    box.textContent = key;
    controls.append(
      box,
      button(
        "Copy key",
        () =>
          void navigator.clipboard
            .writeText(key)
            .catch(() => message("Select and copy the displayed key.")),
      ),
      button("Download key", () => download(key, "vault-recovery-key.txt")),
    );
  } else
    message(
      "Setup awaits acknowledgement. If you lost the key, use the already downloaded key; setup cannot be reopened.",
    );
  const label = document.createElement("label");
  label.className = "check";
  label.innerHTML =
    '<input id="ack" type="checkbox"> I have saved the recovery key safely outside Telegram.';
  controls.append(
    label,
    button(
      "Finish setup",
      async () => {
        if (!(el("#ack") as HTMLInputElement).checked)
          return message("Save and acknowledge the recovery key first.", true);
        try {
          await api("ack", { confirm: true });
          await reload();
        } catch (e) {
          message((e as Error).message, true);
        }
      },
      "primary",
    ),
  );
}
async function reload() {
  const d = await api("list");
  records = d.records;
  revision = d.revision;
  status = { ...status, ...d };
  render();
}
async function mutate(action: string, body: any) {
  const d = await api(action, {
    ...body,
    requestId: crypto.randomUUID(),
    revision,
  });
  await reload();
  if (d.channel !== "published" || d.backup !== "delivered")
    message(
      `Vault saved. Channel publication: ${d.channel ?? "pending"}. Private backup: ${d.backup ?? "pending"}. Use Retry backup.`,
      true,
    );
  else message("Vault saved · channel published · encrypted backup delivered.");
}
function render() {
  if (!session) return auth();
  shell(
    `<section class="hero"><div class="eyebrow">Everything in its place</div><div class="row between wrap"><h1>Your digital essentials.</h1><button id="add" class="primary">＋ Add new</button></div><p class="muted">One quiet home for your passwords and 2FA.</p></section><div class="tabs"><button id="tab-password" class="${tab === "password" ? "active" : ""}">Passwords <span class="small">${records.filter((r) => r.type === "password").length}</span></button><button id="tab-totp" class="${tab === "totp" ? "active" : ""}">2FA codes <span class="small">${records.filter((r) => r.type === "totp").length}</span></button></div><div class="toolbar"><input class="search" id="search" aria-label="Search vault" placeholder="Search your vault…" value="${escape(query)}"><button id="favorites" class="${favorites ? "favorite" : ""}">☆ Favorites</button><button id="import">Import</button><button id="backup">Backup & restore</button></div><div id="cards" class="grid"></div><div id="pagination" class="pagination"></div>${status.simulatedTelegram ? '<div class="notice">Local Telegram simulation enabled. No channel files or private backups are sent.</div>' : ""}<div class="status"><span>● Vault saved · revision ${revision}</span><span>Channel: ${escape(status.channel)}</span><span>Private backup: ${escape(status.backup)}</span></div><div class="row"><button id="retry" class="plain">↻ Retry backup</button><a class="small" href="/recovery.html">Offline recovery</a></div>`,
  );
  el("#header-actions").append(
    button("Lock vault", async () => {
      try {
        await api("logout");
        session = "";
        mode = "login";
        records = [];
        codes.clear();
        document.querySelector(".backdrop")?.remove();
        render();
      } catch (e) {
        message((e as Error).message, true);
      }
    }),
  );
  el("#add").onclick = () => edit();
  el("#import").onclick = () => importer();
  el("#backup").onclick = () => backup();
  el("#retry").onclick = async () => {
    try {
      const d = await api("retry");
      status = { ...status, ...d };
      render();
      message(`Channel ${d.channel} · private backup ${d.backup}`);
    } catch (e) {
      message((e as Error).message, true);
    }
  };
  for (const t of ["password", "totp"])
    el("#tab-" + t).onclick = () => {
      tab = t;
      page = 0;
      render();
    };
  el("#favorites").onclick = () => {
    favorites = !favorites;
    page = 0;
    render();
  };
  el("#search").oninput = (e) => {
    query = (e.target as HTMLInputElement).value;
    page = 0;
    cards();
  };
  cards();
}
function cards() {
  const filtered = records.filter(
    (r) =>
      r.type === tab &&
      (!favorites || r.favorite) &&
      JSON.stringify([r.name, r.url, r.username, r.notes, r.issuer, r.account])
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  const groups = new Map<string, any[]>();
  for (const r of filtered) {
    const k =
      r.type === "password" ? hostname(r.url) : r.issuer || "Authenticator";
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  const all = [...groups].sort(([a], [b]) => a.localeCompare(b)),
    pages = Math.max(1, Math.ceil(all.length / 8));
  page = Math.min(page, pages - 1);
  const target = el("#cards");
  target.replaceChildren();
  if (!all.length) {
    target.innerHTML =
      '<div class="empty">No records here yet.<br><span class="small">Add a record or import an export to get started.</span></div>';
  }
  for (const [name, items] of all.slice(page * 8, page * 8 + 8)) {
    const card = document.createElement("article");
    card.className = "card";
    card.innerHTML = `<div class="card-head"><div class="initial">${escape(name.slice(0, 2).toUpperCase())}</div><div class="title"><strong>${escape(name)}</strong><span>${items.length} account${items.length === 1 ? "" : "s"}</span></div><span class="muted">↗</span></div>`;
    for (const r of items) {
      const detail = document.createElement("details");
      detail.open = tab === "totp";
      detail.innerHTML = `<summary>${r.favorite ? "★ " : ""}${escape(r.type === "password" ? r.username || r.name : r.account || "Account")}</summary><div class="account"><div class="muted small">${escape(r.type === "password" ? r.name : r.algorithm + " · " + r.digits + " digits · " + r.period + "s")}</div><div class="secret ${r.type === "totp" ? "otp" : ""}" id="secret-${r.id}">${r.type === "password" ? "••••••••" : "— — — — — —"}</div><div id="timer-${r.id}" class="muted small"></div><div class="row wrap" id="actions-${r.id}"></div></div>`;
      card.append(detail);
      const actions = detail.querySelector("#actions-" + r.id)!;
      actions.append(
        button(
          r.type === "password"
            ? "Reveal"
            : codes.has(r.id)
              ? "Refresh"
              : "Show code",
          async () => {
            try {
              if (r.type === "password") {
                const d = await api("reveal", { id: r.id });
                el("#secret-" + r.id).textContent = d.password;
                setTimeout(() => {
                  const e = document.getElementById("secret-" + r.id);
                  if (e) e.textContent = "••••••••";
                }, 15000);
              } else {
                await refreshCode(r.id);
                cards();
              }
            } catch (e) {
              message((e as Error).message, true);
            }
          },
        ),
        button("Copy", async () => {
          try {
            const d = await api(r.type === "password" ? "reveal" : "totp", {
              id: r.id,
            });
            await navigator.clipboard.writeText(d.password ?? d.code);
            message("Copied. Clipboard contents may remain after logout.");
          } catch (e) {
            message((e as Error).message, true);
          }
        }),
        button("Edit", () => edit(r), "plain"),
        button(
          r.favorite ? "★" : "☆",
          async () => {
            try {
              await mutate("save", { record: { ...r, favorite: !r.favorite } });
            } catch (e) {
              message((e as Error).message, true);
            }
          },
          "plain",
        ),
        button(
          "Delete",
          () => {
            const m = modal(
              "Delete record?",
              `<p>This removes ${escape(r.type === "password" ? r.name : r.issuer)} from the current vault. Encrypted snapshot history is retained.</p>`,
              async () => {
                await mutate("delete", { id: r.id, confirm: true });
                m.close();
              },
            );
          },
          "plain",
        ),
      );
      if (r.type === "totp" && codes.has(r.id)) displayCode(r.id);
    }
    target.append(card);
  }
  const pager = el("#pagination");
  pager.replaceChildren();
  if (pages > 1) {
    const prev = button("←", () => {
      page--;
      cards();
    });
    prev.disabled = page === 0;
    const next = button("→", () => {
      page++;
      cards();
    });
    next.disabled = page + 1 >= pages;
    pager.append(prev, document.createTextNode(`${page + 1} / ${pages}`), next);
  }
}
async function refreshCode(id: string) {
  const d = await api("totp", { id });
  codes.set(id, { ...d, received: Date.now() });
  displayCode(id);
}
function displayCode(id: string) {
  const d = codes.get(id),
    node = document.getElementById("secret-" + id),
    timer = document.getElementById("timer-" + id);
  if (!d || !node || !timer) return;
  const now = d.serverTime + Date.now() - d.received,
    remaining = Math.max(0, Math.ceil((d.expiresAt - now) / 1000));
  node.textContent = remaining ? d.code : "Expired";
  timer.textContent = remaining
    ? `Expires in ${remaining}s · ${new Date(d.expiresAt).toLocaleTimeString()}`
    : "Refresh to get a current code";
}
setInterval(() => {
  for (const id of codes.keys()) displayCode(id);
}, 250);
function edit(r?: any) {
  const type = r?.type ?? tab;
  const body = `<p class="muted small">${r ? "Leave secret fields blank to keep their current value." : "Add your account details."}</p>${!r ? '<label>Record type</label><select id="record-type"><option value="password">Password</option><option value="totp">2FA code</option></select>' : ""}<div id="record-fields"></div>`;
  const m = modal(r ? "Edit record" : "Add record", body, async (f) => {
    const t =
      (m.element.querySelector("#record-type") as HTMLSelectElement)?.value ??
      type;
    let record: any = { ...r, type: t, favorite: f.has("favorite") };
    if (t === "password") {
      record = {
        ...record,
        name: f.get("name"),
        url: f.get("url"),
        username: f.get("username"),
        notes: f.get("notes"),
      };
      const password = f.get("password");
      if (password || !r) record.password = password;
    } else {
      const uri = f.get("uri");
      if (uri) record = { type: "totp", uri, ...(r ? { id: r.id } : {}) };
      else {
        record = {
          ...record,
          issuer: f.get("issuer"),
          account: f.get("account"),
          algorithm: f.get("algorithm"),
          digits: Number(f.get("digits")),
          period: Number(f.get("period")),
          passwordId: f.get("passwordId") || null,
        };
        const secret = f.get("secret");
        if (secret || !r) record.secret = secret;
      }
    }
    await mutate("save", { record });
    m.close();
  });
  function fields(t: string) {
    const container = m.element.querySelector("#record-fields")!;
    container.innerHTML =
      t === "password"
        ? field("Service name", "name", r?.name ?? "", "text", true) +
          field("Website URL", "url", r?.url ?? "", "url") +
          field("Username / email", "username", r?.username ?? "") +
          field("Password", "password", "", "password", !r) +
          `<label>Notes</label><textarea name="notes">${escape(r?.notes ?? "")}</textarea>`
        : field("Issuer", "issuer", r?.issuer ?? "") +
          field("Account label", "account", r?.account ?? "") +
          field("Base32 secret", "secret", "", "password") +
          field("Or paste an otpauth://totp URI", "uri", "", "password") +
          `<label>Algorithm</label><select name="algorithm">${["SHA1", "SHA256", "SHA512"].map((a) => `<option ${a === (r?.algorithm ?? "SHA1") ? "selected" : ""}>${a}</option>`).join("")}</select><label>Digits</label><select name="digits"><option ${r?.digits !== 8 ? "selected" : ""}>6</option><option ${r?.digits === 8 ? "selected" : ""}>8</option></select>` +
          field(
            "Period (seconds, 15–120)",
            "period",
            String(r?.period ?? 30),
            "number",
            true,
          ) +
          `<label>Explicitly link a password (optional)</label><select name="passwordId"><option value="">No link</option>${records
            .filter((p) => p.type === "password")
            .map(
              (p) =>
                `<option value="${p.id}" ${p.id === r?.passwordId ? "selected" : ""}>${escape(p.name + " · " + p.username)}</option>`,
            )
            .join("")}</select>`;
    container.innerHTML += `<label class="check"><input type="checkbox" name="favorite" ${r?.favorite ? "checked" : ""}>Favorite</label>`;
  }
  fields(type);
  const select = m.element.querySelector("#record-type") as HTMLSelectElement;
  if (select) {
    select.value = type;
    select.onchange = () => fields(select.value);
  }
}
function importer() {
  let source = "",
    previewRevision = revision;
  const m = modal(
    "Import credentials",
    `<p class="muted small">Google Passwords CSV, OneCloud v1 JSON, or TOTP URI. Up to 1 MiB. Uploaded records are not logged. Names never create password/2FA links.</p><label>Choose export</label><input type="file" id="import-file" accept=".csv,.json,.txt"><label>Duplicate policy</label><select id="policy" name="policy"><option value="skip">Skip</option><option value="update">Update</option><option value="both">Keep Both</option></select><div id="preview"></div><button type="button" id="inspect">Validate & preview</button>`,
    async (f) => {
      if (
        !source ||
        !(m.element.querySelector("#confirmed") as HTMLInputElement)?.checked
      )
        throw Error("Validate and confirm the preview first");
      if (revision !== previewRevision)
        throw Error("Vault changed; preview again");
      await mutate("import-commit", {
        source,
        policy: f.get("policy"),
        confirm: true,
      });
      source = "";
      m.close();
    },
  );
  const preview = m.element.querySelector("#preview")!;
  const invalidate = () => {
    source = "";
    preview.innerHTML = "";
  };
  m.element
    .querySelector("#import-file")!
    .addEventListener("change", invalidate);
  m.element.querySelector("#policy")!.addEventListener("change", invalidate);
  m.element.querySelector("#inspect")!.addEventListener("click", async () => {
    try {
      const file = (m.element.querySelector("#import-file") as HTMLInputElement)
        .files?.[0];
      if (!file || file.size > 1048576)
        throw Error("Select an export up to 1 MiB");
      source = await file.text();
      const d = await api("import-preview", {
        source,
        policy: (m.element.querySelector("#policy") as HTMLSelectElement).value,
      });
      previewRevision = revision;
      preview.innerHTML = `<div class="preview">Format: ${escape(d.format)}<p>${d.valid} valid · ${d.invalid} invalid<br>${d.duplicates} duplicates · ${d.new} new · ${d.updated} updated</p>${d.errors
        .slice(0, 10)
        .map(
          (e: any) => `<p class="small">Row ${e.row}: ${escape(e.reason)}</p>`,
        )
        .join(
          "",
        )}<label class="check"><input id="confirmed" type="checkbox">Commit the valid records in one revision</label></div>`;
    } catch (e) {
      source = "";
      message((e as Error).message, true);
    }
  });
}
function backup() {
  let source: any,
    previewRevision = revision;
  const m = modal(
    "Backup & restore",
    `<p class="muted small">Download a self-contained encrypted copy. Keep it outside Telegram. Restore preserves this vault’s identity and Telegram binding.</p><button type="button" id="download">Download encrypted backup</button><hr><label>Restore encrypted backup</label><input id="restore-file" type="file" accept=".json">${field("Backup recovery key", "recovery", "", "password")}<label>Restore mode</label><select name="mode" id="restore-mode"><option value="merge">Merge · keep both duplicates</option><option value="replace">Replace all records</option></select><button id="restore-inspect" type="button">Authenticate & preview</button><div id="restore-preview"></div>`,
    async (f) => {
      if (
        !source ||
        !(m.element.querySelector("#restore-confirm") as HTMLInputElement)
          ?.checked
      )
        throw Error("Authenticate and confirm restore first");
      if (revision !== previewRevision)
        throw Error("Vault changed; preview again");
      await mutate("restore-commit", {
        backup: source,
        recovery: f.get("recovery"),
        mode: f.get("mode"),
        confirm: true,
      });
      source = undefined;
      m.close();
    },
  );
  m.element.querySelector("#download")!.addEventListener("click", async () => {
    try {
      const d = await api("backup");
      download(d.backup, "vault.encrypted.json");
    } catch (e) {
      message((e as Error).message, true);
    }
  });
  const invalidate = () => {
    source = undefined;
    m.element.querySelector("#restore-preview")!.innerHTML = "";
  };
  for (const id of ["restore-file", "recovery", "restore-mode"])
    m.element.querySelector("#" + id)!.addEventListener("change", invalidate);
  m.element
    .querySelector("#restore-inspect")!
    .addEventListener("click", async () => {
      try {
        const file = (
          m.element.querySelector("#restore-file") as HTMLInputElement
        ).files?.[0];
        if (!file || file.size > 3000000)
          throw Error("Choose an encrypted backup up to 3 MB");
        source = JSON.parse(await file.text());
        const d = await api("restore-preview", {
          backup: source,
          recovery: (m.element.querySelector("#recovery") as HTMLInputElement)
            .value,
        });
        previewRevision = revision;
        m.element.querySelector("#restore-preview")!.innerHTML =
          `<div class="preview">${d.passwords} passwords · ${d.totp} 2FA records<label class="check"><input id="restore-confirm" type="checkbox">I confirm the selected Merge / Replace operation. Previous encrypted channel snapshots remain in history.</label></div>`;
      } catch (e) {
        source = undefined;
        message((e as Error).message, true);
      }
    });
}
fetch("/api")
  .then((r) => r.json())
  .then((d) => {
    status = d;
    auth();
  })
  .catch(() => {
    status = { writesEnabled: false };
    auth();
  });
