-- One row per supporter, keyed by who they are, so the roll lists people rather than payments.
-- A public supporter's key is the SHA-256 of their email (or of their name when Ko-fi sends none);
-- every private tip gets its own key from its message id and stores no name.
CREATE TABLE supporters (
	id INTEGER PRIMARY KEY,
	key TEXT NOT NULL UNIQUE,
	name TEXT,
	email_hash TEXT,
	has_avatar INTEGER NOT NULL DEFAULT 0,
	monthly INTEGER NOT NULL DEFAULT 0,
	last_at TEXT NOT NULL,
	hidden INTEGER NOT NULL DEFAULT 0
);

-- Serves the roll: WHERE hidden = 0 ORDER BY last_at DESC LIMIT n.
CREATE INDEX supporters_roll ON supporters (hidden, last_at DESC);

-- Ko-fi retries a webhook it thinks failed; a message id seen before changes nothing.
CREATE TABLE seen (message_id TEXT PRIMARY KEY);
