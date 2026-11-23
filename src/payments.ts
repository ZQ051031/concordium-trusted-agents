import { randomUUID } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import { ExactConcordiumScheme as Seller } from "@x402/concordium/exact/server";
import { ExactConcordiumScheme as Buyer } from "@x402/concordium/exact/client";
import { ExactConcordiumScheme as Facilitator } from "@x402/concordium/exact/facilitator";
import { CCD_ASSET_IDENTIFIER, toConcordiumFacilitatorSigner } from "@x402/concordium";
import {
  decodePaymentRequiredHeader, decodePaymentResponseHeader, decodePaymentSignatureHeader,
  encodePaymentRequiredHeader, encodePaymentResponseHeader, encodePaymentSignatureHeader,
} from "@x402/core/http";
import type { PaymentPayload, PaymentRequirements, SettleResponse } from "@x402/core/types";
import { host, port, isHash, NETWORK, sameAccount, txLink, type Wallet } from "./chain.js";

export const PURCHASE = "150000"; // 0.15 test CCD
export const SALE = "250000"; // 0.25 test CCD

export function buyer(wallet: Wallet) {
  return new Buyer(wallet, { grpcUrl: `${host}:${port}`, useTls: true });
}

export function facilitator(wallet: Wallet) {
  const signer = toConcordiumFacilitatorSigner(wallet.accountAddress.toString(), wallet.signer, {
    host, port: Number(port), useTls: true, network: NETWORK,
  });
  return new Facilitator({ signer, requireFinalization: true, finalizationTimeoutMs: 60_000 });
}

export async function quote(payTo: string, amount: string, feePayer: string): Promise<PaymentRequirements> {
  const seller = new Seller();
  const price = await seller.parsePrice({ amount, asset: CCD_ASSET_IDENTIFIER }, NETWORK);
  return seller.enhancePaymentRequirements({
    ...price, extra: price.extra ?? {}, scheme: "exact", network: NETWORK, payTo, maxTimeoutSeconds: 90,
  }, { x402Version: 2, scheme: "exact", network: NETWORK, extra: { feePayer } }, []);
}

function matches(value: PaymentRequirements | undefined, expected: PaymentRequirements) {
  return value?.scheme === "exact" && value.network === NETWORK && value.asset === CCD_ASSET_IDENTIFIER &&
    value.amount === expected.amount && value.payTo === expected.payTo &&
    value.maxTimeoutSeconds === expected.maxTimeoutSeconds && value.extra?.feePayer === expected.extra.feePayer;
}

function respond(res: ServerResponse, status: number, body: string, headers: Record<string, string> = {}) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers });
  res.end(body);
}

function settlementError(receipt: SettleResponse) {
  const details = receipt.errorReason ?? "unexpected settlement receipt";
  return isHash(receipt.transaction) ? `${details}; inspect ${txLink(receipt.transaction)}` : details;
}

export async function withPaidResource<T>(
  resource: { name: string; requirements: PaymentRequirements; payer: string; body: string },
  gateway: Pick<Facilitator, "verify" | "settle">,
  run: (url: string) => Promise<T>,
): Promise<T> {
  const path = `/${resource.name}/${randomUUID()}`;
  let url: string;
  let attempted = false;
  const server = createServer((req, res) => {
    void handle().catch(() => respond(res, 502, JSON.stringify({ error: "Payment service failed; check settlement before retrying" })));

    async function handle() {
      if (req.method !== "GET" || req.url !== path) {
        respond(res, 404, "{}");
        return;
      }
      const signature = req.headers["payment-signature"];
      if (!signature) {
        respond(res, 402, "{}", {
          "PAYMENT-REQUIRED": encodePaymentRequiredHeader({
            x402Version: 2, resource: { url, description: resource.name, mimeType: "application/json" },
            accepts: [resource.requirements],
          }),
        });
        return;
      }
      let proof: PaymentPayload;
      try {
        if (typeof signature !== "string" || signature.length > 8192) throw new Error();
        proof = decodePaymentSignatureHeader(signature);
        if (proof.x402Version !== 2 || proof.resource?.url !== url || !matches(proof.accepted, resource.requirements)) {
          throw new Error();
        }
      } catch {
        respond(res, 400, JSON.stringify({ error: "Invalid x402 proof for this quote" }));
        return;
      }
      const verified = await gateway.verify(proof, resource.requirements);
      if (!verified.isValid || !verified.payer || !sameAccount(verified.payer, resource.payer)) {
        respond(res, 403, JSON.stringify({ error: "Payment signer differs from the expected payer, or proof is invalid" }));
        return;
      }
      if (attempted) {
        respond(res, 409, JSON.stringify({ error: "Settlement already attempted; check the original transaction" }));
        return;
      }
      attempted = true;
      const receipt = await gateway.settle(proof, resource.requirements);
      if (!receipt.success || receipt.network !== NETWORK || !isHash(receipt.transaction) ||
          !receipt.payer || !sameAccount(receipt.payer, resource.payer)) {
        respond(res, 502, JSON.stringify({ error: settlementError(receipt) }));
        return;
      }
      respond(res, 200, resource.body, { "PAYMENT-RESPONSE": encodePaymentResponseHeader(receipt) });
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing local HTTP listener");
    url = `http://127.0.0.1:${address.port}${path}`;
    return await run(url);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

export async function pay(
  url: string, expected: PaymentRequirements, client: Pick<Buyer, "createPaymentPayload">,
) {
  const opts = { redirect: "error" as const, signal: AbortSignal.timeout(100_000) };
  const first = await fetch(url, opts);
  await first.body?.cancel();
  const header = first.headers.get("payment-required");
  if (first.status !== 402 || !header) throw new Error("Expected HTTP 402 with PAYMENT-REQUIRED");
  const ask = decodePaymentRequiredHeader(header);
  if (ask.x402Version !== 2 || ask.resource?.url !== url || ask.accepts.length !== 1 || !matches(ask.accepts[0], expected)) {
    throw new Error("x402 quote violates the testnet, asset, price, recipient or sponsor policy");
  }

  const proof = {
    ...await client.createPaymentPayload(2, ask.accepts[0]), accepted: ask.accepts[0], resource: ask.resource,
  };
  const result = await fetch(url, { ...opts, headers: { "PAYMENT-SIGNATURE": encodePaymentSignatureHeader(proof) } });
  const body = await result.text();
  const settled = result.headers.get("payment-response");
  if (result.status !== 200 || !settled) throw new Error(`x402 settlement failed (HTTP ${result.status}): ${body}`);
  const receipt = decodePaymentResponseHeader(settled);
  if (!receipt.success || receipt.network !== NETWORK || !isHash(receipt.transaction)) {
    throw new Error(settlementError(receipt));
  }
  return { body, transaction: receipt.transaction };
}
