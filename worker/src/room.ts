import { DurableObject } from "cloudflare:workers";
import type { Env, Participant, Round, RoomState, ServerMessage } from "./types";

export class RoomDO extends DurableObject<Env> {
  private participants: Participant[] = [];
  private sessions = new Map<string, WebSocket>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(() => {
      ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS room (
          id TEXT PRIMARY KEY,
          host_id TEXT NOT NULL,
          numbers TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'active',
          created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          last_active_at INTEGER NOT NULL
        )
      `);
      ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS participants (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          is_host INTEGER NOT NULL DEFAULT 0,
          can_vote INTEGER NOT NULL DEFAULT 1,
          joined_at INTEGER NOT NULL
        )
      `);
      ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS rounds (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          number INTEGER NOT NULL,
          topic TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'voting',
          created_at INTEGER NOT NULL
        )
      `);
      ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS votes (
          round_id INTEGER NOT NULL,
          participant_id TEXT NOT NULL,
          value TEXT,
          voted_at INTEGER NOT NULL,
          UNIQUE(round_id, participant_id)
        )
      `);
    });
  }

  async createRoom(data: { id: string; hostName: string; numbers: string[] }): Promise<RoomState> {
    const id = data.id;
    const now = Date.now();
    const hostId = crypto.randomUUID();
    const expiresAt = now + 7 * 24 * 60 * 60 * 1000;

    this.ctx.storage.sql.exec(
      `INSERT INTO room (id, host_id, numbers, status, created_at, expires_at, last_active_at)
       VALUES (?, ?, ?, 'active', ?, ?, ?)`,
      id, hostId, JSON.stringify(data.numbers), now, expiresAt, now
    );

    this.ctx.storage.sql.exec(
      "INSERT INTO participants (id, name, is_host, can_vote, joined_at) VALUES (?, ?, 1, 1, ?)",
      hostId, data.hostName, now
    );

    await this.ctx.storage.setAlarm(expiresAt);

    return this.buildState();
  }

  async getRoomState(): Promise<RoomState> {
    return this.buildState();
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const participantId = url.searchParams.get("pid") || crypto.randomUUID();
    const participantName = url.searchParams.get("name") || "Anonymous";

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    server.accept();

    const participant: Participant = {
      id: participantId,
      name: participantName,
      isHost: false,
      canVote: true,
      joinedAt: Date.now(),
    };

    const existing = this.participants.find((p) => p.id === participantId);
    if (existing) {
      Object.assign(existing, participant);
    } else {
      this.participants.push(participant);
      this.ctx.storage.sql.exec(
        "INSERT OR IGNORE INTO participants (id, name, is_host, can_vote, joined_at) VALUES (?, ?, 0, 1, ?)",
        participantId, participantName, Date.now()
      );
    }

    this.sessions.set(participantId, server);
    server.send(JSON.stringify({ type: "room_state", state: this.buildState() }));

    this.broadcast({ type: "participant_joined", participant }, participantId);

    server.addEventListener("message", (event) => {
      try {
        const msg = JSON.parse(event.data as string);
        this.handleMessage(participantId, msg);
      } catch {
        server.send(JSON.stringify({ type: "error", message: "invalid message" }));
      }
    });

    server.addEventListener("close", () => {
      this.sessions.delete(participantId);
      this.broadcast({ type: "participant_left", participantId });
    });

    return new Response(null, { status: 101, webSocket: client });
  }

  private handleMessage(pid: string, msg: any) {
    const participant = this.participants.find((p) => p.id === pid);
    if (!participant) return;

    switch (msg.type) {
      case "vote": {
        if (!participant.canVote) return;

        const round = this.currentRound();
        if (!round || round.status !== "voting") return;

        this.ctx.storage.sql.exec(
          `INSERT INTO votes (round_id, participant_id, value, voted_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(round_id, participant_id) DO UPDATE SET value = excluded.value, voted_at = excluded.voted_at`,
          round.id, pid, msg.value, Date.now()
        );

        this.broadcast({ type: "vote_cast", participantId: pid });
        break;
      }

      case "reveal": {
        if (!participant.isHost) return;
        const round = this.currentRound();
        if (!round || round.status !== "voting") return;

        this.ctx.storage.sql.exec(
          "UPDATE rounds SET status = 'revealed' WHERE id = ?", round.id
        );

        const rows = this.ctx.storage.sql.exec<{ participant_id: string; value: string }>(
          "SELECT participant_id, value FROM votes WHERE round_id = ? AND value IS NOT NULL", round.id
        ).toArray();

        const votes: Record<string, string> = {};
        for (const row of rows) votes[row.participant_id] = row.value;

        this.broadcast({ type: "votes_revealed", votes });
        break;
      }

      case "clear_round": {
        if (!participant.isHost) return;
        this.ctx.storage.sql.exec("DELETE FROM votes WHERE round_id = ?", this.currentRound()?.id ?? 0);
        this.ctx.storage.sql.exec("DELETE FROM rounds WHERE id = ?", this.currentRound()?.id ?? 0);
        this.broadcast({ type: "round_cleared" });
        break;
      }

      case "new_round": {
        if (!participant.isHost) return;
        const num = this.ctx.storage.sql.exec<{ n: number }>(
          "SELECT COALESCE(MAX(number), 0) + 1 as n FROM rounds"
        ).one().n;

        const now = Date.now();
        this.ctx.storage.sql.exec(
          "INSERT INTO rounds (number, topic, status, created_at) VALUES (?, ?, 'voting', ?)",
          num, msg.topic ?? "", now
        );

        this.broadcast({
          type: "new_round",
          round: { id: this.currentRound()!.id, number: num, topic: msg.topic ?? "", status: "voting", createdAt: now },
        });
        break;
      }

      case "change_settings": {
        if (!participant.isHost) return;
        if (!Array.isArray(msg.numbers) || msg.numbers.length === 0) return;
        this.ctx.storage.sql.exec("UPDATE room SET numbers = ?", JSON.stringify(msg.numbers));
        this.broadcast({ type: "settings_changed", numbers: msg.numbers });
        break;
      }

      case "reassign_host": {
        if (!participant.isHost) return;
        this.ctx.storage.sql.exec("UPDATE room SET host_id = ?", msg.participantId);
        this.broadcast({ type: "host_changed", hostId: msg.participantId });
        break;
      }

      case "set_vote_permission": {
        if (!participant.isHost) return;
        this.broadcast({ type: "participant_updated", participant: { id: msg.participantId, canVote: msg.canVote } as any });
        break;
      }

      case "update_name": {
        if (!msg.name) return;
        this.broadcast({ type: "participant_updated", participant: { id: pid, name: msg.name } as any });
        break;
      }
    }
  }

  private currentRound() {
    const rows = this.ctx.storage.sql.exec<Round>(
      "SELECT id, number, topic, status, created_at FROM rounds ORDER BY id DESC LIMIT 1"
    ).toArray();
    return rows[0] ?? null;
  }

  private buildState(): RoomState {
    const roomRow = this.ctx.storage.sql.exec<{
      id: string; host_id: string; numbers: string; status: string;
      created_at: number; expires_at: number;
    }>("SELECT * FROM room").one();

    const participantRows = this.ctx.storage.sql.exec<{
      id: string; name: string; is_host: number; can_vote: number; joined_at: number;
    }>("SELECT * FROM participants ORDER BY joined_at").toArray();

    return {
      id: roomRow.id,
      name: roomRow.id,
      hostId: roomRow.host_id,
      numbers: JSON.parse(roomRow.numbers),
      status: roomRow.status as any,
      createdAt: roomRow.created_at,
      expiresAt: roomRow.expires_at,
      participants: participantRows.map((p) => ({
        id: p.id,
        name: p.name,
        isHost: p.is_host === 1,
        canVote: p.can_vote === 1,
        joinedAt: p.joined_at,
      })),
      currentRound: this.currentRound(),
    };
  }

  private broadcast(msg: ServerMessage, excludePid?: string) {
    const data = JSON.stringify(msg);
    for (const [pid, ws] of this.sessions) {
      if (pid !== excludePid) ws.send(data);
    }
  }

  async alarm() {
    const row = this.ctx.storage.sql.exec<{ id: string }>("SELECT id FROM room").one();
    if (row) this.ctx.storage.sql.exec("UPDATE room SET status = 'closed' WHERE id = ?", row.id);
  }
}
