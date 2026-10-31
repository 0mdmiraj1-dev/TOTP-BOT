import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { handler } from "./http.js";
import { createRuntime } from "./runtime.js";
const runtime = await createRuntime(true);
const server = createServer(async (req, res) => {
  if (req.url?.startsWith("/api")) return handler(req, res, runtime);
  const path = req.url?.split("?")[0];
  const files: Record<string, [string, string]> = {
    "/": ["index.html", "text/html"],
    "/app.js": ["app.js", "text/javascript"],
    "/recovery.html": ["recovery.html", "text/html"],
    "/recovery.js": ["recovery.js", "text/javascript"],
    "/style.css": ["style.css", "text/css"],
  };
  const f = files[path ?? "/"];
  if (!f) {
    res.writeHead(404);
    res.end();
    return;
  }
  try {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", f[1]);
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'",
    );
    res.end(await readFile(new URL("../public/" + f[0], import.meta.url)));
  } catch {
    res.writeHead(500);
    res.end("Run npm run build first");
  }
});
server.listen(3000, "127.0.0.1", () =>
  console.log(
    "Local development vault: http://127.0.0.1:3000 (synthetic identity 10001)",
  ),
);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () =>
    server.close(async () => {
      await runtime.close?.();
      process.exit(0);
    }),
  );
