import { readFile } from "node:fs/promises";
import { addressOf, deploy, readReceipt } from "./audit.js";
import { contractLink, loadWallet, ownerCredential, testnet } from "./chain.js";
import { dataset, rank } from "./evidence.js";
import { makeCard, pinCard, register, verifyBadge } from "./registry.js";
import { demo, reconcile, verifyRun } from "./run.js";

const usage = `Evidence Ledger · Concordium testnet only

  npm run demo -- preview
  npm run demo -- register
  npm run demo -- card BADGE
  npm run demo -- pin-card BADGE PUBLIC_HTTPS_URL LOCAL_CARD_FILE
  npm run demo -- verify-badge BADGE
  npm run demo -- deploy BADGE
  npm run demo -- run BADGE AUDIT_INDEX.SUBINDEX
  npm run demo -- anchor TRANSCRIPT_FILE
  npm run demo -- verify-run TRANSCRIPT_FILE
  npm run demo -- receipt AUDIT_INDEX.SUBINDEX SALE_TX_HASH
`;

async function main([command, ...args]: string[]) {
  if (!command || command === "--help" || command === "help") {
    process.stdout.write(usage);
    return;
  }
  const [first, second, third] = args;
  switch (command) {
    case "preview":
      if (args.length === 0) return rank(dataset);
      break;
    case "register":
      if (args.length === 0) return register(await testnet(), await loadWallet("OWNER"));
      break;
    case "card":
      if (args.length === 1) return makeCard(first);
      break;
    case "pin-card":
      if (args.length === 3) {
        return pinCard(await testnet(), await loadWallet("OWNER"), first, second, await readFile(third));
      }
      break;
    case "verify-badge":
      if (args.length === 1) {
        const badge = await verifyBadge(first);
        return { ...badge, credential: await ownerCredential(await testnet(), badge.owner) };
      }
      break;
    case "deploy":
      if (args.length === 1) {
        const wallet = await loadWallet("OWNER");
        const badge = await verifyBadge(first, wallet.accountAddress.toString());
        const node = await testnet();
        await ownerCredential(node, badge.owner);
        return deploy(node, wallet, badge.tokenId);
      }
      break;
    case "run":
      if (args.length === 2) {
        addressOf(second);
        const [owner, reviewer, sponsor] = await Promise.all(
          (["OWNER", "REVIEWER", "SPONSOR"] as const).map(loadWallet)
        );
        return demo(await testnet(), owner, reviewer, sponsor, first, second);
      }
      break;
    case "anchor":
      if (args.length === 1) return reconcile(await testnet(), await loadWallet("OWNER"), first);
      break;
    case "verify-run":
      if (args.length === 1) return verifyRun(await testnet(), first);
      break;
    case "receipt":
      if (args.length === 2) {
        const contract = addressOf(first);
        return { contract: contractLink(contract), receipt: await readReceipt(await testnet(), contract, second) };
      }
      break;
  }
  throw new Error(usage);
}

try {
  const value = await main(process.argv.slice(2));
  if (value !== undefined) console.log(JSON.stringify(value, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : "Unexpected failure.");
  process.exitCode = 1;
}
