# Evidence Ledger demo video

**Target length** 2 minutes 50 seconds

Before recording, complete the testnet setup in the README. Have the agent badge, hosted card, audit address, and the explorer tabs from a completed run ready. Keep wallet files off screen. Use a prepared run if you need to cut around finalization.

| Time | On screen | Narration |
| --- | --- | --- |
| 0:00–0:25 | Testnet badge and the Agent Card. Highlight the registration, badge extension, and card hash from `verify-badge`. | “Evidence Ledger researches a claim for another agent. On Concordium testnet, its badge resolves to a registered owner account and an Agent Card. The CLI checks the card against the registry hash and checks the owner’s testnet identity credential. The test credential demonstrates the identity link. Real-world identity verification is outside the testnet run.” |
| 0:25–1:00 | Start `run` with the badge and audit address. Show the dataset request and open the finalized purchase. | “The agent requests a dataset about a city bus pilot. The service returns HTTP 402 with a price of 0.15 test CCD. The agent signs the x402 payment and the sponsor covers the transaction fee. Once the transfer settles, the service returns the dataset.” |
| 1:00–1:30 | Show the `Cite` decision and two citations. Open the sale transaction and show the direction of payment. | “The agent ranks the claims, discards a future-dated claim and deduplicates the results. It recommends citing two claims. The reviewer buys the brief through a second x402 request, this time paying 0.25 test CCD to the agent.” |
| 1:30–2:15 | Open the audit append transaction and contract. Show `verify-run` and highlight the receipt's timestamp, token ID and hashes. | “The audit contract stores the decision, block time, the owner's registry token, the input and output hashes, the card hash, and both payment references. Only the instance owner can append. The verifier replays the decision, checks both finalized transfers and matches the result to the receipt.” |
| 2:15–2:50 | Return to the project README and open the linked CCDExplorer transactions from the completed run. | “Follow the explorer links to see both sides of the exchange and the audit append. The transcript lets a reviewer reproduce the result and check it against the public record.” |
