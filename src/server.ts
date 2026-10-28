import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";

import { createApp } from "./api/app.js";

const app = createApp();
app.use("/*", serveStatic({ root: "./dist/web" }));
app.get("/*", serveStatic({ path: "./dist/web/index.html" }));

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port }, ({ port: listeningPort }) => {
  console.log(`PERXIA checkout disponible en http://localhost:${listeningPort}`);
});
