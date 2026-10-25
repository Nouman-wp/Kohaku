import { nonceManager, type Address } from "viem";

/**
 * Public RPCs are load-balanced: right after a transaction is mined, the next node asked for
 * the pending nonce can still answer with the old one, and the next transaction is rejected
 * ("nonce too low", or on HashKey Chain "Missing or invalid parameters"). Every signer keeps
 * its own nonce (viem's nonceManager, passed to privateKeyToAccount), and a send that fails
 * this way is retried once the manager has re-read the nonce.
 */
export { nonceManager };

const STALE_NONCE = /nonce too low|nonce has already been used|invalid parameters|replacement transaction underpriced|nonce is too low/i;

export function isStaleNonce(err: unknown): boolean {
  const e = err as { shortMessage?: string; message?: string; details?: string };
  return STALE_NONCE.test(`${e?.shortMessage ?? ""} ${e?.details ?? ""} ${e?.message ?? ""}`);
}

const lastWrite = new Map<string, number>();

/**
 * Run `send` (simulate + write) and retry it on a stale-nonce rejection. The same lag hits
 * reads: a simulation right after this signer's previous transaction can land on a node that
 * has not seen it yet (an approve, then a deposit that needs the allowance), so a revert within
 * a few seconds of our own last write is retried too. A revert that persists is real and thrown.
 */
export async function sendWithNonceRetry<T>(address: Address, chainId: number, send: () => Promise<T>, attempts = 6): Promise<T> {
  const key = `${chainId}:${address.toLowerCase()}`;
  for (let i = 1; ; i++) {
    try {
      const out = await send();
      lastWrite.set(key, Date.now());
      return out;
    } catch (err) {
      const stale = isStaleNonce(err);
      const lagging = Date.now() - (lastWrite.get(key) ?? 0) < 20_000;
      if (i >= attempts || (!stale && !lagging)) throw err;
      if (stale) nonceManager.reset({ address, chainId });
      await new Promise((r) => setTimeout(r, 1_500 * i));
    }
  }
}

/**
 * Rewrite a public URL to a local one when the caller runs next to the service behind it
 * (the clearing service and the fleet on one machine, both published under one domain):
 * `routeUrl("https://site/agents/scout/a2a", [["https://site/agents/", "http://127.0.0.1:8788/agents/"]])`.
 */
export function routeUrl(url: string, routes: readonly (readonly [string, string])[] = []): string {
  for (const [from, to] of routes) if (from && url.startsWith(from)) return to + url.slice(from.length);
  return url;
}
