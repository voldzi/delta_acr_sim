export const SAFETY_NOTIFICATION_LOAD_BUDGET_MS = 8_000;

export class SafetyNotificationLoadBudgetExceededError extends Error {
  constructor() {
    super("Safety notification input did not load within its request budget.");
    this.name = "SafetyNotificationLoadBudgetExceededError";
  }
}

/** Bound candidate requests without cancelling the existing coalesced cache refresh. */
export async function loadSafetyNotificationInputWithinBudget<T>(load: () => Promise<T>): Promise<T> {
  const pending = Promise.resolve().then(load);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new SafetyNotificationLoadBudgetExceededError()), SAFETY_NOTIFICATION_LOAD_BUDGET_MS);
  });

  try {
    // The race observes late rejections too, after a timed-out request has returned.
    // Keep the underlying load alive so another request can reuse its cache entry.
    return await Promise.race([pending, deadline]);
  } finally {
    clearTimeout(timer);
  }
}
