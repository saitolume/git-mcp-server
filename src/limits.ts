/** Hard bounds only for one record or for sets that the MCP wire contract must enumerate. */
export const COMPLETE_RECORD_MAX_BYTES = 16 * 1024;
export const GIT_PATH_MAX_BYTES = 4 * 1024;
export const EXPLICIT_PATH_SET_MAX_COUNT = 10_000;
export const EXPLICIT_PATH_SET_MAX_BYTES = 128 * 1024;
/** Supported unique initialized-gitlink paths; each requires two bounded nested Git reads. */
export const INITIALIZED_GITLINK_PATH_MAX_COUNT = 64;
export const RETURNED_PATH_SET_MAX_COUNT = 100_000;
export const RETURNED_PATH_SET_MAX_BYTES = 16 * 1024 * 1024;
export const RETURNED_REF_SET_MAX_COUNT = 10_000;
export const RETURNED_REF_SET_MAX_BYTES = 8 * 1024 * 1024;
export const STREAM_STDERR_MAX_BYTES = 32 * 1024;
