import { RoomDO } from "./room";
export { RoomDO };

import type { Env } from "./types";

function roomCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/api/rooms" && request.method === "POST") {
      try {
        const body = await request.json() as { hostName: string; numbers?: string[] };
        if (!body.hostName) return new Response("hostName required", { status: 400 });

        const id = roomCode();
        const numbers = body.numbers ?? ["0", "1", "2", "3", "5", "8", "13", "21", "34", "55", "89", "?"];
        const stub = env.ROOM_DO.get(env.ROOM_DO.idFromName(id));
        const state = await stub.createRoom({ id, hostName: body.hostName, numbers });

        return Response.json(state, { status: 201 });
      } catch (e) {
        return Response.json({ error: String(e) }, { status: 500 });
      }
    }

    if (path.startsWith("/ws/")) {
      const roomId = path.slice(4);
      if (!roomId) return new Response("room id required", { status: 400 });

      const stub = env.ROOM_DO.get(env.ROOM_DO.idFromName(roomId));
      return stub.fetch(request.url.replace("/ws", "/api/room"), request);
    }

    if (path.startsWith("/api/room/")) {
      const roomId = path.slice(10);
      if (!roomId) return new Response("room id required", { status: 400 });

      const stub = env.ROOM_DO.get(env.ROOM_DO.idFromName(roomId));

      if (request.method === "GET") {
        const state = await stub.getRoomState();
        return Response.json(state);
      }
    }

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
