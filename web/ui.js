// Safe DOM helpers. Everything this page renders is either read from an
// arbitrary on-chain job description or from RPC error strings, i.e. attacker
// controlled. So no innerHTML anywhere: text goes in via textContent only.

export function el(tag, opts = {}, kids = []) {
  const n = document.createElement(tag);
  if (opts.class) n.className = opts.class;
  if (opts.text != null) n.textContent = String(opts.text);
  if (opts.href) n.setAttribute('href', opts.href);
  if (opts.target) n.setAttribute('target', opts.target);
  if (opts.rel) n.setAttribute('rel', opts.rel);
  if (opts.id) n.id = opts.id;
  if (opts.type) n.type = opts.type;
  if (opts.placeholder) n.placeholder = opts.placeholder;
  if (opts.rows) n.rows = opts.rows;
  if (opts.style) n.setAttribute('style', opts.style);
  if (opts.inputmode) n.setAttribute('inputmode', opts.inputmode);
  if (opts.data) for (const [k, v] of Object.entries(opts.data)) n.dataset[k] = v;
  for (const k of [].concat(kids)) if (k != null) n.append(k);
  return n;
}
export const clear = (node) => { while (node.firstChild) node.removeChild(node.firstChild); };
export const set = (node, kids) => { clear(node); for (const k of [].concat(kids)) if (k != null) node.append(k); };

/** Only ever produce links to an allow-listed explorer origin. */
export function safeLink(text, url, allowedOrigin) {
  try {
    const u = new URL(url);
    if (allowedOrigin && u.origin !== new URL(allowedOrigin).origin) throw new Error('bad origin');
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('bad scheme');
    return el('a', { text, href: u.href, target: '_blank', rel: 'noopener noreferrer' });
  } catch {
    return el('span', { text });
  }
}
