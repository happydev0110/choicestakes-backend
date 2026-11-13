// Missing settings mean visible; provider availability remains independently required.
// The operator table is never written by catalog synchronization.
export const visibleGame = `NOT EXISTS (
  SELECT 1 FROM apimatic_game_settings visibility
  WHERE visibility.currency=g.currency AND visibility.game_uuid=g.game_uuid AND visibility.visible=FALSE
)`;
