import { FormControl, TextField, Button } from "@mui/material";
import { Icon } from "@iconify/react";
import React from "react";

interface Props {
  fen: string;
  setFen: (fen: string) => void;
}

export default function GameFenInput({ fen, setFen }: Props) {
  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();

    reader.onload = (e) => {
      const fileContent = e.target?.result as string;
      setFen(fileContent.trim());
    };

    reader.readAsText(file);
  };

  return (
    <FormControl fullWidth>
      <TextField
        label="Enter FEN here..."
        variant="outlined"
        value={fen}
        onChange={(e) => setFen(e.target.value)}
        placeholder="rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"
        sx={{ mb: 2 }}
      />
      <Button
        variant="contained"
        component="label"
        startIcon={<Icon icon="material-symbols:upload" />}
      >
        Choose FEN File
        <input type="file" hidden accept=".fen,.txt" onChange={handleFileChange} />
      </Button>
    </FormControl>
  );
} 