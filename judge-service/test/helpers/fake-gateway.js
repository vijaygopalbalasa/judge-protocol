// An in-memory stand-in for Circle Gateway's x402 facilitator on Arc testnet,
// faithful to what the real testnet API was observed to do (2026-09-27):
//   verify: checks the EIP-712 signature and the fields only. It returned
//           isValid: true for a payer with NO Gateway balance.
//   settle: the real gate. {success:false, errorReason:"insufficient_balance"}
//           for an unfunded payer; a used nonce cannot settle twice.
import { verifyTypedData, getAddress } from "viem";

export const GATEWAY_WALLET = "0x0077777d7EBA4688BDeF3E311b846F25870A19B9";
export const ARC = "eip155:5042002";
export const USDC = "0x3600000000000000000000000000000000000000";

const TYPES = { TransferWithAuthorization: [
  { name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" },
  { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" },
] };

export function fakeGateway({ balances = {}, supported = true, fail = {} } = {}) {
  const bal = new Map(Object.entries(balances).map(([a, v]) => [a.toLowerCase(), BigInt(v)]));
  const usedNonces = new Set(); // lower-cased: a nonce is a number, not a string
  const transfers = new Map();   // nonce -> the settled transfer, as Gateway's transfer search returns it
  const never = () => new Promise(() => {});
  const calls = { getSupported: 0, verify: [], settle: [], balanceOf: [] };
  let tx = 0;

  async function sigOk(payload, req) {
    const a = payload?.payload?.authorization;
    const signature = payload?.payload?.signature;
    if (!a || !signature) return false;
    try {
      return await verifyTypedData({
        address: getAddress(a.from),
        domain: { name: req.extra.name, version: req.extra.version, chainId: Number(req.network.split(":")[1]), verifyingContract: getAddress(req.extra.verifyingContract) },
        types: TYPES, primaryType: "TransferWithAuthorization",
        message: { from: getAddress(a.from), to: getAddress(a.to), value: BigInt(a.value), validAfter: BigInt(a.validAfter), validBefore: BigInt(a.validBefore), nonce: a.nonce },
        signature,
      });
    } catch { return false; }
  }

  const facilitator = {
    async getSupported() {
      calls.getSupported++;
      if (fail.getSupported) throw new Error("gateway unreachable");
      return { kinds: supported ? [{ x402Version: 2, scheme: "exact", network: ARC,
        extra: { name: "GatewayWalletBatched", version: "1", verifyingContract: GATEWAY_WALLET.toLowerCase(), minValiditySeconds: 604800,
          assets: [{ symbol: "USDC", address: USDC, decimals: 6 }] } }] : [], extensions: [], signers: {} };
    },
    async verify(payload, req) {
      calls.verify.push({ payload, req });
      if (fail.verify) throw new Error("gateway verify unreachable");
      if (fail.verifyHang) return never();
      const a = payload.payload.authorization;
      const ok = await sigOk(payload, req);
      return ok ? { isValid: true, payer: a.from.toLowerCase() } : { isValid: false, invalidReason: "invalid_signature", payer: a?.from };
    },
    async settle(payload, req) {
      calls.settle.push({ payload, req });
      if (fail.settle) throw new Error("gateway settle unreachable");
      if (fail.settleHang) return never();
      const a = payload.payload.authorization;
      const nonce = String(a.nonce).toLowerCase();
      if (!(await sigOk(payload, req))) return { success: false, errorReason: "invalid_signature", transaction: "", network: req.network };
      if (usedNonces.has(nonce)) return { success: false, errorReason: "nonce_already_used", transaction: "", network: req.network };
      const have = bal.get(a.from.toLowerCase()) ?? 0n;
      if (have < BigInt(a.value)) return { success: false, errorReason: "insufficient_balance", transaction: "", network: req.network };
      bal.set(a.from.toLowerCase(), have - BigInt(a.value));
      usedNonces.add(nonce);
      const t = { id: `gw-transfer-${++tx}`, status: "received", fromAddress: a.from.toLowerCase(), toAddress: String(a.to).toLowerCase(), amount: String(a.value), nonce };
      transfers.set(nonce, t);
      if (fail.settleProcessedThenHang) return never(); // processed, but the answer never comes back
      return { success: true, transaction: t.id, network: req.network, payer: a.from.toLowerCase() };
    },
  };

  async function balanceOf(address) {
    calls.balanceOf.push(address);
    if (fail.balance) throw new Error("gateway balances unreachable");
    return bal.get(String(address).toLowerCase()) ?? 0n;
  }

  /** Gateway's transfer search by nonce (GET /v1/x402/transfers?nonce=...). */
  async function lookupTransfer(nonce) {
    calls.lookup = (calls.lookup ?? 0) + 1;
    return transfers.get(String(nonce).toLowerCase()) ?? null;
  }

  return { facilitator, balanceOf, lookupTransfer, calls, balance: (a) => bal.get(a.toLowerCase()) ?? 0n, drain: (a) => bal.set(a.toLowerCase(), 0n) };
}
