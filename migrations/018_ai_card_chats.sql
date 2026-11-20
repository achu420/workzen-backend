-- Per-card AI chats: ai_chats rows with metadata.scope = 'card' are looked up by the card's row or
-- database when a card or database is deleted.
CREATE INDEX IF NOT EXISTS ai_chats_card_row_idx ON ai_chats ((metadata->>'row_id')) WHERE metadata->>'scope' = 'card';
CREATE INDEX IF NOT EXISTS ai_chats_card_database_idx ON ai_chats ((metadata->>'database_id')) WHERE metadata->>'scope' = 'card';
