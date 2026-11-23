import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import {
  AccountAddress, AccountTransactionType, BlockHash, CcdAmount, ContractAddress, Energy,
  Parameter, ReceiveName, TransactionExpiry, TransactionHash, TransactionKindString,
  TransactionSummaryType, buildAccountSigner, parseWallet, signTransaction,
  type AccountSigner, type AccountTransaction, type AccountTransactionInput,
} from "@concordium/web-sdk";
import { ConcordiumGRPCNodeClient, credentials } from "@concordium/web-sdk/nodejs";
import { CONCORDIUM_TESTNET_CAIP2, CONCORDIUM_TESTNET_GRPC } from "@x402/concordium";

export const NETWORK = CONCORDIUM_TESTNET_CAIP2;
export const GENESIS = "4221332d34e1694168c2a0c0b3fd0f273809612cb13d000d5c2e00e85f50f796";
export const [host, port] = CONCORDIUM_TESTNET_GRPC.split(":");
export const explorer = "https://ccdexplorer.io/testnet";
export const txLink = (hash: string) => `${explorer}/transaction/${hash}`;
export const contractLink = (address: ContractAddress.Type) => `${explorer}/contract/${address.index}/${address.subindex}`;
export const sha256 = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
export const isHash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
export const sameAccount = (a: string, b: string) =>
  AccountAddress.isAlias(AccountAddress.fromBase58(a), AccountAddress.fromBase58(b));

export type Wallet = { accountAddress: AccountAddress.Type; signer: AccountSigner };

export async function loadWallet(role: "OWNER" | "REVIEWER" | "SPONSOR"): Promise<Wallet> {
  const name = `${role}_WALLET_FILE`;
  const file = process.env[name];
  if (!file) throw new Error(`Set ${name} to your local Concordium testnet account export`);
  let wallet;
  try {
    wallet = parseWallet(await readFile(file, "utf8"));
  } catch {
    throw new Error(`${name} must point to a readable, unencrypted Concordium account export`);
  }
  if (wallet.environment.toLowerCase() !== "testnet") {
    throw new Error(`${name} must be a testnet export`);
  }
  return { accountAddress: AccountAddress.fromBase58(wallet.value.address), signer: buildAccountSigner(wallet) };
}

export async function testnet() {
  const node = new ConcordiumGRPCNodeClient(host, Number(port), credentials.createSsl(), { timeout: 10_000 });
  const consensus = await node.getConsensusStatus();
  if (BlockHash.toHexString(consensus.genesisBlock) !== GENESIS) throw new Error("Unexpected node genesis");
  return node;
}

export type Node = Awaited<ReturnType<typeof testnet>>;

export async function waitForFinalization(
  node: Pick<Node, "getBlockItemStatus">, hash: TransactionHash.Type, timeoutMs: number,
) {
  const deadline = performance.now() + timeoutMs;
  const expired = new Error(`Finalization timed out at ${txLink(hash.toString())}`);
  const timer = new AbortController();

  async function poll() {
    while (performance.now() < deadline) {
      let status;
      try {
        status = await node.getBlockItemStatus(hash);
      } catch (error) {
        // A just-submitted transaction may not be visible to the queried node yet.
        if ((error as { code?: string }).code !== "NOT_FOUND") throw error;
      }
      if (performance.now() >= deadline) break;
      if (status?.status === "finalized") return status.outcome;
      await delay(1000, undefined, { signal: timer.signal });
    }
    throw expired;
  }

  const timeout = delay(timeoutMs, undefined, { signal: timer.signal }).then(() => { throw expired; });
  try {
    return await Promise.race([poll(), timeout]);
  } finally {
    timer.abort();
  }
}

export async function ownerCredential(node: Node, owner: string) {
  const { accountCredentials } = await node.getAccountInfo(AccountAddress.fromBase58(owner));
  const currentMonth = new Date().toISOString().slice(0, 7).replace("-", "");
  for (const { value } of Object.values(accountCredentials)) {
    const { ipIdentity, policy } = value.contents;
    if (value.type === "normal" && /^\d{6}$/.test(policy.validTo) && policy.validTo >= currentMonth) {
      return { identityProvider: ipIdentity, validThrough: policy.validTo };
    }
  }
  throw new Error("The badge owner needs a current Concordium testnet identity credential");
}

export async function send(
  node: Node, wallet: Wallet, type: AccountTransactionType, payload: AccountTransactionInput,
) {
  const { nonce } = await node.getNextAccountNonce(wallet.accountAddress);
  const transaction: AccountTransaction = {
    type,
    header: {
      sender: wallet.accountAddress,
      nonce,
      expiry: TransactionExpiry.fromDate(new Date(Date.now() + 5 * 60_000)),
    },
    payload,
  };
  const sig = await signTransaction(transaction, wallet.signer);
  const hash = await node.sendAccountTransaction(transaction, sig);
  console.error(`Submitted ${txLink(hash.toString())}`);
  const { summary } = await waitForFinalization(node, hash, 120_000);
  if (summary?.type !== TransactionSummaryType.AccountTransaction || summary.transactionType === TransactionKindString.Failed) {
    throw new Error(`Finalized transaction rejected at ${txLink(hash.toString())}`);
  }
  return summary;
}

export function update(node: Node, wallet: Wallet, address: ContractAddress.Type, method: string, bytes: string) {
  return send(node, wallet, AccountTransactionType.Update, {
    address,
    amount: CcdAmount.zero(),
    receiveName: ReceiveName.fromString(method),
    message: Parameter.fromHexString(bytes),
    maxContractExecutionEnergy: Energy.create(30_000),
  });
}

export async function verifyTransfer(
  node: Node, hash: string, from: string, to: string, amount: string, sponsor: string,
) {
  const status = await node.getBlockItemStatus(TransactionHash.fromHexString(hash));
  const summary = status.status === "finalized" ? status.outcome.summary : undefined;
  if (summary?.type !== TransactionSummaryType.AccountTransaction ||
      summary.transactionType !== TransactionKindString.Transfer ||
      !sameAccount(summary.sender.toString(), from) ||
      !sameAccount(summary.transfer.to.toString(), to) ||
      summary.transfer.amount.microCcdAmount.toString() !== amount ||
      !summary.sponsor || !sameAccount(summary.sponsor.sponsor.toString(), sponsor)) {
    throw new Error(`Expected finalized sponsored test CCD transfer at ${txLink(hash)}`);
  }
}
