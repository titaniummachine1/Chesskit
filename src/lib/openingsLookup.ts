import { openings } from "@/data/openings";

const knownOpeningBoardFens = new Set(openings.map((opening) => opening.fen));

export const isKnownOpeningPosition = (fen: string): boolean => {
  const boardFen = fen.split(" ")[0];
  return knownOpeningBoardFens.has(boardFen);
};
