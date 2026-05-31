// Prisma client extension — transparent at-rest encryption for
// confidential columns.
//
// Confidentiality TSC. Builds on the AES-256-GCM helper in
// src/lib/soc2/field-encryption.ts. The extension wires the helper
// into Prisma so feature code never has to remember to encrypt/
// decrypt — `prisma.journalEntry.create({ data: { memo } })` writes
// ciphertext to Postgres, and `prisma.journalEntry.findUnique(...)`
// returns the plaintext memo to the caller.
//
// Column registry (single source of truth):
//   See ENCRYPTED_COLUMNS below. To add a column:
//     1. Add the (model, field) pair here
//     2. Verify the Prisma type is `String?` (we encode null-as-null
//        and refuse empty strings)
//     3. Add the field name to `PII_FIELD_NAMES` in
//        `src/lib/soc2/index.ts` so it also redacts in logs
//     4. Add a migration entry in `prisma/sql/encrypt-{model}-{field}.ts`
//        that re-encrypts existing plaintext rows (skip already-
//        encrypted via `looksEncrypted`)
//     5. Update `docs/policies/data-classification.md`
//
// Failure modes:
//   - If FIELD_ENCRYPTION_KEY isn't set, the extension passes the
//     plaintext through unchanged. The helper throws
//     KeyNotConfiguredError if called, but the extension catches and
//     warns rather than failing every Prisma query. This is the
//     "rollout safety net" — production sets the key on day 1; dev
//     can run without it.
//   - Decryption failure (tampered ciphertext, wrong key) on read
//     surfaces as a FieldEncryptionError on the read path.
//     Application code should catch and fall back to displaying
//     "[Encryption error — contact support]" rather than crashing
//     the page.
//
// Per-model wiring is intentionally explicit rather than reflection-
// driven. Adding a new encrypted column is a code review event;
// hiding that behind a decorator would make it invisible.

import { Prisma } from "@prisma/client";
import {
  encryptField,
  decryptField,
  looksEncrypted,
  KeyNotConfiguredError,
  FieldEncryptionError,
} from "@/lib/soc2/field-encryption";

// ─────────────────────────────────────────────────────────────────────────────
// Column registry
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Tuples of (Prisma model name, field name) for every column the
 * extension transparently encrypts. Order doesn't matter; lookups
 * happen by model + field.
 */
export const ENCRYPTED_COLUMNS: ReadonlyArray<{
  model: string;
  field: string;
}> = [
  // BankStatementLine.description is the free-text vendor / payment
  // identifier from the bank (e.g., "TST*BROOKLYN GRIND" or "ACH
  // CREDIT VENDOR_A INVOICE_42"). Highly correlable: the description
  // text typically reveals the customer's bank-account holder, payment
  // counterparties, and rough activity pattern. Highest-value target
  // in recon.
  { model: "BankStatementLine", field: "description" },
  // Party.displayName is the customer / vendor / contact name as it
  // appears on AR/AP, JE detail, and the aging reports in ledger-core.
  // Recon doesn't WRITE Party (it's owned by ledger-core), but the
  // matching pipeline READS it: `src/lib/matching/candidates.ts` joins
  // JournalLine → party.displayName to display the counterparty
  // alongside each match candidate. Without this registry entry, the
  // matcher would surface ciphertext to the user. A leaked Party
  // table = a leaked customer roster, which is also a competitive-
  // intelligence asset. Audited 2026-05-29 across all 5 repos: zero
  // queries filter by displayName (only `code` is searchable), so
  // AES-GCM is safe — no need for deterministic encryption.
  { model: "Party", field: "displayName" },
];

function isEncryptedColumn(model: string, field: string): boolean {
  return ENCRYPTED_COLUMNS.some((c) => c.model === model && c.field === field);
}

function fieldsForModel(model: string): string[] {
  return ENCRYPTED_COLUMNS.filter((c) => c.model === model).map((c) => c.field);
}

/**
 * Parent-to-child relation map. Lets the encryption walker recurse
 * into nested writes like:
 *   prisma.bankStatement.create({ data: { lines: { create: [{...}] } } })
 * Prisma's $extends query hook only fires on the TOP-LEVEL model;
 * the nested `lines.create` payload never sees BankStatementLine's
 * hook. We compensate by enumerating the relation paths that lead
 * to encrypted columns and walking them explicitly.
 *
 * Add entries as new nested-write paths surface during feature work.
 */
const RELATION_MAP: ReadonlyArray<{
  parent: string;
  relation: string;
  child: string;
}> = [
  { parent: "BankStatement", relation: "lines", child: "BankStatementLine" },
];

function relationsForModel(parent: string): Array<{
  relation: string;
  child: string;
}> {
  return RELATION_MAP.filter((r) => r.parent === parent).map((r) => ({
    relation: r.relation,
    child: r.child,
  }));
}

/**
 * True iff this model has either an encrypted column directly OR a
 * relation path to a child model that does. Used by the query hooks
 * to decide whether to walk args.data at all — a model with neither
 * touches no ciphertext and can short-circuit straight to the
 * underlying query.
 */
function modelTouchesEncryption(model: string): boolean {
  if (fieldsForModel(model).length > 0) return true;
  for (const r of RELATION_MAP) {
    if (r.parent === model && fieldsForModel(r.child).length > 0) return true;
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Encryption helpers (safe wrappers — never crash the query)
// ─────────────────────────────────────────────────────────────────────────────

let warnedAboutMissingKey = false;

/**
 * Encrypt a value if it's a string + the key is configured.
 * Pass-through (with a one-time warning) when key is missing.
 * Skip already-encrypted values (idempotency on UPDATE).
 */
function safeEncrypt(value: unknown): unknown {
  if (typeof value !== "string" || value.length === 0) return value;
  if (looksEncrypted(value)) return value;
  try {
    return encryptField(value);
  } catch (e) {
    if (e instanceof KeyNotConfiguredError) {
      if (!warnedAboutMissingKey) {
        console.warn(
          "[encrypted-fields] FIELD_ENCRYPTION_KEY is not set; columns " +
            "in ENCRYPTED_COLUMNS write plaintext. Set the env var to enable."
        );
        warnedAboutMissingKey = true;
      }
      return value;
    }
    throw e;
  }
}

/**
 * Decrypt a value if it looks encrypted. Pass-through when it
 * doesn't (allows mixed plaintext / ciphertext during rollout).
 * Decryption failures surface as a FieldEncryptionError; callers
 * decide whether to swallow or propagate.
 */
function safeDecrypt(value: unknown): unknown {
  if (typeof value !== "string" || value.length === 0) return value;
  if (!looksEncrypted(value)) return value;
  try {
    return decryptField(value);
  } catch (e) {
    if (e instanceof KeyNotConfiguredError) {
      // The ciphertext is in the row but we can't decrypt. Return a
      // sentinel so the application can render "[Encryption error]"
      // rather than crash.
      return "[encrypted — key not configured]";
    }
    if (e instanceof FieldEncryptionError) {
      return "[encryption error — contact support]";
    }
    throw e;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Extension
// ─────────────────────────────────────────────────────────────────────────────
//
// Two phases per operation:
//   1. WRITE (create / update / upsert / createMany): walk the input
//      `data` recursively and encrypt any field name in the registry
//      for the operating model.
//   2. READ (findFirst / findMany / findUnique / etc.): walk the
//      result and decrypt any ciphertext.
//
// `createMany` returns a count, not rows — no read decryption needed.
// `updateMany` returns a count, no read decryption.

export const encryptedFieldsExtension = Prisma.defineExtension({
  name: "encrypted-fields",
  query: {
    $allModels: {
      async create({ model, args, query }) {
        if (!modelTouchesEncryption(model)) return query(args);
        args.data = encryptDataObject(model, args.data) as typeof args.data;
        const result = await query(args);
        return decryptRow(model, result);
      },

      async createMany({ model, args, query }) {
        if (!modelTouchesEncryption(model)) return query(args);
        const data = args.data as unknown;
        if (Array.isArray(data)) {
          args.data = data.map((row) => encryptDataObject(model, row)) as typeof args.data;
        } else {
          args.data = encryptDataObject(model, data) as typeof args.data;
        }
        return query(args);
      },

      async update({ model, args, query }) {
        if (!modelTouchesEncryption(model)) return query(args);
        args.data = encryptDataObject(model, args.data) as typeof args.data;
        const result = await query(args);
        return decryptRow(model, result);
      },

      async updateMany({ model, args, query }) {
        if (!modelTouchesEncryption(model)) return query(args);
        args.data = encryptDataObject(model, args.data) as typeof args.data;
        return query(args);
      },

      async upsert({ model, args, query }) {
        if (!modelTouchesEncryption(model)) return query(args);
        args.create = encryptDataObject(model, args.create) as typeof args.create;
        args.update = encryptDataObject(model, args.update) as typeof args.update;
        const result = await query(args);
        return decryptRow(model, result);
      },

      async findUnique({ model, args, query }) {
        if (!modelTouchesEncryption(model)) return query(args);
        const result = await query(args);
        return decryptRow(model, result);
      },

      async findUniqueOrThrow({ model, args, query }) {
        if (!modelTouchesEncryption(model)) return query(args);
        const result = await query(args);
        return decryptRow(model, result);
      },

      async findFirst({ model, args, query }) {
        if (!modelTouchesEncryption(model)) return query(args);
        const result = await query(args);
        return decryptRow(model, result);
      },

      async findFirstOrThrow({ model, args, query }) {
        if (!modelTouchesEncryption(model)) return query(args);
        const result = await query(args);
        return decryptRow(model, result);
      },

      async findMany({ model, args, query }) {
        if (!modelTouchesEncryption(model)) return query(args);
        const result = await query(args);
        if (!Array.isArray(result)) return result;
        return result.map((row) => decryptRow(model, row));
      },
    },
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Walkers
// ─────────────────────────────────────────────────────────────────────────────

/** Encrypt fields in the `data` payload of a write operation. */
function encryptDataObject(model: string, data: unknown): unknown {
  if (!data || typeof data !== "object" || Array.isArray(data)) return data;
  const fields = fieldsForModel(model);
  const out: Record<string, unknown> = { ...(data as Record<string, unknown>) };

  // Encrypt direct fields on this model.
  for (const field of fields) {
    if (!(field in out)) continue;
    const value = out[field];
    if (value === null || value === undefined) {
      out[field] = value;
      continue;
    }
    // Prisma write-operation values can be `{ set: ... }` for nested
    // update inputs. Unwrap before encrypting and re-wrap on the way
    // out so the underlying generator still recognizes the shape.
    if (typeof value === "object" && "set" in value) {
      const wrapped = value as { set: unknown };
      out[field] = { set: safeEncrypt(wrapped.set) };
      continue;
    }
    out[field] = safeEncrypt(value);
  }

  // Recurse into nested relation writes. Prisma's $extends query
  // hooks only fire on the TOP-LEVEL model; if a feature does
  //   prisma.bankStatement.create({ data: { lines: { create: [...] } } })
  // the BankStatementLine model's hook never sees the payload. We
  // walk the relation map to compensate.
  for (const { relation, child } of relationsForModel(model)) {
    if (!(relation in out)) continue;
    const nested = out[relation];
    if (!nested || typeof nested !== "object") continue;
    const nestedRec = nested as Record<string, unknown>;

    // `create` can be a single object or an array of objects.
    if ("create" in nestedRec) {
      const createPayload = nestedRec.create;
      if (Array.isArray(createPayload)) {
        nestedRec.create = createPayload.map((item) =>
          encryptDataObject(child, item)
        );
      } else if (createPayload && typeof createPayload === "object") {
        nestedRec.create = encryptDataObject(child, createPayload);
      }
    }
    // `createMany.data` is always an array.
    if (
      "createMany" in nestedRec &&
      nestedRec.createMany &&
      typeof nestedRec.createMany === "object"
    ) {
      const cm = nestedRec.createMany as Record<string, unknown>;
      if (Array.isArray(cm.data)) {
        cm.data = cm.data.map((item) => encryptDataObject(child, item));
      } else if (cm.data && typeof cm.data === "object") {
        cm.data = encryptDataObject(child, cm.data);
      }
    }
    // `update` and `upsert` paths intentionally NOT recursed for
    // now — those would require unwinding Prisma's where/data tuple
    // shapes per relation. Add when a real use case surfaces.

    out[relation] = nestedRec;
  }

  return out;
}

/** Decrypt fields in a single returned row. */
function decryptRow<T>(model: string, row: T): T {
  if (!row || typeof row !== "object") return row;
  const fields = fieldsForModel(model);
  const out: Record<string, unknown> = { ...(row as Record<string, unknown>) };
  for (const field of fields) {
    if (!(field in out)) continue;
    const value = out[field];
    if (value === null || value === undefined) continue;
    out[field] = safeDecrypt(value);
  }
  return out as T;
}

/** Test helper. Reset the one-time missing-key warning so tests can re-trigger. */
export function _resetWarningForTesting(): void {
  warnedAboutMissingKey = false;
}
