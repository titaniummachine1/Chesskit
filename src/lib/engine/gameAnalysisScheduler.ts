import { getIsStalemate, getWhoIsCheckmated } from "../chess";
import { formatElapsedMs, logMessageIfLocalhost } from "../helpers";
import { EngineWorker } from "@/types/engine";
import { PositionEval } from "@/types/eval";
import { AnalysisProgressTracker } from "./analysisProgressTracker";
import { getLichessTryReason, LichessPrefetchCache } from "./lichessCloudEval";
import {
  assignIndicesToLanesByWorkWeight,
  buildPositionWorkWeights,
  getPendingWorkWeight,
} from "./positionWorkWeights";
import {
  getResultProperty,
  parseEvaluationResults,
} from "./helpers/parseResults";
import { sendCommandsToWorker } from "./worker";

interface AnalysisLane {
  id: number;
  worker: EngineWorker;
  pendingIndices: number[];
  currentIndex: number | null;
  completedCount: number;
}

export interface RunGameAnalysisParams {
  workers: EngineWorker[];
  fens: string[];
  depth: number;
  sessionId: number;
  lichessCache: LichessPrefetchCache;
  progressTracker: AnalysisProgressTracker;
  isSessionActive: () => boolean;
  onPositionComplete: (index: number, positionEval: PositionEval) => void;
}

class AnalysisLogger {
  private readonly startedAt = performance.now();
  private engineCompleted = 0;

  constructor(private readonly sessionId: number) {}

  private prefix(): string {
    return `[analysis #${this.sessionId} +${formatElapsedMs(performance.now() - this.startedAt)}]`;
  }

  log(message: string) {
    logMessageIfLocalhost(`${this.prefix()} ${message}`);
  }

  logPositionDone(
    laneId: number,
    index: number,
    positionMs: number,
    depthReached: number,
    completed: number,
    total: number,
    progressPercent: number
  ) {
    this.engineCompleted++;
    const elapsed = performance.now() - this.startedAt;
    const rate = elapsed > 0 ? (this.engineCompleted / elapsed) * 1000 : 0;

    logMessageIfLocalhost(
      `${this.prefix()} L${laneId} pos #${index} depth ${depthReached} in ${formatElapsedMs(positionMs)} | ${completed}/${total} | progress ${progressPercent.toFixed(1)}% (${rate.toFixed(2)} pos/s)`
    );
  }

  logFinished(completed: number, laneCount: number) {
    const elapsed = performance.now() - this.startedAt;
    const rate = elapsed > 0 ? (completed / elapsed) * 1000 : 0;

    logMessageIfLocalhost(
      `${this.prefix()} Finished ${completed} positions with ${laneCount} lanes in ${formatElapsedMs(elapsed)} (${rate.toFixed(2)} pos/s avg)`
    );
  }
}

class WorkCoordinator {
  private readonly waiters = new Set<() => void>();

  waitForWork(): Promise<void> {
    return new Promise((resolve) => {
      this.waiters.add(resolve);
    });
  }

  notifyWorkAvailable() {
    for (const resolve of this.waiters) {
      resolve();
    }
    this.waiters.clear();
  }
}

const getTerminalPositionEval = (fen: string): PositionEval | undefined => {
  const whoIsCheckmated = getWhoIsCheckmated(fen);
  if (whoIsCheckmated) {
    return {
      lines: [
        {
          pv: [],
          depth: 0,
          multiPv: 1,
          mate: whoIsCheckmated === "w" ? -1 : 1,
        },
      ],
    };
  }

  if (getIsStalemate(fen)) {
    return {
      lines: [
        {
          pv: [],
          depth: 0,
          multiPv: 1,
          cp: 0,
        },
      ],
    };
  }

  return undefined;
};

export const countEnginePositions = (fens: string[]): number => {
  let count = 0;

  for (const fen of fens) {
    if (!getTerminalPositionEval(fen)) {
      count++;
    }
  }

  return count;
};

export const getEffectiveWorkersNb = (
  requestedWorkersNb: number,
  enginePositionCount: number
): number => {
  if (enginePositionCount <= 0) return 1;
  return Math.min(requestedWorkersNb, enginePositionCount);
};

const buildPositionCommand = (fen: string): string => {
  return `position fen ${fen}`;
};

const getStealCount = (pendingCount: number): number => {
  if (pendingCount <= 1) return pendingCount;
  if (pendingCount === 2) return 1;
  return Math.ceil(pendingCount / 2);
};

const findBusiestPeer = (
  lanes: AnalysisLane[],
  idleLaneId: number,
  positionWeights: number[],
  isIndexDone: (index: number) => boolean
): AnalysisLane | undefined => {
  let busiest: AnalysisLane | undefined;
  let maxWorkWeight = 0;

  for (const lane of lanes) {
    if (lane.id === idleLaneId) continue;

    const undonePending = lane.pendingIndices.filter(
      (index) => !isIndexDone(index)
    );
    const workWeight = getPendingWorkWeight(undonePending, positionWeights);
    if (workWeight <= 0) continue;

    if (
      !busiest ||
      workWeight > maxWorkWeight ||
      (workWeight === maxWorkWeight && lane.id < busiest.id)
    ) {
      maxWorkWeight = workWeight;
      busiest = lane;
    }
  }

  return busiest;
};

const tryStealFromBusiestPeer = (
  lanes: AnalysisLane[],
  idleLane: AnalysisLane,
  positionWeights: number[],
  isIndexDone: (index: number) => boolean,
  logger: AnalysisLogger
): boolean => {
  const victim = findBusiestPeer(
    lanes,
    idleLane.id,
    positionWeights,
    isIndexDone
  );
  if (!victim) return false;

  const undonePending = victim.pendingIndices.filter(
    (index) => !isIndexDone(index)
  );
  if (undonePending.length === 0) return false;

  const stealCount = getStealCount(undonePending.length);
  const toSteal = new Set(
    undonePending.slice(undonePending.length - stealCount)
  );
  const stolen = victim.pendingIndices.filter((index) => toSteal.has(index));
  victim.pendingIndices = victim.pendingIndices.filter(
    (index) => !toSteal.has(index)
  );

  idleLane.pendingIndices.push(...stolen);
  stolen.sort((a, b) => a - b);

  const victimWorkLeft = getPendingWorkWeight(
    victim.pendingIndices,
    positionWeights
  );
  const stolenWork = stolen.reduce(
    (sum, index) => sum + positionWeights[index],
    0
  );

  logger.log(
    `Lane ${idleLane.id} stole [${stolen.join(", ")}] (work ${stolenWork.toFixed(2)}) from lane ${victim.id} (work left ${victimWorkLeft.toFixed(2)})`
  );

  return true;
};

const injectLocalWork = (
  lanes: AnalysisLane[],
  index: number,
  positionWeights: number[],
  logger: AnalysisLogger
): void => {
  if (lanes.length === 0) return;

  for (const lane of lanes) {
    if (lane.pendingIndices.includes(index) || lane.currentIndex === index) {
      return;
    }
  }

  let lightestLane = lanes[0];
  let lightestWork = getPendingWorkWeight(
    lightestLane.pendingIndices,
    positionWeights
  );

  for (let laneId = 1; laneId < lanes.length; laneId++) {
    const lane = lanes[laneId];
    const work = getPendingWorkWeight(lane.pendingIndices, positionWeights);
    if (work < lightestWork) {
      lightestWork = work;
      lightestLane = lane;
    }
  }

  lightestLane.pendingIndices.push(index);
  lightestLane.pendingIndices.sort((a, b) => a - b);

  const newWork = getPendingWorkWeight(
    lightestLane.pendingIndices,
    positionWeights
  );
  logger.log(
    `Cloud miss pos #${index} → lane ${lightestLane.id} (work weight ${newWork.toFixed(2)})`
  );
};

const removeIndexFromLaneQueues = (
  lanes: AnalysisLane[],
  index: number
): void => {
  for (const lane of lanes) {
    lane.pendingIndices = lane.pendingIndices.filter((i) => i !== index);
  }
};

const takeNextPendingIndex = (
  lane: AnalysisLane,
  isIndexDone: (index: number) => boolean
): number | undefined => {
  while (lane.pendingIndices.length > 0) {
    const index = lane.pendingIndices.shift()!;
    if (!isIndexDone(index)) return index;
  }

  return undefined;
};

const LICHESS_COORDINATOR_LANE = -1;

interface GameAnalysisRunContext {
  lanes: AnalysisLane[];
  fens: string[];
  depth: number;
  positionWeights: number[];
  coordinator: WorkCoordinator;
  progressTracker: AnalysisProgressTracker;
  logger: AnalysisLogger;
  lichessCache: LichessPrefetchCache;
  isSessionActive: () => boolean;
  isIndexDone: (index: number) => boolean;
  onPositionComplete: (index: number, positionEval: PositionEval) => void;
  getCompleted: () => number;
  isGlobalComplete: () => boolean;
}

const handleCloudPrefetchResult = (
  index: number,
  result: NonNullable<Awaited<ReturnType<LichessPrefetchCache["awaitResult"]>>>,
  ctx: GameAnalysisRunContext
): void => {
  if (result.eval) {
    if (ctx.isIndexDone(index)) return;

    const lichessReason = getLichessTryReason(ctx.fens[index], index);
    const cloudDepth = result.eval.lines[0].depth ?? ctx.depth;
    logMessageIfLocalhost(
      `Lichess cloud hit pos #${index} (${lichessReason}, depth ${cloudDepth}, pv ${result.eval.lines.length}/${result.requiredMultiPv})`
    );
    removeIndexFromLaneQueues(ctx.lanes, index);
    ctx.progressTracker.setLaneDepth(
      LICHESS_COORDINATOR_LANE,
      index,
      ctx.depth
    );
    ctx.progressTracker.markComplete(index, LICHESS_COORDINATOR_LANE);
    ctx.onPositionComplete(index, result.eval);
    return;
  }

  const lichessReason = getLichessTryReason(ctx.fens[index], index);
  logMessageIfLocalhost(
    `Lichess cloud ${result.missReason} pos #${index} (${lichessReason}, need pv ${result.requiredMultiPv})`
  );
  if (!ctx.isIndexDone(index)) {
    injectLocalWork(ctx.lanes, index, ctx.positionWeights, ctx.logger);
  }
};

const runCloudCoordinator = async (
  ctx: GameAnalysisRunContext
): Promise<void> => {
  const candidates = ctx.lichessCache.getCandidateIndices();
  if (candidates.length === 0) return;

  await Promise.all(
    candidates.map(async (index) => {
      const result = await ctx.lichessCache.awaitResult(index);
      if (!ctx.isSessionActive() || !result) return;

      handleCloudPrefetchResult(index, result, ctx);
      ctx.coordinator.notifyWorkAvailable();
    })
  );
};

const evaluatePosition = async (
  worker: EngineWorker,
  fen: string,
  depth: number,
  laneId: number,
  index: number,
  progressTracker: AnalysisProgressTracker
): Promise<{ eval: PositionEval; depthReached: number }> => {
  let depthReached = 0;

  const onNewMessage = (messages: string[]) => {
    const message = messages.at(-1);
    if (!message?.startsWith("info ")) return;

    const depthValue = getResultProperty(message, "depth");
    if (!depthValue) return;

    const parsedDepth = Number.parseInt(depthValue, 10);
    if (parsedDepth > depthReached) {
      depthReached = parsedDepth;
      progressTracker.setLaneDepth(laneId, index, depthReached);
    }
  };

  progressTracker.setLaneDepth(laneId, index, 0);

  const results = await sendCommandsToWorker(
    worker,
    [buildPositionCommand(fen), `go depth ${depth}`],
    "bestmove",
    onNewMessage
  );

  if (depthReached === 0) {
    depthReached = depth;
  }

  return {
    eval: parseEvaluationResults(results, fen),
    depthReached,
  };
};

const waitForLaneWork = async (
  lane: AnalysisLane,
  ctx: GameAnalysisRunContext
): Promise<boolean> => {
  if (
    tryStealFromBusiestPeer(
      ctx.lanes,
      lane,
      ctx.positionWeights,
      ctx.isIndexDone,
      ctx.logger
    )
  ) {
    ctx.coordinator.notifyWorkAvailable();
    return true;
  }

  if (ctx.isGlobalComplete() || !ctx.isSessionActive()) return false;

  await ctx.coordinator.waitForWork();
  return true;
};

const finishLanePosition = (
  lane: AnalysisLane,
  index: number,
  positionEval: PositionEval,
  depthReached: number,
  positionMs: number,
  ctx: GameAnalysisRunContext
): void => {
  ctx.progressTracker.markComplete(index, lane.id);
  ctx.onPositionComplete(index, positionEval);
  lane.currentIndex = null;
  lane.completedCount++;

  ctx.logger.logPositionDone(
    lane.id,
    index,
    positionMs,
    depthReached,
    ctx.getCompleted(),
    ctx.fens.length,
    ctx.progressTracker.getProgress()
  );
  ctx.coordinator.notifyWorkAvailable();
};

const runLane = async (lane: AnalysisLane, ctx: GameAnalysisRunContext) => {
  while (!ctx.isGlobalComplete() && ctx.isSessionActive()) {
    if (lane.pendingIndices.length === 0) {
      const shouldContinue = await waitForLaneWork(lane, ctx);
      if (!shouldContinue) break;
      continue;
    }

    if (!ctx.isSessionActive()) break;

    const index = takeNextPendingIndex(lane, ctx.isIndexDone);
    if (index === undefined) continue;

    lane.currentIndex = index;

    const positionStartedAt = performance.now();
    const { eval: positionEval, depthReached } = await evaluatePosition(
      lane.worker,
      ctx.fens[index],
      ctx.depth,
      lane.id,
      index,
      ctx.progressTracker
    );
    const positionMs = performance.now() - positionStartedAt;

    if (!ctx.isSessionActive()) break;

    if (ctx.isIndexDone(index)) {
      lane.currentIndex = null;
      ctx.coordinator.notifyWorkAvailable();
      continue;
    }

    finishLanePosition(
      lane,
      index,
      positionEval,
      depthReached,
      positionMs,
      ctx
    );
  }
};

export const runGameAnalysis = async ({
  workers,
  fens,
  depth,
  sessionId,
  lichessCache,
  progressTracker,
  isSessionActive,
  onPositionComplete,
}: RunGameAnalysisParams): Promise<void> => {
  const logger = new AnalysisLogger(sessionId);
  let completed = 0;
  const finishedIndices = new Set<number>();
  const positionWeights = buildPositionWorkWeights(fens.length);

  const wrappedOnComplete = (index: number, positionEval: PositionEval) => {
    if (finishedIndices.has(index)) return;
    finishedIndices.add(index);
    completed++;
    onPositionComplete(index, positionEval);
  };

  const localIndices: number[] = [];

  for (let index = 0; index < fens.length; index++) {
    const terminalEval = getTerminalPositionEval(fens[index]);
    if (terminalEval) {
      progressTracker.markComplete(index, -1);
      wrappedOnComplete(index, terminalEval);
      continue;
    }

    localIndices.push(index);
  }

  if (localIndices.length === 0) {
    return;
  }
  if (!isSessionActive()) return;

  const laneCount = Math.min(workers.length, Math.max(localIndices.length, 1));
  const indexChunks = assignIndicesToLanesByWorkWeight(
    localIndices,
    laneCount,
    positionWeights
  );

  const cloudCandidateCount = lichessCache.candidateCount;

  for (const worker of workers.slice(0, indexChunks.length)) {
    worker.isReady = false;
  }

  const lanes: AnalysisLane[] = indexChunks.map((pendingIndices, id) => ({
    id,
    worker: workers[id],
    pendingIndices,
    currentIndex: null,
    completedCount: 0,
  }));

  logger.log(
    `Started ${lanes.length} WASM lanes for ${localIndices.length} positions (${cloudCandidateCount} with Lichess prefetch), depth ${depth}`
  );
  lanes.forEach((lane) => {
    const laneWork = getPendingWorkWeight(lane.pendingIndices, positionWeights);
    logger.log(
      `Lane ${lane.id} initial queue: [${lane.pendingIndices.join(", ")}] (work weight ${laneWork.toFixed(2)})`
    );
  });

  const coordinator = new WorkCoordinator();
  const isGlobalComplete = () => completed >= fens.length;
  const isIndexDone = (index: number) => finishedIndices.has(index);

  const runContext: GameAnalysisRunContext = {
    lanes,
    fens,
    depth,
    positionWeights,
    coordinator,
    progressTracker,
    logger,
    lichessCache,
    isSessionActive,
    isIndexDone,
    onPositionComplete: wrappedOnComplete,
    getCompleted: () => completed,
    isGlobalComplete,
  };

  await Promise.all([
    runCloudCoordinator(runContext),
    ...lanes.map((lane) => runLane(lane, runContext)),
  ]);

  if (isSessionActive()) {
    logger.logFinished(completed, lanes.length);
  } else {
    logger.log("Aborted (superseded by newer analysis session)");
  }

  for (const worker of workers.slice(0, lanes.length)) {
    worker.isReady = true;
  }
};
