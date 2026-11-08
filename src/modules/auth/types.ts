export type Player = {
  id: string;
  email: string;
  displayName: string;
  emailVerified: boolean;
};

export type StoredPlayer = Player & { passwordHash: string; status: string };
export type SessionRecord = { tokenHash: string; playerId: string; expiresAt: Date; createdAt: Date };

export interface AuthStore {
  findPlayerByEmail(email: string): Promise<StoredPlayer | null>;
  createPlayer(player: StoredPlayer, session: SessionRecord, previousTokenHash?: string): Promise<void>;
  createSession(session: SessionRecord, previousTokenHash?: string): Promise<void>;
  findSession(tokenHash: string, now: Date, idleMinutes: number): Promise<Player | null>;
  deleteSession(tokenHash: string): Promise<void>;
  consumeLoginAttempt(email: string): Promise<boolean>;
}

export class AuthError extends Error {
  constructor(public statusCode: number, public code: string, message: string) { super(message); }
}

export function publicPlayer(player: StoredPlayer): Player {
  return { id: player.id, email: player.email, displayName: player.displayName, emailVerified: player.emailVerified };
}
