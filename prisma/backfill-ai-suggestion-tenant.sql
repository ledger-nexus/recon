-- Backfill AiSuggestion.tenant_id from the bank line's chain:
--   AiSuggestion.bank_line_id
--     → bank_statement_line.statement_id
--     → bank_statement.bank_account_id
--     → bank_account.entity_id
--     → legal_entity.tenant_id
--
-- Run AFTER `pnpm db:push` adds the nullable tenant_id column.
-- Idempotent — only updates rows where tenant_id IS NULL.
--
-- After this completes, every existing AiSuggestion row should have
-- tenant_id set (we have a 100% join path because bank_line_id is
-- required). New rows are stamped by the Server Action.

UPDATE ai_suggestion AS s
SET tenant_id = e.tenant_id
FROM bank_statement_line AS l
JOIN bank_statement AS st  ON l.statement_id     = st.id
JOIN bank_account    AS ba ON st.bank_account_id = ba.id
JOIN legal_entity    AS e  ON ba.entity_id        = e.id
WHERE s.bank_line_id = l.id
  AND s.tenant_id IS NULL;

-- Verify: this should return 0.
-- SELECT COUNT(*) FROM ai_suggestion WHERE tenant_id IS NULL;
