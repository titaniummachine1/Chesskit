import { DEFAULT_ENGINE } from "@/constants";
import { getRecommendedWorkersNb } from "@/lib/engine/worker";
import { readStoredJson } from "@/lib/storage";
import { EngineName } from "@/types/enums";
import { CurrentPosition, GameEval, SavedEvals } from "@/types/eval";
import { Chess } from "chess.js";
import { atom } from "jotai";
import { atomWithStorage } from "jotai/utils";

export const gameEvalAtom = atom<GameEval | undefined>(undefined);
export const gameAtom = atom(new Chess());
export const boardAtom = atom(new Chess());
export const currentPositionAtom = atom<CurrentPosition>({});

export const boardOrientationAtom = atom(true);
export const showBestMoveArrowAtom = atom(true);
export const showPlayerMoveIconAtom = atom(true);

export const engineNameAtom = atomWithStorage<EngineName>(
  "engine-name",
  readStoredJson("engine-name", DEFAULT_ENGINE)
);
export const engineDepthAtom = atomWithStorage(
  "engine-depth",
  readStoredJson("engine-depth", 14)
);
export const engineMultiPvAtom = atomWithStorage(
  "engine-multi-pv",
  readStoredJson("engine-multi-pv", 3)
);
export const engineWorkersNbAtom = atomWithStorage(
  "engineWorkersNb",
  getRecommendedWorkersNb()
);
export const evaluationProgressAtom = atom(0);

export const savedEvalsAtom = atom<SavedEvals>({});
