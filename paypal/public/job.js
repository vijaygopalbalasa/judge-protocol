import { $, api, criteriaList, getConfig, markNav, message, modeBanner, money, when } from "./common.js";
import { describeEvent, describeResult } from "./plain.js";

const id = new URLSearchParams(location.search).get("id");
const config = await getConfig();
modeBanner(config);
markNav();
let job;
let buttonsRendered = false;
const deliveryKey = localStorage.getItem(`judge-pay-delivery-${id}`);
const workerUrl = `/worker.html?job=${encodeURIComponent(id)}${deliveryKey ? `#key=${encodeURIComponent(deliveryKey)}` : ""}`;
if (deliveryKey) {
  $("worker-access").hidden = false;
  $("worker-invite").value = `${location.origin}${workerUrl}`;
  $("worker-access-open").href = workerUrl;
}

const STATUS = {
  posted: "Waiting for the PayPal hold", funding: "Approve in PayPal", funded: "Held, waiting for delivery",
  judged: "Judged, settling", captured: "Captured, paying the worker", paid: "Paid", refunded: "Hold voided",
  expired: "Expired, hold voided", failed: "Needs attention",
};

const STAGES = ["Checks agreed", "Payment held", "Work delivered", "Settled"];
function stepper(status) {
  const reached = { posted: 1, funding: 1, funded: 2, judged: 3, captured: 3, paid: 4, refunded: 4, expired: 2, failed: 3 }[status] ?? 1;
  $("stepper").replaceChildren(...STAGES.map((name, i) => {
    const li = document.createElement("li");
    let state = i < reached ? "done" : i === reached ? "current" : "";
    let note = i < reached ? "Done" : i === reached ? "Now" : "";
    if (status === "refunded" && i === 3) { state = "stopped"; note = "Hold voided"; }
    if (status === "expired" && i >= 2) { state = "stopped"; note = i === 2 ? "Missed deadline" : "Hold voided"; }
    if (status === "failed" && i === 3) { state = "stopped"; note = "Needs attention"; }
    if (status === "paid" && i === 3) note = "Worker paid";
    li.className = state;
    const b = document.createElement("b");
    b.textContent = name;
    li.append(b, note);
    if (state === "current") li.setAttribute("aria-current", "step");
    return li;
  }));
}

function definitions(target, entries) {
  $(target).replaceChildren(...entries.filter(([, v]) => v).flatMap(([name, value]) => {
    const dt = document.createElement("dt");
    dt.textContent = name;
    const dd = document.createElement("dd");
    dd.textContent = value;
    return [dt, dd];
  }));
}

function facts(job) {
  definitions("paypal-facts", [
    ["PayPal order", job.paypal.orderId], ["Authorization", job.paypal.authorizationId],
    ["Capture", job.paypal.captureId], ["Payout batch", job.paypal.payoutBatchId],
    ["Payout status", job.paypal.payoutItemStatus ?? job.paypal.payoutStatus], ["Hold voided", job.paypal.voided ? "yes" : null],
  ]);
}

function render(next) {
  job = next;
  $("loading").hidden = true;
  $("job").hidden = false;
  $("job-id").textContent = job.id;
  $("title").textContent = job.title;
  $("task").textContent = job.task;
  $("price").textContent = money(job.price);
  $("payout").textContent = `${money(job.payout)} after ${job.feeBps / 100}% platform fee`;
  $("deadline").textContent = when(job.deadline);
  $("status").textContent = STATUS[job.status] ?? job.status;
  $("status").className = `status-pill ${job.status}`;
  $("criteria").replaceChildren(criteriaList(job.criteria));
  $("criteria-hash").textContent = job.criteriaHash;
  stepper(job.status);
  $("funding-section").hidden = !["posted", "funding"].includes(job.status);
  $("worker-access").hidden = !deliveryKey || !["posted", "funding", "funded"].includes(job.status);
  $("copy-worker-link").className = job.status === "funded" ? "primary" : "secondary";
  $("worker-access-title").textContent = job.status === "funded" ? "The money is held. Send this link to your worker." : "Your worker's private link (works once the hold is placed)";
  $("verdict-section").hidden = !job.verdict;
  if (job.verdict) {
    const passed = job.verdict.pass;
    $("verdict-section").className = `outcome ${passed ? "ok" : "bad"}`;
    $("verdict-title").textContent = passed
      ? (job.status === "paid" ? `Every check passed. ${money(job.payout)} paid to the worker.` : "Every check passed. Paying the worker...")
      : job.status === "refunded" ? "A check failed. The hold was voided; the buyer is not charged." : "A check failed. Voiding the hold...";
    $("verdict-summary").textContent = `Score ${job.verdict.score} of 100 (needed ${job.verdict.threshold}). The agreed program decided this, not the AI. ${passed ? `PayPal captured ${money(job.price)}${job.status === "paid" ? " and confirmed the payout" : ""}.` : "No capture, no payout."}`;
    definitions("outcome-facts", passed
      ? [["Capture", job.paypal.captureId], ["Payout batch", job.paypal.payoutBatchId], ["Payout status", job.paypal.payoutItemStatus ?? job.paypal.payoutStatus]]
      : [["Authorization", job.paypal.authorizationId], ["Status", job.paypal.voided ? "VOIDED" : "voiding"]]);
    $("results").replaceChildren(...job.verdict.results.map((result) => {
      const r = describeResult(result);
      const li = document.createElement("li");
      li.className = r.pass ? "ok" : "bad";
      li.textContent = r.text;
      return li;
    }));
    $("receipt-link").href = `/api/jobs/${encodeURIComponent(job.id)}/receipt`;
    $("verify-link").href = `/receipt/?src=${encodeURIComponent(`/api/jobs/${job.id}/receipt`)}`;
  }
  facts(job);
  $("events").replaceChildren(...[...job.events].reverse().map((event) => {
    const li = document.createElement("li");
    li.className = ["failed", "payout-review"].includes(event.type) ? "bad" : ["settle-retry", "payout-retry", "expire-retry"].includes(event.type) ? "wait" : "ok";
    const time = document.createElement("time");
    time.dateTime = event.at;
    time.textContent = when(event.at);
    li.append(time, describeEvent(event));
    return li;
  }));
  if (["posted", "funding"].includes(job.status)) void setupFunding();
}

async function setupFunding() {
  if (config.localMode) {
    $("local-approve").hidden = false;
    $("paypal-buttons").hidden = true;
    return;
  }
  if (buttonsRendered) return;
  buttonsRendered = true;
  try {
    if (!config.clientId) throw new Error("The PayPal client ID is not configured.");
    const host = config.environment === "live" ? "www.paypal.com" : "www.sandbox.paypal.com";
    const script = document.createElement("script");
    script.src = `https://${host}/sdk/js?client-id=${encodeURIComponent(config.clientId)}&currency=USD&intent=authorize&components=buttons`;
    script.async = true;
    await new Promise((resolve, reject) => { script.onload = resolve; script.onerror = () => reject(new Error("PayPal Buttons could not load.")); document.head.append(script); });
    await globalThis.paypal.Buttons({
      style: { layout: "vertical", shape: "rect", label: "paypal" },
      async createOrder() {
        const order = await api(`/api/jobs/${encodeURIComponent(id)}/order`, { method: "POST", body: {} });
        return order.orderId;
      },
      async onApprove(data) {
        message("funding-message", "PayPal approved. Creating the authorization hold...", "wait");
        const funded = await api(`/api/jobs/${encodeURIComponent(id)}/authorize`, { method: "POST", body: { orderId: data.orderID } });
        message("funding-message", "Payment held. The worker can now deliver.", "ok");
        render(funded);
      },
      onCancel() { message("funding-message", "PayPal checkout was cancelled. Nothing was charged.", "wait"); },
      onError(error) { message("funding-message", error.message ?? "PayPal checkout failed.", "bad"); },
    }).render("#paypal-buttons");
  } catch (error) {
    buttonsRendered = false;
    message("funding-message", error.message, "bad");
  }
}

$("copy-worker-link").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText($("worker-invite").value);
    message("access-message", "Private worker link copied. Send it only to the worker.", "ok");
  } catch {
    $("worker-invite").focus();
    $("worker-invite").select();
    message("access-message", "Select and copy the private link. Share it only with the worker.", "wait");
  }
});

$("local-approve").addEventListener("click", async () => {
  $("local-approve").disabled = true;
  message("funding-message", "Creating and approving a simulated authorization...", "wait");
  try {
    const order = await api(`/api/jobs/${encodeURIComponent(id)}/order`, { method: "POST", body: {} });
    const funded = await api(`/api/local/jobs/${encodeURIComponent(id)}/approve`, { method: "POST", body: { orderId: order.orderId } });
    message("funding-message", "Simulated hold created. No PayPal account was contacted.", "ok");
    render(funded);
  } catch (error) {
    message("funding-message", error.message, "bad");
  } finally {
    $("local-approve").disabled = false;
  }
});

async function refresh() {
  try { render(await api(`/api/jobs/${encodeURIComponent(id)}`)); }
  catch (error) { $("loading").hidden = true; message("message", error.message, "bad"); }
}

if (!id) message("message", "Add a job id to the URL, or create a new job.", "bad");
else {
  await refresh();
  setInterval(() => {
    if (job && ["posted", "funding", "funded", "judged", "captured"].includes(job.status) && !document.hidden) void refresh();
  }, 5000);
}
