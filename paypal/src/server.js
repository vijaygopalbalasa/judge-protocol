// Builds the Judge Pay app from environment variables. Used by the local server (scripts/dev-server.js) and by the
// Vercel function (api/index.js); only where jobs are stored differs.
import { createApp } from "./app.js";
import { createAi } from "./ai.js";
import { createOpenRouterAi } from "./openrouter-ai.js";
import { createEscrow, hashSecret } from "./escrow.js";
import { baseUrlFor, createPayPal } from "./paypal.js";

export function appFromEnv(env, { store, publicUrl }) {
  const { PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET } = env;
  if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET) throw new Error("Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET.");
  const environment = env.PAYPAL_ENV === "live" ? "live" : "sandbox";
  const paypal = createPayPal({ clientId: PAYPAL_CLIENT_ID, clientSecret: PAYPAL_CLIENT_SECRET, baseUrl: baseUrlFor(env) });
  const escrow = createEscrow({
    paypal, store, publicUrl,
    feeBps: Number(env.JUDGE_PAY_FEE_BPS ?? 500),
    deadlineHours: Number(env.JUDGE_PAY_DEADLINE_HOURS ?? 72),
    operatorKeyHash: env.JUDGE_PAY_OPERATOR_KEY ? hashSecret(env.JUDGE_PAY_OPERATOR_KEY) : null,
  });
  const ai = env.OPENROUTER_API_KEY
    ? createOpenRouterAi({ apiKey: env.OPENROUTER_API_KEY, model: env.OPENROUTER_MODEL || undefined, publicUrl })
    : env.ANTHROPIC_API_KEY ? createAi({ model: env.AI_MODEL || undefined }) : null;
  const aiLimits = {
    perCallerPerHour: Number(env.JUDGE_PAY_AI_PER_HOUR ?? 20),
    perDay: Number(env.JUDGE_PAY_AI_PER_DAY ?? 300),
  };
  return { app: createApp({ escrow, ai, clientId: PAYPAL_CLIENT_ID, environment, aiLimits, demoWorkerEmail: env.DEMO_WORKER_EMAIL || null }), ai, environment };
}
