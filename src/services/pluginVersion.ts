// Self-hosted LiveSync version floors this app states to users. One place, so
// the invite page, the SPA and the client-activity check cannot drift apart.

/**
 * Plugin 1.0.37 (2026-10-16) fixed a security issue where synchronised
 * changes could reach files outside the intended synchronisation scope.
 * Invites ask for this version or newer, and clients below it are flagged
 * as outdated in the UI and in vault health. It is also at or above every
 * feature floor below, so it is the single version users need to know.
 */
export const MIN_RECOMMENDED_PLUGIN_VERSION = '1.0.37';

/** Independent ID derivation (keyed vaults) needs plugin 1.0.33 or newer. */
export const ID_DERIVATION_MIN_PLUGIN_VERSION = '1.0.33';

/** The oldest plugin whose setup-URI import flow this app documents (§ 4). */
export const SETUP_URI_MIN_PLUGIN_VERSION = '1.0.13';
