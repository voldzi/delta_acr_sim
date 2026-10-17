/** Internal worker policy only; not a new public erase or administrator API. */
export const COMPLETED_REPLAY_MODE = "same-epoch-completed-content-replay-v1";
export function completedReplayEnabled(value) {
  if (value === undefined || value === "disabled") return false;
  if (value !== COMPLETED_REPLAY_MODE) throw Error("INVALID_COMPLETED_REPLAY_MODE");
  return true;
}
