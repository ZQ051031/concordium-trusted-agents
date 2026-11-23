import { mkdir, mkdtemp, readFile, rename, writeFile } from "node:fs/promises";
import { addressOf, append, checkAudit, encodeCommitments, readReceipt, type Commitments } from "./audit.js";
import {
  contractLink, NETWORK, ownerCredential, sameAccount, sha256, txLink, verifyTransfer, type Node, type Wallet,
} from "./chain.js";
import { dataset, rank } from "./evidence.js";
import { buyer, facilitator, pay, PURCHASE, quote, SALE, withPaidResource } from "./payments.js";
import { tokenBadge, verifyBadge } from "./registry.js";

type Journal = {
  network: string;
  address: string;
  badge: string;
  tokenId: string;
  owner: string;
  card: string;
  cardHash: string;
  reviewer: string;
  sponsor: string;
  datasetBody?: string;
  briefBody?: string;
  purchaseTx?: string;
  saleTx?: string;
};
type Receipt = NonNullable<Awaited<ReturnType<typeof readReceipt>>>;

async function paymentBadge(badge: string, owner: string) {
  const verified = await verifyBadge(badge, owner);
  if (!verified.agentWallet || !sameAccount(verified.agentWallet, owner)) {
    throw new Error("The registered native payment wallet must match the agent owner for this demo");
  }
  return verified;
}

async function save(file: string, value: Journal) {
  await writeFile(`${file}.tmp`, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  await rename(`${file}.tmp`, file);
}

async function validate(node: Node, file: string) {
  const journal = JSON.parse(await readFile(file, "utf8")) as Journal;
  if (journal.network !== NETWORK || tokenBadge(journal.tokenId) !== journal.badge ||
      !journal.datasetBody || !journal.briefBody ||
      !journal.purchaseTx || !journal.saleTx) throw new Error("Expected a completed testnet payment transcript");
  if (journal.datasetBody !== JSON.stringify(dataset)) throw new Error("Dataset differs from the demo fixture");
  const brief = rank(dataset);
  if (journal.briefBody !== JSON.stringify(brief)) throw new Error("Brief differs from the replayed decision");
  const commitments: Commitments = {
    inputHash: sha256(journal.datasetBody),
    outputHash: sha256(journal.briefBody),
    cardHash: journal.cardHash,
    purchaseTx: journal.purchaseTx,
    saleTx: journal.saleTx,
    decision: brief.decision,
  };
  encodeCommitments(commitments);
  if (sameAccount(journal.owner, journal.reviewer) || sameAccount(journal.owner, journal.sponsor) ||
      sameAccount(journal.reviewer, journal.sponsor)) throw new Error("Demo requires three distinct testnet accounts");

  const address = addressOf(journal.address);
  await checkAudit(node, address, journal.owner, journal.tokenId);
  await Promise.all([
    verifyTransfer(node, journal.purchaseTx, journal.owner, journal.reviewer, PURCHASE, journal.sponsor),
    verifyTransfer(node, journal.saleTx, journal.reviewer, journal.owner, SALE, journal.sponsor),
  ]);
  return { journal, address, commitments, brief };
}

function result(context: Awaited<ReturnType<typeof validate>>, audit: Receipt) {
  return {
    network: NETWORK,
    badge: context.journal.badge,
    tokenId: context.journal.tokenId,
    brief: context.brief,
    purchaseExplorer: txLink(context.commitments.purchaseTx),
    saleExplorer: txLink(context.commitments.saleTx),
    contractExplorer: contractLink(context.address),
    audit,
  };
}

export async function reconcile(node: Node, owner: Wallet, file: string) {
  const context = await validate(node, file);
  if (!sameAccount(owner.accountAddress.toString(), context.journal.owner)) throw new Error("Audit signer differs from the verified owner");
  const existing = await readReceipt(node, context.address, context.commitments.saleTx);
  if (!existing) {
    const badge = await paymentBadge(context.journal.badge, context.journal.owner);
    if (badge.cardHash !== context.journal.cardHash) throw new Error("Agent Card changed before the audit was written");
    await ownerCredential(node, context.journal.owner);
  }
  const audit = await append(node, owner, context.address, context.commitments);
  return { ...result(context, {
    identity: audit.identity, attestedAt: audit.attestedAt, commitments: audit.commitments,
  }), auditTx: audit.auditTx, auditTxExplorer: audit.auditTxExplorer };
}

export async function verifyRun(node: Node, file: string) {
  const context = await validate(node, file);
  const audit = await readReceipt(node, context.address, context.commitments.saleTx);
  if (!audit || encodeCommitments(audit.commitments) !== encodeCommitments(context.commitments)) {
    throw new Error("On-chain audit receipt does not match the local transcript");
  }
  return result(context, audit);
}

export async function demo(
  node: Node, ownerWallet: Wallet, reviewerWallet: Wallet, sponsorWallet: Wallet,
  badge: string, address: string,
) {
  const owner = ownerWallet.accountAddress.toString();
  const reviewer = reviewerWallet.accountAddress.toString();
  const sponsor = sponsorWallet.accountAddress.toString();
  if (sameAccount(owner, reviewer) || sameAccount(owner, sponsor) || sameAccount(reviewer, sponsor)) {
    throw new Error("Owner, reviewer and sponsor require distinct testnet accounts");
  }
  const verified = await paymentBadge(badge, owner);
  await checkAudit(node, addressOf(address), owner, verified.tokenId);
  const credential = await ownerCredential(node, owner);
  const [ownerInfo, reviewerInfo, sponsorInfo] = await Promise.all(
    [ownerWallet, reviewerWallet, sponsorWallet].map(wallet => node.getAccountInfo(wallet.accountAddress))
  );
  for (const account of [ownerInfo, reviewerInfo, sponsorInfo]) {
    if (account.accountAmount.microCcdAmount < 1_000_000n) {
      throw new Error("Fund each of the three testnet accounts with at least 1 faucet CCD before the demo");
    }
  }

  const gateway = facilitator(sponsorWallet);
  const journal: Journal = {
    network: NETWORK, address, badge, tokenId: verified.tokenId, owner, card: verified.card,
    cardHash: verified.cardHash, reviewer, sponsor,
  };
  await mkdir(".run", { recursive: true, mode: 0o700 });
  const file = `${await mkdtemp(".run/receipt-")}/transcript.json`;
  await save(file, journal);
  console.error(`Active testnet badge ${badge} · credential issuer ${credential.identityProvider} · card SHA-256 ${verified.cardHash}`);
  console.error(`Writing payment transcript to ${file}`);

  const purchaseQuote = await quote(reviewer, PURCHASE, sponsor);
  console.error("Dataset request → HTTP 402 → agent pays 0.15 test CCD");
  const purchase = await withPaidResource(
    { name: "dataset", requirements: purchaseQuote, payer: owner, body: JSON.stringify(dataset) },
    gateway, url => pay(url, purchaseQuote, buyer(ownerWallet)),
  );
  journal.purchaseTx = purchase.transaction;
  journal.datasetBody = purchase.body;
  await save(file, journal);
  console.error(`Purchase settled ${txLink(purchase.transaction)}`);
  await verifyTransfer(node, purchase.transaction, owner, reviewer, PURCHASE, sponsor);

  // Check for transfer/revocation or a card change before offering the brief for sale.
  if ((await paymentBadge(badge, owner)).cardHash !== verified.cardHash) {
    throw new Error("The badge or Agent Card changed during the demo");
  }
  const brief = rank(JSON.parse(purchase.body));
  console.error(`Decision: ${brief.decision}. ${brief.rationale}`);
  const saleQuote = await quote(owner, SALE, sponsor);
  console.error("Brief request → HTTP 402 → agent receives 0.25 test CCD");
  const sale = await withPaidResource(
    { name: "brief", requirements: saleQuote, payer: reviewer, body: JSON.stringify(brief) },
    gateway, url => pay(url, saleQuote, buyer(reviewerWallet)),
  );
  journal.saleTx = sale.transaction;
  journal.briefBody = sale.body;
  await save(file, journal);
  console.error(`Sale settled ${txLink(sale.transaction)}`);

  return { transcript: file, ...await reconcile(node, ownerWallet, file) };
}
