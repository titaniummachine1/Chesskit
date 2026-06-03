import { Icon } from "@iconify/react";
import {
  engineDepthAtom,
  engineMultiPvAtom,
  engineNameAtom,
  engineWorkersNbAtom,
  evaluationProgressAtom,
  gameAtom,
  gameEvalAtom,
  savedEvalsAtom,
} from "../states";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { getEvaluateGameParams } from "@/lib/chess";
import { useGameDatabase } from "@/hooks/useGameDatabase";
import { LoadingButton } from "@mui/lab";
import { useEngine } from "@/hooks/useEngine";
import { logAnalyticsEvent } from "@/lib/firebase";
import { SavedEvals } from "@/types/eval";
import { useEffect, useCallback, useRef } from "react";
import { usePlayersData } from "@/hooks/usePlayersData";
import { Typography } from "@mui/material";
import { useCurrentPosition } from "../hooks/useCurrentPosition";
import {
  releaseUiAnalysisLock,
  tryAcquireUiAnalysisLock,
} from "@/lib/engine/gameAnalysisLock";

export default function AnalyzeButton() {
  const engineName = useAtomValue(engineNameAtom);
  const engine = useEngine(engineName);
  useCurrentPosition(engine);
  const engineWorkersNb = useAtomValue(engineWorkersNbAtom);
  const [evaluationProgress, setEvaluationProgress] = useAtom(
    evaluationProgressAtom
  );
  const engineDepth = useAtomValue(engineDepthAtom);
  const engineMultiPv = useAtomValue(engineMultiPvAtom);
  const { setGameEval, gameFromUrl } = useGameDatabase();
  const [gameEval, setEval] = useAtom(gameEvalAtom);
  const game = useAtomValue(gameAtom);
  const setSavedEvals = useSetAtom(savedEvalsAtom);
  const { white, black } = usePlayersData(gameAtom);

  const autoAnalyzeGameKeyRef = useRef<string | null>(null);
  const gameKey = game.pgn();

  const readyToAnalyse =
    engine?.getIsReady() && game.history().length > 0 && !evaluationProgress;

  const handleAnalyze = useCallback(async () => {
    const params = getEvaluateGameParams(game);
    if (!engine?.getIsReady() || params.fens.length === 0) {
      return;
    }

    if (!tryAcquireUiAnalysisLock()) {
      return;
    }

    setEvaluationProgress((prev) => Math.max(prev ?? 0, 1));

    let superseded = false;

    try {
      const newGameEval = await engine.evaluateGame({
        ...params,
        depth: engineDepth,
        multiPv: engineMultiPv,
        setEvaluationProgress,
        playersRatings: {
          white: white?.rating,
          black: black?.rating,
        },
        workersNb: engineWorkersNb,
      });

      setEval(newGameEval);

      if (gameFromUrl) {
        setGameEval(gameFromUrl.id, newGameEval);
      }

      const gameSavedEvals: SavedEvals = params.fens.reduce((acc, fen, idx) => {
        acc[fen] = { ...newGameEval.positions[idx], engine: engineName };
        return acc;
      }, {} as SavedEvals);
      setSavedEvals((prev) => ({
        ...prev,
        ...gameSavedEvals,
      }));

      logAnalyticsEvent("analyze_game", {
        engine: engineName,
        depth: engineDepth,
        multiPv: engineMultiPv,
        nbPositions: params.fens.length,
      });
    } catch (error) {
      if (error instanceof Error && error.message === "Analysis superseded") {
        superseded = true;
        return;
      }

      throw error;
    } finally {
      releaseUiAnalysisLock();
      if (!superseded) {
        setEvaluationProgress(0);
      }
    }
  }, [
    engine,
    engineName,
    engineWorkersNb,
    game,
    engineDepth,
    engineMultiPv,
    setEvaluationProgress,
    setEval,
    gameFromUrl,
    setGameEval,
    setSavedEvals,
    white.rating,
    black.rating,
  ]);

  useEffect(() => {
    autoAnalyzeGameKeyRef.current = null;
  }, [gameKey]);

  useEffect(() => {
    if (
      !gameEval &&
      readyToAnalyse &&
      autoAnalyzeGameKeyRef.current !== gameKey
    ) {
      autoAnalyzeGameKeyRef.current = gameKey;
      handleAnalyze();
    }
  }, [gameEval, readyToAnalyse, handleAnalyze, gameKey]);

  if (evaluationProgress) return null;

  return (
    <LoadingButton
      variant="contained"
      size="small"
      startIcon={<Icon icon="streamline:magnifying-glass-solid" height={12} />}
      onClick={handleAnalyze}
      disabled={!readyToAnalyse}
    >
      <Typography fontSize="0.9em" fontWeight="500" lineHeight="1.4em">
        {gameEval ? "Analyze again" : "Analyze"}
      </Typography>
    </LoadingButton>
  );
}
