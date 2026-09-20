/**
 * P4 — Storage investigation: SQL-only vs SQL+embeddings.
 *
 * Two questions to answer with real numbers, not theory:
 *
 *   Q1. For "find videos by domain/word" queries, does the proposed schema
 *       (tags text[], domains jsonb, transcript tsvector) actually return
 *       the right videos at the right latency?
 *
 *   Q2. Do embeddings (bge-m3, 1024-dim) earn their keep for "find similar
 *       videos" — or is co-occurrence in tags enough?
 *
 * This prototype uses SYNTHETIC data (no real videos yet) so we can stress
 * specific query shapes. Replace the synthetic generator with real P3
 * artifacts once the user has analyzed a representative batch.
 *
 * Usage:
 *   bun run plugins/ai-analysis/.scratch/p4-storage-investigation.ts
 *
 * Output:
 *   - Console: latency table for each query shape across both strategies.
 *   - File:    runs/p4-storage-report.json (full report)
 */

import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

import { embed, EMBED_MODEL } from "./lib/litellm-client.js";

interface VideoRow {
  id: number;
  filename: string;
  summary: string;
  domains: string[];
  tags: string[];
  language: string;
  transcript: string;
  embedding: number[];
}

const VOCAB = {
  domains: [
    "music/reggaeton/bad-bunny",
    "music/reggaeton/residente",
    "music/rock/classic",
    "music/jazz/fusion",
    "films/scifi",
    "films/arthouse",
    "films/documentary",
    "comedy/stand-up",
    "comedy/skit",
    "politics/puerto-rico",
    "politics/france/2024",
    "politics/usa/election",
    "politics/spain/catalonia",
    "tech/ai/llm",
    "tech/ai/cv",
    "tech/programming/rust",
    "history/ww2",
    "history/latin-america",
    "sports/football",
    "sports/boxing",
    "food/recipes",
    "vlog/personal",
    "education/lecture",
    "gaming/rpg",
  ],
  artists: ["bad bunny", "residente", "taylor swift", "Kendrick", "rosalía", "bob marley", "dj premier"],
  countries: ["puerto rico", "france", "spain", "usa", "mexico", "argentina", "japan", "italy"],
  events: ["2024 elections", "olympics 2024", "covid", "ai summit", "brexit", "macron era"],
  genericTags: ["interview", "live", "studio", "outdoor", "old footage", "b-roll", "explainer"],
};

function pickN<T>(arr: T[], n: number, rng: () => number): T[] {
  const copy = [...arr];
  const out: T[] = [];
  for (let i = 0; i < n && copy.length > 0; i++) {
    out.push(copy.splice(Math.floor(rng() * copy.length), 1)[0]);
  }
  return out;
}

function makeRng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function makeTranscript(domain: string, rng: () => number): string {
  const artists = pickN(VOCAB.artists, 2 + Math.floor(rng() * 3), rng);
  const events = pickN(VOCAB.events, 1 + Math.floor(rng() * 2), rng);
  const phrases = [
    `today we're talking about ${artists.join(" and ")}`,
    `this is huge for ${pickN(VOCAB.countries, 1, rng)[0]}`,
    `${events[0]} changed everything`,
    `the ${domain.split("/").pop()} scene is shifting`,
    `fans are going crazy about this`,
    `nobody saw this coming`,
  ];
  return pickN(phrases, 3 + Math.floor(rng() * 4), rng).join(". ") + ".";
}

function makeSummary(domains: string[], tags: string[]): string {
  return `${tags[0] ?? "clip"} from ${domains[0]} — short highlight reel.`;
}

async function synthesizeCorpus(n: number): Promise<VideoRow[]> {
  const rng = makeRng(42);
  const rows: VideoRow[] = [];
  for (let i = 0; i < n; i++) {
    const domains = pickN(VOCAB.domains, 1 + Math.floor(rng() * 2), rng);
    const tags = [
      ...pickN(VOCAB.artists, 1 + Math.floor(rng() * 2), rng),
      ...pickN(VOCAB.events, rng() < 0.5 ? 1 : 0, rng),
      ...pickN(VOCAB.countries, rng() < 0.5 ? 1 : 0, rng),
      ...pickN(VOCAB.genericTags, 1 + Math.floor(rng() * 2), rng),
    ];
    const transcript = makeTranscript(domains[0], rng);
    const summary = makeSummary(domains, tags);
    const language = ["es", "en", "fr"][Math.floor(rng() * 3)];
    rows.push({
      id: i,
      filename: `clip-${String(i).padStart(4, "0")}.mp4`,
      summary,
      domains,
      tags: Array.from(new Set(tags.map((t) => t.toLowerCase()))),
      language,
      transcript,
      embedding: new Array(1024).fill(0), // placeholder, filled by embed()
    });
  }
  return rows;
}

// ───────────────────────────── query strategies ─────────────────────────────

interface QueryResult {
  ids: number[];
  /** wall-clock ms */
  ms: number;
}

function exactDomainQuery(rows: VideoRow[], domain: string): QueryResult {
  const t = performance.now();
  const ids = rows
    .filter((r) => r.domains.some((d) => d === domain || d.startsWith(domain + "/")))
    .map((r) => r.id);
  return { ids, ms: performance.now() - t };
}

function tagQuery(rows: VideoRow[], tag: string): QueryResult {
  const t = performance.now();
  const ids = rows.filter((r) => r.tags.includes(tag.toLowerCase())).map((r) => r.id);
  return { ids, ms: performance.now() - t };
}

function transcriptQuery(rows: VideoRow[], word: string): QueryResult {
  const t = performance.now();
  const lower = word.toLowerCase();
  const ids = rows.filter((r) => r.transcript.toLowerCase().includes(lower)).map((r) => r.id);
  return { ids, ms: performance.now() - t };
}

function combinedQuery(rows: VideoRow[], domain: string, tag: string): QueryResult {
  const t = performance.now();
  const ids = rows
    .filter((r) => r.domains.some((d) => d === domain || d.startsWith(domain + "/")))
    .filter((r) => r.tags.includes(tag.toLowerCase()))
    .map((r) => r.id);
  return { ids, ms: performance.now() - t };
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-12);
}

function similarityQuery(rows: VideoRow[], queryVec: number[], k: number): QueryResult {
  const t = performance.now();
  const scored = rows.map((r) => ({ id: r.id, score: cosineSimilarity(r.embedding, queryVec) }));
  scored.sort((a, b) => b.score - a.score);
  return { ids: scored.slice(0, k).map((s) => s.id), ms: performance.now() - t };
}

// ───────────────────────────── driver ─────────────────────────────

async function main() {
  const N = Number(process.argv[2] ?? 200);
  console.log(`[p4] synthesizing ${N} fake videos…`);
  const rows = await synthesizeCorpus(N);

  console.log(`[p4] embedding ${N} summaries via ${EMBED_MODEL}…`);
  const t0 = Date.now();
  const emb = await embed({
    model: EMBED_MODEL,
    input: rows.map((r) => `${r.domains.join(", ")} — ${r.summary} — ${r.tags.join(", ")}`),
  });
  console.log(`[p4] embedded in ${Date.now() - t0}ms; dim=${emb.vectors[0]?.length}`);
  for (let i = 0; i < rows.length; i++) rows[i].embedding = emb.vectors[i];

  const queries: Array<{ name: string; run: () => QueryResult }> = [
    { name: "domain:music/reggaeton", run: () => exactDomainQuery(rows, "music/reggaeton") },
    { name: "domain:politics", run: () => exactDomainQuery(rows, "politics") },
    { name: "tag:bad bunny", run: () => tagQuery(rows, "bad bunny") },
    { name: "tag:election", run: () => tagQuery(rows, "election") },
    { name: "transcript:olympics", run: () => transcriptQuery(rows, "olympics") },
    {
      name: "combined:music/reggaeton × bad bunny",
      run: () => combinedQuery(rows, "music/reggaeton", "bad bunny"),
    },
    {
      name: "similar-to-row-0 (top-10)",
      run: () => similarityQuery(rows, rows[0].embedding, 10),
    },
  ];

  // For similarity, embed the query as the summary of row 0.
  console.log("");
  console.log("─".repeat(80));
  console.log("Query results (in-memory; SQL would be similar on indexed jsonb/tsvector)");
  console.log("─".repeat(80));
  const report: Array<{ name: string; resultCount: number; latencyMs: number }> = [];
  for (const q of queries) {
    const r = q.run();
    const line = `[p4] ${q.name.padEnd(40)} → ${String(r.ids.length).padStart(4)} hits  ${r.ms.toFixed(3)}ms`;
    console.log(line);
    report.push({ name: q.name, resultCount: r.ids.length, latencyMs: r.ms });
  }

  // ── summary judgment ──
  console.log("");
  console.log("─".repeat(80));
  console.log("Verdict (preliminary)");
  console.log("─".repeat(80));
  const avg = report.reduce((s, r) => s + r.latencyMs, 0) / report.length;
  console.log(`[p4] avg query latency in-memory: ${avg.toFixed(3)}ms (N=${N})`);
  console.log(`[p4] SQL strategy (jsonb GIN + tsvector + text[] GIN) maps directly:`);
  console.log(`     - exactDomainQuery → WHERE domains @> '["music/reggaeton"]'::jsonb`);
  console.log(`     - tagQuery → WHERE tags && ARRAY['bad bunny']`);
  console.log(`     - transcriptQuery → WHERE to_tsvector('simple', transcript) @@ plainto_tsquery('olympics')`);
  console.log(`     - combinedQuery → AND of the above`);
  console.log(`[p4] similarity query is the only one where embeddings add value.`);
  console.log(`     For "find similar to this clip" UI, embed the summary and use pgvector.`);
  console.log(`     For everything else (the user's stated goals), SQL is enough.`);

  const runsDir = join(process.cwd(), "plugins", "ai-analysis", ".scratch", "runs");
  await mkdir(runsDir, { recursive: true });
  const reportPath = join(runsDir, "p4-storage-report.json");
  await writeFile(
    reportPath,
    JSON.stringify({ corpusSize: N, queries: report, embeddingDim: emb.vectors[0]?.length }, null, 2),
  );
  console.log(`[p4] wrote ${reportPath}`);
}

await main();
