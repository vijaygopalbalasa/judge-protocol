import { describeCheck } from "./plain.js";

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
    const where = config.environment === "live" ? "PayPal live: real money." : "PayPal sandbox: test money only.";
    const who = config.assistant === "openrouter" ? `${config.model ?? "a model"} via OpenRouter` : config.model ?? "Claude";
    el.textContent = `${where} ${config.ai ? `AI (${who}) drafts the checks and can do the work; it never decides payment.` : "AI is not configured; manual checks and delivery still work."}`;
  }
}

/** The agreed checks as plain rules, with the exact JSON one click away. */
export function criteriaList(criteria, { raw = true } = {}) {
  const wrap = document.createElement("div");
  const list = document.createElement("ol");
  list.className = "terms";
  const checks = criteria?.checks ?? [];
  const total = checks.reduce((sum, c) => sum + (c.weight ?? 1), 0);
  for (const check of checks) {
    const { title, lines } = describeCheck(check);
    const li = document.createElement("li");
    const head = document.createElement("strong");
    head.textContent = title;
    li.append(head);
    if (checks.length > 1 && criteria.passThreshold < 100) {
      const w = document.createElement("span");
      w.className = "weight";
      w.textContent = `weight ${check.weight ?? 1}/${total}`;
      li.append(w);
    }
    if (lines.length) {
      const ul = document.createElement("ul");
      ul.append(...lines.map((line) => { const item = document.createElement("li"); item.textContent = line; return item; }));
      li.append(ul);
    }
    list.append(li);
  }
  if (!checks.length) { list.className = "terms-empty"; list.textContent = "No checks yet."; }
  const rule = document.createElement("p");
  rule.className = "hint";
  rule.textContent = criteria?.passThreshold === 100 || criteria?.passThreshold === undefined
    ? "Payment is released only if every check passes."
    : `Payment is released at a weighted score of ${criteria.passThreshold} or more.`;
  wrap.append(list, rule);
  if (raw) {
    const details = document.createElement("details");
    details.className = "raw";
    const summary = document.createElement("summary");
    summary.textContent = "Exact agreed JSON";
    const pre = document.createElement("pre");
    pre.textContent = JSON.stringify(criteria, null, 2);
    details.append(summary, pre);
    wrap.append(details);
  }
  return wrap;
}

/** Marks the current page in the site navigation. */
export function markNav() {
  const here = location.pathname.replace(/index\.html$/, "");
  for (const a of document.querySelectorAll(".site-header nav a")) {
    const path = new URL(a.href).pathname;
    if (path !== "/" && here.startsWith(path)) a.setAttribute("aria-current", "page");
  }
}
