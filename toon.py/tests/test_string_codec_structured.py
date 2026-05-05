from toon.string_codec import compress_source_structured


def test_structured_codec_prefers_anchors_inside_partial_function_body():
    text = "\n".join(
        [
            "export function alpha() {",
            "    const setup = 1;",
            "    const intermediate = setup + 1;",
            "    const more = intermediate + 1;",
            "    if (more > 2) {",
            "        return more;",
            "    }",
            "    throw new Error('bad');",
            "}",
        ]
    )

    structure = [{"type": "function",
                  "name": "alpha",
                  "startLine": 0,
                  "endLine": 8,
                  "exported": True,
                  "priority": 300,
                  "anchors": [{"startLine": 5,
                               "endLine": 5,
                               "kind": "return",
                               "priority": 400},
                              {"startLine": 7,
                               "endLine": 7,
                               "kind": "throw",
                               "priority": 380},
                              {"startLine": 4,
                               "endLine": 4,
                               "kind": "if",
                               "priority": 320},
                              ],
                  }]

    budget = 115
    result = compress_source_structured(text, budget, structure)

    assert len(result) <= budget
    assert "export function alpha() {  # L1" in result
    assert "        return more;" in result
    assert "    const setup = 1;" not in result
    assert "# ... [" in result


def test_structured_codec_drops_jsdoc_param_blocks_before_definitions():
    text = "\n".join(
        [
            "/**",
            " * Builds the thing.",
            " * @param {string} source   - the source code",
            " * @param {string} langName - tree-sitter language name",
            " * @returns {Promise<Symbol[] | null>}",
            " */",
            "export function build(source, langName) {",
            "    if (!source) {",
            "        throw new Error('missing source');",
            "    }",
            "    return langName + source;",
            "}",
        ]
    )

    structure = [{"type": "function",
                  "name": "build",
                  "startLine": 6,
                  "endLine": 11,
                  "exported": True,
                  "priority": 300,
                  "anchors": [{"startLine": 7,
                               "endLine": 7,
                               "kind": "if",
                               "priority": 320},
                              {"startLine": 8,
                               "endLine": 8,
                               "kind": "throw",
                               "priority": 380},
                              {"startLine": 10,
                               "endLine": 10,
                               "kind": "return",
                               "priority": 400},
                              ],
                  }]

    result = compress_source_structured(text, 170, structure)

    assert "@param" not in result
    assert "@returns" not in result
    assert "export function build(source, langName) {  # L7" in result


def test_structured_codec_inlines_tiny_gaps_instead_of_one_line_markers():
    text = "\n".join(
        [
            "export function sample() {",
            "    const prep = 1;",
            "    return prep;",
            "}",
        ]
    )

    structure = [{"type": "function",
                  "name": "sample",
                  "startLine": 0,
                  "endLine": 3,
                  "exported": True,
                  "priority": 300,
                  "anchors": [{"startLine": 2,
                               "endLine": 2,
                               "kind": "return",
                               "priority": 400},
                              ],
                  }]

    result = compress_source_structured(text, 90, structure)

    assert "    const prep = 1;" in result
    assert "[lines 2-2 omitted]" not in result


def test_structured_codec_preserves_tail_return_after_context_fill():
    text = "\n".join(
        [
            "from __future__ import annotations",
            "",
            "import json",
            "",
            "import httpx",
            "",
            "from .config import settings",
            "",
            "",
            "async def expand_queries(query: str, num_variants: int = 5) -> list[str]:",
            "    variants = await _llm_expand(query, num_variants)",
            "    result: list[str] = []",
            "    for q in [query, *variants]:",
            "        normalized = q.strip()",
            "        if normalized:",
            "            result.append(normalized)",
            "    return result",
            "",
            "",
            "async def _llm_expand(query: str, num_variants: int) -> list[str]:",
            '    """Generate query variants using LiteLLM."""',
            '    url = settings.litellm_base_url + "/v1/chat/completions"',
            "",
            '    headers: dict[str, str] = {"Content-Type": "application/json"}',
            "    if settings.litellm_api_key:",
            '        headers["Authorization"] = f"Bearer {settings.litellm_api_key}"',
            "",
            "    dynamic_header = (",
            '        f"Produce exactly {num_variants} search query variants. "',
            '        f"Return ONLY a JSON array of {num_variants} strings, no other text or markdown."',
            "    )",
            "    extra_system = settings.system_prompt.strip()",
            '    system_content = dynamic_header + (f"\\n\\n{extra_system}" if extra_system else "")',
            "",
            "    user_template = settings.user_query.strip()",
            "    user_content = user_template.format(query=query) if user_template else query",
            "",
            "    payload = {",
            '        "model": settings.litellm_model,',
            '        "messages": [',
            '            {"role": "system", "content": system_content},',
            '            {"role": "user", "content": user_content},',
            "        ],",
            "    }",
            "",
            "    async with httpx.AsyncClient(timeout=15.0) as client:",
            "        resp = await client.post(url, headers=headers, json=payload)",
            "        resp.raise_for_status()",
            "",
            '    content = resp.json()["choices"][0]["message"]["content"]',
            "    variants: list[str] = json.loads(content)",
            "    return variants",
        ])

    structure = [
        {
            "type": "function",
            "name": "expand_queries",
            "startLine": 9,
            "endLine": 16,
            "exported": True,
            "priority": 200,
            "anchors": [
                {"startLine": 10, "endLine": 10, "kind": "call", "priority": 140},
                {"startLine": 13, "endLine": 13, "kind": "call", "priority": 140},
                {"startLine": 14, "endLine": 15, "kind": "if", "priority": 320},
                {"startLine": 16, "endLine": 16, "kind": "return", "priority": 400},
            ],
        },
        {
            "type": "function",
            "name": "_llm_expand",
            "startLine": 19,
            "endLine": 47,
            "exported": False,
            "priority": 100,
            "anchors": [
                {"startLine": 24, "endLine": 25, "kind": "if", "priority": 320},
                {"startLine": 31, "endLine": 31, "kind": "call", "priority": 140},
                {"startLine": 34, "endLine": 34, "kind": "call", "priority": 140},
                {"startLine": 35, "endLine": 35, "kind": "call", "priority": 140},
                {"startLine": 43, "endLine": 43, "kind": "with", "priority": 220},
                {"startLine": 44, "endLine": 44, "kind": "await", "priority": 180},
                {"startLine": 45, "endLine": 45, "kind": "call", "priority": 140},
                {"startLine": 46, "endLine": 46, "kind": "call", "priority": 140},
                {"startLine": 47, "endLine": 47, "kind": "return", "priority": 400},
            ],
        },
    ]

    result = compress_source_structured(text, 1060, structure)

    assert len(result) <= 1060
    assert (
        "async def _llm_expand(query: str, num_variants: int) -> list[str]:  # L20" in result
    )
    assert "    variants: list[str] = json.loads(content)" in result
    assert "    return variants" in result
