import { useGameDatabase } from "@/hooks/useGameDatabase";
import { getGameFromPgn, getGameFromFen } from "@/lib/chess";
import { GameOrigin } from "@/types/enums";
import {
  MenuItem,
  Select,
  Button,
  Dialog,
  DialogTitle,
  DialogContent,
  FormControl,
  InputLabel,
  OutlinedInput,
  DialogActions,
  Grid2 as Grid,
  Snackbar,
  Alert,
} from "@mui/material";
import { setContext as setSentryContext } from "@sentry/react";
import { Chess } from "chess.js";
import { useRef, useState } from "react";
import GamePgnInput from "./gamePgnInput";
import GameFenInput from "./gameFenInput";
import ChessComInput from "./chessComInput";
import { useLocalStorage } from "@/hooks/useLocalStorage";
import LichessInput from "./lichessInput";
import { useSetAtom } from "jotai";
import { boardOrientationAtom } from "../analysis/states";

interface Props {
  open: boolean;
  onClose: () => void;
  setGame?: (game: Chess) => Promise<void>;
}

export default function NewGameDialog({ open, onClose, setGame }: Props) {
  const [pgn, setPgn] = useState("");
  const [fen, setFen] = useState("");
  const [gameOrigin, setGameOrigin] = useLocalStorage(
    "preferred-game-origin",
    GameOrigin.ChessCom
  );
  const [parsingError, setParsingError] = useState("");
  const parsingErrorTimeout = useRef<NodeJS.Timeout | null>(null);
  const setBoardOrientation = useSetAtom(boardOrientationAtom);
  const { addGame } = useGameDatabase();

  const handleAddGame = async (input: string, boardOrientation?: boolean) => {
    if (!input) return;

    try {
      let gameToAdd: Chess;
      
      if (gameOrigin === GameOrigin.Fen) {
        gameToAdd = getGameFromFen(input);
        setSentryContext("loadedGame", { fen: input });
      } else {
        gameToAdd = getGameFromPgn(input);
        setSentryContext("loadedGame", { pgn: input });
      }

      if (setGame) {
        await setGame(gameToAdd);
      } else {
        await addGame(gameToAdd);
      }

      setBoardOrientation(boardOrientation ?? true);
      handleClose();
    } catch (error) {
      console.error(error);

      if (parsingErrorTimeout.current) {
        clearTimeout(parsingErrorTimeout.current);
      }

      const errorMessage = gameOrigin === GameOrigin.Fen 
        ? "Invalid FEN: " 
        : "Invalid PGN: ";

      setParsingError(
        error instanceof Error
          ? `${errorMessage}${error.message} !`
          : `${errorMessage}unknown error !`
      );

      parsingErrorTimeout.current = setTimeout(() => {
        setParsingError("");
      }, 3000);
    }
  };

  const handleClose = () => {
    setPgn("");
    setFen("");
    setParsingError("");
    if (parsingErrorTimeout.current) {
      clearTimeout(parsingErrorTimeout.current);
    }
    onClose();
  };

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      maxWidth="md"
      fullWidth
      slotProps={{
        paper: {
          sx: {
            position: "fixed",
            top: 0,
          },
        },
      }}
    >
      <DialogTitle marginY={1} variant="h5">
        {setGame ? "Load a game" : "Add a game to your database"}
      </DialogTitle>
      <DialogContent>
        <Grid
          container
          marginTop={1}
          alignItems="center"
          justifyContent="start"
          rowGap={2}
        >
          <FormControl sx={{ m: 1, width: 150 }}>
            <InputLabel id="dialog-select-label">Game origin</InputLabel>
            <Select
              labelId="dialog-select-label"
              id="dialog-select"
              displayEmpty
              input={<OutlinedInput label="Game origin" />}
              value={gameOrigin ?? ""}
              onChange={(e) => {
                setGameOrigin(e.target.value as GameOrigin);
                setParsingError("");
              }}
            >
              {Object.entries(gameOriginLabel).map(([origin, label]) => (
                <MenuItem key={origin} value={origin}>
                  {label}
                </MenuItem>
              ))}
            </Select>
          </FormControl>

          {gameOrigin === GameOrigin.Pgn && (
            <GamePgnInput pgn={pgn} setPgn={setPgn} />
          )}

          {gameOrigin === GameOrigin.Fen && (
            <GameFenInput fen={fen} setFen={setFen} />
          )}

          {gameOrigin === GameOrigin.ChessCom && (
            <ChessComInput onSelect={handleAddGame} />
          )}

          {gameOrigin === GameOrigin.Lichess && (
            <LichessInput onSelect={handleAddGame} />
          )}

          <Snackbar open={!!parsingError}>
            <Alert
              onClose={() => setParsingError("")}
              severity="error"
              variant="filled"
              sx={{ width: "100%" }}
            >
              {parsingError}
            </Alert>
          </Snackbar>
        </Grid>
      </DialogContent>
      <DialogActions sx={{ m: 2 }}>
        <Button variant="outlined" onClick={handleClose}>
          Cancel
        </Button>
        {gameOrigin === GameOrigin.Pgn && (
          <Button
            variant="contained"
            sx={{ marginLeft: 2 }}
            onClick={() => {
              handleAddGame(pgn);
            }}
          >
            Add
          </Button>
        )}
        {gameOrigin === GameOrigin.Fen && (
          <Button
            variant="contained"
            sx={{ marginLeft: 2 }}
            onClick={() => {
              handleAddGame(fen);
            }}
          >
            Add
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}

const gameOriginLabel: Record<GameOrigin, string> = {
  [GameOrigin.ChessCom]: "Chess.com",
  [GameOrigin.Lichess]: "Lichess.org",
  [GameOrigin.Pgn]: "PGN",
  [GameOrigin.Fen]: "FEN",
};
