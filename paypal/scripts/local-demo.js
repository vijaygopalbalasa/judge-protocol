import { createServer } from "node:http";
import { createApp } from "../src/app.js";
import { createEscrow } from "../src/escrow.js";
import { createPayPal } from "../src/paypal.js";
import { memoryStore } from "../src/store.js";
import { fakePayPal } from "../test/helpers/fake-paypal.js";

const port = Number(process.env.PORT ?? 3000);
const fake = fakePayPal({ clientId: "local-preview", clientSecret: "local-preview" });
const paypal = createPayPal({ clientId: "local-preview", clientSecret: "local-preview", fetchImpl: fake.fetch });
const escrow = createEscrow({ paypal, store: memoryStore(), publicUrl: `http://localhost:${port}` });

const previewAi = {
  async draftCriteria({ request } = {}) {
    if (typeof request !== "string" || !request.trim()) throw new Error("describe the job first");
    return {
      title: "Refund reconciliation report",
      summary: "A JSON reconciliation with the exact total and all three receipt identifiers.",
      criteria: { version: 1, passThreshold: 100, checks: [
        { kind: "json", params: { shape: {
          type: "object", additionalProperties: false,
          required: ["report", "currency", "total_refunds", "receipt_ids", "summary"],
          properties: {
            report: { type: "string", enum: ["refund_reconciliation"] },
            currency: { type: "string", enum: ["USD"] },
            total_refunds: { type: "number", enum: [25] },
            receipt_ids: { type: "array", minItems: 3, maxItems: 3, uniqueItems: true, items: { type: "string", enum: ["RCPT-1042", "RCPT-1048", "RCPT-1051"] } },
            summary: { type: "string", minLength: 20, maxLength: 240 },
          },
        } }, weight: 3 },
        { kind: "contains", params: { all: ["RCPT-1042", "RCPT-1048", "RCPT-1051"] }, weight: 1 },
        { kind: "length", params: { min: 100, max: 1000, unit: "chars" }, weight: 1 },
      ] },
      reasons: ["The JSON has the agreed fields and the exact refund total of 25 USD.", "All three source receipt identifiers appear.", "The report stays within a bounded size."],
      notCheckable: ["Whether the source receipts are authentic; these checks validate the requested transformation, not external accounting records."],
    };
  },
  async work() {
    return {
      content: JSON.stringify({ report: "refund_reconciliation", currency: "USD", total_refunds: 25,
        receipt_ids: ["RCPT-1042", "RCPT-1048", "RCPT-1051"], summary: "Three refunds totaling 25.00 USD are reconciled." }, null, 2),
      passed: true, rounds: 1,
      trace: [{ round: 1, score: 100, pass: true, failed: [] }],
    };
  },
};

const app = createApp({ escrow, ai: previewAi, environment: "sandbox", local: fake });
const server = createServer(app);
server.listen(port, "127.0.0.1", () => {
  console.log(`Judge Pay local preview: http://127.0.0.1:${port}`);
  console.log("This uses a payment simulator and a canned assistant. No PayPal account or real AI is contacted.");
});
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => server.close(() => process.exit(0)));
