export interface Env {
  ROOM_DO: DurableObjectNamespace<import("./room").RoomDO>;
  ASSETS: Fetcher;
}

export interface ParticipantState {
  id: string;
  name: string;
  online: boolean;
  joinedAt: number;
  vote: string | null;
  hasVoted: boolean;
}

export interface RoomState {
  id: string;
  roomName: string;
  numbers: string[];
  createdAt: number;
  updatedAt: number;
  revealed: boolean;
  participants: ParticipantState[];
  summary: {
    average: number | null;
    revealedCount: number;
    totalParticipants: number;
  };
}

export type ClientMessage =
  | { type: "vote"; value: string }
  | { type: "reveal" }
  | { type: "clear" }
  | { type: "rename"; name: string };

export type ServerMessage =
  | { type: "room_state"; state: RoomState }
  | { type: "system"; message: string }
  | { type: "error"; message: string };

export interface JoinRoomRequest {
  roomName?: string;
  password?: string;
  roomKey?: string;
  participantId?: string;
  participantName: string;
}

export interface JoinRoomResponse {
  roomKey: string;
  roomName: string;
  participantId: string;
  state: RoomState;
}
