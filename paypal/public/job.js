import { $, api, criteriaList, getConfig, message, modeBanner, money, when } from "./common.js";

const id = new URLSearchParams(location.search).get("id");
const config = await getConfig();
modeBanner(config);
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
  posted: "Waiting for authorization", funding: "Approve in PayPal", funded: "Funded, awaiting delivery",
  judged: "Judged, settling", captured: "Captured, paying worker", paid: "Paid", refunded: "Hold voided",
  expired: "Expired, hold voided", failed: "Needs attention",
};

function facts(job) {
  const entries = [
    ["PayPal order", job.paypal.orderId], ["Authorization", job.paypal.authorizationId],
    ["Capture", job.paypal.captureId], ["Payout batch", job.paypal.payoutBatchId],
    ["Payout status", job.paypal.payoutItemStatus ?? job.paypal.payoutStatus],
  ].filter(([, value]) => value);
  $("paypal-facts").replaceChildren(...entries.flatMap(([name, value]) => {
    const dt = document.createElement("dt");
    dt.textContent = name;
    const dd = document.createElement("dd");
    dd.textContent = value;
    dd.title = value;
    return [dt, dd];
  }));
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
  $("funding-section").hidden = !["posted", "funding"].includes(job.status);
  $("worker-section").hidden = job.status !== "funded";
  $("worker-link").href = workerUrl;
  $("verdict-section").hidden = !job.verdict;
  if (job.verdict) {
    const passed = job.verdict.pass;
    $("verdict-title").textContent = passed ? "Every check passed. Payment released." : "A check failed. The hold was voided.";
    $("verdict-summary").textContent = `Score ${job.verdict.score}; pass threshold ${job.verdict.threshold}. ${job.status === "paid" ? "PayPal confirmed the worker payout." : job.status === "captured" ? "Payment captured; payout is still pending." : job.status === "refunded" ? "The buyer was not charged." : "See the money trail below."}`;
    $("results").replaceChildren(...job.verdict.results.map((result) => {
      const li = document.createElement("li");
      li.className = result.pass ? "ok" : "bad";
      li.textContent = `${result.kind}: ${result.detail}`;
      return li;
    }));
    $("receipt-link").href = `/api/jobs/${encodeURIComponent(job.id)}/receipt`;
    $("verify-link").href = `/receipt/?src=${encodeURIComponent(`/api/jobs/${job.id}/receipt`)}`;
  }
  facts(job);
  $("events").replaceChildren(...[...job.events].reverse().map((event) => {
    const li = document.createElement("li");
    li.className = ["failed", "payout-review"].includes(event.type) ? "bad" : ["settle-retry", "payout-retry", "expire-retry"].includes(event.type) ? "wait" : "ok";
    li.textContent = `${when(event.at)}: ${event.type}${event.detail ? `, ${event.detail}` : ""}`;
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
