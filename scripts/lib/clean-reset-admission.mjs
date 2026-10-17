/** Narrow composition port. The real Root implementation is NOT supplied here. */
export async function withResetWork(rootGate, context, work) {
  if (typeof rootGate?.withResetAdmission !== "function") throw new Error("RESET_ROOT_GATE_REQUIRED");
  let open = true,
    flight,
    value,
    error;
  const current = () => {
    if (!open) throw new Error("RESET_ADMISSION_CLOSED");
  };
  try {
    value = await rootGate.withResetAdmission(Object.freeze(context), (admission) => {
      current();
      if (flight) throw new Error("RESET_ADMISSION_CALLBACK_INVALID");
      flight = (async () => {
        if (typeof admission?.assertCurrent !== "function") throw new Error("RESET_LIVE_ADMISSION_REQUIRED");
        return work(admission, current);
      })();
      void flight.catch(() => {});
      return flight;
    });
  } catch (e) {
    error = e;
  } finally {
    open = false;
  }
  let result, failed;
  if (flight)
    try {
      result = await flight;
    } catch (e) {
      failed = e;
    }
  if (error || failed) throw error ?? failed;
  if (!result || result !== value) throw new Error("RESET_ADMISSION_DID_NOT_COMPLETE_WORK");
  return result;
}
