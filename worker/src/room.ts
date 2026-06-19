import { DurableObject } from "cloudflare:workers";
import type { ClientMessage, Env, JoinRoomResponse, ParticipantState, RoomState, ServerMessage } from "./types";

type SessionInfo = {
  participantId: string;
};

type EnsureRoomPayload = {
  roomKey: string;
  roomName: string;
  participantId: string;
  participantName: string;
};

type RoomRow = {
  id: string;
  room_name: string;
  numbers: string;
  revealed: number;
  created_at: number;
  updated_at: number;
};

type ParticipantRow = {
  id: string;
  name: string;
  online: number;
  joined_at: number;
};

type VoteRow = {
  participant_id: string;
  value: string | null;
  updated_at: number;
};

const defaultNumbers = ["0", "1", "2", "3", "5", "8", "13", "21", "34", "55", "89", "?"];
const roomTtlMs = 7 * 24 * 60 * 60 * 1000;

export class RoomDO extends DurableObject<Env> {
  private sessions = new Map<WebSocket, SessionInfo>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS room (
          id TEXT PRIMARY KEY,
          room_name TEXT NOT NULL,
          numbers TEXT NOT NULL,
          revealed INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `);
      ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS participants (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          online INTEGER NOT NULL DEFAULT 0,
          joined_at INTEGER NOT NULL
        )
      `);
      ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS votes (
          participant_id TEXT PRIMARY KEY,
          value TEXT,
          updated_at INTEGER NOT NULL
        )
      `);
    });
  }

  async ensureRoom(payload: EnsureRoomPayload): Promise<JoinRoomResponse> {
    const now = Date.now();

    this.createRoomIfMissing(payload.roomKey, payload.roomName, now);

    this.ctx.storage.sql.exec(
      `INSERT INTO participants (id, name, online, joined_at) VALUES (?, ?, 0, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name`,
      payload.participantId,
      payload.participantName,
      now,
    );

    this.touchRoom(now);

    return {
      roomKey: payload.roomKey,
      roomName: (this.roomRow()?.room_name ?? payload.roomName),
      participantId: payload.participantId,
      state: this.buildState(),
    };
  }

  async getRoomState(): Promise<RoomState | null> {
    const row = this.roomRow();
    return row ? this.buildState() : null;
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected websocket", { status: 426 });
    }

    const url = new URL(request.url);
    const participantId = url.searchParams.get("pid")?.trim();
    const participantName = url.searchParams.get("name")?.trim();

    if (!participantId || !participantName) {
      return new Response("participant details required", { status: 400 });
    }

    const roomKey = url.pathname.split("/").pop()?.trim() || "room";
    const now = Date.now();
    this.createRoomIfMissing(roomKey, roomKey, now);
    const room = this.roomRow();

    if (!room) {
      return new Response("room not found", { status: 404 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();

    this.ctx.storage.sql.exec(
      `INSERT INTO participants (id, name, online, joined_at) VALUES (?, ?, 1, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, online = 1`,
      participantId,
      participantName,
      now,
    );

    this.sessions.set(server, { participantId });
    this.touchRoom(now);
    this.broadcast({ type: "system", message: `${participantName} joined ${room.room_name}.` });
    this.broadcastState();

    server.addEventListener("message", (event) => {
      try {
        const message = JSON.parse(String(event.data)) as ClientMessage;
        this.handleMessage(participantId, message);
      } catch {
        this.send(server, { type: "error", message: "invalid message" });
      }
    });

    server.addEventListener("close", () => {
      this.sessions.delete(server);
      const name = this.participantName(participantId);
      this.ctx.storage.sql.exec("DELETE FROM votes WHERE participant_id = ?", participantId);
      this.ctx.storage.sql.exec("DELETE FROM participants WHERE id = ?", participantId);
      const remainingParticipants = this.ctx.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) as count FROM participants",
      ).toArray()[0]?.count ?? 0;

      if (remainingParticipants === 0) {
        this.clearRoomData();
        return;
      }

      this.touchRoom(Date.now());
      this.broadcast({ type: "system", message: `${name} left room.` });
      this.broadcastState();
    });

    return new Response(null, { status: 101, webSocket: client });
  }

  private handleMessage(participantId: string, message: ClientMessage) {
    const room = this.roomRow();
    if (!room) {
      return;
    }

    switch (message.type) {
      case "vote": {
        const numbers = JSON.parse(room.numbers) as string[];
        if (!numbers.includes(message.value)) {
          this.broadcast({ type: "error", message: `invalid vote ${message.value}` });
          return;
        }
        this.ctx.storage.sql.exec(
          `INSERT INTO votes (participant_id, value, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(participant_id) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
          participantId,
          message.value,
          Date.now(),
        );
        this.ctx.storage.sql.exec("UPDATE room SET revealed = 0, updated_at = ? WHERE id = ?", Date.now(), room.id);
        this.broadcastState();
        break;
      }

      case "reveal":
        this.ctx.storage.sql.exec("UPDATE room SET revealed = 1, updated_at = ? WHERE id = ?", Date.now(), room.id);
        this.broadcast({ type: "system", message: `${this.participantName(participantId)} revealed votes.` });
        this.broadcastState();
        break;

      case "clear":
        this.ctx.storage.sql.exec("DELETE FROM votes");
        this.ctx.storage.sql.exec("UPDATE room SET revealed = 0, updated_at = ? WHERE id = ?", Date.now(), room.id);
        this.broadcast({ type: "system", message: `${this.participantName(participantId)} cleared round.` });
        this.broadcastState();
        break;

      case "rename":
        if (!message.name.trim()) {
          this.broadcast({ type: "error", message: "name required" });
          return;
        }
        this.ctx.storage.sql.exec("UPDATE participants SET name = ? WHERE id = ?", message.name.trim(), participantId);
        this.broadcast({ type: "system", message: `${this.participantName(participantId)} updated name.` });
        this.broadcastState();
        break;
    }
  }

  private roomRow(): RoomRow | null {
    const rows = this.ctx.storage.sql.exec<RoomRow>(
      "SELECT id, room_name, numbers, revealed, created_at, updated_at FROM room LIMIT 1",
    ).toArray();

    return rows[0] ?? null;
  }

  private createRoomIfMissing(roomKey: string, roomName: string, now: number) {
    if (this.roomRow()) {
      return;
    }

    this.ctx.storage.sql.exec(
      "INSERT INTO room (id, room_name, numbers, revealed, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)",
      roomKey,
      roomName,
      JSON.stringify(defaultNumbers),
      now,
      now,
    );
  }

  private buildState(): RoomState {
    const room = this.roomRow();
    if (!room) {
      throw new Error("room missing");
    }

    const votes = this.ctx.storage.sql.exec<VoteRow>(
      "SELECT participant_id, value, updated_at FROM votes",
    ).toArray();
    const voteMap = new Map(votes.map((vote) => [vote.participant_id, vote]));

    const participants = this.ctx.storage.sql.exec<ParticipantRow>(
      "SELECT id, name, online, joined_at FROM participants ORDER BY joined_at ASC",
    ).toArray().map<ParticipantState>((participant) => {
      const vote = voteMap.get(participant.id)?.value ?? null;
      return {
        id: participant.id,
        name: participant.name,
        online: participant.online === 1,
        joinedAt: participant.joined_at,
        vote: room.revealed === 1 ? vote : null,
        hasVoted: vote !== null,
      };
    });

    const numericVotes = votes
      .map((vote) => Number(vote.value))
      .filter((value) => Number.isFinite(value));

    const average = room.revealed === 1 && numericVotes.length > 0
      ? Math.round((numericVotes.reduce((sum, value) => sum + value, 0) / numericVotes.length) * 100) / 100
      : null;

    return {
      id: room.id,
      roomName: room.room_name,
      numbers: JSON.parse(room.numbers) as string[],
      createdAt: room.created_at,
      updatedAt: room.updated_at,
      revealed: room.revealed === 1,
      participants,
      summary: {
        average,
        revealedCount: room.revealed === 1 ? votes.filter((vote) => vote.value !== null).length : 0,
        totalParticipants: participants.length,
      },
    };
  }

  private broadcastState() {
    this.touchRoom(Date.now());
    this.broadcast({ type: "room_state", state: this.buildState() });
  }

  private broadcast(message: ServerMessage) {
    for (const socket of this.sessions.keys()) {
      this.send(socket, message);
    }
  }

  private send(socket: WebSocket, message: ServerMessage) {
    socket.send(JSON.stringify(message));
  }

  private participantName(participantId: string) {
    return this.ctx.storage.sql.exec<{ name: string }>(
      "SELECT name FROM participants WHERE id = ?",
      participantId,
    ).one()?.name ?? "user";
  }

  private touchRoom(now: number) {
    const room = this.roomRow();
    if (!room) {
      return;
    }
    this.ctx.storage.sql.exec("UPDATE room SET updated_at = ? WHERE id = ?", now, room.id);
    void this.ctx.storage.setAlarm(now + roomTtlMs);
  }

  private clearRoomData() {
    this.ctx.storage.sql.exec("DELETE FROM votes");
    this.ctx.storage.sql.exec("DELETE FROM participants");
    this.ctx.storage.sql.exec("DELETE FROM room");
  }

  async alarm() {
    const room = this.roomRow();
    if (!room) {
      return;
    }

    const now = Date.now();
    if (room.updated_at + roomTtlMs <= now) {
      this.clearRoomData();
      return;
    }

    void this.ctx.storage.setAlarm(room.updated_at + roomTtlMs);
  }
}
