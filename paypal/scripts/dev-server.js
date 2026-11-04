import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { appFromEnv } from "../src/server.js";
import { fileStore } from "../src/store.js";

try { process.loadEnvFile(fileURLToPath(new URL("../.env", import.meta.url))); }
catch (error) { if (error.code !== "ENOENT") throw error; }

if (!process.env.PAYPAL_CLIENT_ID || !process.env.PAYPAL_CLIENT_SECRET) {
  console.error("Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET in paypal/.env. For a credential-free UI preview, run npm run demo instead.");
  process.exit(1);
}

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "127.0.0.1";
const publicUrl = (process.env.PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/$/, "");
const dataDir = process.env.JUDGE_PAY_DATA_DIR ?? fileURLToPath(new URL("../.data/", import.meta.url));
const { app, ai, environment } = appFromEnv(process.env, { store: fileStore(`${dataDir}/jobs`), publicUrl });
const server = createServer(app);
server.requestTimeout = 300_000;
server.listen(port, host, () => console.log(`Judge Pay listening on ${publicUrl} (${environment}; AI ${ai ? `${ai.provider ?? "anthropic"} configured` : "not configured"})`));

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => server.close(() => process.exit(0)));
}
