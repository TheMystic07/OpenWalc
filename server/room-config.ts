import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

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

function getPersistedRoomIdFilePath(): string {
  const configured = process.env.ROOM_ID_FILE?.trim();
  if (configured) {
    return resolve(process.cwd(), configured);
  }
  return resolve(process.cwd(), "output", "room-id.txt");
}

function readPersistedRoomId(filePath: string): string | null {
  if (!existsSync(filePath)) return null;
  const persisted = readFileSync(filePath, "utf-8").trim();
  if (!persisted) return null;
  return /^[A-Za-z0-9_-]{12}$/.test(persisted) ? persisted : null;
}

function persistRoomId(filePath: string, roomId: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${roomId}\n`, "utf-8");
}

function resolveRoomId(): string {
  const roomIdFromEnv = process.env.ROOM_ID?.trim();
  if (roomIdFromEnv) return roomIdFromEnv;

  if (!process.env.NEON_DATABASE_URL) {
    return generateRoomId();
  }

  const roomIdFilePath = getPersistedRoomIdFilePath();
  const persistedRoomId = readPersistedRoomId(roomIdFilePath);
  if (persistedRoomId) return persistedRoomId;

  const generatedRoomId = generateRoomId();
  persistRoomId(roomIdFilePath, generatedRoomId);
  return generatedRoomId;
}

/** Load room configuration from environment variables */
export function loadRoomConfig(): RoomConfig {
  return {
    roomId: resolveRoomId(),
    roomName: process.env.ROOM_NAME ?? "Open WALC",
    roomDescription: process.env.ROOM_DESCRIPTION ?? "",
    host: process.env.WORLD_HOST ?? "0.0.0.0",
    port: parseInt(process.env.WORLD_PORT ?? "18800", 10),
    maxAgents: parseInt(process.env.MAX_AGENTS ?? "100", 10),
    prizePoolUsd: Number(process.env.PRIZE_POOL_USD ?? "10000"),
  };
}
