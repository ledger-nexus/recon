// Public entry points for recon's NetSuite mapper.
//
// PR #1 of the recon NetSuite sprint ships the foundation (types +
// pure mappers + unit tests). The orchestrator (importFromNsRecon)
// lands in PR #2 with integration tests.

export {
  mapBankAccount,
  mapStatement,
  mapStatementLine,
  mapForImport,
  NS_RECON_MAPPING_VERSION,
  type MappedBankAccount,
  type MappedBankStatement,
  type MappedBankStatementLine,
  type MappedLineMatch,
  type MappedReconImport,
  type MatchSource,
  type MatchStatus,
} from "./mappers";

export type {
  NsRef,
  NsBankAccount,
  NsBankStatement,
  NsBankStatementLine,
  NsReconciliation,
  NsReconExport,
} from "./types";

export {
  importFromNsRecon,
  type ImportFromNsReconInput,
  type ImportFromNsReconResult,
  type ImportStatementResult,
} from "./import";
