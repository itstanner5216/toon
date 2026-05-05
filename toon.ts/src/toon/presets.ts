// Ported from: toon/presets.py
// Python line count: 95 (no self-test)
// Port verification:
//   - All four presets preserved: "generic", "codex_logs", "mcp_responses", "aggressive"
//   - All field values are character-for-character identical to Python source
//   - PRESETS dict -> Record<string, ToonConfig> with same key names
//   - Python uses direct ToonConfig()/FieldMatcher()/etc. constructors;
//     TS uses defaultToonConfig/defaultFieldMatcher/etc. factories with same field values
//   - "generic": encode_rules=[min_length=500, truncate budget=400]
//   - "codex_logs": preserve_rules pattern "(message|reasoning)$",
//     encode_rules: payload.output truncate/400, payload.arguments parse_json,
//     (output|stdout|stderr)$ truncate/300
//   - "mcp_responses": preserve_rules pattern "(error|status|message|id|type)$",
//     encode_rules: min_length=1000 truncate/500
//   - "aggressive": bmx enabled=true, encode_rules: min_length=200 truncate/200

import {
  defaultToonConfig,
  defaultFieldMatcher,
  defaultCodecConfig,
  defaultBMXConfig,
  type ToonConfig,
  type EncoderRule,
  type FieldMatcher,
} from './config.js';

// ---------------------------------------------------------------------------
//  Preset definitions
// ---------------------------------------------------------------------------

export const PRESETS: Record<string, ToonConfig> = {

  // generic
  // Safe default: only compresses long strings. Good starting point
  // when you don't know the shape of the tool output.
  "generic": defaultToonConfig({
    encode_rules: [
      {
        matcher: defaultFieldMatcher({ min_length: 500 }),
        codec: defaultCodecConfig("truncate", 400),
      } satisfies EncoderRule,
    ],
  }),

  // codex_logs
  // Tuned for Codex-style agent traces where payload.output and
  // payload.arguments carry the bulk of the tokens, and
  // message / reasoning must be kept verbatim.
  "codex_logs": defaultToonConfig({
    preserve_rules: [
      defaultFieldMatcher({ field_pattern: "(message|reasoning)$" }),
    ] satisfies FieldMatcher[],
    encode_rules: [
      {
        matcher: defaultFieldMatcher({ field_path: "payload.output" }),
        codec: defaultCodecConfig("truncate", 400),
      } satisfies EncoderRule,
      {
        matcher: defaultFieldMatcher({ field_path: "payload.arguments" }),
        codec: defaultCodecConfig("parse_json"),
      } satisfies EncoderRule,
      {
        matcher: defaultFieldMatcher({ field_pattern: "(output|stdout|stderr)$" }),
        codec: defaultCodecConfig("truncate", 300),
      } satisfies EncoderRule,
    ],
  }),

  // mcp_responses
  // MCP (Model Context Protocol) tool responses: preserve structural
  // metadata fields, compress only genuinely large payloads.
  "mcp_responses": defaultToonConfig({
    preserve_rules: [
      defaultFieldMatcher({
        field_pattern: "(error|status|message|id|type)$",
      }),
    ] satisfies FieldMatcher[],
    encode_rules: [
      {
        matcher: defaultFieldMatcher({ min_length: 1000 }),
        codec: defaultCodecConfig("truncate", 500),
      } satisfies EncoderRule,
    ],
  }),

  // aggressive
  // Maximum compression: enables BMX+ scoring and applies tight
  // truncation to anything >= 200 characters.
  "aggressive": defaultToonConfig({
    bmx: defaultBMXConfig({ enabled: true }),
    encode_rules: [
      {
        matcher: defaultFieldMatcher({ min_length: 200 }),
        codec: defaultCodecConfig("truncate", 200),
      } satisfies EncoderRule,
    ],
  }),
};
