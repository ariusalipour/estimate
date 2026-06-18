export interface Env {
  ROOM_DO: DurableObjectNamespace<RoomDO>;
  ASSETS: Fetcher;
}

export interface Participant {
  id: string;
  name: string;
  isHost: boolean;
  canVote: boolean;
  joinedAt: number;
}

export interface Round {
  id: number;
  number: number;
  topic: string;
  status: "voting" | "revealed";
  createdAt: number;
}

export interface Vote {
  participantId: string;
  value: string | null;
}

export interface RoomState {
  id: string;
  name: string;
  hostId: string;
  numbers: string[];
  status: "active" | "closed";
  createdAt: number;
  expiresAt: number;
  participants: Participant[];
  currentRound: Round | null;
}

export type ServerMessage =
  | { type: "room_state"; state: RoomState }
  | { type: "participant_joined"; participant: Participant }
  | { type: "participant_left"; participantId: string }
  | { type: "participant_updated"; participant: Participant }
  | { type: "vote_cast"; participantId: string }
  | { type: "votes_revealed"; votes: Record<string, string> }
  | { type: "new_round"; round: Round }
  | { type: "round_cleared" }
  | { type: "host_changed"; hostId: string }
  | { type: "settings_changed"; numbers: string[] }
  | { type: "error"; message: string };

export type ClientMessage =
  | { type: "vote"; value: string }
  | { type: "reveal" }
  | { type: "clear_round" }
  | { type: "new_round"; topic?: string }
  | { type: "change_settings"; numbers: string[] }
  | { type: "reassign_host"; participantId: string }
  | { type: "set_vote_permission"; participantId: string; canVote: boolean }
  | { type: "update_name"; name: string };
