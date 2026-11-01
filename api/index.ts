import type { IncomingMessage, ServerResponse } from "node:http";
import { handler } from "../src/http.js";
import { createRuntime } from "../src/runtime.js";
export default async function api(req: IncomingMessage, res: ServerResponse) {
  try {
    await handler(req, res, await createRuntime(false));
  } catch {
    res.statusCode = 503;
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        writesEnabled: false,
        error:
          "Server configuration invalid; check private environment variables",
      }),
    );
  }
}
