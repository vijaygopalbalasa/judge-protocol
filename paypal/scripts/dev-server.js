import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { createApp } from "../src/app.js";
import { createAi } from "../src/ai.js";
import { createOpenRouterAi } from "../src/openrouter-ai.js";
import { createEscrow, hashSecret } from "../src/escrow.js";
import { baseUrlFor, createPayPal } from "../src/paypal.js";
import { fileStore } from "../src/store.js";

try { process.loadEnvFile(fileURLToPath(new URL("../.env", import.meta.url))); }
catch (error) { if (error.code !== "ENOENT") throw error; }

const { PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET } = process.env;
if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET) {
  console.error("Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET in paypal/.env. For a credential-free UI preview, run npm run demo instead.");
  process.exit(1);
}

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "127.0.0.1";
const publicUrl = (process.env.PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/$/, "");
const environment = process.env.PAYPAL_ENV === "live" ? "live" : "sandbox";
const baseUrl = baseUrlFor(process.env);
const paypal = createPayPal({ clientId: PAYPAL_CLIENT_ID, clientSecret: PAYPAL_CLIENT_SECRET, baseUrl });
const dataDir = process.env.JUDGE_PAY_DATA_DIR ?? fileURLToPath(new URL("../.data/", import.meta.url));
const escrow = createEscrow({
  paypal,
  store: fileStore(`${dataDir}/jobs`),
  publicUrl,
  feeBps: Number(process.env.JUDGE_PAY_FEE_BPS ?? 500),
  deadlineHours: Number(process.env.JUDGE_PAY_DEADLINE_HOURS ?? 72),
  operatorKeyHash: process.env.JUDGE_PAY_OPERATOR_KEY ? hashSecret(process.env.JUDGE_PAY_OPERATOR_KEY) : null,
});
const ai = process.env.OPENROUTER_API_KEY
  ? createOpenRouterAi({ model: process.env.OPENROUTER_MODEL || undefined, publicUrl })
  : process.env.ANTHROPIC_API_KEY ? createAi({ model: process.env.AI_MODEL || undefined }) : null;
const app = createApp({ escrow, ai, clientId: PAYPAL_CLIENT_ID, environment });
const server = createServer(app);
server.requestTimeout = 300_000;
server.listen(port, host, () => console.log(`Judge Pay listening on ${publicUrl} (${environment}; AI ${ai ? `${ai.provider ?? "anthropic"} configured` : "not configured"})`));

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => server.close(() => process.exit(0)));
}
