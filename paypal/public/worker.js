import { $, api, getConfig, message, modeBanner } from "./common.js";

const config = await getConfig();
modeBanner(config);
const params = new URLSearchParams(location.search);
const storageKey = (id) => `judge-pay-delivery-${id}`;
const linkedJob = params.get("job") ?? "";
const linkedKey = new URLSearchParams(location.hash.slice(1)).get("key");
if (linkedJob && linkedKey) localStorage.setItem(storageKey(linkedJob), linkedKey);
if (location.hash) history.replaceState({}, "", `/worker.html${linkedJob ? `?job=${encodeURIComponent(linkedJob)}` : ""}`);

$("job-id").value = linkedJob;
$("worker-key").value = linkedJob ? localStorage.getItem(storageKey(linkedJob)) ?? "" : "";
$("job-id").addEventListener("change", () => {
  $("worker-key").value = localStorage.getItem(storageKey($("job-id").value.trim())) ?? "";
});
$("ai-work").textContent = config.localMode ? "Run the canned preview worker" : config.ai ? "Let the AI worker deliver and settle" : "AI worker unavailable";

function credentials() {
  const job = $("job-id").value.trim();
  const workerKey = $("worker-key").value;
  if (!job) throw new Error("Enter the funded job id.");
  if (!workerKey) throw new Error("Open the private worker link or paste its delivery key.");
  localStorage.setItem(storageKey(job), workerKey);
  return { job, workerKey };
}

function showTrace(trace) {
  $("trace").hidden = !trace?.length;
  $("trace").textContent = JSON.stringify(trace ?? [], null, 2);
}

function done(jobId) {
  $("job-link-wrap").hidden = false;
  $("job-link").href = `/job.html?id=${encodeURIComponent(jobId)}`;
  $("download").hidden = false;
}

$("ai-work").addEventListener("click", async () => {
  $("ai-work").disabled = true;
  showTrace(null);
  try {
    const { job, workerKey } = credentials();
    message("message", config.localMode ? "Running the canned worker and deterministic checks..." : "AI is drafting and checking the work. This can take a minute...", "wait");
    const out = await api(`/api/jobs/${encodeURIComponent(job)}/ai-work`, { method: "POST", body: { workerKey } });
    showTrace(out.trace);
    message("message", `Delivered. Result: ${out.job.status}. The checks, not the AI, settled the payment.`, "ok");
    done(job);
  } catch (error) {
    showTrace(error.data?.trace);
    message("message", error.message, "bad");
  } finally { $("ai-work").disabled = false; }
});

$("deliver").addEventListener("click", async () => {
  $("deliver").disabled = true;
  showTrace(null);
  try {
    const { job, workerKey } = credentials();
    const file = $("delivery-file").files?.[0];
    const body = { workerKey };
    if (file) {
      if (file.size > 256 * 1024) throw new Error("The delivery file is over 256 KiB.");
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = "";
      for (let at = 0; at < bytes.length; at += 32768) binary += String.fromCharCode(...bytes.subarray(at, at + 32768));
      body.base64 = btoa(binary);
      body.contentType = file.type || "application/octet-stream";
    } else {
      body.content = $("delivery").value;
      body.contentType = "text/plain";
    }
    message("message", "Running the agreed checks and settling by their result...", "wait");
    const out = await api(`/api/jobs/${encodeURIComponent(job)}/deliver`, { method: "POST", body });
    message("message", `${out.verdict.pass ? "Every check passed" : "A check failed"}. Job state: ${out.status}.`, out.verdict.pass ? "ok" : "bad");
    done(job);
  } catch (error) { message("message", error.message, "bad"); }
  finally { $("deliver").disabled = false; }
});

$("download").addEventListener("click", async () => {
  try {
    const { job, workerKey } = credentials();
    const out = await api(`/api/jobs/${encodeURIComponent(job)}/delivery`, { method: "POST", body: { workerKey } });
    const binary = atob(out.base64);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: out.contentType }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `judge-pay-${job}-delivery`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error) { message("message", error.message, "bad"); }
});
