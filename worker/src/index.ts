import { RoomDO } from "./room";
import type { Env, JoinRoomRequest } from "./types";

export { RoomDO };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/api/session/room") {
      return handleJoinRoom(request, env);
    }

    if (url.pathname.startsWith("/api/room/") && request.method === "GET") {
      const roomKey = url.pathname.slice("/api/room/".length);
      if (!roomKey) {
        return Response.json({ error: "room key required" }, { status: 400 });
      }

      const stub = env.ROOM_DO.get(env.ROOM_DO.idFromName(roomKey));
      const state = await stub.getRoomState();
      if (!state) {
        return Response.json({ error: "room not found" }, { status: 404 });
      }
      return Response.json(state);
    }

    if (url.pathname.startsWith("/ws/")) {
      const roomKey = url.pathname.slice("/ws/".length);
      if (!roomKey) {
        return new Response("room key required", { status: 400 });
      }

      const stub = env.ROOM_DO.get(env.ROOM_DO.idFromName(roomKey));
      return stub.fetch(request);
    }

    if (request.method === "GET" && !url.pathname.includes(".")) {
      const assetResponse = await env.ASSETS.fetch(new Request(new URL("/index.html", request.url), {
        method: "GET",
        headers: request.headers,
      }));

      return new Response(assetResponse.body, {
        status: 200,
        headers: assetResponse.headers,
      });
    }

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;

async function handleJoinRoom(request: Request, env: Env): Promise<Response> {
  try {
    const body = await request.json() as JoinRoomRequest;
    const participantName = body.participantName?.trim();

    if (!participantName) {
      return Response.json({ error: "participantName required" }, { status: 400 });
    }

    const participantId = body.participantId?.trim() || crypto.randomUUID();
    let roomKey = body.roomKey?.trim();
    let roomName = body.roomName?.trim();

    if (!roomKey) {
      if (!roomName || !body.password?.trim()) {
        return Response.json({ error: "roomName and password required" }, { status: 400 });
      }
      roomKey = await createRoomKey(roomName, body.password.trim());
    }

    if (!roomName) {
      roomName = roomKey;
    }

    const stub = env.ROOM_DO.get(env.ROOM_DO.idFromName(roomKey));
    const result = await stub.ensureRoom({
      roomKey,
      roomName,
      participantId,
      participantName,
    });

    return Response.json(result);
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}

async function createRoomKey(roomName: string, password: string): Promise<string> {
  const normalized = roomName.trim().toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
  const payload = new TextEncoder().encode(`${normalized}:${password}`);
  const digest = await crypto.subtle.digest("SHA-256", payload);
  const hash = Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 12);

  return `${normalized || "room"}-${hash}`;
}
