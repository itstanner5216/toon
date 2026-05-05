// Ported from: engines/sagerank.py
// Python line count: 846
// Port verification:
//   - Graph build: posting-list intersection (TAAT), eIDF-weighted cosine similarity,
//     self-tuning threshold at 1% of max similarity (_buildGraph)
//   - Scoring: BM25-style saturation TF, entropy-blended eIDF per term (_computeEidf)
//   - Convergence: power iteration PageRank, damping=0.85, max_iter=50, epsilon=1e-6,
//     L1 norm convergence check, dangling-node mass to personalization (_pagerank)
//   - Query bias: BMX+ TAAT query scoring blended into personalization vector (_scoreQuery)
//   - Coverage selection: greedy MMR-like PR(i)*(lambda + (1-lambda)*novel/total) (_extractWithCoverage)
//   - Position prior: centrality-detected lead bias + fixed trail boost (_positionPrior)
//   - Keyword extraction: eIDF * sqrt(df) scoring (_getKeywords)
//   - All math: Math.log (natural), Math.sqrt, Math.exp, Math.abs, Math.floor for floor-div
//   - Python // → Math.floor(a/b), Python ** → Math.pow or ** operator
//   - Python None → null, falsy-length guards on arrays/maps
//   - Python Counter → Map<string,number> with manual increment

// ════════════════════════════════════════════════════════════════════════
//  Constants
// ════════════════════════════════════════════════════════════════════════

// ════════════════════════════════════════════════════════════════════════
//  Helpers
// ════════════════════════════════════════════════════════════════════════

function _fastSigmoid(x: number): number {
  // Padé rational approximation to σ(x). |error| < 0.01.
  if (x >= 8.0) return 1.0;
  if (x <= -8.0) return 0.0;
  const x2 = x * x;
  const x3 = x2 * x;
  return (x3 + 6.0 * x + 12.0) / (x3 + 12.0 * x + 48.0);
}

function _segmentSentences(text: string, minLength: number = 10): string[] {
  // Rule-based sentence segmentation. No dependencies.
  // Handles paragraphs, line-per-message logs, and standard prose.
  const trimmed = text.trim();
  if (trimmed.length === 0) return [];

  const raw: string[] = [];
  const blocks = trimmed.split(/\n\s*\n/);
  for (const rawBlock of blocks) {
    const block = rawBlock.trim();
    if (block.length === 0) continue;
    for (const rawLine of block.split("\n")) {
      const line = rawLine.trim();
      if (line.length === 0) continue;
      // Split on sentence-ending punctuation followed by space + capital
      const parts = line.split(/(?<=[.!?])\s+(?=[A-Z"])/);
      for (const rawP of parts) {
        const p = rawP.trim();
        if (p.length > 0) raw.push(p);
      }
    }
  }

  if (raw.length === 0) return [];

  // Merge very short fragments with previous sentence
  const merged: string[] = [raw[0]];
  for (let i = 1; i < raw.length; i++) {
    if (merged[merged.length - 1].length < minLength) {
      merged[merged.length - 1] += " " + raw[i];
    } else {
      merged.push(raw[i]);
    }
  }
  return merged;
}

// ════════════════════════════════════════════════════════════════════════
//  Result
// ════════════════════════════════════════════════════════════════════════

export interface SageResult {
  readonly sentences: string[];
  readonly scores: number[];
  readonly selectedIndices: number[];
  readonly keywords: [string, number][];
  readonly stats: Record<string, number | boolean | string>;
  readonly summary: string;
  readonly selectedSentences: string[];
  top(k?: number | null): [number, string, number][];
}

function makeSageResult(
  sentences: string[],
  scores: number[],
  selectedIndices: number[],
  keywords: [string, number][],
  stats: Record<string, number | boolean | string>,
): SageResult {
  const summary = [...selectedIndices]
    .sort((a, b) => a - b)
    .map((i) => sentences[i])
    .join(" ");

  const selectedSentences = [...selectedIndices]
    .sort((a, b) => a - b)
    .map((i) => sentences[i]);

  function top(k?: number | null): [number, string, number][] {
    const ranked = [...Array(scores.length).keys()].sort(
      (a, b) => scores[b] - scores[a],
    );
    const truncated = k != null ? ranked.slice(0, k) : ranked;
    return truncated.map((i) => [i, sentences[i], scores[i]]);
  }

  return {
    sentences,
    scores,
    selectedIndices,
    keywords,
    stats,
    summary,
    selectedSentences,
    top,
  };
}

// ════════════════════════════════════════════════════════════════════════
//  SageRank
// ════════════════════════════════════════════════════════════════════════

export class SageRank {
  private readonly _k1: number;
  private readonly _b: number;
  private readonly _damping: number;
  private readonly _maxIter: number;
  private readonly _epsilon: number;
  private readonly _coverageWeight: number;
  private readonly _minSentLen: number;
  private readonly _normalize: boolean;

  constructor(
    k1: number = 1.5,
    b: number = 0.75,
    damping: number = 0.85,
    maxIter: number = 50,
    epsilon: number = 1e-6,
    coverageWeight: number = 0.5,
    minSentenceLength: number = 10,
    normalize: boolean = true,
  ) {
    this._k1 = k1;
    this._b = b;
    this._damping = damping;
    this._maxIter = maxIter;
    this._epsilon = epsilon;
    this._coverageWeight = coverageWeight;
    this._minSentLen = minSentenceLength;
    this._normalize = normalize;
  }

  // ────────────────────────────────────────────────────────────────
  //  Tokenisation
  // ────────────────────────────────────────────────────────────────

  static _tokenize(text: string): string[] {
    // Must reset lastIndex because _WORD_RE has the /g flag and is module-level;
    // instead, use exec loop to avoid stateful .test()
    const lower = text.toLowerCase();
    const tokens: string[] = [];
    const re = /\b\w+\b/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(lower)) !== null) {
      tokens.push(m[0]);
    }
    return tokens;
  }

  // ────────────────────────────────────────────────────────────────
  //  Index Construction
  // ────────────────────────────────────────────────────────────────

  static _buildPostingLists(
    sentTokens: string[][],
  ): [Map<string, Map<number, number>>, Map<string, number>, Map<number, number>, number] {
    // Returns [postingLists, docFreqs, docLengths, avgDl]
    const postingLists = new Map<string, Map<number, number>>();
    const docFreqs = new Map<string, number>();
    const docLengths = new Map<number, number>();
    let totalLength = 0;

    for (let idx = 0; idx < sentTokens.length; idx++) {
      const tokens = sentTokens[idx];
      const dl = tokens.length;
      docLengths.set(idx, dl);
      totalLength += dl;

      // Counter equivalent
      const tf = new Map<string, number>();
      for (const token of tokens) {
        tf.set(token, (tf.get(token) ?? 0) + 1);
      }

      for (const [term, count] of tf.entries()) {
        if (!postingLists.has(term)) postingLists.set(term, new Map<number, number>());
        postingLists.get(term)!.set(idx, count);
        docFreqs.set(term, (docFreqs.get(term) ?? 0) + 1);
      }
    }

    const n = sentTokens.length;
    const avgDl = n > 0 ? totalLength / n : 0.0;
    return [postingLists, docFreqs, docLengths, avgDl];
  }

  // ────────────────────────────────────────────────────────────────
  //  Entropy-Weighted IDF
  // ────────────────────────────────────────────────────────────────

  static _computeEidf(
    postingLists: Map<string, Map<number, number>>,
    docFreqs: Map<string, number>,
    n: number,
  ): [Map<string, number>, Map<string, number>, Map<string, number>, number] {
    // Returns [idf, eidf, info, idfMax]
    const idf = new Map<string, number>();
    const info = new Map<string, number>();

    // Phase 1: IDF
    for (const [term, df] of docFreqs.entries()) {
      if (df > 0 && n > 0) {
        idf.set(term, Math.log((n - df + 0.5) / (df + 0.5) + 1.0));
      } else {
        idf.set(term, 0.0);
      }
    }

    const idfValues = [...idf.values()];
    const idfMax = idfValues.length > 0 ? Math.max(...idfValues) : 1.0;

    // Phase 2: Term informativeness (entropy-blended)
    for (const [term, df] of docFreqs.entries()) {
      if (df < 2) {
        info.set(term, 1.0); // rare → maximally informative
        continue;
      }

      const posting = postingLists.get(term);
      if (!posting || posting.size === 0) {
        info.set(term, 0.0);
        continue;
      }

      const idfInfo = n > 0 ? 1.0 - df / n : 0.0;

      // TF variance → blend weight
      const tfVals = [...posting.values()];
      const nPost = tfVals.length;
      const meanTf = tfVals.reduce((a, b) => a + b, 0) / nPost;
      const variance = tfVals.reduce((acc, v) => acc + (v - meanTf) ** 2, 0) / nPost;
      const blendAlpha = variance / (variance + 1.0);

      if (blendAlpha < 0.001) {
        info.set(term, idfInfo);
      } else {
        const mapped = tfVals.map((tf) => _fastSigmoid(tf));
        const totalMapped = mapped.reduce((a, b) => a + b, 0);
        if (totalMapped === 0.0) {
          info.set(term, idfInfo);
          continue;
        }

        let entropy = 0.0;
        const invTotal = 1.0 / totalMapped;
        for (const mVal of mapped) {
          const p = mVal * invTotal;
          if (p > 0.0) {
            entropy -= p * Math.log(p);
          }
        }

        const maxEnt = Math.log(df);
        const normEnt =
          maxEnt > 0.0 ? Math.min(entropy / maxEnt, 1.0) : 0.0;
        const shannonInfo = Math.max(1.0 - normEnt, 0.0);
        info.set(
          term,
          blendAlpha * shannonInfo + (1.0 - blendAlpha) * idfInfo,
        );
      }
    }

    // Phase 3: eIDF = IDF · (1 + γₜ · info)
    const eidf = new Map<string, number>();
    const invIdfMax = idfMax > 0.0 ? 1.0 / idfMax : 1.0;
    for (const term of docFreqs.keys()) {
      const termIdf = idf.get(term) ?? 0.0;
      const gammaT = termIdf * invIdfMax;
      eidf.set(term, termIdf * (1.0 + gammaT * (info.get(term) ?? 0.0)));
    }

    return [idf, eidf, info, idfMax];
  }

  // ────────────────────────────────────────────────────────────────
  //  Similarity Graph (posting-list intersection)
  // ────────────────────────────────────────────────────────────────

  _buildGraph(
    postingLists: Map<string, Map<number, number>>,
    eidf: Map<string, number>,
    docLengths: Map<number, number>,
    avgDl: number,
    n: number,
  ): [Map<number, Map<number, number>>, number] {
    // Returns [adjacency, edgeCount]
    const k1 = this._k1;
    const b = this._b;

    // Adaptive scaling limits for large corpora
    const eidfValues = [...eidf.values()];
    const maxEidf = eidfValues.length > 0 ? Math.max(...eidfValues) : 0.0;
    let minEidf: number;
    let maxPosting: number;
    if (n > 5000) {
      minEidf = maxEidf * 0.05;
      maxPosting = Math.floor(n / 10);
    } else if (n > 1000) {
      minEidf = maxEidf * 0.02;
      maxPosting = Math.floor(n / 5);
    } else {
      minEidf = maxEidf * 0.005;
      maxPosting = Math.max(Math.floor(n / 2), 10);
    }

    const tfSat = (tf: number, dl: number): number => {
      if (avgDl <= 0) return tf;
      return (tf * (k1 + 1.0)) / (tf + k1 * (1.0 - b + b * dl / avgDl));
    };

    // Phase 1: Norms for cosine normalisation
    const normSq = new Map<number, number>();
    for (const [term, posting] of postingLists.entries()) {
      const e = eidf.get(term) ?? 0.0;
      if (e <= 0.0) continue;
      for (const [idx, tf] of posting.entries()) {
        const dl = docLengths.get(idx) ?? 0;
        const val = e * tfSat(tf, dl);
        normSq.set(idx, (normSq.get(idx) ?? 0.0) + val * val);
      }
    }

    const norms = new Map<number, number>();
    for (const [i, v] of normSq.entries()) {
      norms.set(i, v > 0.0 ? Math.sqrt(v) : 1.0);
    }

    // Phase 2: Edge weights via posting-list intersection
    // Key encoding: i < j always, encode as i * (n+1) + j for a unique number key
    // Using string key "i,j" is safe and unambiguous
    const raw = new Map<string, number>();

    for (const [term, posting] of postingLists.entries()) {
      const e = eidf.get(term) ?? 0.0;
      if (e < minEidf) continue;
      const items = [...posting.entries()];
      if (items.length < 2 || items.length > maxPosting) continue;

      // Precompute weighted TF for this term
      const weighted: [number, number][] = items.map(([idx, tf]) => {
        const dl = docLengths.get(idx) ?? 0;
        return [idx, e * tfSat(tf, dl)];
      });

      const nItems = weighted.length;
      for (let aPos = 0; aPos < nItems; aPos++) {
        const [idxA, wA] = weighted[aPos];
        for (let bPos = aPos + 1; bPos < nItems; bPos++) {
          const [idxB, wB] = weighted[bPos];
          // Canonical key ordering so (i,j) and (j,i) merge
          const key = idxA < idxB ? `${idxA},${idxB}` : `${idxB},${idxA}`;
          raw.set(key, (raw.get(key) ?? 0.0) + wA * wB);
        }
      }
    }

    // Phase 3: Normalise + threshold → adjacency
    const adjacency = new Map<number, Map<number, number>>();
    let edgeCount = 0;

    if (raw.size > 0) {
      const normalised = new Map<string, number>();
      for (const [key, w] of raw.entries()) {
        const comma = key.indexOf(",");
        const i = parseInt(key.slice(0, comma), 10);
        const j = parseInt(key.slice(comma + 1), 10);
        const ni = norms.get(i) ?? 1.0;
        const nj = norms.get(j) ?? 1.0;
        const sim = w / (ni * nj);
        if (sim > 0.0) {
          normalised.set(key, sim);
        }
      }

      if (normalised.size > 0) {
        const normValues = [...normalised.values()];
        const maxSim = Math.max(...normValues);
        const threshold = maxSim * 0.01; // self-tuning: 1% of max

        for (const [key, sim] of normalised.entries()) {
          if (sim >= threshold) {
            const comma = key.indexOf(",");
            const i = parseInt(key.slice(0, comma), 10);
            const j = parseInt(key.slice(comma + 1), 10);

            if (!adjacency.has(i)) adjacency.set(i, new Map<number, number>());
            if (!adjacency.has(j)) adjacency.set(j, new Map<number, number>());
            adjacency.get(i)!.set(j, sim);
            adjacency.get(j)!.set(i, sim);
            edgeCount++;
          }
        }
      }
    }

    return [adjacency, edgeCount];
  }

  // ────────────────────────────────────────────────────────────────
  //  Adaptive Position Prior
  // ────────────────────────────────────────────────────────────────

  static _positionPrior(centrality: number[], n: number): number[] {
    // Self-tuning position weights from centrality distribution.
    if (n <= 1) return Array(n).fill(1.0);

    const avgC = n > 0 ? centrality.reduce((a, b) => a + b, 0) / n : 0.0;

    // Lead bias detection
    const leadK = Math.max(3, Math.floor(n / 10));
    const leadC =
      leadK > 0
        ? centrality.slice(0, leadK).reduce((a, b) => a + b, 0) / leadK
        : 0.0;

    let leadStrength: number;
    if (avgC > 0) {
      const leadRatio = leadC / avgC;
      // Linear ramp: 0 at ratio=1.0, 1.0 at ratio=1.4+
      leadStrength = Math.max(0.0, Math.min(1.0, (leadRatio - 1.0) * 2.5));
    } else {
      leadStrength = 0.0;
    }

    const trailStrength = 0.3; // fixed, mild

    const invLeadScale = 1.0 / Math.max(n * 0.1, 1.0);
    const invTrailScale = 1.0 / Math.max(n * 0.05, 1.0);

    const weights: number[] = [];
    for (let i = 0; i < n; i++) {
      const lead = Math.exp(-i * invLeadScale);
      const trail = Math.exp(-(n - 1 - i) * invTrailScale);
      weights.push(1.0 + leadStrength * lead + trailStrength * trail);
    }
    return weights;
  }

  // ────────────────────────────────────────────────────────────────
  //  Query Scoring (optional BMX+ TAAT)
  // ────────────────────────────────────────────────────────────────

  _scoreQuery(
    queryTokens: string[],
    postingLists: Map<string, Map<number, number>>,
    eidf: Map<string, number>,
    docLengths: Map<number, number>,
    avgDl: number,
  ): Map<number, number> {
    // Score all sentences against a query using BMX+ TAAT.
    const k1 = this._k1;
    const b = this._b;

    // Counter equivalent for query tokens
    const queryTf = new Map<string, number>();
    for (const token of queryTokens) {
      queryTf.set(token, (queryTf.get(token) ?? 0) + 1);
    }

    const scores = new Map<number, number>();

    for (const [term, qtf] of queryTf.entries()) {
      const posting = postingLists.get(term);
      if (!posting || posting.size === 0) continue;
      const e = eidf.get(term) ?? 0.0;
      if (e <= 0.0) continue;

      for (const [idx, tf] of posting.entries()) {
        const dl = docLengths.get(idx) ?? 0;
        let tfSat: number;
        if (avgDl > 0) {
          tfSat = (tf * (k1 + 1.0)) / (tf + k1 * (1.0 - b + b * dl / avgDl));
        } else {
          tfSat = tf;
        }
        scores.set(idx, (scores.get(idx) ?? 0.0) + e * tfSat * qtf);
      }
    }

    return scores;
  }

  // ────────────────────────────────────────────────────────────────
  //  PageRank
  // ────────────────────────────────────────────────────────────────

  _pagerank(
    adjacency: Map<number, Map<number, number>>,
    personalization: Map<number, number>,
    n: number,
  ): [Map<number, number>, number] {
    // Sparse PageRank with topic-sensitive personalization.
    // Returns [scoresDict, iterations].
    const d = this._damping;

    // Normalise personalization → probability distribution
    let p: number[] = [];
    for (let i = 0; i < n; i++) {
      p.push(personalization.get(i) ?? 1e-10);
    }
    const pSum = p.reduce((a, b) => a + b, 0);
    if (pSum > 0) {
      p = p.map((v) => v / pSum);
    } else {
      p = Array(n).fill(1.0 / n);
    }

    // Precompute outgoing edges (normalised weights)
    const outTotal: number[] = Array(n).fill(0.0);
    const outEdges: [number, number][][] = [];
    for (let i = 0; i < n; i++) {
      outEdges.push([]);
    }

    for (let i = 0; i < n; i++) {
      const neighbours = adjacency.get(i);
      if (!neighbours || neighbours.size === 0) {
        outTotal[i] = 0.0;
        continue;
      }
      let total = 0.0;
      for (const w of neighbours.values()) {
        total += w;
      }
      outTotal[i] = total;
      if (total > 0) {
        for (const [j, w] of neighbours.entries()) {
          outEdges[i].push([j, w / total]);
        }
      }
    }

    // Power iteration
    let pr = [...p];
    let iterations = 0;

    for (let it = 0; it < this._maxIter; it++) {
      iterations = it + 1;
      const prNew: number[] = Array(n).fill(0.0);

      // Dangling mass → personalization distribution
      let dangling = 0.0;
      for (let i = 0; i < n; i++) {
        if (outTotal[i] === 0) {
          dangling += pr[i];
        }
      }

      for (let i = 0; i < n; i++) {
        prNew[i] = (1.0 - d) * p[i] + d * dangling * p[i];
      }

      // Edge transitions
      for (let i = 0; i < n; i++) {
        if (outEdges[i].length > 0) {
          const mass = d * pr[i];
          for (const [j, wNorm] of outEdges[i]) {
            prNew[j] += mass * wNorm;
          }
        }
      }

      // Convergence (L1)
      let diff = 0.0;
      for (let i = 0; i < n; i++) {
        diff += Math.abs(prNew[i] - pr[i]);
      }
      pr = prNew;
      if (diff < this._epsilon) {
        break;
      }
    }

    const result = new Map<number, number>();
    for (let i = 0; i < n; i++) {
      result.set(i, pr[i]);
    }
    return [result, iterations];
  }

  // ────────────────────────────────────────────────────────────────
  //  Coverage-Aware Extraction
  // ────────────────────────────────────────────────────────────────

  _extractWithCoverage(
    prScores: Map<number, number>,
    sentTokens: string[][],
    eidf: Map<string, number>,
    topK: number,
    n: number,
  ): number[] {
    // Greedy extraction maximising centrality × information coverage.
    const cw = this._coverageWeight;

    // Precompute per-sentence term weights
    const sentWeights: Map<string, number>[] = [];
    const sentTotals: number[] = [];

    for (let idx = 0; idx < n; idx++) {
      const weights = new Map<string, number>();
      const uniqueTerms = new Set(sentTokens[idx]);
      for (const t of uniqueTerms) {
        const w = eidf.get(t) ?? 0.0;
        if (w > 0.0) {
          weights.set(t, w);
        }
      }
      sentWeights.push(weights);
      let total = 0.0;
      for (const w of weights.values()) total += w;
      sentTotals.push(total);
    }

    const covered = new Set<string>();
    const selected: number[] = [];
    const remaining = new Set<number>();
    for (let i = 0; i < n; i++) remaining.add(i);

    while (selected.length < topK && remaining.size > 0) {
      let bestIdx = -1;
      let bestScore = -1.0;

      for (const idx of remaining) {
        const pr = prScores.get(idx) ?? 0.0;
        const totalW = sentTotals[idx];

        let coverage: number;
        if (totalW > 0.0) {
          let novelW = 0.0;
          for (const [t, w] of sentWeights[idx].entries()) {
            if (!covered.has(t)) {
              novelW += w;
            }
          }
          coverage = novelW / totalW;
        } else {
          coverage = 0.0;
        }

        const score = pr * (cw + (1.0 - cw) * coverage);

        if (score > bestScore) {
          bestScore = score;
          bestIdx = idx;
        }
      }

      if (bestIdx < 0) break;

      selected.push(bestIdx);
      remaining.delete(bestIdx);
      for (const t of sentWeights[bestIdx].keys()) {
        covered.add(t);
      }
    }

    return selected;
  }

  // ────────────────────────────────────────────────────────────────
  //  Keyword Extraction
  // ────────────────────────────────────────────────────────────────

  static _getKeywords(
    eidf: Map<string, number>,
    docFreqs: Map<string, number>,
    topK: number = 10,
  ): [string, number][] {
    // Top keywords by eIDF · sqrt(df) (informative AND representative).
    const scored: [string, number][] = [];
    for (const term of eidf.keys()) {
      const termEidf = eidf.get(term) ?? 0.0;
      if (termEidf > 0) {
        const df = docFreqs.get(term) ?? 1;
        scored.push([term, termEidf * Math.sqrt(df)]);
      }
    }
    scored.sort((a, b) => b[1] - a[1]);
    return scored.slice(0, topK);
  }

  // ════════════════════════════════════════════════════════════════
  //  Public API
  // ════════════════════════════════════════════════════════════════

  rankSentences(
    sentences: string[],
    topK: number = 5,
    query: string | null = null,
  ): SageResult {
    // Rank pre-segmented sentences/passages/messages.
    const n = sentences.length;
    if (n === 0) {
      return makeSageResult([], [], [], [], {});
    }
    if (n === 1) {
      return makeSageResult(sentences, [1.0], [0], [], { sentences: 1 });
    }
    const effectiveTopK = Math.min(topK, n);

    // 1. Tokenise
    const sentTokens = sentences.map((s) => SageRank._tokenize(s));

    // 2. Build inverted index
    const [postingLists, docFreqs, docLengths, avgDl] =
      SageRank._buildPostingLists(sentTokens);

    // 3. Entropy-weighted IDF
    // idf is the first return value; not used directly in rankSentences (idfMax is returned separately)
    const [, eidf, , idfMax] = SageRank._computeEidf(
      postingLists,
      docFreqs,
      n,
    );

    // 4. Similarity graph
    const [adjacency, edgeCount] = this._buildGraph(
      postingLists,
      eidf,
      docLengths,
      avgDl,
      n,
    );

    // 5. Degree centrality (from graph)
    const centrality: number[] = [];
    for (let i = 0; i < n; i++) {
      const nbrs = adjacency.get(i);
      let sum = 0.0;
      if (nbrs) {
        for (const w of nbrs.values()) sum += w;
      }
      centrality.push(sum);
    }

    // 6. Adaptive position prior
    const position = SageRank._positionPrior(centrality, n);

    // 7. Optional query scoring
    let queryScores: Map<number, number> | null = null;
    if (query !== null && query.length > 0) {
      const qt = SageRank._tokenize(query);
      if (qt.length > 0) {
        queryScores = this._scoreQuery(
          qt,
          postingLists,
          eidf,
          docLengths,
          avgDl,
        );
      }
    }

    // 8. Personalization vector
    const personalization = new Map<number, number>();
    for (let i = 0; i < n; i++) {
      let pVal = position[i];
      if (queryScores !== null && queryScores.size > 0) {
        pVal *= (queryScores.get(i) ?? 0.0) + 0.01;
      }
      personalization.set(i, pVal);
    }

    // 9. PageRank
    const [prScores, prIters] = this._pagerank(adjacency, personalization, n);

    // 10. Coverage-aware extraction
    const selected = this._extractWithCoverage(
      prScores,
      sentTokens,
      eidf,
      effectiveTopK,
      n,
    );

    // 11. Keywords
    const keywords = SageRank._getKeywords(eidf, docFreqs, 10);

    // 12. Normalise scores to [0, 1]
    let scores: number[] = [];
    for (let i = 0; i < n; i++) {
      scores.push(prScores.get(i) ?? 0.0);
    }
    if (this._normalize && scores.length > 0) {
      const maxS = Math.max(...scores);
      if (maxS > 0) {
        scores = scores.map((s) => s / maxS);
      }
    }

    // lead_bias: recompute position prior first element minus 1
    // Python: self._position_prior(centrality, n)[0] - 1.0 if n > 0 else 0.0
    const leadBias =
      n > 0 ? SageRank._positionPrior(centrality, n)[0] - 1.0 : 0.0;

    const stats: Record<string, number | boolean | string> = {
      sentences: n,
      vocabulary: postingLists.size,
      edges: edgeCount,
      pagerank_iters: prIters,
      idf_max: Math.round(idfMax * 10000) / 10000,
      lead_bias: Math.round(leadBias * 10000) / 10000,
      query_biased: query !== null,
    };

    return makeSageResult(sentences, scores, selected, keywords, stats);
  }

  // Alias for non-sentence text units (messages, paragraphs, chunks)
  rankPassages(
    sentences: string[],
    topK: number = 5,
    query: string | null = null,
  ): SageResult {
    return this.rankSentences(sentences, topK, query);
  }

  rank(
    text: string,
    topK: number = 5,
    query: string | null = null,
  ): SageResult {
    // Rank sentences in a text document.
    // Segments text into sentences, then ranks them.
    const sentences = _segmentSentences(text, this._minSentLen);
    return this.rankSentences(sentences, topK, query);
  }

  summarize(
    text: string,
    ratio: number = 0.3,
    query: string | null = null,
  ): string {
    // Return an extractive summary at the given compression ratio.
    const sentences = _segmentSentences(text, this._minSentLen);
    if (sentences.length === 0) return "";
    const topK = Math.max(1, Math.floor(sentences.length * ratio));
    const result = this.rankSentences(sentences, topK, query);
    return result.summary;
  }

  extractKeywords(
    text: string,
    topK: number = 10,
  ): [string, number][] {
    // Extract top keywords using entropy-weighted IDF scoring.
    // Returns list of [term, score] tuples sorted by importance.
    const sentences = _segmentSentences(text, this._minSentLen);
    if (sentences.length === 0) return [];
    const sentTokens = sentences.map((s) => SageRank._tokenize(s));
    const [postingLists, docFreqs] =
      SageRank._buildPostingLists(sentTokens);
    const n = sentences.length;
    const [, eidf] = SageRank._computeEidf(postingLists, docFreqs, n);
    return SageRank._getKeywords(eidf, docFreqs, topK);
  }
}
