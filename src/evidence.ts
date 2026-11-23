// Scoring design ported from ZQ051031/agent-arena-evidence-mining (MIT).
export const POLICY = "evidence-ranker/v1";
export const TOPIC = "city bus pilot ridership";
const STOP = new Set("a an the on in at of to for is was are were has have had by with and that as from it".split(" "));

export type Claim = { text: string; source: string; date: string };
export type Dataset = { topic: string; asOf: string; claims: Claim[] };
export const dataset: Dataset = {
  topic: TOPIC,
  asOf: "2026-11-24",
  // Fictional source snapshots for a reproducible demo.
  claims: [
    { text: "City bus pilot ridership reached 12000 daily trips", source: "transit.example.gov", date: "2026-11-18" },
    { text: "The city bus pilot ridership reached 12000 daily trips", source: "press.example", date: "2026-11-19" },
    { text: "City bus pilot added 6 routes", source: "transit.example.gov", date: "2026-10-02" },
    { text: "Bus garage received an architecture award", source: "community.example", date: "2026-11-18" },
    { text: "City bus pilot ridership reached 99000 daily trips", source: "future.example", date: "2026-12-02" },
  ],
};

function words(text: string) {
  return new Set((text.toLowerCase().replaceAll(",", "").match(/\d+(?:\.\d+)?|[a-z]+/g) ?? [])
    .filter(word => !STOP.has(word)));
}

function similarity(a: string, b: string) {
  const left = words(a);
  const right = words(b);
  const digits = (set: Set<string>) => [...set].filter(word => /^\d/.test(word)).sort().join(",");
  if (digits(left) && digits(right) && digits(left) !== digits(right)) return 0;
  return [...left].filter(word => right.has(word)).length / Math.max(1, new Set([...left, ...right]).size);
}

export function rank(input: Dataset) {
  const keywords = words(input.topic);
  const dated = input.claims.filter(claim => Number.isFinite(Date.parse(claim.date)) && claim.date <= input.asOf);
  const scored = dated.map(claim => {
    const text = words(claim.text);
    const relevance = [...keywords].filter(word => text.has(word)).length / Math.max(1, keywords.size);
    const daysOld = (Date.parse(input.asOf) - Date.parse(claim.date)) / 86_400_000;
    const recency = Math.max(0.2, 1 - daysOld / 365);
    const credibility = claim.source.endsWith(".gov") ? 1 : 0.25;
    const domains = new Set(dated.filter(other => similarity(claim.text, other.text) >= 0.72).map(other => other.source));
    const corroboration = Math.min(1, Math.max(0, domains.size - 1) / 2);
    const score = Math.round(100 * (0.45 * relevance + 0.20 * recency + 0.20 * credibility + 0.15 * corroboration));
    return { ...claim, score };
  }).sort((a, b) => b.score - a.score);
  const citations: typeof scored = [];
  for (const claim of scored) {
    if (claim.score >= 65 && !citations.some(existing => similarity(claim.text, existing.text) >= 0.72)) {
      citations.push(claim);
    }
  }
  const decision = citations.length ? "Cite" as const : "Review" as const;
  return {
    policy: POLICY,
    topic: input.topic,
    asOf: input.asOf,
    decision,
    rationale: decision === "Cite" ? "At least one unique claim scored 65 or higher." : "No unique claim met the citation threshold.",
    citations,
  };
}
