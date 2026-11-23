import { readFile } from "node:fs/promises";
import {
  AccountAddress, AccountTransactionType, CcdAmount, ContractAddress, ContractName, Energy,
  Parameter, ReceiveName, ReturnValue, TransactionKindString, calculateModuleReference, versionedModuleSourceFromBuffer,
} from "@concordium/web-sdk";
import { contractLink, isHash, sameAccount, send, txLink, update, type Node, type Wallet } from "./chain.js";
import { REGISTRY } from "./registry.js";

const CONTRACT = "evidence_audit";
export const MODULE_FILE = "contract/target/evidence-audit.wasm.v1";
export type Address = ContractAddress.Type;

export function addressOf(value: string) {
  if (!/^\d+\.\d+$/.test(value)) throw new Error("Expected audit contract index.subindex");
  const [index, subindex] = value.split(".").map(BigInt);
  return ContractAddress.create(index, subindex);
}

function u64(value: string) {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64LE(BigInt(value));
  return bytes;
}

async function compiledModule() {
  const file = await readFile(MODULE_FILE);
  const source = versionedModuleSourceFromBuffer(Uint8Array.from(file).buffer);
  if (source.version !== 1) throw new Error("Expected a version 1 Concordium module");
  return { file, ref: calculateModuleReference(source) };
}

export async function deploy(node: Node, wallet: Wallet, tokenId: string) {
  const { file, ref } = await compiledModule();
  let moduleTx: string | undefined;
  try {
    await node.getModuleSource(ref);
  } catch (error) {
    if ((error as { code?: number }).code !== 5) throw error;
    const deployment = await send(node, wallet, AccountTransactionType.DeployModule, { source: file });
    if (deployment.transactionType !== TransactionKindString.DeployModule ||
        deployment.moduleDeployed.contents.toString() !== ref.toString()) {
      throw new Error("Finalized transaction did not deploy the expected module");
    }
    moduleTx = deployment.hash.toString();
  }
  const init = await send(node, wallet, AccountTransactionType.InitContract, {
    amount: CcdAmount.zero(),
    initName: ContractName.fromString(CONTRACT),
    moduleRef: ref,
    param: Parameter.fromHexString(u64(tokenId).toString("hex")),
    maxContractExecutionEnergy: Energy.create(30_000),
  });
  if (init.transactionType !== TransactionKindString.InitContract) throw new Error("Expected audit contract init");
  const address = init.contractInitialized.address;
  return {
    address: `${address.index}.${address.subindex}`,
    explorer: contractLink(address),
    moduleRef: ref.toString(),
    moduleTx,
    moduleTxExplorer: moduleTx && txLink(moduleTx),
    initTx: init.hash.toString(),
    initTxExplorer: txLink(init.hash.toString()),
  };
}

async function read(node: Node, contract: Address, fn: string, param?: string) {
  const { lastFinalizedBlock } = await node.getConsensusStatus();
  const result = await node.invokeContract({
    contract, method: ReceiveName.fromString(`${CONTRACT}.${fn}`),
    parameter: param === undefined ? undefined : Parameter.fromHexString(param),
  }, lastFinalizedBlock);
  if (result.tag !== "success" || !result.returnValue) throw new Error(`Audit ${fn} read failed`);
  return Buffer.from(ReturnValue.toBuffer(result.returnValue));
}

// Wire format mirrors the fixed-size types in contract/src/lib.rs.
function decodeIdentity(bytes: Buffer) {
  const owner = AccountAddress.fromBuffer(Uint8Array.from(bytes.subarray(0, 32)).buffer).toString();
  return {
    owner,
    registry: `${bytes.readBigUInt64LE(32)}.${bytes.readBigUInt64LE(40)}`,
    tokenId: bytes.readBigUInt64LE(48).toString(),
  };
}

export async function checkAudit(
  node: Node, address: Address, expectedOwner: string, expectedId: string,
) {
  const { ref } = await compiledModule();
  const info = await node.getInstanceInfo(address);
  if (info.sourceModule.toString() !== ref.toString()) {
    throw new Error("Audit instance source differs from the local Wasm module");
  }
  const bytes = await read(node, address, "identity");
  if (bytes.length !== 56) throw new Error("Unexpected audit identity layout");
  const { owner, registry, tokenId } = decodeIdentity(bytes);
  if (!sameAccount(owner, expectedOwner) || registry !== `${REGISTRY.index}.${REGISTRY.subindex}` || tokenId !== expectedId) {
    throw new Error("Audit instance belongs to a different owner or badge");
  }
}

export type Commitments = {
  inputHash: string; outputHash: string; cardHash: string; purchaseTx: string; saleTx: string;
  decision: "Cite" | "Review";
};

export function encodeCommitments(record: Commitments) {
  const hashes = [record.inputHash, record.outputHash, record.cardHash, record.purchaseTx, record.saleTx];
  if (!hashes.every(isHash) || !["Cite", "Review"].includes(record.decision)) {
    throw new Error("Invalid audit commitments");
  }
  return hashes.join("") + (record.decision === "Cite" ? "00" : "01");
}

export async function readReceipt(node: Node, address: Address, saleTx: string) {
  if (!isHash(saleTx)) throw new Error("Expected a 32-byte sale transaction hash");
  const bytes = await read(node, address, "receipt", saleTx);
  if (bytes.length === 1 && bytes[0] === 0) return null;
  if (bytes.length !== 226 || bytes[0] !== 1 || bytes[225] > 1) throw new Error("Unexpected audit receipt encoding");
  const commitmentBytes = bytes.subarray(65);
  const hash = (index: number) => commitmentBytes.subarray(index * 32, (index + 1) * 32).toString("hex");
  return {
    identity: decodeIdentity(bytes.subarray(1, 57)),
    attestedAt: new Date(Number(bytes.readBigUInt64LE(57))).toISOString(),
    commitments: {
      inputHash: hash(0), outputHash: hash(1), cardHash: hash(2), purchaseTx: hash(3), saleTx: hash(4),
      decision: bytes[225] === 0 ? "Cite" as const : "Review" as const,
    },
  };
}

export async function append(node: Node, wallet: Wallet, address: Address, record: Commitments) {
  const expected = encodeCommitments(record);
  let receipt = await readReceipt(node, address, record.saleTx);
  let auditTx: string | undefined;
  if (!receipt) {
    auditTx = (await update(node, wallet, address, `${CONTRACT}.append`, expected)).hash.toString();
    receipt = await readReceipt(node, address, record.saleTx);
  }
  if (!receipt || encodeCommitments(receipt.commitments) !== expected) throw new Error("Audit commitments differ on-chain");
  return { ...receipt, auditTx, auditTxExplorer: auditTx && txLink(auditTx), contractExplorer: contractLink(address) };
}
