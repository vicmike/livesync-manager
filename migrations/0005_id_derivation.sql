-- Independent ID derivation (Self-hosted LiveSync 1.0.33+): new encrypted
-- vaults get a per-vault key from which chunk and metadata document IDs are
-- derived, instead of from the E2EE passphrase. Encrypted with the master key.
-- NULL means legacy, passphrase-derived IDs: every vault created before this
-- migration, every unencrypted vault, and adopted databases without an
-- ID recovery code. Devices on keyed vaults need plugin 1.0.33 or newer.

ALTER TABLE vaults ADD COLUMN id_derivation_key_enc BLOB;
