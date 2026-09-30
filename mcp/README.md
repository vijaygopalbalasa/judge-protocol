# Judge Protocol: MCP server

An [MCP](https://modelcontextprotocol.io) server that gives an AI agent Judge Protocol as tools: write the
checklist for a job, test a delivery against it, read a job, verify a ruling from chain data, and ask the
judge to rule on Arc testnet. An agent that pays for work can check that work before the escrow pays out.

## Tools

| Tool | What it does | Touches |
|---|---|---|
| `judge_build_checklist` | Writes the acceptance checklist from plain answers (templates: `text`, `records`, `record`, `file`, `endpoint`), the same way as the [checklist builder](https://judge-protocol-verifier.vercel.app/build). Returns the job description to paste, the criteria, their hash, and what they check in plain words. | nothing |
| `judge_check_delivery` | Dry run: scores a delivery against a checklist with a copy of the judge's checks, which tests hold equal to the judge's own. Never signs or settles. A live web check is not run, so such a result is marked not final. | nothing |
| `judge_job_status` | Reads a job and its verdict from Arc testnet or mainnet: status, parties, budget, expiry, whether Judge Protocol is its evaluator. | reads the chain |
| `judge_verify_ruling` | Recomputes a ruling from public chain data with the in-browser verifier's code and compares it with the signed verdict: `verified`, `mismatch`, `unsupported`, `incomplete`, `awaiting` or `error`. A delivery hosted on https or IPFS is not fetched: pass its exact bytes, which count only if they hash to the provider's on-chain commitment. | reads the chain |
| `judge_request_ruling` | Asks the hosted judge to rule now on a job on **Arc testnet** that names Judge Protocol. If the job is submitted and its checklist is valid, the judge **signs a verdict and settles the escrow**: PASS pays the provider, REJECT refunds the client. The same public endpoint as the verifier's Ask the judge button. | settles escrow on Arc testnet |

A resource, `judge://docs/criteria`, carries the full criteria reference
([`docs/CRITERIA.md`](../docs/CRITERIA.md)).

Inputs are closed: a network is `arc-testnet` or `arc-mainnet`, a job id is a whole number, a delivery is
text or base64. The server contacts only the chosen network's Arc RPC and, for ruling requests, the hosted
judge. A URL inside a checklist is never fetched by these tools, no file path or address is taken from the
agent, and the server holds no keys.

## Run it

From a checkout of this repository (Node 20 or later):

```bash
cd mcp && npm ci
```

**Claude Code:**

```bash
claude mcp add judge-protocol -- node /absolute/path/to/judge-protocol/mcp/server.js
```

**Claude Desktop** (`claude_desktop_config.json`) or **Cursor** (`.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "judge-protocol": { "command": "node", "args": ["/absolute/path/to/judge-protocol/mcp/server.js"] }
  }
}
```

## Limits, stated plainly

- Ruling requests go to Arc testnet only, as on the verifier page. On Arc mainnet the tools read and
  verify; they do not ask for rulings.
- Only checks a computer can repeat: length, required terms, JSON shapes, an exact file, a live web
  address. Quality and taste are out of scope, and the tools say so rather than guess.
- The judge reads deliveries of at most 1,000,000 bytes (262,144 on ArcBounty, where a delivery is one
  IPFS block).
- Not published to npm or any MCP registry yet: run it from a checkout.

## Tests

`npm test` (after `npm ci` in `judge-service`, whose code builds the synthetic jobs) runs the server
through an MCP client over an in-memory transport: every tool, every refusal with its message, verification
of real Arc testnet rulings against a fake chain built from recorded data, a hosted delivery finished with
its exact bytes, and overlapping calls on two networks, with every request recorded to prove each network
reads only its own RPC and contracts. `node live-check.js` runs it over stdio against Arc itself (read-only, apart from
one ruling request for a job that is already judged).
