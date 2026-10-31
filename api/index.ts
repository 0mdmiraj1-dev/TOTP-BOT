import type { IncomingMessage, ServerResponse } from "node:http";
import { handler } from "../src/http.js";
import { createRuntime } from "../src/runtime.js";
export default async function api(req: IncomingMessage, res: ServerResponse) {
  await handler(req, res, await createRuntime(false));
}
