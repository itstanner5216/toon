"""toon CLI entry point.

Modes
-----
  (no flags)     Read JSON from stdin, run full pipeline, print JSON result.
  --structured   Read JSON payload {content, budget, structure} from stdin.
                 If ``structure`` is provided (tree-sitter block list from
                 toon_bridge.js), uses compress_source_structured().
                 Otherwise falls back to compress_string().
"""

import argparse
import json
import sys

from .pipeline import compress
from .string_codec import compress_source_structured, compress_string

parser = argparse.ArgumentParser(prog="python3 -m toon", add_help=True)
parser.add_argument(
    "--budget",
    type=int,
    default=None,
    help="Character budget override (default: from payload or pipeline preset)",
)
parser.add_argument(
    "--structured",
    action="store_true",
    help="Structured mode: read {content, budget, structure} JSON from stdin",
)
args = parser.parse_args()

raw = sys.stdin.read()

if args.structured:
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as e:
        sys.stderr.write(f"toon --structured: invalid JSON on stdin: {e}\n")
        sys.exit(1)

    content = data["content"]
    budget = args.budget if args.budget is not None else data.get(
        "budget", len(content))
    # None when tree-sitter failed or unsupported lang
    structure = data.get("structure")

    if structure:
        result = compress_source_structured(content, budget, structure)
    else:
        result = compress_string(content, budget)

    sys.stdout.write(result)

else:
    # Original pipeline mode
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        data = raw

    result = compress(data, budget=args.budget)
    if isinstance(result, str):
        sys.stdout.write(result)
    else:
        sys.stdout.write(json.dumps(result, default=str))
