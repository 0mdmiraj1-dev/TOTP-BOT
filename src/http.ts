import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { Fault, requireThat } from "./model.js";
import { validateInitData } from "./telegram.js";
import { verifyForward } from "./bot.js";
import type { Runtime } from "./runtime.js";
const MAX_BODY = 3500000;
async function read(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const part of req) {
    const b = Buffer.from(part);
    bytes += b.length;
    requireThat(bytes <= MAX_BODY, 413, "Request too large");
    chunks.push(b);
  }
  return Buffer.concat(chunks).toString("utf8");
}
export async function handler(
  req: IncomingMessage,
  res: ServerResponse,
  runtime: Runtime,
) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Content-Type", "application/json");
  try {
    if (req.method === "GET") {
      res.end(
        JSON.stringify({
          mode: runtime.local ? "local-development" : "experimental-channel",
          writesEnabled: runtime.local,
          simulatedTelegram: runtime.simulatedTelegram,
          blocker: runtime.local
            ? undefined
            : "Durable production coordinator not configured",
          localIdentity: runtime.local ? "10001" : undefined,
        }),
      );
      return;
    }
    requireThat(req.method === "POST", 405, "POST required");
    requireThat(
      String(req.headers["content-type"]).startsWith("application/json"),
      415,
      "JSON required",
    );
    const raw = await read(req);
    if (
      req.url?.split("?")[0] === "/api/bot" ||
      new URL(req.url ?? "/", "http://localhost").searchParams.get("route") ===
        "bot"
    ) {
      const p = verifyForward(
        raw,
        String(req.headers["x-vault-signature"] ?? ""),
        process.env.BB_FORWARD_SECRET ?? "",
      );
      await runtime.bot.handle(p);
      res.end('{"accepted":true}');
      return;
    }
    const origin = process.env.APP_ORIGIN ?? "http://127.0.0.1:3000";
    requireThat(req.headers.origin === origin, 403, "Invalid request origin");
    const body = JSON.parse(raw);
    requireThat(
      body && typeof body === "object" && !Array.isArray(body),
      400,
      "Invalid request",
    );
    const action = z.string().max(40).parse(body.action);
    let actor: string | undefined;
    const init = String(req.headers["x-telegram-init-data"] ?? "");
    if (init) actor = validateInitData(init, process.env.BOT_TOKEN ?? "");
    else if (runtime.local) actor = "10001";
    const token = String(req.headers.authorization ?? "").replace(
      /^Bearer /,
      "",
    );
    const result = await runtime.service.request(action, body, {
      actor,
      session: token,
    });
    res.end(JSON.stringify(result));
  } catch (error) {
    const status =
      error instanceof Fault
        ? error.status
        : error instanceof z.ZodError || error instanceof SyntaxError
          ? 400
          : 400;
    res.statusCode = status;
    res.end(
      JSON.stringify({
        error:
          error instanceof Fault
            ? error.message
            : status === 400
              ? "Invalid input or encrypted data authentication failed"
              : "Request failed",
      }),
    );
  }
}
