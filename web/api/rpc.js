// Same-origin JSON-RPC proxy to the Arc testnet RPC.
//
// The in-browser verifier reads the chain directly. Some networks and the Arc
// RPC's own edge rules can block a cross-origin browser fetch, which would make
// the page look broken to a visitor whose only fault is their network. Routing
// the read through this function keeps the request same-origin: the browser
// calls /api/rpc, and the upstream JSON-RPC call happens server-side from
// Vercel. It forwards read-only JSON-RPC bodies and nothing else.
const UPSTREAM = 'https://rpc.testnet.arc.io';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'POST only' });
    return;
  }
  try {
    const body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? {});
    const upstream = await fetch(UPSTREAM, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    const text = await upstream.text();
    res.setHeader('content-type', 'application/json');
    res.status(upstream.status).send(text);
  } catch (e) {
    res.status(502).json({ error: { code: -32000, message: 'rpc proxy failed' } });
  }
}
