import { PositionEval } from "@/types/eval";
import { getIsStalemate, getWhoIsCheckmated } from "../chess";
import { getLichessEval } from "../lichess";
import { logMessageIfLocalhost } from "../helpers";
import { isKnownOpeningPosition } from "../openingsLookup";

/** Shallow cloud entries are ignored; fall back to local engine instead. */
export const LICHESS_MIN_USABLE_DEPTH = 20;

/** Pre-move eval needs two lines to compare played move vs best (see moveClassification). */
export const LICHESS_CLASSIFICATION_MIN_PV = 2;

/** First 5 plies (indices 0–5) — mainstream theory is virtually always cached. */
export const LICHESS_ALWAYS_TRY_MAX_PLY = 5;

export const LICHESS_MAX_PIECES = 7;

export type LichessTryReason = "early" | "opening" | "endgame";

export type LichessCloudMissReason = "404" | "shallow" | "insufficient-pv";

export interface LichessCloudEvalResult {
  eval: PositionEval | null;
  missReason?: LichessCloudMissReason;
  /** Cloud returned fewer PV lines than the live UI requested. */
  partialMultiPv?: boolean;
  requiredMultiPv?: number;
}

const countBoardPieces = (fen: string): number => {
  return fen.split(" ")[0].replace(/[^a-zA-Z]/g, "").length;
};

const getPliesPlayed = (fen: string): number => {
  const parts = fen.split(" ");
  const fullMoveNumber = parseInt(parts[5] || "1", 10);
  const sideToMove = parts[1] || "w";
  return (fullMoveNumber - 1) * 2 + (sideToMove === "b" ? 1 : 0);
};

const isWithinEarlyOpeningWindow = (
  fen: string,
  positionIndex?: number
): boolean => {
  if (
    positionIndex !== undefined &&
    positionIndex <= LICHESS_ALWAYS_TRY_MAX_PLY
  ) {
    return true;
  }

  return getPliesPlayed(fen) <= LICHESS_ALWAYS_TRY_MAX_PLY;
};

export const getLichessTryReason = (
  fen: string,
  positionIndex?: number
): LichessTryReason | undefined => {
  if (isWithinEarlyOpeningWindow(fen, positionIndex)) return "early";
  if (isKnownOpeningPosition(fen)) return "opening";
  if (countBoardPieces(fen) <= LICHESS_MAX_PIECES) return "endgame";
  return undefined;
};

export const shouldTryLichessCloudEval = (
  fen: string,
  positionIndex?: number
): boolean => {
  return getLichessTryReason(fen, positionIndex) !== undefined;
};

const isTerminalEnginePosition = (fen: string): boolean => {
  return !!getWhoIsCheckmated(fen) || getIsStalemate(fen);
};

/** Scan all plies, fire HTTP immediately, return cloud vs local WASM split. */
export const planAndStartLichessPrefetch = (
  fens: string[],
  uciMoves: string[],
  sessionId: number
): {
  lichessCache: LichessPrefetchCache;
  cloudIndices: number[];
  localIndices: number[];
} => {
  const cloudIndices: number[] = [];
  const wasmIndices: number[] = [];

  for (let index = 0; index < fens.length; index++) {
    if (isTerminalEnginePosition(fens[index])) continue;

    wasmIndices.push(index);
    if (getLichessTryReason(fens[index], index)) {
      cloudIndices.push(index);
    }
  }

  const lichessCache = new LichessPrefetchCache(fens, uciMoves);

  logMessageIfLocalhost(
    `[analysis #${sessionId}] Plan: ${cloudIndices.length} Lichess prefetch [${cloudIndices.join(",")}], ${wasmIndices.length} WASM [${wasmIndices.join(",")}]`
  );
  logMessageIfLocalhost(
    `[analysis #${sessionId}] Prefiring ${lichessCache.candidateCount} HTTP requests now`
  );

  return { lichessCache, cloudIndices, localIndices: wasmIndices };
};

export const isLichessCloudEvalUsable = (
  evalResult: PositionEval,
  minLines = 1
): boolean => {
  if (evalResult.lines.length < minLines) return false;

  const cloudDepth = evalResult.lines[0].depth ?? 0;
  return cloudDepth >= LICHESS_MIN_USABLE_DEPTH;
};

export const getLichessCloudMissReason = (
  evalResult: PositionEval,
  minLines = 1
): LichessCloudMissReason => {
  if (evalResult.lines.length === 0) return "404";
  if (evalResult.lines.length < minLines) return "insufficient-pv";

  const cloudDepth = evalResult.lines[0].depth ?? 0;
  if (cloudDepth < LICHESS_MIN_USABLE_DEPTH) return "shallow";

  return "404";
};

/**
 * How many PV lines to request from Lichess for a game-analysis position.
 * Book tabiyas only need depth + best move (Opening comes from FEN lookup).
 * Endgame and everything else needs an alternative line to classify the next ply.
 */
export const getLichessRequiredMultiPvForGame = (
  index: number,
  fens: string[]
): number => {
  const fen = fens[index];

  if (isKnownOpeningPosition(fen)) return 1;
  if (index + 1 >= fens.length) return 1;
  if (isKnownOpeningPosition(fens[index + 1])) return 1;

  return LICHESS_CLASSIFICATION_MIN_PV;
};

/** multiPv=1 is enough when the next ply is book or the played move matches cloud best. */
export const canAcceptLichessCloudEvalWithSinglePv = (
  index: number,
  fens: string[],
  uciMoves: string[],
  evalResult: PositionEval
): boolean => {
  if (getLichessRequiredMultiPvForGame(index, fens) === 1) return true;

  if (index + 1 < fens.length && isKnownOpeningPosition(fens[index + 1])) {
    return true;
  }

  const playedMove = uciMoves[index];
  if (playedMove && evalResult.bestMove && playedMove === evalResult.bestMove) {
    return true;
  }

  return false;
};

const getLichessRequiredMultiPvForLive = (
  fen: string,
  requestedMultiPv: number
): number => {
  if (isKnownOpeningPosition(fen)) return 1;
  return Math.max(LICHESS_CLASSIFICATION_MIN_PV, requestedMultiPv);
};

export const resolveLichessCloudEvalForGame = async (
  index: number,
  fens: string[],
  uciMoves: string[]
): Promise<LichessCloudEvalResult> => {
  const fen = fens[index];
  const classificationMultiPv = getLichessRequiredMultiPvForGame(index, fens);
  const playedMove = uciMoves[index] ?? "";
  const cacheKey = `${fen}|${classificationMultiPv}|${playedMove}`;

  const cached = lichessGameEvalCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const evalPv1 = await getLichessEval(fen, 1);

  if (!isLichessCloudEvalUsable(evalPv1, 1)) {
    const result: LichessCloudEvalResult = {
      eval: null,
      missReason: getLichessCloudMissReason(evalPv1, 1),
      requiredMultiPv: classificationMultiPv,
    };
    lichessGameEvalCache.set(cacheKey, result);
    return result;
  }

  if (
    classificationMultiPv === 1 ||
    canAcceptLichessCloudEvalWithSinglePv(index, fens, uciMoves, evalPv1)
  ) {
    const result: LichessCloudEvalResult = {
      eval: evalPv1,
      requiredMultiPv: 1,
    };
    lichessGameEvalCache.set(cacheKey, result);
    return result;
  }

  const evalPv2 = await getLichessEval(fen, LICHESS_CLASSIFICATION_MIN_PV);

  let result: LichessCloudEvalResult;
  if (isLichessCloudEvalUsable(evalPv2, LICHESS_CLASSIFICATION_MIN_PV)) {
    result = {
      eval: evalPv2,
      requiredMultiPv: LICHESS_CLASSIFICATION_MIN_PV,
    };
  } else {
    result = {
      eval: null,
      missReason: getLichessCloudMissReason(
        evalPv2,
        LICHESS_CLASSIFICATION_MIN_PV
      ),
      requiredMultiPv: LICHESS_CLASSIFICATION_MIN_PV,
    };
  }

  lichessGameEvalCache.set(cacheKey, result);
  return result;
};

const lichessGameEvalCache = new Map<string, LichessCloudEvalResult>();

/** Fire all eligible Lichess lookups at analysis start; workers keep running locally meanwhile. */
export class LichessPrefetchCache {
  private readonly pending = new Map<number, Promise<LichessCloudEvalResult>>();
  private readonly settled = new Map<number, LichessCloudEvalResult>();

  constructor(fens: string[], uciMoves: string[]) {
    for (let index = 0; index < fens.length; index++) {
      if (!shouldTryLichessCloudEval(fens[index], index)) continue;

      const promise = resolveLichessCloudEvalForGame(
        index,
        fens,
        uciMoves
      ).then((result) => {
        this.settled.set(index, result);
        return result;
      });
      this.pending.set(index, promise);
    }
  }

  get candidateCount(): number {
    return this.pending.size;
  }

  isCandidate(index: number): boolean {
    return this.pending.has(index);
  }

  isPending(index: number): boolean {
    return this.pending.has(index) && !this.settled.has(index);
  }

  getSettled(index: number): LichessCloudEvalResult | undefined {
    return this.settled.get(index);
  }

  getCandidateIndices(): number[] {
    return [...this.pending.keys()];
  }

  isAllSettled(): boolean {
    if (this.pending.size === 0) return true;
    return this.settled.size === this.pending.size;
  }

  awaitResult(index: number): Promise<LichessCloudEvalResult | undefined> {
    return this.pending.get(index) ?? Promise.resolve(undefined);
  }
}

export const resolveLichessCloudEvalForLive = async (
  fen: string,
  requestedMultiPv: number
): Promise<LichessCloudEvalResult> => {
  const requiredMultiPv = getLichessRequiredMultiPvForLive(
    fen,
    requestedMultiPv
  );

  const evalResult = await getLichessEval(fen, requiredMultiPv);
  if (isLichessCloudEvalUsable(evalResult, requiredMultiPv)) {
    return {
      eval: evalResult,
      requiredMultiPv,
      partialMultiPv: requestedMultiPv > evalResult.lines.length,
    };
  }

  return {
    eval: null,
    missReason: getLichessCloudMissReason(evalResult, requiredMultiPv),
    requiredMultiPv,
  };
};
