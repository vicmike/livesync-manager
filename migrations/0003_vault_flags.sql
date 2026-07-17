-- Optional E2EE and the vault lock (emergency brake, M9).
-- Unencrypted vaults store a zero-length e2ee_passphrase_enc.

ALTER TABLE vaults ADD COLUMN encrypted INTEGER NOT NULL DEFAULT 1;
ALTER TABLE vaults ADD COLUMN locked INTEGER NOT NULL DEFAULT 0;
