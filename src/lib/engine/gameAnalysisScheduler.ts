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
  retired?: boolean;
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
  onReleaseWorker?: (worker: EngineWorker) => void;
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

const isLaneBusy = (
  lane: AnalysisLane,
  isIndexDone: (index: number) => boolean
): boolean => {
  if (lane.retired) return false;

  if (lane.currentIndex !== null && !isIndexDone(lane.currentIndex)) {
    return true;
  }

  return lane.pendingIndices.some((index) => !isIndexDone(index));
};

const countActiveLanes = (lanes: AnalysisLane[]): number => {
  return lanes.filter((lane) => !lane.retired).length;
};

const countUndoneWasmIndices = (
  lanes: AnalysisLane[],
  isIndexDone: (index: number) => boolean
): number => {
  const undone = new Set<number>();

  for (const lane of lanes) {
    if (lane.retired) continue;

    for (const index of lane.pendingIndices) {
      if (!isIndexDone(index)) undone.add(index);
    }

    if (lane.currentIndex !== null && !isIndexDone(lane.currentIndex)) {
      undone.add(lane.currentIndex);
    }
  }

  return undone.size;
};

const tryRetireIdleLane = (
  lane: AnalysisLane,
  lanes: AnalysisLane[],
  lichessCache: LichessPrefetchCache,
  isIndexDone: (index: number) => boolean,
  onReleaseWorker: ((worker: EngineWorker) => void) | undefined,
  logger: AnalysisLogger
): boolean => {
  if (lane.retired || isLaneBusy(lane, isIndexDone)) return false;
  if (!lichessCache.isAllSettled()) return false;
  if (!onReleaseWorker) return false;

  const activeLanes = countActiveLanes(lanes);
  const undoneWasm = countUndoneWasmIndices(lanes, isIndexDone);

  if (activeLanes <= 1 || undoneWasm >= activeLanes) return false;

  lane.retired = true;
  onReleaseWorker(lane.worker);
  logger.log(
    `Lane ${lane.id} retired (${activeLanes - 1} workers left, ${undoneWasm} WASM ply(s) pending)`
  );
  return true;
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
    if (lane.id === idleLaneId || lane.retired) continue;

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
  if (idleLane.retired) return false;

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
  const activeLanes = lanes.filter((lane) => !lane.retired);
  if (activeLanes.length === 0) return;

  for (const lane of activeLanes) {
    if (lane.pendingIndices.includes(index) || lane.currentIndex === index) {
      return;
    }
  }

  let lightestLane = activeLanes[0];
  let lightestWork = getPendingWorkWeight(
    lightestLane.pendingIndices,
    positionWeights
  );

  for (let laneId = 1; laneId < activeLanes.length; laneId++) {
    const lane = activeLanes[laneId];
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

const runCloudCoordinator = async (
  lichessCache: LichessPrefetchCache,
  lanes: AnalysisLane[],
  fens: string[],
  depth: number,
  positionWeights: number[],
  coordinator: WorkCoordinator,
  progressTracker: AnalysisProgressTracker,
  logger: AnalysisLogger,
  isSessionActive: () => boolean,
  isIndexDone: (index: number) => boolean,
  onPositionComplete: (index: number, positionEval: PositionEval) => void
): Promise<void> => {
  const candidates = lichessCache.getCandidateIndices();
  if (candidates.length === 0) return;

  await Promise.all(
    candidates.map(async (index) => {
      const result = await lichessCache.awaitResult(index);
      if (!isSessionActive() || !result) return;

      if (result.eval) {
        if (isIndexDone(index)) return;

        const lichessReason = getLichessTryReason(fens[index], index);
        const cloudDepth = result.eval.lines[0].depth ?? depth;
        logMessageIfLocalhost(
          `Lichess cloud hit pos #${index} (${lichessReason}, depth ${cloudDepth}, pv ${result.eval.lines.length}/${result.requiredMultiPv})`
        );
        removeIndexFromLaneQueues(lanes, index);
        progressTracker.setLaneDepth(LICHESS_COORDINATOR_LANE, index, depth);
        progressTracker.markComplete(index, LICHESS_COORDINATOR_LANE);
        onPositionComplete(index, result.eval);
      } else {
        const lichessReason = getLichessTryReason(fens[index], index);
        logMessageIfLocalhost(
          `Lichess cloud ${result.missReason} pos #${index} (${lichessReason}, need pv ${result.requiredMultiPv})`
        );
        if (!isIndexDone(index)) {
          injectLocalWork(lanes, index, positionWeights, logger);
        }
      }

      coordinator.notifyWorkAvailable();
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

    const parsedDepth = parseInt(depthValue, 10);
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

const runLane = async (
  lane: AnalysisLane,
  lanes: AnalysisLane[],
  coordinator: WorkCoordinator,
  lichessCache: LichessPrefetchCache,
  logger: AnalysisLogger,
  fens: string[],
  depth: number,
  positionWeights: number[],
  progressTracker: AnalysisProgressTracker,
  isSessionActive: () => boolean,
  isIndexDone: (index: number) => boolean,
  onPositionComplete: (index: number, positionEval: PositionEval) => void,
  onReleaseWorker: ((worker: EngineWorker) => void) | undefined,
  getCompleted: () => number,
  isGlobalComplete: () => boolean
) => {
  while (!lane.retired && !isGlobalComplete() && isSessionActive()) {
    if (lane.pendingIndices.length === 0) {
      if (
        tryStealFromBusiestPeer(
          lanes,
          lane,
          positionWeights,
          isIndexDone,
          logger
        )
      ) {
        coordinator.notifyWorkAvailable();
        continue;
      }

      if (isGlobalComplete() || !isSessionActive()) break;

      if (
        tryRetireIdleLane(
          lane,
          lanes,
          lichessCache,
          isIndexDone,
          onReleaseWorker,
          logger
        )
      ) {
        coordinator.notifyWorkAvailable();
        break;
      }

      await coordinator.waitForWork();
      continue;
    }

    if (!isSessionActive()) break;

    const index = takeNextPendingIndex(lane, isIndexDone);
    if (index === undefined) continue;

    lane.currentIndex = index;

    const positionStartedAt = performance.now();
    const { eval: positionEval, depthReached } = await evaluatePosition(
      lane.worker,
      fens[index],
      depth,
      lane.id,
      index,
      progressTracker
    );
    const positionMs = performance.now() - positionStartedAt;

    if (!isSessionActive()) break;

    if (isIndexDone(index)) {
      lane.currentIndex = null;
      coordinator.notifyWorkAvailable();
      continue;
    }

    progressTracker.markComplete(index, lane.id);
    onPositionComplete(index, positionEval);

    lane.currentIndex = null;
    lane.completedCount++;

    logger.logPositionDone(
      lane.id,
      index,
      positionMs,
      depthReached,
      getCompleted(),
      fens.length,
      progressTracker.getProgress()
    );
    coordinator.notifyWorkAvailable();
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
  onReleaseWorker,
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

  await Promise.all([
    runCloudCoordinator(
      lichessCache,
      lanes,
      fens,
      depth,
      positionWeights,
      coordinator,
      progressTracker,
      logger,
      isSessionActive,
      isIndexDone,
      wrappedOnComplete
    ),
    ...lanes.map((lane) =>
      runLane(
        lane,
        lanes,
        coordinator,
        lichessCache,
        logger,
        fens,
        depth,
        positionWeights,
        progressTracker,
        isSessionActive,
        isIndexDone,
        wrappedOnComplete,
        onReleaseWorker,
        () => completed,
        isGlobalComplete
      )
    ),
  ]);

  if (isSessionActive()) {
    const activeLanes = countActiveLanes(lanes);
    logger.logFinished(completed, activeLanes);
  } else {
    logger.log("Aborted (superseded by newer analysis session)");
  }

  for (const lane of lanes) {
    if (lane.retired) continue;
    lane.worker.isReady = true;
  }
};
