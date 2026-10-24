// Plain JSON Schemas for the two model outputs: the worker's analysis (Claude structured output)
// and the verifier's review (Droid SDK structured output). Plain objects, not Zod, because the
// Droid SDK expects Zod 3 and the bridge may use Zod 4. Every object is closed and every field
// required, which is what structured-output modes need.

import { PROVIDERS, RELATIONS } from "./types.ts";

export const FINDINGS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["findings"],
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "key",
          "relation",
          "citedItemIds",
          "explanation",
          "contractText",
        ],
        properties: {
          key: { type: "string" },
          relation: { type: "string", enum: [...RELATIONS] },
          citedItemIds: { type: "array", items: { type: "integer" } },
          explanation: { type: "string" },
          contractText: { type: "string" },
        },
      },
    },
  },
} as const;

export const REVIEW_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "clauses", "rootCause"],
  properties: {
    summary: { type: "string" },
    clauses: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["clause", "key", "verdict", "evidence"],
        properties: {
          clause: { type: "string" },
          key: { type: "string" },
          verdict: {
            type: "string",
            enum: ["conforms", "violates", "not_applicable"],
          },
          evidence: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["file", "line", "note"],
              properties: {
                file: { type: "string" },
                line: { type: "integer" },
                note: { type: "string" },
              },
            },
          },
        },
      },
    },
    rootCause: {
      anyOf: [
        { type: "null" },
        {
          type: "object",
          additionalProperties: false,
          required: ["key", "violator", "explanation"],
          properties: {
            key: { type: "string" },
            violator: { type: "string", enum: [...PROVIDERS, "unknown"] },
            explanation: { type: "string" },
          },
        },
      ],
    },
  },
} as const;
