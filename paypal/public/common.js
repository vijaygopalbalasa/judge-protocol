export const $ = (id) => document.getElementById(id);

export async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { error: text || `HTTP ${res.status}` }; }
  if (!res.ok) {
    const error = new Error(data?.error ?? `Request failed with HTTP ${res.status}`);
    error.status = res.status;
    error.data = data;
    throw error;
  }
  return data;
}

let configPromise;
export function getConfig() {
  configPromise ??= api("/api/config");
  return configPromise;
}

export function message(id, text = "", kind = "") {
  const el = $(id);
  el.textContent = text;
  el.className = `message${kind ? ` ${kind}` : ""}`;
  el.hidden = !text;
}

export const money = (amount) => amount ? `${amount.value} ${amount.currency}` : "";
export const short = (id) => id ? `${id.slice(0, 10)}...${id.slice(-6)}` : "";
export const when = (iso) => iso ? new Date(iso).toISOString().slice(0, 19).replace("T", " ") + " UTC" : "";

export function modeBanner(config) {
  const el = $("mode-banner");
  if (!el) return;
  el.hidden = false;
  if (config.localMode) {
    el.className = "banner wait";
    el.textContent = "Local preview: PayPal is simulated and the assistant is canned. No account is contacted and no money moves.";
  } else {
    el.className = "banner";
    el.textContent = `PayPal ${config.environment} mode. ${config.ai ? `${config.assistant === "openrouter" ? "OpenRouter AI" : "Claude"} is connected for drafting and delivery.` : "AI is not configured; manual checks and delivery still work."}`;
  }
}

export function criteriaList(criteria) {
  const list = document.createElement("ol");
  list.className = "check-list";
  for (const check of criteria?.checks ?? []) {
    const li = document.createElement("li");
    const title = document.createElement("strong");
    title.textContent = check.kind;
    const detail = document.createElement("code");
    detail.textContent = JSON.stringify(check.params);
    li.append(title, detail);
    list.append(li);
  }
  return list;
}
