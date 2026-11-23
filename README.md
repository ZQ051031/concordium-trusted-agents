# Evidence Ledger

Evidence Ledger takes a research brief from paid input to verifiable decision. The agent buys a fictional dataset for **0.15 test CCD**, ranks the claims, and sells a brief for **0.25 test CCD**. The agent writes one audit receipt that links the decision, the two payments, and its registered identity.

The scoring policy comes from [agent-arena-evidence-mining](https://github.com/ZQ051031/agent-arena-evidence-mining). It considers relevance, recency, source credibility, and corroboration, discards future-dated claims, and removes duplicates. The resulting brief can recommend citations or escalate for review.

## Concordium components

| Component | Role in the demo |
| --- | --- |
| Verified by Concordium badge and Concordium ID | The CLI checks for an active badge, a matching card, the owner and payment wallet, and a current testnet identity credential on the owner's account. Testnet identity providers issue credentials without verifying real-world identity. |
| ERC-8004-compatible Agent Registry and Agent Card | The CLI registers a CIS-8004 agent token, generates its Agent Card with the registration and badge extension, and anchors the hosted file's SHA-256 hash through `setAgentURI`. The [Agent Registry app](https://agent-registry.concordium.com) can resolve the badge on testnet. |
| x402 exact payments | The agent and reviewer use HTTP 402, `PAYMENT-REQUIRED`, `PAYMENT-SIGNATURE`, and `PAYMENT-RESPONSE`. A third account sponsors both native CCD transfers. The local HTTP service releases either resource after settlement. The verifier checks finalized transfers on Concordium. |
| Rust audit contract | `evidence_audit` accepts append calls from the account that initialized it and prevents reuse of payment hashes on that instance. A receipt stores the block timestamp, account and badge reference, decision, SHA-256 hashes of the dataset, brief and card, and both payment transaction hashes. |

The receipt follows the traceability idea in [Article 12 of the EU AI Act](https://eur-lex.europa.eu/eli/reg/2024/1689/oj/eng). It is an owner-signed attestation. The CLI verifies the registry and payments and replays the ranking against the saved input and output. On-chain, the contract enforces the signer and hash uniqueness. The private transcript keeps the dataset and brief available for replay.

## Build and preview

Use Node.js 22+, Rust stable with `wasm32v1-none` support, and `cargo-concordium` 5.0.0. Run these commands from the repository root using a POSIX shell.

```sh
npm ci
npm run build
npm run demo -- preview

rustup target add wasm32v1-none
cargo install cargo-concordium --version 5.0.0 --locked
(
  cd contract
  cargo concordium build --out target/evidence-audit.wasm.v1 \
    --schema-out target/evidence-audit.schema.bin
  cargo test --locked
)
npm test
```

The preview produces a `Cite` decision with two claims about a fictional city bus pilot. The Rust test deploys the compiled Wasm to a test harness and checks owner-only writes, receipt encoding and replay rejection. The Node tests cover ranking, audit encoding and the x402 HTTP exchange with a test facilitator.

## Run on Concordium testnet

### 1. Prepare the three signers

The owner performs the wallet and signing steps on their machine. Set the wallet network to **Testnet**, create or choose three distinct accounts, and request free faucet CCD on each. Use an account created under the Concordium testnet identity provider as the owner. Keep at least 1 test CCD in each account when starting the paid demo. Use the account key **Export to file** option to get Web Wallet JSON, and store the files privately outside the repo. [Concordium testnet setup](https://docs.concordium.com/en/mainnet/tutorials/setup-env.html) · [Account export guide](https://docs.concordium.com/en/mainnet/technical-reference/wallets/guides/export-account-private-key.html)

```sh
export OWNER_WALLET_FILE=/path/to/private/owner-testnet.json
export REVIEWER_WALLET_FILE=/path/to/private/reviewer-testnet.json
export SPONSOR_WALLET_FILE=/path/to/private/sponsor-testnet.json
```

The owner signs the registry and audit transactions and buys the dataset. The reviewer sells the dataset and buys the brief. The sponsor pays the network fees on the two transfers. Use dedicated testnet exports and keep them out of Git, the hosted card, and screen recordings. The CLI checks the node's testnet genesis and the export's testnet label before writing.

### 2. Register and publish the Agent Card

```sh
npm run demo -- register
```

Save the printed badge, token ID, and registration transaction. Set `BADGE` to that badge and generate the card.

```sh
BADGE='<badge printed by register>'
npm run --silent demo -- card "$BADGE" > agent-card.json
```

Publish the exact bytes at a public HTTPS URL that serves the file directly. For example, commit just the generated card to a public branch and copy its raw GitHub URL at the commit that contains it. Set `CARD_URL` to your published URL.

```sh
CARD_URL='<public HTTPS URL of agent-card.json>'
npm run demo -- pin-card "$BADGE" "$CARD_URL" agent-card.json
npm run demo -- verify-badge "$BADGE"
```

Open the printed card URL and check the extension and registration, then look up the badge in the Agent Registry app with Testnet selected. Keep the card bytes stable after pinning. [Agent Registry guide](https://docs.concordium.com/en/mainnet/how-to/integrations/agent-registry.html) · [Agent Card specification](https://docs.concordium.com/en/mainnet/technical-reference/agent-registry/agent-card.html)

### 3. Deploy, exchange, and replay

```sh
npm run demo -- deploy "$BADGE"
AUDIT_ADDRESS='<index.subindex printed by deploy>'
npm run demo -- run "$BADGE" "$AUDIT_ADDRESS"
```

The run prints both settlement transactions, the audit append transaction, the contract link, and the path to the transcript. Keep the transcript and the Wasm used for deployment. Verification checks the exact Wasm module reference, the contract identity, both payments, and the input and output commitments against the finalized receipt.

```sh
TRANSCRIPT='<transcript path printed by run>'
SALE_TX='<sale transaction hash printed by run>'
npm run demo -- verify-run "$TRANSCRIPT"
npm run demo -- receipt "$AUDIT_ADDRESS" "$SALE_TX"
```

If both payments finalized and the audit append failed, run `npm run demo -- anchor "$TRANSCRIPT"` to retry just the audit step. If a payment times out, inspect its transaction or the account activity before starting another paid run.

## Testnet verification

- The [official CIS-8004 registry at 12802.0](https://ccdexplorer.io/testnet/contract/12802/0) is live. The CLI resolved an [existing registration transaction](https://ccdexplorer.io/testnet/transaction/6104b7b5bdbecd46771e963ffd0effeff4dc16e16c2cb03b627413a4cbff1d14) and verified its active badge, anchored card and testnet identity credential. This registration belongs to a separate agent.
- Evidence Ledger's badge, audit deployment, settlements, and audit append are pending the owner's signed run. After running it, record the real audit contract address and the CCDExplorer links for registration, card pinning, module deployment, contract initialization, both x402 transfers, and the audit append. If the module is already deployed, use the existing module reference and the new initialization transaction.
- In CCDExplorer, confirm every transaction succeeded. Check that both transfers show the sponsor, the purchase goes to the reviewer for 0.15 test CCD, and the sale goes to the owner for 0.25 test CCD. In the audit instance, find the append call and compare the receipt from the CLI against the transcript and the card hash.

The [demo video script](DEMO_SCRIPT.md) follows this sequence. See the [Concordium smart contract quick start](https://docs.concordium.com/en/mainnet/tutorials/quick-start.html), [Concordium JavaScript SDK](https://docs.concordium.com/concordium-node-sdk-js/latest/), and [x402 Concordium implementation](https://github.com/x402-foundation/x402/tree/main/typescript/packages/mechanisms/concordium) for the underlying tooling.
