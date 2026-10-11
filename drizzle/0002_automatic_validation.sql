ALTER TABLE answers ADD COLUMN validation_status TEXT NOT NULL DEFAULT 'needs_review';
ALTER TABLE answers ADD COLUMN validation_reason TEXT NOT NULL DEFAULT 'Aguardando conferência automática';
