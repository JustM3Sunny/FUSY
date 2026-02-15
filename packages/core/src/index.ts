export interface AgentState {
  id: string;
  status: "idle" | "running" | "failed";
}

export const createInitialState = (id: string): AgentState => ({
  id,
  status: "idle"
});
