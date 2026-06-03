export interface EngineWorker {
  isReady: boolean;
  /** True while this worker is reserved for full-game analysis lanes. */
  inGameAnalysis?: boolean;
  uci(command: string): void;
  listen: (data: string) => void;
  terminate: () => void;
}

export interface WorkerJob {
  commands: string[];
  finalMessage: string;
  onNewMessage?: (messages: string[]) => void;
  resolve: (messages: string[]) => void;
}
