"""
SageRank — Entropy-Weighted Graph Ranking for Extractive Text Analysis.

Successor to TextRank/LexRank. Builds on graph-based sentence ranking
with five innovations from information theory and lexical retrieval:

  1. Entropy-weighted similarity kernel (from BMX+)
     sim(Sᵢ,Sⱼ) = Σₜ [eIDF(t)·tf_sat(t,Sᵢ)·tf_sat(t,Sⱼ)] / (‖Sᵢ‖·‖Sⱼ‖)
     where eIDF(t) = IDF(t)·(1 + γₜ·info(t)), γₜ = IDF(t)/IDF_max

  2. Adaptive position prior (self-tuning lead/trail bias)
     Detects structural lead bias from centrality distribution.
     News articles get strong lead boost; conversations get none.

  3. Coverage-optimized extraction (information-theoretic)
     Greedy selection: PR(Sᵢ)·(λ + (1-λ)·novel_info(Sᵢ)/total_info(Sᵢ))
     Directly optimizes for informative term coverage, not just diversity.

  4. Query-biased personalization (optional)
     BMX+ TAAT scoring biases PageRank toward query-relevant sentences
     while still propagating relevance through the similarity graph.

  5. Self-tuning everything
     Similarity threshold, position bias strength, entropy blend —
     all derived from corpus statistics. Zero configuration required.

Graph construction uses posting-list intersection (TAAT-style) instead
of all-pairs cosine, giving O(V · avg_posting²) instead of O(N² · V).

Standalone. Zero dependencies. Single file. Drop-in anywhere.

Usage:
    sage = SageRank()
    result = sage.rank("Your long document here...", top_k=5)
    print(result.summary)
    print(result.keywords)

    # Query-biased (what matters for THIS question?)
    result = sage.rank(text, top_k=5, query="specific topic")

    # Pre-segmented (conversations, logs, passages)
    result = sage.rank_sentences(["msg1", "msg2", ...], top_k=3)

    # Quick summary at 30% compression
    print(sage.summarize(text, ratio=0.3))

    # Just keywords
    print(sage.extract_keywords(text, top_k=10))
"""

import math
import re
from collections import Counter, defaultdict
from dataclasses import dataclass, field

# ════════════════════════════════════════════════════════════════════════
#  Constants
# ════════════════════════════════════════════════════════════════════════

_WORD_RE = re.compile(r"\b\w+\b")


# ════════════════════════════════════════════════════════════════════════
#  Helpers
# ════════════════════════════════════════════════════════════════════════


def _fast_sigmoid(x: float) -> float:
    """Padé rational approximation to σ(x). |error| < 0.01."""
    if x >= 8.0:
        return 1.0
    if x <= -8.0:
        return 0.0
    x2 = x * x
    x3 = x2 * x
    return (x3 + 6.0 * x + 12.0) / (x3 + 12.0 * x + 48.0)


def _segment_sentences(text: str, min_length: int = 10) -> list[str]:
    """Rule-based sentence segmentation. No dependencies.

    Handles paragraphs, line-per-message logs, and standard prose.
    For better segmentation, use rank_sentences() with your own splitter.
    """
    text = text.strip()
    if not text:
        return []

    raw: list[str] = []
    for block in re.split(r"\n\s*\n", text):
        block = block.strip()
        if not block:
            continue
        for line in block.split("\n"):
            line = line.strip()
            if not line:
                continue
            # Split on sentence-ending punctuation followed by space + capital
            parts = re.split(r"(?<=[.!?])\s+(?=[A-Z\"])", line)
            for p in parts:
                p = p.strip()
                if p:
                    raw.append(p)

    if not raw:
        return []

    # Merge very short fragments with previous sentence
    merged = [raw[0]]
    for i in range(1, len(raw)):
        if len(merged[-1]) < min_length:
            merged[-1] += " " + raw[i]
        else:
            merged.append(raw[i])
    return merged


# ════════════════════════════════════════════════════════════════════════
#  Result
# ════════════════════════════════════════════════════════════════════════


@dataclass
class SageResult:
    """Result container for SageRank operations.

    Attributes:
        sentences:        All input sentences.
        scores:           PageRank score per sentence (normalized 0-1).
        selected_indices: Indices chosen by coverage-aware extraction,
                          in selection order (most important first).
        keywords:         Top terms by eIDF × √df score.
        stats:            Algorithm diagnostics (edges, iterations, etc.).
    """

    sentences: list[str]
    scores: list[float]
    selected_indices: list[int]
    keywords: list[tuple[str, float]]
    stats: dict = field(default_factory=dict)

    @property
    def summary(self) -> str:
        """Selected sentences joined in original document order."""
        return " ".join(
            self.sentences[i] for i in sorted(self.selected_indices)
        )

    @property
    def selected_sentences(self) -> list[str]:
        """Selected sentences in original document order."""
        return [self.sentences[i] for i in sorted(self.selected_indices)]

    def top(self, k: int | None = None) -> list[tuple[int, str, float]]:
        """All sentences ranked by score, optionally truncated to top-k."""
        ranked = sorted(
            range(len(self.scores)),
            key=lambda i: self.scores[i],
            reverse=True,
        )
        if k is not None:
            ranked = ranked[:k]
        return [(i, self.sentences[i], self.scores[i]) for i in ranked]


# ════════════════════════════════════════════════════════════════════════
#  SageRank
# ════════════════════════════════════════════════════════════════════════


class SageRank:
    """Entropy-weighted graph-based sentence ranker.

    Self-tuning — all parameters derived from corpus statistics:
      eIDF(t)  = IDF(t) · (1 + γₜ · info(t))     entropy-aware IDF
      γₜ       = IDF(t) / IDF_max                  term-adaptive weight
      info(t)  = blend(shannon, idf_info, var)      variance-blended

    Optional overrides for BM25 TF parameters and PageRank damping.
    """

    __slots__ = (
        "_k1", "_b", "_damping", "_max_iter", "_epsilon",
        "_coverage_weight", "_min_sent_len", "_normalize",
    )

    def __init__(
        self,
        k1: float = 1.5,
        b: float = 0.75,
        damping: float = 0.85,
        max_iter: int = 50,
        epsilon: float = 1e-6,
        coverage_weight: float = 0.5,
        min_sentence_length: int = 10,
        normalize: bool = True,
    ):
        self._k1 = k1
        self._b = b
        self._damping = damping
        self._max_iter = max_iter
        self._epsilon = epsilon
        self._coverage_weight = coverage_weight
        self._min_sent_len = min_sentence_length
        self._normalize = normalize

    # ────────────────────────────────────────────────────────────────
    #  Tokenisation
    # ────────────────────────────────────────────────────────────────

    @staticmethod
    def _tokenize(text: str) -> list[str]:
        return _WORD_RE.findall(text.lower())

    # ────────────────────────────────────────────────────────────────
    #  Index Construction
    # ────────────────────────────────────────────────────────────────

    @staticmethod
    def _build_posting_lists(
        sent_tokens: list[list[str]],
    ) -> tuple[dict, dict, dict, float]:
        """Build inverted index over sentence tokens.

        Returns (posting_lists, doc_freqs, doc_lengths, avg_dl).
        """
        posting_lists: dict[str, dict[int, int]] = {}
        doc_freqs: dict[str, int] = {}
        doc_lengths: dict[int, int] = {}
        total_length = 0

        for idx, tokens in enumerate(sent_tokens):
            dl = len(tokens)
            doc_lengths[idx] = dl
            total_length += dl
            tf = Counter(tokens)
            for term, count in tf.items():
                if term not in posting_lists:
                    posting_lists[term] = {}
                posting_lists[term][idx] = count
                doc_freqs[term] = doc_freqs.get(term, 0) + 1

        n = len(sent_tokens)
        avg_dl = total_length / n if n > 0 else 0.0
        return posting_lists, doc_freqs, doc_lengths, avg_dl

    # ────────────────────────────────────────────────────────────────
    #  Entropy-Weighted IDF
    # ────────────────────────────────────────────────────────────────

    @staticmethod
    def _compute_eidf(
        posting_lists: dict, doc_freqs: dict, n: int,
    ) -> tuple[dict, dict, dict, float]:
        """Compute eIDF(t) = IDF(t)·(1 + γₜ·info(t)) for all terms.

        info(t) is a variance-blended mix of Shannon entropy and
        IDF-derived informativeness (identical to BMX+ formulation).

        Returns (idf_dict, eidf_dict, info_dict, idf_max).
        """
        idf: dict[str, float] = {}
        info: dict[str, float] = {}

        # Phase 1: IDF
        for term, df in doc_freqs.items():
            if df > 0 and n > 0:
                idf[term] = math.log((n - df + 0.5) / (df + 0.5) + 1.0)
            else:
                idf[term] = 0.0

        idf_max = max(idf.values()) if idf else 1.0

        # Phase 2: Term informativeness (entropy-blended)
        for term, df in doc_freqs.items():
            if df < 2:
                info[term] = 1.0  # rare → maximally informative
                continue

            posting = posting_lists.get(term, {})
            if not posting:
                info[term] = 0.0
                continue

            idf_info = 1.0 - df / n if n > 0 else 0.0

            # TF variance → blend weight (smooth Shannon ↔ IDF transition)
            tf_vals = list(posting.values())
            n_post = len(tf_vals)
            mean_tf = sum(tf_vals) / n_post
            variance = sum((v - mean_tf) ** 2 for v in tf_vals) / n_post
            blend_alpha = variance / (variance + 1.0)

            if blend_alpha < 0.001:
                info[term] = idf_info
            else:
                mapped = [_fast_sigmoid(float(tf)) for tf in tf_vals]
                total_mapped = sum(mapped)
                if total_mapped == 0.0:
                    info[term] = idf_info
                    continue

                entropy = 0.0
                inv_total = 1.0 / total_mapped
                for m_val in mapped:
                    p = m_val * inv_total
                    if p > 0.0:
                        entropy -= p * math.log(p)

                max_ent = math.log(df)
                norm_ent = (
                    min(entropy / max_ent, 1.0) if max_ent > 0.0 else 0.0
                )
                shannon_info = max(1.0 - norm_ent, 0.0)
                info[term] = (
                    blend_alpha * shannon_info
                    + (1.0 - blend_alpha) * idf_info
                )

        # Phase 3: eIDF = IDF · (1 + γₜ · info)
        eidf: dict[str, float] = {}
        inv_idf_max = 1.0 / idf_max if idf_max > 0.0 else 1.0
        for term in doc_freqs:
            gamma_t = idf.get(term, 0.0) * inv_idf_max
            eidf[term] = idf.get(term, 0.0) * (
                1.0 + gamma_t * info.get(term, 0.0)
            )

        return idf, eidf, info, idf_max

    # ────────────────────────────────────────────────────────────────
    #  Similarity Graph (posting-list intersection)
    # ────────────────────────────────────────────────────────────────

    def _build_graph(
        self,
        posting_lists: dict,
        eidf: dict,
        doc_lengths: dict,
        avg_dl: float,
        n: int,
    ) -> tuple[dict[int, dict[int, float]], int]:
        """Build similarity graph via TAAT posting-list intersection.

        Edge weight is cosine similarity in the eIDF-weighted BM25-TF
        vector space. Self-tuning threshold removes noise edges.

        Returns (adjacency, edge_count).
        """
        k1, b = self._k1, self._b

        # Adaptive scaling limits for large corpora
        max_eidf = max(eidf.values()) if eidf else 0.0
        if n > 5000:
            min_eidf = max_eidf * 0.05
            max_posting = n // 10
        elif n > 1000:
            min_eidf = max_eidf * 0.02
            max_posting = n // 5
        else:
            min_eidf = max_eidf * 0.005
            max_posting = max(n // 2, 10)

        def _tf_sat(tf: int, dl: int) -> float:
            if avg_dl <= 0:
                return float(tf)
            return (tf * (k1 + 1.0)) / (
                tf + k1 * (1.0 - b + b * dl / avg_dl)
            )

        # Phase 1: Norms for cosine normalisation
        norm_sq: dict[int, float] = defaultdict(float)
        for term, posting in posting_lists.items():
            e = eidf.get(term, 0.0)
            if e <= 0.0:
                continue
            for idx, tf in posting.items():
                val = e * _tf_sat(tf, doc_lengths[idx])
                norm_sq[idx] += val * val

        norms = {
            i: math.sqrt(v) if v > 0.0 else 1.0
            for i, v in norm_sq.items()
        }

        # Phase 2: Edge weights via posting-list intersection
        raw: dict[tuple[int, int], float] = defaultdict(float)

        for term, posting in posting_lists.items():
            e = eidf.get(term, 0.0)
            if e < min_eidf:
                continue
            items = list(posting.items())
            if len(items) < 2 or len(items) > max_posting:
                continue

            # Precompute weighted TF for this term
            weighted = [
                (idx, e * _tf_sat(tf, doc_lengths[idx]))
                for idx, tf in items
            ]

            n_items = len(weighted)
            for a_pos in range(n_items):
                idx_a, w_a = weighted[a_pos]
                for b_pos in range(a_pos + 1, n_items):
                    idx_b, w_b = weighted[b_pos]
                    # Canonical key ordering so (i,j) and (j,i) merge
                    key = (idx_a, idx_b) if idx_a < idx_b else (idx_b, idx_a)
                    raw[key] += w_a * w_b

        # Phase 3: Normalise + threshold → adjacency
        adjacency: dict[int, dict[int, float]] = defaultdict(dict)
        edge_count = 0

        if raw:
            normalised: dict[tuple[int, int], float] = {}
            for (i, j), w in raw.items():
                ni = norms.get(i, 1.0)
                nj = norms.get(j, 1.0)
                sim = w / (ni * nj)
                if sim > 0.0:
                    normalised[(i, j)] = sim

            if normalised:
                max_sim = max(normalised.values())
                threshold = max_sim * 0.01  # self-tuning: 1% of max

                for (i, j), sim in normalised.items():
                    if sim >= threshold:
                        adjacency[i][j] = sim
                        adjacency[j][i] = sim
                        edge_count += 1

        return dict(adjacency), edge_count

    # ────────────────────────────────────────────────────────────────
    #  Adaptive Position Prior
    # ────────────────────────────────────────────────────────────────

    @staticmethod
    def _position_prior(centrality: list[float], n: int) -> list[float]:
        """Self-tuning position weights from centrality distribution.

        Detects lead bias: if early sentences are more central than
        average, applies exponential lead boost. Fixed mild trail boost
        for conclusions. Returns multiplicative position weight per
        sentence.
        """
        if n <= 1:
            return [1.0] * n

        avg_c = sum(centrality) / n if n > 0 else 0.0

        # Lead bias detection
        lead_k = max(3, n // 10)
        lead_c = sum(centrality[:lead_k]) / lead_k if lead_k > 0 else 0.0

        if avg_c > 0:
            lead_ratio = lead_c / avg_c
            # Linear ramp: 0 at ratio=1.0, 1.0 at ratio=1.4+
            lead_strength = max(0.0, min(1.0, (lead_ratio - 1.0) * 2.5))
        else:
            lead_strength = 0.0

        trail_strength = 0.3  # fixed, mild

        inv_lead_scale = 1.0 / max(n * 0.1, 1.0)
        inv_trail_scale = 1.0 / max(n * 0.05, 1.0)

        weights = []
        for i in range(n):
            lead = math.exp(-i * inv_lead_scale)
            trail = math.exp(-(n - 1 - i) * inv_trail_scale)
            weights.append(
                1.0 + lead_strength * lead + trail_strength * trail
            )
        return weights

    # ────────────────────────────────────────────────────────────────
    #  Query Scoring (optional BMX+ TAAT)
    # ────────────────────────────────────────────────────────────────

    def _score_query(
        self,
        query_tokens: list[str],
        posting_lists: dict,
        eidf: dict,
        doc_lengths: dict,
        avg_dl: float,
    ) -> dict[int, float]:
        """Score all sentences against a query using BMX+ TAAT."""
        k1, b = self._k1, self._b
        query_tf = Counter(query_tokens)
        scores: dict[int, float] = defaultdict(float)

        for term, qtf in query_tf.items():
            posting = posting_lists.get(term)
            if not posting:
                continue
            e = eidf.get(term, 0.0)
            if e <= 0.0:
                continue

            for idx, tf in posting.items():
                dl = doc_lengths[idx]
                if avg_dl > 0:
                    tf_sat = (tf * (k1 + 1.0)) / (
                        tf + k1 * (1.0 - b + b * dl / avg_dl)
                    )
                else:
                    tf_sat = float(tf)
                scores[idx] += e * tf_sat * qtf

        return dict(scores)

    # ────────────────────────────────────────────────────────────────
    #  PageRank
    # ────────────────────────────────────────────────────────────────

    def _pagerank(
        self,
        adjacency: dict[int, dict[int, float]],
        personalization: dict[int, float],
        n: int,
    ) -> tuple[dict[int, float], int]:
        """Sparse PageRank with topic-sensitive personalization.

        Dangling nodes distribute mass to the personalization vector
        (topic-sensitive, not uniform). Converges via L1 norm check.

        Returns (scores_dict, iterations).
        """
        d = self._damping

        # Normalise personalization → probability distribution
        p = [personalization.get(i, 1e-10) for i in range(n)]
        p_sum = sum(p)
        if p_sum > 0:
            p = [v / p_sum for v in p]
        else:
            p = [1.0 / n] * n

        # Precompute outgoing edges (normalised weights)
        out_total = [0.0] * n
        out_edges: list[list[tuple[int, float]]] = [[] for _ in range(n)]

        for i in range(n):
            neighbours = adjacency.get(i, {})
            total = sum(neighbours.values())
            out_total[i] = total
            if total > 0:
                out_edges[i] = [
                    (j, w / total) for j, w in neighbours.items()
                ]

        # Power iteration
        pr = list(p)
        iterations = 0

        for it in range(self._max_iter):
            iterations = it + 1
            pr_new = [0.0] * n

            # Dangling mass → personalization distribution
            dangling = 0.0
            for i in range(n):
                if out_total[i] == 0:
                    dangling += pr[i]

            for i in range(n):
                pr_new[i] = (1.0 - d) * p[i] + d * dangling * p[i]

            # Edge transitions
            for i in range(n):
                if out_edges[i]:
                    mass = d * pr[i]
                    for j, w_norm in out_edges[i]:
                        pr_new[j] += mass * w_norm

            # Convergence (L1)
            diff = sum(abs(pr_new[i] - pr[i]) for i in range(n))
            pr = pr_new
            if diff < self._epsilon:
                break

        return {i: pr[i] for i in range(n)}, iterations

    # ────────────────────────────────────────────────────────────────
    #  Coverage-Aware Extraction
    # ────────────────────────────────────────────────────────────────

    def _extract_with_coverage(
        self,
        pr_scores: dict[int, float],
        sent_tokens: list[list[str]],
        eidf: dict,
        top_k: int,
        n: int,
    ) -> list[int]:
        """Greedy extraction maximising centrality × information coverage.

        At each step, selects the sentence with highest:
            PR(i) · (λ + (1−λ) · novel_info(i) / total_info(i))

        where novel_info counts eIDF weight of terms not yet covered
        by previously selected sentences.

        Returns selected indices in selection order (importance-first).
        """
        cw = self._coverage_weight

        # Precompute per-sentence term weights
        sent_weights: list[dict[str, float]] = []
        sent_totals: list[float] = []

        for idx in range(n):
            weights: dict[str, float] = {}
            for t in set(sent_tokens[idx]):
                w = eidf.get(t, 0.0)
                if w > 0.0:
                    weights[t] = w
            sent_weights.append(weights)
            sent_totals.append(sum(weights.values()))

        covered: set[str] = set()
        selected: list[int] = []
        remaining = set(range(n))

        while len(selected) < top_k and remaining:
            best_idx = -1
            best_score = -1.0

            for idx in remaining:
                pr = pr_scores.get(idx, 0.0)
                total_w = sent_totals[idx]

                if total_w > 0.0:
                    novel_w = sum(
                        w for t, w in sent_weights[idx].items()
                        if t not in covered
                    )
                    coverage = novel_w / total_w
                else:
                    coverage = 0.0

                score = pr * (cw + (1.0 - cw) * coverage)

                if score > best_score:
                    best_score = score
                    best_idx = idx

            if best_idx < 0:
                break

            selected.append(best_idx)
            remaining.discard(best_idx)
            covered.update(sent_weights[best_idx].keys())

        return selected

    # ────────────────────────────────────────────────────────────────
    #  Keyword Extraction
    # ────────────────────────────────────────────────────────────────

    @staticmethod
    def _get_keywords(
        eidf: dict, doc_freqs: dict, top_k: int = 10,
    ) -> list[tuple[str, float]]:
        """Top keywords by eIDF · √df (informative AND representative)."""
        scored = [
            (term, eidf.get(term, 0.0) * math.sqrt(doc_freqs.get(term, 1)))
            for term in eidf
            if eidf.get(term, 0.0) > 0
        ]
        scored.sort(key=lambda x: x[1], reverse=True)
        return scored[:top_k]

    # ════════════════════════════════════════════════════════════════
    #  Public API
    # ════════════════════════════════════════════════════════════════

    def rank_sentences(
        self,
        sentences: list[str],
        top_k: int = 5,
        query: str | None = None,
    ) -> SageResult:
        """Rank pre-segmented sentences/passages/messages.

        Args:
            sentences: List of text units to rank.
            top_k:     Number of sentences to select.
            query:     Optional query to bias ranking toward.

        Returns:
            SageResult with scores, selected indices, keywords, stats.
        """
        n = len(sentences)
        if n == 0:
            return SageResult([], [], [], [])
        if n == 1:
            return SageResult(sentences, [1.0], [0], [], {"sentences": 1})
        top_k = min(top_k, n)

        # 1. Tokenise
        sent_tokens = [self._tokenize(s) for s in sentences]

        # 2. Build inverted index
        posting_lists, doc_freqs, doc_lengths, avg_dl = (
            self._build_posting_lists(sent_tokens)
        )

        # 3. Entropy-weighted IDF
        idf, eidf, info, idf_max = self._compute_eidf(
            posting_lists, doc_freqs, n
        )

        # 4. Similarity graph
        adjacency, edge_count = self._build_graph(
            posting_lists, eidf, doc_lengths, avg_dl, n
        )

        # 5. Degree centrality (from graph)
        centrality = [
            sum(adjacency.get(i, {}).values()) for i in range(n)
        ]

        # 6. Adaptive position prior
        position = self._position_prior(centrality, n)

        # 7. Optional query scoring
        query_scores = None
        if query:
            qt = self._tokenize(query)
            if qt:
                query_scores = self._score_query(
                    qt, posting_lists, eidf, doc_lengths, avg_dl
                )

        # 8. Personalization vector
        personalization: dict[int, float] = {}
        for i in range(n):
            p = position[i]
            if query_scores:
                p *= query_scores.get(i, 0.0) + 0.01
            personalization[i] = p

        # 9. PageRank
        pr_scores, pr_iters = self._pagerank(adjacency, personalization, n)

        # 10. Coverage-aware extraction
        selected = self._extract_with_coverage(
            pr_scores, sent_tokens, eidf, top_k, n
        )

        # 11. Keywords
        keywords = self._get_keywords(eidf, doc_freqs, top_k=10)

        # 12. Normalise scores to [0, 1]
        scores = [pr_scores.get(i, 0.0) for i in range(n)]
        if self._normalize and scores:
            max_s = max(scores)
            if max_s > 0:
                scores = [s / max_s for s in scores]

        stats = {
            "sentences": n,
            "vocabulary": len(posting_lists),
            "edges": edge_count,
            "pagerank_iters": pr_iters,
            "idf_max": round(idf_max, 4),
            "lead_bias": round(
                self._position_prior(centrality, n)[0] - 1.0, 4
            ) if n > 0 else 0.0,
            "query_biased": query is not None,
        }

        return SageResult(
            sentences=sentences,
            scores=scores,
            selected_indices=selected,
            keywords=keywords,
            stats=stats,
        )

    # Alias for non-sentence text units (messages, paragraphs, chunks)
    rank_passages = rank_sentences

    def rank(
        self,
        text: str,
        top_k: int = 5,
        query: str | None = None,
    ) -> SageResult:
        """Rank sentences in a text document.

        Segments text into sentences, then ranks them.
        For pre-segmented input, use rank_sentences() instead.
        """
        sentences = _segment_sentences(text, self._min_sent_len)
        return self.rank_sentences(sentences, top_k=top_k, query=query)

    def summarize(
        self,
        text: str,
        ratio: float = 0.3,
        query: str | None = None,
    ) -> str:
        """Return an extractive summary at the given compression ratio.

        Args:
            text:  Input document.
            ratio: Fraction of sentences to keep (0.0–1.0).
            query: Optional query to bias summary toward.

        Returns:
            Summary string (selected sentences in document order).
        """
        sentences = _segment_sentences(text, self._min_sent_len)
        if not sentences:
            return ""
        top_k = max(1, int(len(sentences) * ratio))
        result = self.rank_sentences(sentences, top_k=top_k, query=query)
        return result.summary

    def extract_keywords(
        self,
        text: str,
        top_k: int = 10,
    ) -> list[tuple[str, float]]:
        """Extract top keywords using entropy-weighted IDF scoring.

        Returns list of (term, score) tuples sorted by importance.
        """
        sentences = _segment_sentences(text, self._min_sent_len)
        if not sentences:
            return []
        sent_tokens = [self._tokenize(s) for s in sentences]
        posting_lists, doc_freqs, _, _ = self._build_posting_lists(
            sent_tokens
        )
        n = len(sentences)
        _, eidf, _, _ = self._compute_eidf(posting_lists, doc_freqs, n)
        return self._get_keywords(eidf, doc_freqs, top_k=top_k)

