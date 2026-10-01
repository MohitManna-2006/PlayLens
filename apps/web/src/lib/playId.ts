/**
 * PlayLens play IDs: "<game_id>-<play_id>", e.g. "2023090700-101".
 * `play_id` alone repeats across games, so it never identifies a play by itself.
 * Mirrors playlens_ml.data.ids on the backend.
 */
const PATTERN = /^(\d{1,12})-(\d{1,6})$/;

export interface PlayKey {
  gameId: number;
  playId: number;
}

export function formatPlayId(gameId: number, playId: number): string {
  if (!Number.isInteger(gameId) || !Number.isInteger(playId) || gameId < 0 || playId < 0) {
    throw new Error(`Invalid play key ${gameId}, ${playId}`);
  }
  return `${gameId}-${playId}`;
}

/** The (game_id, play_id) key, or null when the value is not a PlayLens play ID. */
export function parsePlayId(value: string): PlayKey | null {
  const m = PATTERN.exec(value);
  return m ? { gameId: Number(m[1]), playId: Number(m[2]) } : null;
}
