import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

/**
 * Client for HSP Agentic Payment, HashKey's MCP server for agent payments
 * (https://mcp-qa.hashkeymerchant.com/ on QA). HSP holds the app key and secret; callers
 * pass the team's merchant_name for attribution. Connections are only accepted from
 * allowlisted IPs, which is why the store talks to HSP from the server and the buyer's
 * wallet only ever sends back a signature.
 *
 * Flow (from HSP's guide, revision 2026-10-30):
 *   create_order -> get_order -> prepare_payment -> wallet signs eip712 ->
 *   finalize_payment -> submit_payment -> query_payment (every 15 s)
 */

export interface HspToken {
  address: string;
  chain_id: number;
  decimals: number;
  name: string;
  symbol: string;
  payment_protocol: "eip3009" | "permit2";
  permit2_spender?: string;
  version?: string;
}

export interface HspNetwork {
  chain_id: number;
  name: string;
  display_name: string;
  is_testnet: boolean;
}

export interface HspChainConfig {
  networks: HspNetwork[];
  tokens: HspToken[];
}

export interface HspCreatedOrder {
  flow_id: string;
  payment_request_id: string;
  payment_url?: string;
  [k: string]: unknown;
}

export interface HspPrepared {
  eip712: { domain: Record<string, unknown>; types: Record<string, { name: string; type: string }[]>; primaryType: string; message: Record<string, unknown> };
  cart_hash: string;
  token_total_raw: string;
  quote_expires_at: string;
  pay_to?: string;
  payer?: string;
  payment_request_id?: string;
  payment_payload: Record<string, unknown>;
  payment_mandate_contents: Record<string, unknown>;
  [k: string]: unknown;
}

export interface HspPaymentQuery {
  status?: string;
  attribution_verified?: boolean;
  payment?: { status?: string; status_reason?: string; tx_signature?: string; network?: string; to_pay_address?: string; payer_address?: string; [k: string]: unknown };
  [k: string]: unknown;
}

export class HspToolError extends Error {
  constructor(
    readonly tool: string,
    message: string,
    readonly code?: number,
  ) {
    super(`HSP ${tool}: ${message}`);
  }
}

export class HspAgentic {
  private client: Client | null = null;
  private connecting: Promise<Client> | null = null;
  private config: { at: number; value: HspChainConfig } | null = null;

  constructor(
    readonly url: string,
    readonly merchantName: string,
    private readonly log: (message: string) => void = () => undefined,
  ) {}

  private async connect(): Promise<Client> {
    if (this.client) return this.client;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const client = new Client({ name: "kohaku-store", version: "0.1.0" });
      await client.connect(new StreamableHTTPClientTransport(new URL(this.url)));
      client.onclose = () => {
        if (this.client === client) this.client = null;
      };
      this.client = client;
      this.log(`connected to HSP Agentic Payment at ${this.url}`);
      return client;
    })().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  /** Call one tool; reconnects once if the session went away. */
  async call<T>(tool: string, args: Record<string, unknown>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      let client: Client;
      try {
        client = await this.connect();
      } catch (err) {
        throw new HspToolError(tool, `cannot reach HSP (${(err as Error).message}); is this server's IP allowlisted?`);
      }
      try {
        const res = (await client.callTool({ name: tool, arguments: args }, undefined, { timeout: 90_000 })) as {
          isError?: boolean;
          content?: { type: string; text?: string }[];
          structuredContent?: unknown;
        };
        const text = (res.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
        if (res.isError) {
          const code = Number(text.match(/\b(\d{5})\b/)?.[1]) || undefined;
          throw new HspToolError(tool, text.slice(0, 600) || "tool error", code);
        }
        if (res.structuredContent && typeof res.structuredContent === "object") return res.structuredContent as T;
        try {
          return JSON.parse(text) as T;
        } catch {
          return { text } as T;
        }
      } catch (err) {
        if (err instanceof HspToolError || attempt > 0) throw err;
        // stale session or dropped connection: start a fresh one and retry once
        this.client = null;
        await client.close().catch(() => undefined);
      }
    }
  }

  async chainConfig(maxAgeMs = 10 * 60_000): Promise<HspChainConfig> {
    if (this.config && Date.now() - this.config.at < maxAgeMs) return this.config.value;
    const value = await this.call<HspChainConfig>("get_chain_config", {});
    this.config = { at: Date.now(), value };
    return value;
  }

  /** The enabled token for a chain and symbol, straight from HSP's live config. */
  async token(chainId: number, symbol: string): Promise<{ token: HspToken; network: HspNetwork }> {
    const cfg = await this.chainConfig();
    const token = cfg.tokens.find((t) => t.chain_id === chainId && t.symbol.toUpperCase() === symbol.toUpperCase());
    const network = cfg.networks.find((n) => n.chain_id === chainId);
    if (!token || !network) throw new HspToolError("get_chain_config", `HSP has no ${symbol} on chain ${chainId}`);
    return { token, network };
  }

  createOrder(payTo: string, cartMandate: Record<string, unknown>): Promise<HspCreatedOrder> {
    return this.call<HspCreatedOrder>("create_order", { merchant_name: this.merchantName, pay_to: payTo, cart_mandate: cartMandate });
  }

  getOrder(flowId: string): Promise<Record<string, unknown>> {
    return this.call("get_order", { flow_id: flowId });
  }

  preparePayment(flowId: string, payer: string, protocol: string): Promise<HspPrepared> {
    return this.call<HspPrepared>("prepare_payment", { flow_id: flowId, payer, protocol });
  }

  finalizePayment(p: { signature: string; payment_payload: unknown; payment_mandate_contents: unknown; cart_hash: string }): Promise<{ payment_mandate_json: string; [k: string]: unknown }> {
    return this.call("finalize_payment", p);
  }

  submitPayment(paymentMandateJson: string): Promise<Record<string, unknown>> {
    return this.call("submit_payment", { payment_mandate_json: paymentMandateJson });
  }

  queryPayment(ids: { flowId?: string; paymentRequestId?: string }): Promise<HspPaymentQuery> {
    return this.call<HspPaymentQuery>("query_payment", {
      ...(ids.flowId ? { flow_id: ids.flowId } : {}),
      ...(ids.paymentRequestId ? { payment_request_id: ids.paymentRequestId } : {}),
      expected_merchant_name: this.merchantName,
    });
  }
}
