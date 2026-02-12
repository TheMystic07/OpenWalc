import { randomBytes } from "node:crypto";

export interface RoomConfig {
  roomId: string;
  roomName: string;
  roomDescription: string;
  host: string;
  port: number;
  maxAgents: number;
  prizePoolUsd: number;
}

/** Generate a URL-safe short ID (12 chars, similar to nanoid) */
function generateRoomId(): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";
  const bytes = randomBytes(12);
  let id = "";
  for (let i = 0; i < 12; i++) {
    id += alphabet[bytes[i] % alphabet.length];
  }
  return id;
}

/** Load room configuration from environment variables */
export function loadRoomConfig(): RoomConfig {
  return {
    roomId: process.env.ROOM_ID ?? generateRoomId(),
    roomName: process.env.ROOM_NAME ?? "Open WALC",
    roomDescription: process.env.ROOM_DESCRIPTION ?? "",
    host: process.env.WORLD_HOST ?? "0.0.0.0",
    port: parseInt(process.env.WORLD_PORT ?? "18800", 10),
    maxAgents: parseInt(process.env.MAX_AGENTS ?? "100", 10),
    prizePoolUsd: Number(process.env.PRIZE_POOL_USD ?? "10000"),
  };
}
