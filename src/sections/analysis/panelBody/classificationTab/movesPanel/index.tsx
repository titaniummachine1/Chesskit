import { Grid2 as Grid } from "@mui/material";
import MovesLine from "./movesLine";
import { useMemo, useEffect } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { boardAtom, gameAtom, gameEvalAtom } from "../../../states";
import { MoveClassification } from "@/types/enums";

export default function MovesPanel() {
  const board = useAtomValue(boardAtom);
  const game = useAtomValue(gameAtom);
  const setGame = useSetAtom(gameAtom);
  const gameEval = useAtomValue(gameEvalAtom);

  const gameMoves = useMemo(() => {
    const boardHistory = board.history();
    const gameHistory = game.history();

    // Decide which history to show:
    // If board is a strict prefix of game, keep full game moves for easy navigation;
    // otherwise show the board path (divergent variation).
    const isBoardPrefixOfGame = gameHistory
      .slice(0, boardHistory.length)
      .join() === boardHistory.join();

    const history = isBoardPrefixOfGame ? gameHistory : boardHistory;

    if (!history.length) return undefined;

    const moves: { san: string; moveClassification?: MoveClassification }[][] =
      [];

    for (let i = 0; i < history.length; i += 2) {
      const items = [
        {
          san: history[i],
          moveClassification: gameEval?.positions[i + 1]?.moveClassification,
        },
      ];

      if (history[i + 1]) {
        items.push({
          san: history[i + 1],
          moveClassification: gameEval?.positions[i + 2]?.moveClassification,
        });
      }

      moves.push(items);
    }

    return moves;
  }, [board, game, gameEval]);

  // Sync board -> game when new branch is created or extended
  useEffect(() => {
    const boardHistory = board.history();
    const gameHistory = game.history();

    const isBoardPrefixOfGame = gameHistory
      .slice(0, boardHistory.length)
      .join() === boardHistory.join();

    // Update game only if board has diverged/extended beyond existing game path
    if (!isBoardPrefixOfGame || boardHistory.length > gameHistory.length) {
      const newGame = new (require("chess.js").Chess)();
      newGame.loadPgn(board.pgn());
      setGame(newGame);
    }
  }, [board, game, setGame]);

  return (
    <Grid
      container
      justifyContent="center"
      alignItems="start"
      gap={0.8}
      sx={{ scrollbarWidth: "thin", overflowY: "auto" }}
      maxHeight="100%"
      size={6}
      id="moves-panel"
    >
      {gameMoves?.map((moves, idx) => (
        <MovesLine
          key={`${moves.map(({ san }) => san).join()}-${idx}`}
          moves={moves}
          moveNb={idx + 1}
        />
      ))}
    </Grid>
  );
}
