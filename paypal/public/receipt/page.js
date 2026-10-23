// The receipt page: reads the receipt and the delivered file, runs check.js, and shows each step as plain text.
import { checkReceipt } from "./check.js";

const $ = (id) => document.getElementById(id);
const LABELS = { format: "Format", "receipt hash": "Receipt hash", "criteria hash": "Agreed checks", delivery: "Delivered file",
  checks: "Checks run again", "evidence hash": "Evidence hash", decision: "Decision", payout: "Payout", paypal: "PayPal" };
let delivery = null;

const bytesOf = async (input) => {
  const file = input.files?.[0];
  return file ? new Uint8Array(await file.arrayBuffer()) : null;
};

$("receipt-file").addEventListener("change", async () => {
  const b = await bytesOf($("receipt-file"));
  if (b) $("receipt").value = new TextDecoder().decode(b);
});

$("delivery-file").addEventListener("change", async () => {
  delivery = await bytesOf($("delivery-file"));
  if (delivery) $("delivery-note").textContent = `Loaded ${$("delivery-file").files[0].name} (${delivery.length} bytes).`;
});

$("example").addEventListener("click", async () => {
  const [r, d] = await Promise.all([fetch("./example/receipt.json"), fetch("./example/delivery.txt")]);
  $("receipt").value = await r.text();
  delivery = new Uint8Array(await d.arrayBuffer());
  $("delivery-note").textContent = `Loaded the example delivery (${delivery.length} bytes).`;
  await run();
});

$("check").addEventListener("click", run);

async function run() {
  let receipt;
  try {
    receipt = JSON.parse($("receipt").value);
  } catch {
    show({ verified: false, steps: [{ name: "format", ok: false, detail: "the receipt is not valid JSON" }] });
    return;
  }
  show(await checkReceipt(receipt, delivery));
}

function show(out) {
  $("result").hidden = false;
  const failed = out.steps.some((s) => s.ok === false);
  const verdict = $("verdict");
  verdict.textContent = out.verified
    ? "Everything checks out. The receipt is consistent, and your file gives exactly the ruling it records."
    : failed ? "Does not check out. See the step marked with a cross." : "Not finished yet. See the steps still waiting.";
  verdict.className = `verdict ${out.verified ? "ok" : failed ? "bad" : "wait"}`;
  const list = $("steps");
  list.replaceChildren();
  for (const s of out.steps) {
    const li = document.createElement("li");
    li.className = s.ok === true ? "ok" : s.ok === false ? "bad" : "wait";
    const name = document.createElement("strong");
    name.textContent = LABELS[s.name] ?? s.name;
    li.append(name, document.createTextNode(`: ${s.detail}`));
    list.append(li);
  }
}

// ?src= loads a receipt from a link: an https address, or this site.
const src = new URLSearchParams(location.search).get("src");
if (src) {
  try {
    const url = new URL(src, location.href);
    if (url.protocol === "https:" || url.origin === location.origin) {
      const res = await fetch(url, { credentials: "omit" });
      if (res.ok) $("receipt").value = await res.text();
    }
  } catch {
    // A bad link leaves the box empty for pasting.
  }
}
