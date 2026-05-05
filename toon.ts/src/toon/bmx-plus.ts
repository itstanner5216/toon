// Ported from: toon/engines/bmx_plus.py
// Python line count: 482
// Port verification:
//   - _fastSigmoid: Padé rational approximation, identical clamp at ±8.0, same formula
//   - _tokenize: _WORD_RE = /\b\w+\b/g applied to text.toLowerCase(), same as Python _WORD_RE.findall(text.lower())
//   - buildIndex: resets state when chunks provided, builds posting lists, doc_freqs, term_total_freqs, computes entropies then parameters
//   - search: TAAT accumulation, BM25 TF saturation (k1=1.5, b=0.75), entropy-aware IDF, tanh coverage bonus, Soft-AND final score, normalize_scores path, top_k slice
//   - updateIndex: lazy entropy (dirty set), removes old doc first if chunk_id exists
//   - removeFromIndex: decrements doc_freqs, prunes zero-freq terms from all caches, updates avg_doc_length
//   - _computeParameters: alpha=max(0.5,min(1.5,avgdl/100)), beta=1/log(1+N) or 0.01, idf_max from idf_cache
//   - _computeTermEntropies: df<2 shortcut, empty posting shortcut, IDF-info, TF variance, blend_alpha, Shannon entropy via sigmoid-mapped dist, blended info
//   - _flushDirtyEntropies: intersection of dirty set and query terms only
//   - documentCount/vocabularySize getters, getStats rounds to 2/4 decimal places matching Python round()
//   - All Python defaultdict(float) accumulators use Map<string, number> with ?? 0 default
//   - Math.log used for natural log (matching Python math.log)
//   - JS /g regex is stateful — _WORD_RE recreated per call via lastIndex reset (see _tokenize)

/**
 * BMX+ — Entropy-Weighted Lexical Search via Term-At-A-Time Evaluation.
 *
 * Successor to BMX (arXiv:2408.06643). Builds on BM25's proven TF saturation
 * curve with three innovations:
 *   1. Term-adaptive entropy-aware IDF (γt = IDFt / IDF_max)
 *   2. Variance-blended informativeness (Shannon ↔ IDF, smooth transition)
 *   3. tanh Soft-AND coverage bonus (RankEvolve-inspired, anti-dominance)
 *
 * All executed within a TAAT posting-list architecture for 3.4–30× speedup.
 */

// Module-level word regex — recreated (via exec loop) or used with matchAll
// Python: _WORD_RE = re.compile(r"\b\w+\b")
const _WORD_RE = /\b\w+\b/g;

/**
 * Padé rational approximation to σ(x) = 1/(1+e^-x). |error| < 0.01.
 */
function _fastSigmoid(x: number): number {
  if (x >= 8.0) return 1.0;
  if (x <= -8.0) return 0.0;
  const x2 = x * x;
  const x3 = x2 * x;
  return (x3 + 6.0 * x + 12.0) / (x3 + 12.0 * x + 48.0);
}

interface Chunk {
  chunk_id: string;
  text: string;
}

export class BMXPlusIndex {
  // ── Public configuration ──
  readonly alphaOverride: number | null;
  readonly betaOverride: number | null;
  readonly normalizeScores: boolean;

  // ── Document storage ──
  private _documents: Map<string, string[]>;
  private _docLengths: Map<string, number>;
  private _avgDocLength: number;
  private _totalDocs: number;
  private _isBuilt: boolean;

  // ── Posting lists: term → {chunk_id: tf} ──
  private _postingLists: Map<string, Map<string, number>>;

  // ── Frequencies and IDF ──
  private _docFreqs: Map<string, number>;
  private _idfCache: Map<string, number>;

  // ── Entropy state ──
  private _termTotalFreqs: Map<string, number>;
  private _termEntropy: Map<string, number>;
  private _termInfo: Map<string, number>;
  private _dirtyTerms: Set<string>;

  // ── Self-tuning parameters ──
  private _alpha: number;
  private _beta: number;
  private _idfMax: number;

  constructor(
    alphaOverride: number | null = null,
    betaOverride: number | null = null,
    normalizeScores: boolean = false
  ) {
    this.alphaOverride = alphaOverride;
    this.betaOverride = betaOverride;
    this.normalizeScores = normalizeScores;

    this._documents = new Map();
    this._docLengths = new Map();
    this._avgDocLength = 0.0;
    this._totalDocs = 0;
    this._isBuilt = false;

    this._postingLists = new Map();
    this._docFreqs = new Map();
    this._idfCache = new Map();

    this._termTotalFreqs = new Map();
    this._termEntropy = new Map();
    this._termInfo = new Map();
    this._dirtyTerms = new Set();

    this._alpha = 1.0;
    this._beta = 0.01;
    this._idfMax = 1.0;
  }

  // ════════════════════════════════════════════════════════════════════
  //  Tokenisation
  // ════════════════════════════════════════════════════════════════════

  /**
   * Python: _WORD_RE.findall(text.lower())
   * JS /g regex is stateful — use String.prototype.match which returns all
   * matches without the statefulness issue of repeated .test()/.exec() calls.
   */
  static _tokenize(text: string): string[] {
    // String.match with /g returns all matches as string[] or null
    // Equivalent to Python re.compile(r"\b\w+\b").findall(text.lower())
    const lower = text.toLowerCase();
    const matches = lower.match(_WORD_RE);
    return matches !== null ? matches : [];
  }

  // ════════════════════════════════════════════════════════════════════
  //  Self-Tuning Parameters
  // ════════════════════════════════════════════════════════════════════

  private _computeParameters(): void {
    const N = this._totalDocs;
    const avgdl = this._avgDocLength;

    this._alpha =
      this.alphaOverride !== null
        ? this.alphaOverride
        : Math.max(0.5, Math.min(1.5, avgdl / 100.0));

    this._beta =
      this.betaOverride !== null
        ? this.betaOverride
        : N > 0
        ? 1.0 / Math.log(1.0 + N)
        : 0.01;

    // Compute IDF_max for term-adaptive scaling: γt = IDFt / IDF_max
    // Rare terms get full entropy weight, common terms get none,
    // independent of corpus size.
    if (this._idfCache.size > 0) {
      let max = -Infinity;
      for (const v of this._idfCache.values()) {
        if (v > max) max = v;
      }
      this._idfMax = max;
    } else {
      this._idfMax = 1.0;
    }
  }

  // ════════════════════════════════════════════════════════════════════
  //  Entropy Computation
  // ════════════════════════════════════════════════════════════════════

  /** Lucene-variant BM25 IDF (always non-negative). */
  private _computeIdf(term: string): number {
    const df = this._docFreqs.get(term) ?? 0;
    const N = this._totalDocs;
    if (df > 0 && N > 0) {
      return Math.log((N - df + 0.5) / (df + 0.5) + 1.0);
    }
    return 0.0;
  }

  /**
   * Compute term informativeness via smoothly blended entropy.
   *
   * Blends Shannon entropy (when TFs vary across documents) with
   * IDF-derived informativeness (1 - df/N) using TF variance as
   * the interpolation weight. This avoids a hard discontinuity
   * when a single document with tf=2 flips the computation regime.
   */
  private _computeTermEntropies(terms?: Set<string>): void {
    const target: Set<string> =
      terms !== undefined ? terms : new Set(this._docFreqs.keys());
    const N = this._totalDocs;

    for (const term of target) {
      const df = this._docFreqs.get(term) ?? 0;
      this._idfCache.set(term, this._computeIdf(term));

      if (df < 2) {
        this._termEntropy.set(term, 0.0);
        this._termInfo.set(term, 1.0);
        continue;
      }

      const posting = this._postingLists.get(term);
      if (!posting || posting.size === 0) {
        this._termEntropy.set(term, 1.0);
        this._termInfo.set(term, 0.0);
        continue;
      }

      // IDF-derived informativeness (always available)
      const idfInfo = N > 0 ? 1.0 - df / N : 0.0;

      // Compute TF variance to determine blend weight
      const tfVals: number[] = [...posting.values()];
      const nPost = tfVals.length;
      const meanTf = tfVals.reduce((a, b) => a + b, 0) / nPost;
      const variance =
        tfVals.reduce((acc, v) => acc + (v - meanTf) ** 2, 0) / nPost;

      // Smooth blend: α→0 when uniform, α→1 when varied
      // epsilon=1.0 gives a gentle sigmoid-like transition
      const blendAlpha = variance / (variance + 1.0);

      if (blendAlpha < 0.001) {
        // Essentially uniform — pure IDF-derived info
        this._termInfo.set(term, idfInfo);
        this._termEntropy.set(term, 1.0 - idfInfo);
      } else {
        // Compute Shannon entropy of sigmoid-mapped distribution
        const mapped: number[] = tfVals.map((tf) => _fastSigmoid(tf));
        const totalMapped = mapped.reduce((a, b) => a + b, 0);

        if (totalMapped === 0.0) {
          this._termInfo.set(term, idfInfo);
          this._termEntropy.set(term, 1.0 - idfInfo);
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
        const normEnt = maxEnt > 0.0 ? Math.min(entropy / maxEnt, 1.0) : 0.0;
        const shannonInfo = Math.max(1.0 - normEnt, 0.0);

        // Blend: Shannon when TFs vary, IDF-derived when uniform
        const blended = blendAlpha * shannonInfo + (1.0 - blendAlpha) * idfInfo;
        this._termInfo.set(term, blended);
        this._termEntropy.set(term, 1.0 - blended);
      }
    }
  }

  /** Lazily recompute entropies only for dirty terms in the query. */
  private _flushDirtyEntropies(queryTerms: Set<string>): void {
    if (this._dirtyTerms.size === 0) return;
    const toFlush: Set<string> = new Set();
    for (const t of this._dirtyTerms) {
      if (queryTerms.has(t)) toFlush.add(t);
    }
    if (toFlush.size > 0) {
      this._computeTermEntropies(toFlush);
      for (const t of toFlush) {
        this._dirtyTerms.delete(t);
      }
    }
  }

  // ════════════════════════════════════════════════════════════════════
  //  Build Index
  // ════════════════════════════════════════════════════════════════════

  /** Clear all index state. */
  _reset(): void {
    this._documents.clear();
    this._docLengths.clear();
    this._postingLists.clear();
    this._docFreqs.clear();
    this._idfCache.clear();
    this._termTotalFreqs.clear();
    this._termEntropy.clear();
    this._termInfo.clear();
    this._dirtyTerms.clear();
    this._avgDocLength = 0.0;
    this._totalDocs = 0;
    this._isBuilt = false;
  }

  /** Build from [{chunk_id: string, text: string}, ...]. */
  buildIndex(chunks?: Chunk[]): void {
    if (chunks && chunks.length > 0) {
      this._reset();
      for (const chunk of chunks) {
        const tokens = BMXPlusIndex._tokenize(chunk.text);
        const cid = chunk.chunk_id;
        this._documents.set(cid, tokens);
        this._docLengths.set(cid, tokens.length);
      }
    }

    const N = this._documents.size;
    if (N === 0) {
      this._isBuilt = true;
      return;
    }

    this._totalDocs = N;
    let totalLen = 0;
    for (const l of this._docLengths.values()) totalLen += l;
    this._avgDocLength = totalLen / N;

    // Build posting lists, document frequencies, total term frequencies
    for (const [cid, tokens] of this._documents.entries()) {
      // Counter equivalent
      const termCounts = new Map<string, number>();
      for (const token of tokens) {
        termCounts.set(token, (termCounts.get(token) ?? 0) + 1);
      }

      for (const [term, count] of termCounts.entries()) {
        if (!this._postingLists.has(term)) {
          this._postingLists.set(term, new Map());
        }
        this._postingLists.get(term)!.set(cid, count);

        this._docFreqs.set(term, (this._docFreqs.get(term) ?? 0) + 1);
        this._termTotalFreqs.set(
          term,
          (this._termTotalFreqs.get(term) ?? 0) + count
        );
      }
    }

    this._computeTermEntropies(); // also populates _idfCache
    this._computeParameters();    // uses _idfCache for _idfMax
    this._isBuilt = true;
  }

  // ════════════════════════════════════════════════════════════════════
  //  TAAT Search
  // ════════════════════════════════════════════════════════════════════

  /**
   * Search via Term-At-A-Time posting list traversal.
   *
   * Uses BM25's proven TF saturation curve inside the TAAT architecture,
   * with term-adaptive entropy-aware IDF and tanh Soft-AND coverage bonus.
   */
  search(query: string, topK: number = 10): Array<[string, number]> {
    if (!this._isBuilt || this._documents.size === 0) return [];

    const queryTokens = BMXPlusIndex._tokenize(query);
    if (queryTokens.length === 0) return [];

    // Counter equivalent for query tokens
    const queryTf = new Map<string, number>();
    for (const token of queryTokens) {
      queryTf.set(token, (queryTf.get(token) ?? 0) + 1);
    }
    const uniqueQuery = new Set(queryTokens);
    const m = uniqueQuery.size;

    this._flushDirtyEntropies(uniqueQuery);

    // Cache locals for the hot loop
    const k1 = 1.5;
    const b = 0.75;
    const idfMax = this._idfMax;
    const avgdl = this._avgDocLength;
    const invIdfMax = idfMax > 0.0 ? 1.0 / idfMax : 1.0;
    const docLengths = this._docLengths;
    const postingLists = this._postingLists;
    const idfCache = this._idfCache;
    const termInfo = this._termInfo;
    const invM = 1.0 / m;

    // Per-query informativeness weights
    const infoWeights = new Map<string, number>();
    let infoTotal = 0.0;
    for (const t of uniqueQuery) {
      const v = termInfo.get(t) ?? 0.0;
      infoWeights.set(t, v);
      infoTotal += v;
    }
    // infoTotal is accumulated but not used beyond this point (matches Python)

    // TAAT accumulation — Python uses defaultdict(float)
    const scores = new Map<string, number>();
    const infoAccum = new Map<string, number>();
    const tanhCoverage = new Map<string, number>();

    for (const [term, qTf] of queryTf.entries()) {
      const posting = postingLists.get(term);
      if (!posting || posting.size === 0) continue;

      const idf = idfCache.get(term) ?? 0.0;
      const infoQi = infoWeights.get(term) ?? 0.0;

      // Term-adaptive γt: rare terms get full entropy weight,
      // common terms get none — corpus-size independent
      const gammaT = idf * invIdfMax;
      const infoXQ = gammaT * infoQi * qTf;

      if (idf <= 0.0) {
        for (const cid of posting.keys()) {
          tanhCoverage.set(cid, (tanhCoverage.get(cid) ?? 0.0) + 1.0);
          infoAccum.set(cid, (infoAccum.get(cid) ?? 0.0) + infoXQ);
        }
        continue;
      }

      // Entropy-aware IDF with term-adaptive scaling
      const eidf = idf * (1.0 + gammaT * infoQi);

      for (const [cid, tf] of posting.entries()) {
        // BM25 TF saturation — proven, well-calibrated
        const dl = docLengths.get(cid)!;
        const tfSat = (tf * (k1 + 1.0)) / (tf + k1 * (1.0 - b + b * dl / avgdl));

        const termScore = eidf * tfSat * qTf;
        scores.set(cid, (scores.get(cid) ?? 0.0) + termScore);
        infoAccum.set(cid, (infoAccum.get(cid) ?? 0.0) + infoXQ);
        tanhCoverage.set(cid, (tanhCoverage.get(cid) ?? 0.0) + Math.tanh(termScore));
      }
    }

    if (scores.size === 0) return [];

    // Final: Soft-AND coverage bonus
    const finalScores: Array<[string, number]> = [];
    for (const [cid, base] of scores.entries()) {
      const softAnd = (tanhCoverage.get(cid) ?? 0.0) * invM;
      finalScores.push([cid, base + softAnd * (infoAccum.get(cid) ?? 0.0)]);
    }

    // Sort descending by score
    finalScores.sort((a, b_) => b_[1] - a[1]);

    if (this.normalizeScores && finalScores.length > 0) {
      const maxScore = finalScores[0][1];
      if (maxScore > 0.0) {
        for (let i = 0; i < finalScores.length; i++) {
          finalScores[i] = [finalScores[i][0], finalScores[i][1] / maxScore];
        }
      }
    }

    return finalScores.slice(0, topK);
  }

  // ════════════════════════════════════════════════════════════════════
  //  Incremental Updates
  // ════════════════════════════════════════════════════════════════════

  /** Add or replace a document (lazy entropy recomputation). */
  updateIndex(chunkId: string, text: string): void {
    if (this._documents.has(chunkId)) {
      this.removeFromIndex(chunkId);
    }

    const tokens = BMXPlusIndex._tokenize(text);
    this._documents.set(chunkId, tokens);
    this._docLengths.set(chunkId, tokens.length);

    // Counter equivalent
    const termCounts = new Map<string, number>();
    for (const token of tokens) {
      termCounts.set(token, (termCounts.get(token) ?? 0) + 1);
    }
    const affected: Set<string> = new Set();

    for (const [term, count] of termCounts.entries()) {
      if (!this._postingLists.has(term)) {
        this._postingLists.set(term, new Map());
      }
      this._postingLists.get(term)!.set(chunkId, count);

      this._docFreqs.set(term, (this._docFreqs.get(term) ?? 0) + 1);
      this._termTotalFreqs.set(
        term,
        (this._termTotalFreqs.get(term) ?? 0) + count
      );
      affected.add(term);
    }

    this._totalDocs = this._documents.size;
    let totalLen = 0;
    for (const l of this._docLengths.values()) totalLen += l;
    this._avgDocLength = totalLen / this._totalDocs;
    this._computeParameters();
    for (const t of affected) this._dirtyTerms.add(t);
  }

  /** Remove a document (lazy entropy recomputation). */
  removeFromIndex(chunkId: string): void {
    if (!this._documents.has(chunkId)) return;

    const tokens = this._documents.get(chunkId)!;
    // Counter equivalent
    const termCounts = new Map<string, number>();
    for (const token of tokens) {
      termCounts.set(token, (termCounts.get(token) ?? 0) + 1);
    }
    const affected: Set<string> = new Set();

    for (const [term, count] of termCounts.entries()) {
      const posting = this._postingLists.get(term);
      if (posting && posting.has(chunkId)) {
        posting.delete(chunkId);
        if (posting.size === 0) {
          this._postingLists.delete(term);
        }
      }

      const newDf = Math.max((this._docFreqs.get(term) ?? 1) - 1, 0);
      this._docFreqs.set(term, newDf);
      if (newDf === 0) {
        this._docFreqs.delete(term);
        this._idfCache.delete(term);
        this._termEntropy.delete(term);
        this._termInfo.delete(term);
      }

      const newTtf = Math.max(
        (this._termTotalFreqs.get(term) ?? count) - count,
        0
      );
      this._termTotalFreqs.set(term, newTtf);
      if (newTtf === 0) {
        this._termTotalFreqs.delete(term);
      }

      affected.add(term);
    }

    this._documents.delete(chunkId);
    this._docLengths.delete(chunkId);

    this._totalDocs = this._documents.size;
    if (this._totalDocs > 0) {
      let totalLen = 0;
      for (const l of this._docLengths.values()) totalLen += l;
      this._avgDocLength = totalLen / this._totalDocs;
    } else {
      this._avgDocLength = 0.0;
    }
    this._computeParameters();
    for (const t of affected) this._dirtyTerms.add(t);
  }

  // ════════════════════════════════════════════════════════════════════
  //  Properties
  // ════════════════════════════════════════════════════════════════════

  get documentCount(): number {
    return this._totalDocs;
  }

  get vocabularySize(): number {
    return this._postingLists.size;
  }

  getStats(): Record<string, unknown> {
    return {
      total_docs: this._totalDocs,
      vocabulary_size: this.vocabularySize,
      avg_doc_length: Math.round(this._avgDocLength * 100) / 100,
      alpha: Math.round(this._alpha * 10000) / 10000,
      beta: Math.round(this._beta * 10000) / 10000,
      idf_max: Math.round(this._idfMax * 10000) / 10000,
    };
  }
}
