import type { RoomConfig } from "./room-config.js";
import type { SurvivalContractState } from "./types.js";

export interface RoomInfo {
  roomId: string;
  name: string;
  description: string;
  agents: number;
  maxAgents: number;
  nostrChannelId: string | null;
  survival: SurvivalContractState;
}

export function createRoomInfoGetter(
  config: RoomConfig,
  getAgentCount: () => number,
  getChannelId: () => string | null,
  getSurvival: () => SurvivalContractState,
): () => RoomInfo {
  return () => ({
    roomId: config.roomId,
    name: config.roomName,
    description: config.roomDescription,
    agents: getAgentCount(),
    maxAgents: config.maxAgents,
    nostrChannelId: getChannelId(),
    survival: getSurvival(),
  });
}
