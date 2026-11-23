import {
  AccountAddress, ContractAddress, ContractEvent, TransactionEventTag, TransactionKindString,
  tokenAddressToBase58,
} from "@concordium/web-sdk";
import { contractLink, isHash, NETWORK, sameAccount, sha256, txLink, update, type Node, type Wallet } from "./chain.js";

export const MCP = "https://agent-registry-mcp.concordium.com";
export const REGISTRY = ContractAddress.create(12802, 0);
const REGISTRY_ID = `${NETWORK}:12802.0`;
const BADGE_URI = "https://docs.concordium.com/a2a-extensions/concordium-badge/v1";
const BADGE = /^[1-9A-HJ-NP-Za-km-z]{15,30}$/;
const PROJECT = "https://github.com/ZQ051031/concordium-trusted-agents";

export function tokenBadge(tokenId: string) {
  if (!/^(0|[1-9]\d{0,19})$/.test(tokenId)) throw new Error("Invalid CIS-8004 token ID");
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64LE(BigInt(tokenId));
  return tokenAddressToBase58({ contract: REGISTRY, id: bytes.toString("hex") });
}

export async function mcp<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch(`${MCP}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {
      name, arguments: { ...args, network: "testnet" },
    } }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Registry HTTP ${res.status}`);
  const { result, error } = await res.json();
  const content = result?.content?.[0]?.text;
  if (error || result?.isError || typeof content !== "string") {
    throw new Error(`Registry ${name} failed: ${error?.message ?? content ?? "missing response"}`);
  }
  const value = JSON.parse(content);
  if (value?.network !== "testnet") throw new Error("Registry response is missing testnet context");
  return value as T;
}

export type Agent = {
  token_id: string;
  token_address: string;
  owner_account: string;
  agent_wallet: string | null;
  agent_uri: string | null;
  metadata_hash_hex: string | null;
  status: string;
};

export type Badge = {
  token_id: number;
  token_address: string;
  owner_account: string;
  agent_wallet: string | null;
  status: string;
  extension: {
    uri: string;
    params: { tokenAddress: string; owner: { account: string }; contracts: { cis8004: string } };
  };
  registrations_entry: { agentId: number; agentRegistry: string };
};

export async function badgeData(badge: string) {
  if (!BADGE.test(badge)) throw new Error("Expected a short Concordium badge");
  const data = await mcp<Badge>("get_badge_json", { token_address: badge });
  if (data.token_address !== badge || !Number.isSafeInteger(data.token_id) || tokenBadge(String(data.token_id)) !== badge ||
      data.extension?.uri !== BADGE_URI ||
      data.extension.params.tokenAddress !== `${NETWORK}/cis-2:${badge}` ||
      data.extension.params.owner.account !== `${NETWORK}:${data.owner_account}` ||
      data.registrations_entry?.agentRegistry !== REGISTRY_ID ||
      data.registrations_entry.agentId !== data.token_id ||
      data.extension.params.contracts.cis8004 !== REGISTRY_ID) {
    throw new Error("Badge is outside the official testnet registry");
  }
  return data;
}

export async function verifyBadge(badge: string, expectedOwner?: string) {
  const metadata = await badgeData(badge);
  const result = await mcp<{
    badge_valid: boolean; card_sha256: string; token_address: string;
    on_chain: { owner_account: string; status: string; agent_uri: string; metadata_hash_hex: string };
    checks: { extension_conformant: boolean; hash_matches_on_chain: boolean };
  }>("check_badge", { id: badge });
  if (result.badge_valid !== true || result.token_address !== badge ||
      result.checks?.hash_matches_on_chain !== true || result.checks.extension_conformant !== true ||
      result.on_chain?.status !== "Active" || metadata.status !== "Active" ||
      result.on_chain.owner_account !== metadata.owner_account ||
      (expectedOwner && !sameAccount(expectedOwner, metadata.owner_account)) ||
      !isHash(result.card_sha256) || result.card_sha256 !== result.on_chain.metadata_hash_hex) {
    throw new Error("Expected an active testnet badge with a matching Agent Card and owner");
  }
  return {
    badge,
    tokenId: String(metadata.token_id),
    identity: metadata.extension.params.tokenAddress,
    owner: metadata.owner_account,
    agentWallet: metadata.agent_wallet,
    card: result.on_chain.agent_uri,
    cardHash: result.card_sha256,
    registry: contractLink(REGISTRY),
    identityAssurance: "Concordium testnet account and registry credential",
  };
}

type RegistryPayload = {
  receive_name: string;
  contract_address: { index: number; subindex: number };
  parameter_hex: string;
  sender: string;
};

async function registryWrite(
  node: Node, wallet: Wallet, tool: string, method: string, args: Record<string, unknown>,
) {
  const sender = wallet.accountAddress.toString();
  const tx = await mcp<RegistryPayload>(tool, { ...args, sender });
  if (tx.receive_name !== method || tx.contract_address.index !== 12802 ||
      tx.contract_address.subindex !== 0 || tx.sender !== sender ||
      !/^(?:[a-f0-9]{2})+$/.test(tx.parameter_hex)) {
    throw new Error("Refusing unexpected registry transaction payload");
  }
  const result = await update(node, wallet, REGISTRY, method, tx.parameter_hex);
  if (result.transactionType !== TransactionKindString.Update) throw new Error("Expected update summary");
  return result;
}

export async function register(node: Node, wallet: Wallet) {
  const result = await registryWrite(node, wallet, "build_register", "CIS-8004.register", {});
  // Registered log 240: one-byte tag, then the 8-byte CIS-2 token ID prefixed by its length.
  for (const event of result.events) {
    if (event?.tag !== TransactionEventTag.Updated || event.address.index !== REGISTRY.index ||
        event.address.subindex !== REGISTRY.subindex) continue;
    for (const log of event.events) {
      const bytes = Buffer.from(ContractEvent.toBuffer(log));
      if (bytes.length < 42 || bytes[0] !== 240 || bytes[1] !== 8) continue;
      const tokenId = bytes.readBigUInt64LE(2).toString();
      const agent = await mcp<Agent>("agent_of", { token_id: tokenId });
      if (agent.token_id !== tokenId || !sameAccount(agent.owner_account, wallet.accountAddress.toString())) {
        throw new Error("Registry did not resolve the new token to the signer");
      }
      return { badge: agent.token_address, tokenId, transaction: result.hash.toString(), explorer: txLink(result.hash.toString()) };
    }
  }
  throw new Error(`Registry update finalized without a recognized Registered event: ${txLink(result.hash.toString())}`);
}

export async function makeCard(badge: string) {
  const data = await badgeData(badge);
  if (data.status !== "Active") throw new Error("An active registration is required");
  return {
    type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
    name: "Evidence Ledger",
    description: "Purchases a dataset, ranks and deduplicates evidence, and sells a citation brief with an on-chain accountability receipt.",
    version: "1.0.0",
    provider: { organization: "Evidence Ledger", url: PROJECT },
    documentationUrl: PROJECT,
    defaultInputModes: ["application/json"],
    defaultOutputModes: ["application/json"],
    skills: [{
      id: "evidence-brief", name: "Evidence brief",
      description: "Rank and deduplicate source claims, or escalate thin evidence for review.",
      tags: ["research", "x402", "audit"],
    }],
    capabilities: { streaming: false, pushNotifications: false, extensions: [data.extension] },
    services: [{ name: "web", endpoint: PROJECT }],
    active: true,
    x402Support: true,
    registrations: [data.registrations_entry],
  };
}

export async function pinCard(node: Node, wallet: Wallet, badge: string, uri: string, expectedCard: Buffer) {
  const url = new URL(uri);
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("Agent Card requires a public HTTPS URL");
  const data = await badgeData(badge);
  if (!AccountAddress.isAlias(wallet.accountAddress, AccountAddress.fromBase58(data.owner_account))) {
    throw new Error("Agent Card update requires the testnet registry owner");
  }
  const res = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(10_000) });
  if (!res.ok || !expectedCard.equals(Buffer.from(await res.arrayBuffer()))) {
    throw new Error("Published card bytes differ from the local file");
  }
  const card = JSON.parse(expectedCard.toString("utf8"));
  if (card.name !== "Evidence Ledger" || !card.capabilities?.extensions?.some(
    (ext: Badge["extension"]) => ext.uri === BADGE_URI &&
      ext.params.tokenAddress === data.extension.params.tokenAddress &&
      ext.params.owner.account === data.extension.params.owner.account &&
      ext.params.contracts.cis8004 === REGISTRY_ID,
  ) || !card.registrations?.some((r: Badge["registrations_entry"]) =>
    r.agentRegistry === REGISTRY_ID && r.agentId === data.token_id)) {
    throw new Error("Agent Card does not describe this agent and badge");
  }
  const result = await registryWrite(node, wallet, "build_set_agent_uri", "CIS-8004.setAgentURI", {
    token_id: String(data.token_id),
    agent_uri: url.href,
    metadata_hash_hex: sha256(expectedCard),
  });
  console.error(`Pinned card at ${txLink(result.hash.toString())}`);
  return { transaction: result.hash.toString(), explorer: txLink(result.hash.toString()), ...await verifyBadge(badge) };
}
