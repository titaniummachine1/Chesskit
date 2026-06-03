let activeSessionId = 0;
let uiAnalysisLock = false;
let onAnalysisUnlock: (() => void) | null = null;

export const beginGameAnalysisSession = (): number => {
  activeSessionId++;
  return activeSessionId;
};

/** Invalidates in-flight analysis (e.g. engine shutdown) without starting a new run. */
export const cancelGameAnalysisSession = (): void => {
  activeSessionId++;
};

export const isGameAnalysisSessionActive = (sessionId: number): boolean => {
  return sessionId === activeSessionId;
};

export const tryAcquireUiAnalysisLock = (): boolean => {
  if (uiAnalysisLock) return false;
  uiAnalysisLock = true;
  return true;
};

export const releaseUiAnalysisLock = (): void => {
  uiAnalysisLock = false;
  onAnalysisUnlock?.();
  onAnalysisUnlock = null;
};

export const isUiAnalysisLocked = (): boolean => uiAnalysisLock;

/** Runs immediately when no analysis is active, otherwise after the UI lock is released. */
export const runAfterAnalysisUnlock = (callback: () => void): void => {
  if (!uiAnalysisLock) {
    callback();
    return;
  }

  onAnalysisUnlock = callback;
};
