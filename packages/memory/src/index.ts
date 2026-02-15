export interface SessionMemory {
  sessionId: string;
  entries: string[];
}

export const createSessionMemory = (sessionId: string): SessionMemory => ({
  sessionId,
  entries: []
});
