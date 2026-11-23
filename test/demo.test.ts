import assert from "node:assert/strict";
import { test } from "node:test";
import { BlockHash, TransactionHash, TransactionStatusEnum } from "@concordium/web-sdk";
import {
  decodePaymentRequiredHeader, decodePaymentResponseHeader, encodePaymentSignatureHeader,
} from "@x402/core/http";
import { encodeCommitments } from "../src/audit.js";
import { NETWORK, waitForFinalization } from "../src/chain.js";
import { dataset, rank } from "../src/evidence.js";
import { pay, PURCHASE, quote, withPaidResource } from "../src/payments.js";
import { tokenBadge } from "../src/registry.js";

// Public testnet account addresses used only as fixture identities.
const payer = "43WTW9mXTvFheLNjmsso5hDEJyYTdn8cssFXYDUHruUjqSSpMu";
const recipient = "3dt3UMPzRASZndjmKpSWgCP2HhmoxZrgs8FDPtZjNHZzj13hhB";
const sponsor = "3whdieGHx43KKRwQYbC5pAUdmWZ61B7yreNRU9i36MtdCvajR8";
const mockTransaction = "01".repeat(32);
const stubClient = {
  createPaymentPayload: async () => ({ x402Version: 2, payload: { transportTest: true } }),
};

test("finalization propagates node errors and bounds pending waits", async () => {
  const hash = TransactionHash.fromHexString(mockTransaction);
  let calls = 0;
  await assert.rejects(waitForFinalization({
    async getBlockItemStatus() {
      calls++;
      throw Object.assign(new Error("Unknown transaction"), { code: "NOT_FOUND" });
    },
  }, hash, 25), /Finalization timed out/);
  assert.equal(calls, 1);
  await assert.rejects(waitForFinalization({
    async getBlockItemStatus() { throw new Error("Connection refused"); },
  }, hash, 1000), /Connection refused/);
});

test("finalization times out while the status request is in flight", async () => {
  const hash = TransactionHash.fromHexString(mockTransaction);
  const finalized = {
    status: TransactionStatusEnum.Finalized as const,
    outcome: { blockHash: BlockHash.fromHexString(mockTransaction), summary: null },
  };
  let resolve!: (status: typeof finalized) => void;
  const promise = new Promise<typeof finalized>(settle => { resolve = settle; });
  const wait = waitForFinalization({ getBlockItemStatus: () => promise }, hash, 25);
  await assert.rejects(wait, /Finalization timed out/);
  resolve(finalized);
  await assert.rejects(wait, /Finalization timed out/);
});

test("evidence ranking removes duplicate and future claims and can escalate", () => {
  const brief = rank(dataset);
  assert.equal(brief.decision, "Cite");
  assert.deepEqual(brief.citations.map(claim => claim.text), [
    "City bus pilot ridership reached 12000 daily trips",
    "City bus pilot added 6 routes",
  ]);
  assert.equal(rank({ ...dataset, claims: [] }).decision, "Review");
});

test("audit parameter binds both transfer hashes and a decision discriminant", () => {
  const commitments = {
    inputHash: "01".repeat(32), outputHash: "02".repeat(32), cardHash: "03".repeat(32),
    purchaseTx: "04".repeat(32), saleTx: "05".repeat(32), decision: "Review" as const,
  };
  const encoded = Buffer.from(encodeCommitments(commitments), "hex");
  assert.equal(encoded.length, 161);
  assert.deepEqual([...encoded.filter((_, offset) => offset % 32 === 0)], [1, 2, 3, 4, 5, 1]);
  assert.throws(() => encodeCommitments({ ...commitments, saleTx: "invalid" }), /Invalid audit/);
  assert.equal(tokenBadge("1224"), "JyP9XfKVsCUMaaEsDtyoS");
});

test("HTTP 402, signer and price checks, sponsored receipt, single settlement attempt", async () => {
  const requirements = await quote(recipient, PURCHASE, sponsor);
  assert.equal(requirements.asset, "CCD");
  assert.equal(requirements.network, NETWORK);
  assert.equal(requirements.extra.feePayer, sponsor);
  let signer = sponsor;
  let settlements = 0;
  const facilitator = {
    verify: async () => ({ isValid: true, payer: signer }),
    settle: async () => {
      settlements++;
      return { success: true, transaction: mockTransaction, payer, network: NETWORK };
    },
  };
  const body = JSON.stringify(dataset);
  await withPaidResource({ name: "dataset", requirements, payer, body }, facilitator, async url => {
    const challenge = await fetch(url);
    assert.equal(challenge.status, 402);
    assert.equal(await challenge.text(), "{}");
    const proof = {
      ...await stubClient.createPaymentPayload(),
      accepted: requirements,
      resource: decodePaymentRequiredHeader(challenge.headers.get("payment-required")!).resource,
    };
    const send = (signature: string) => fetch(url, { headers: { "PAYMENT-SIGNATURE": signature } });
    const wrong = await send(encodePaymentSignatureHeader({ ...proof, accepted: { ...requirements, amount: "1" } }));
    assert.equal(wrong.status, 400);
    await wrong.body?.cancel();
    const badSigner = await send(encodePaymentSignatureHeader(proof));
    assert.equal(badSigner.status, 403);
    await badSigner.body?.cancel();
    assert.equal(settlements, 0);
    await assert.rejects(pay(url, { ...requirements, amount: "1" }, {
      createPaymentPayload: async () => assert.fail("refuse before signing"),
    }), /violates/);
    signer = payer;
    assert.deepEqual(await pay(url, requirements, stubClient), { body, transaction: mockTransaction });
    const replay = await send(encodePaymentSignatureHeader(proof));
    assert.equal(replay.status, 409);
    assert.equal(replay.headers.get("payment-response"), null);
    await replay.body?.cancel();
    assert.equal(settlements, 1);
  });
});

test("failed settlement never releases the dataset", async () => {
  const requirements = await quote(recipient, PURCHASE, sponsor);
  await withPaidResource({ name: "dataset", requirements, payer, body: "private data" }, {
    verify: async () => ({ isValid: true, payer }),
    settle: async () => ({ success: false, transaction: mockTransaction, network: NETWORK, errorReason: "pending" }),
  }, async url => {
    await assert.rejects(pay(url, requirements, stubClient), error => {
      assert.match(String(error), /pending/);
      assert.match(String(error), new RegExp(mockTransaction));
      assert.doesNotMatch(String(error), /private data/);
      return true;
    });
  });
});
