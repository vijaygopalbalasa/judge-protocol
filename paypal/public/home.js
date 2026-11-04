import { $, api, getConfig, message, modeBanner } from "./common.js";

const config = await getConfig();
modeBanner(config);
$("draft").textContent = config.localMode ? "Draft checks in local preview" : config.ai ? "Draft checks with AI" : "AI drafting unavailable";

$("draft").addEventListener("click", async () => {
  $("draft").disabled = true;
  message("message", config.localMode ? "Preparing preview checks..." : "AI is drafting objective checks...", "wait");
  try {
    const draft = await api("/api/ai/draft", { method: "POST", body: { request: $("task").value } });
    $("title").value = draft.title;
    $("criteria").value = JSON.stringify(draft.criteria, null, 2);
    $("reasons").replaceChildren(...(draft.reasons ?? []).map((reason) => {
      const li = document.createElement("li");
      li.textContent = reason;
      return li;
    }));
    $("not-checkable").textContent = draft.notCheckable?.length ? `Not checked: ${draft.notCheckable.join("; ")}` : "";
    $("draft-notes").hidden = false;
    message("message", "Checks drafted. Review and edit them before creating the job.", "ok");
  } catch (error) {
    message("message", error.message, "bad");
  } finally {
    $("draft").disabled = false;
  }
});

$("job-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("create").disabled = true;
  message("message", "Creating the job and pinning its checks...", "wait");
  try {
    let criteria;
    try { criteria = JSON.parse($("criteria").value); }
    catch { throw new Error("The agreed checks must be valid JSON."); }
    const job = await api("/api/jobs", { method: "POST", body: {
      title: $("title").value, task: $("task").value, criteria,
      price: $("price").value, workerEmail: $("worker-email").value,
    } });
    localStorage.setItem(`judge-pay-delivery-${job.id}`, job.workerAccess.key);
    location.assign(`/job.html?id=${encodeURIComponent(job.id)}`);
  } catch (error) {
    message("message", error.message, "bad");
    $("create").disabled = false;
  }
});
