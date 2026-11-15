import type { PlayerTelemetry } from '../types/interfaces';

export const MAX_PARTY_PLAYERS = 3;
export const PLAYER_SLOT_COUNT = 3;
export const PROTOCOL_VERSION = 2;
export const NETWORK_TICK_HZ = 15;
export const RECONNECT_GRACE_MS = 25_000;
export const ISLAND_MAX_RADIUS = 108.5;

export const PLAYER_MAX_HP = 100;
export const STARTING_CAPTURE_SPHERES = 12;
export const MAX_CAPTURE_SPHERES = 24;
export const DODGE_IFRAME_MS = 450;
export const CAPTURE_RESOLVE_MS = 1100;
export const MONSTER_RESPAWN_MS = 25_000;

export const PLAYER_MAX_HUNGER = 100;
export const MAX_BASE_WORKERS = 3;
export const RESOURCE_RESPAWN_MS = 20_000;
export const BUILD_GRID_SIZE_METERS = 2.0;

export type CoopConnectionState =
    | 'offline'
    | 'connecting'
    | 'connected'
    | 'reconnecting';

export type PlayerSlotIndex = 0 | 1 | 2;

export interface SlotPaletteEntry {
    name: string;
    hex: string;
    rgb: [number, number, number];
}

export const SLOT_PALETTE: Record<PlayerSlotIndex, SlotPaletteEntry> = {
    0: { name: 'Azure', hex: '#2dd4bf', rgb: [0.18, 0.83, 0.75] },
    1: { name: 'Solar', hex: '#f59e0b', rgb: [0.96, 0.62, 0.04] },
    2: { name: 'Nova', hex: '#f43f5e', rgb: [0.96, 0.25, 0.37] },
};

export interface Vec3Tuple {
    x: number;
    y: number;
    z: number;
}

export type WorldEventKind =
    | 'crystal_collected'
    | 'monster_captured'
    | 'structure_placed'
    | 'structure_removed'
    | 'player_joined'
    | 'player_left';

export type MonsterSpeciesId = 'moss_hopper' | 'aether_wisp' | 'shale_golem';

export type MonsterAIState =
    | 'patrol'
    | 'rest'
    | 'observe'
    | 'alert'
    | 'chase'
    | 'attack'
    | 'hit'
    | 'flee'
    | 'return'
    | 'capturing'
    | 'captured'
    | 'dead';

export type CombatActionKind =
    | 'melee_attack'
    | 'ranged_attack'
    | 'dodge_roll'
    | 'throw_capture'
    | 'summon_companion'
    | 'recall_companion';

export type PlayerCombatState = 'idle' | 'attack' | 'dodge' | 'hit' | 'throw';

export type CompanionAIState =
    | 'follow'
    | 'assist_chase'
    | 'assist_attack'
    | 'hit'
    | 'recall';

export type CombatEventKind =
    | 'melee_hit'
    | 'ranged_cast'
    | 'ranged_hit'
    | 'monster_attack_telegraph'
    | 'monster_attack_hit'
    | 'player_hit'
    | 'player_dodge'
    | 'player_respawn'
    | 'monster_dead'
    | 'capture_throw'
    | 'capture_result'
    | 'companion_summon'
    | 'companion_recall'
    | 'companion_attack'
    | 'loot_drop';

export interface MonsterSyncState {
    id: string;
    species: MonsterSpeciesId;
    name: string;
    level: number;
    x: number;
    y: number;
    z: number;
    yaw: number;
    vx: number;
    vz: number;
    hp: number;
    maxHp: number;
    aiState: MonsterAIState;
    targetPlayerId: string | null;
    targetCompanionId: string | null;
    captureLockByPlayerId: string | null;
    respawnRemainingMs: number;
    attackCharge: number;
}

export interface CapturedMonsterRecord {
    uid: string;
    species: MonsterSpeciesId;
    nickname: string;
    level: number;
    hp: number;
    maxHp: number;
    attackPower: number;
}

export interface CompanionSyncState {
    uid: string;
    ownerPlayerId: string;
    species: MonsterSpeciesId;
    nickname: string;
    level: number;
    x: number;
    y: number;
    z: number;
    yaw: number;
    hp: number;
    maxHp: number;
    aiState: CompanionAIState;
    targetMonsterId: string | null;
}

export type ResourceKind =
    | 'wood'
    | 'stone'
    | 'ore'
    | 'berry'
    | 'aether_shard'
    | 'cooked_berry';

export type SharedResourceInventory = Record<ResourceKind, number>;

export const DEFAULT_SHARED_RESOURCES: Readonly<SharedResourceInventory> = {
    wood: 4,
    stone: 2,
    ore: 0,
    berry: 3,
    aether_shard: 0,
    cooked_berry: 1,
};

export function createDefaultSharedResources(): SharedResourceInventory {
    return { ...DEFAULT_SHARED_RESOURCES };
}

export type ToolId = 'hands' | 'wood_axe' | 'stone_pickaxe' | 'aether_blade';

export const TOOL_COMBAT_BONUSES: Readonly<
    Record<ToolId, { meleeBonus: number; rangedBonus: number }>
> = {
    hands: { meleeBonus: 0, rangedBonus: 0 },
    wood_axe: { meleeBonus: 6, rangedBonus: 0 },
    stone_pickaxe: { meleeBonus: 8, rangedBonus: 0 },
    aether_blade: { meleeBonus: 16, rangedBonus: 8 },
};

export type CraftRecipeId =
    | 'wood_axe'
    | 'stone_pickaxe'
    | 'aether_blade'
    | 'capture_sphere_pack'
    | 'cooked_berry_batch';

export interface CraftRecipeDef {
    recipeId: CraftRecipeId;
    name: string;
    nameKo: string;
    description: string;
    cost: Partial<SharedResourceInventory>;
    requiresWorkbench: boolean;
    yieldItem: string;
    yieldAmount: number;
    unlocksTool?: ToolId;
    resourceYieldKind?: ResourceKind;
    meleeBonus: number;
    rangedBonus: number;
}

export const CRAFT_RECIPES: Readonly<Record<CraftRecipeId, CraftRecipeDef>> = {
    wood_axe: {
        recipeId: 'wood_axe',
        name: 'Wood Axe',
        nameKo: '나무 도끼',
        description: '벌목 속도와 근접 공격력(+6)을 높여주는 기초 도끼입니다.',
        cost: { wood: 3, stone: 1 },
        requiresWorkbench: false,
        yieldItem: 'wood_axe',
        yieldAmount: 1,
        unlocksTool: 'wood_axe',
        meleeBonus: 6,
        rangedBonus: 0,
    },
    stone_pickaxe: {
        recipeId: 'stone_pickaxe',
        name: 'Stone Pickaxe',
        nameKo: '돌 곡괭이',
        description: '채광 효율과 근접 공격력(+8)을 높여주는 석재 곡괭이입니다.',
        cost: { wood: 2, stone: 3 },
        requiresWorkbench: false,
        yieldItem: 'stone_pickaxe',
        yieldAmount: 1,
        unlocksTool: 'stone_pickaxe',
        meleeBonus: 8,
        rangedBonus: 0,
    },
    aether_blade: {
        recipeId: 'aether_blade',
        name: 'Aether Blade',
        nameKo: '에테르 블레이드',
        description: '근접(+16) 및 원거리(+8) 위력을 크게 끌어올리는 에테르 무기입니다.',
        cost: { wood: 3, stone: 4, ore: 3, aether_shard: 2 },
        requiresWorkbench: true,
        yieldItem: 'aether_blade',
        yieldAmount: 1,
        unlocksTool: 'aether_blade',
        meleeBonus: 16,
        rangedBonus: 8,
    },
    capture_sphere_pack: {
        recipeId: 'capture_sphere_pack',
        name: 'Capture Sphere Pack',
        nameKo: '포획 스피어 팩',
        description: '몬스터 포획용 에테르 스피어 4개를 제작합니다.',
        cost: { stone: 2, ore: 1, aether_shard: 1 },
        requiresWorkbench: true,
        yieldItem: 'capture_sphere',
        yieldAmount: 4,
        meleeBonus: 0,
        rangedBonus: 0,
    },
    cooked_berry_batch: {
        recipeId: 'cooked_berry_batch',
        name: 'Cooked Berry Batch',
        nameKo: '구운 베리 묶음',
        description: '베리를 구워 포만감(+35)과 체력(+20)을 크게 회복하는 식량을 2개 만듭니다.',
        cost: { berry: 3, wood: 1 },
        requiresWorkbench: true,
        yieldItem: 'cooked_berry',
        yieldAmount: 2,
        resourceYieldKind: 'cooked_berry',
        meleeBonus: 0,
        rangedBonus: 0,
    },
};

export const CRAFT_RECIPE_LIST: ReadonlyArray<CraftRecipeDef> = Object.values(CRAFT_RECIPES);

export type ModularStructureRecipeId =
    | 'wood_foundation'
    | 'wood_wall'
    | 'wood_door'
    | 'wood_roof'
    | 'workbench'
    | 'storage_chest'
    | 'straw_bed';

export interface ModularStructureRecipeDef {
    recipeId: ModularStructureRecipeId;
    name: string;
    nameKo: string;
    layer: 0 | 1 | 2;
    cost: Partial<SharedResourceInventory>;
    footprintMeters: { x: number; z: number };
    heightMeters: number;
    elevationOffsetY: number;
    maxSlopeDeg: number;
    blocksMovement: boolean;
    blocksCamera: boolean;
    description: string;
}

export const MODULAR_STRUCTURE_RECIPES: Readonly<
    Record<ModularStructureRecipeId, ModularStructureRecipeDef>
> = {
    wood_foundation: {
        recipeId: 'wood_foundation',
        name: 'Wood Foundation',
        nameKo: '목재 토대',
        layer: 0,
        cost: { wood: 2 },
        footprintMeters: { x: 2.0, z: 2.0 },
        heightMeters: 0.35,
        elevationOffsetY: 0,
        maxSlopeDeg: 28,
        blocksMovement: false,
        blocksCamera: false,
        description: '거점 건축의 바닥을 이루는 2x2m 원목 토대입니다.',
    },
    wood_wall: {
        recipeId: 'wood_wall',
        name: 'Wood Wall',
        nameKo: '목재 벽',
        layer: 1,
        cost: { wood: 2 },
        footprintMeters: { x: 2.0, z: 0.35 },
        heightMeters: 2.6,
        elevationOffsetY: 0.35,
        maxSlopeDeg: 28,
        blocksMovement: true,
        blocksCamera: true,
        description: '거점을 보호하는 목재 벽체입니다.',
    },
    wood_door: {
        recipeId: 'wood_door',
        name: 'Wood Doorway',
        nameKo: '목재 출입구',
        layer: 1,
        cost: { wood: 2 },
        footprintMeters: { x: 2.0, z: 0.35 },
        heightMeters: 2.6,
        elevationOffsetY: 0.35,
        maxSlopeDeg: 28,
        blocksMovement: false,
        blocksCamera: false,
        description: '자유롭게 드나들 수 있는 목재 문틀입니다.',
    },
    wood_roof: {
        recipeId: 'wood_roof',
        name: 'Wood Roof',
        nameKo: '목재 지붕',
        layer: 2,
        cost: { wood: 2 },
        footprintMeters: { x: 2.2, z: 2.2 },
        heightMeters: 0.6,
        elevationOffsetY: 2.95,
        maxSlopeDeg: 32,
        blocksMovement: false,
        blocksCamera: false,
        description: '거점 상단을 덮는 따뜻한 목재 지붕입니다.',
    },
    workbench: {
        recipeId: 'workbench',
        name: 'Frontier Workbench',
        nameKo: '작업대',
        layer: 1,
        cost: { wood: 4, stone: 2 },
        footprintMeters: { x: 1.6, z: 1.0 },
        heightMeters: 1.05,
        elevationOffsetY: 0.35,
        maxSlopeDeg: 22,
        blocksMovement: true,
        blocksCamera: false,
        description: '고급 도구, 포획 스피어, 구운 베리를 제작할 수 있는 작업대입니다.',
    },
    storage_chest: {
        recipeId: 'storage_chest',
        name: 'Aether Storage Chest',
        nameKo: '보관함',
        layer: 1,
        cost: { wood: 3, stone: 1 },
        footprintMeters: { x: 1.1, z: 0.75 },
        heightMeters: 0.85,
        elevationOffsetY: 0.35,
        maxSlopeDeg: 24,
        blocksMovement: true,
        blocksCamera: false,
        description: '거점 동료 몬스터들이 채집한 자원을 보관하는 공용 상자입니다.',
    },
    straw_bed: {
        recipeId: 'straw_bed',
        name: 'Straw Bed',
        nameKo: '밀짚 침대',
        layer: 1,
        cost: { wood: 3 },
        footprintMeters: { x: 1.2, z: 2.1 },
        heightMeters: 0.72,
        elevationOffsetY: 0.35,
        maxSlopeDeg: 22,
        blocksMovement: true,
        blocksCamera: false,
        description: '탐험가의 체력과 기력을 회복하고 거점 몬스터가 휴식하는 침대입니다.',
    },
};

export const MODULAR_STRUCTURE_RECIPE_LIST: ReadonlyArray<ModularStructureRecipeDef> =
    Object.values(MODULAR_STRUCTURE_RECIPES);

export interface PlacedStructureSyncState {
    id: string;
    recipeId: ModularStructureRecipeId | string;
    gridX: number;
    gridZ: number;
    layer: 0 | 1 | 2;
    x: number;
    y: number;
    z: number;
    rotationYawDeg: number;
    ownerPlayerId: string;
    ownerName: string;
    createdAtMs: number;
}

export type ResourceNodeKind = 'wood' | 'stone' | 'ore' | 'berry';

export interface ResourceNodeSyncState {
    id: string;
    kind: ResourceNodeKind;
    name: string;
    x: number;
    y: number;
    z: number;
    hp: number;
    maxHp: number;
    depleted: boolean;
    respawnRemainingMs: number;
}

export interface SeededResourceNodeDef {
    id: string;
    kind: ResourceNodeKind;
    name: string;
    x: number;
    z: number;
    maxHp: number;
    yieldKind: ResourceKind;
    yieldAmount: number;
}

/**
 * 24 deterministic resource nodes placed around Aether Sanctuary avoiding spawn (0, 12),
 * ruins, vital crystals, lake bowl, and wild monster spawns:
 * 8 wood trees, 6 stone boulders, 5 aether ore veins, 5 berry bushes.
 */
export const SEEDED_RESOURCE_NODES: ReadonlyArray<SeededResourceNodeDef> = [
    // 8 Wood Trees
    { id: 'res-wood-1', kind: 'wood', name: 'Sanctuary Oak', x: -12, z: 6, maxHp: 100, yieldKind: 'wood', yieldAmount: 3 },
    { id: 'res-wood-2', kind: 'wood', name: 'Meadow Timber', x: -18, z: 18, maxHp: 100, yieldKind: 'wood', yieldAmount: 3 },
    { id: 'res-wood-3', kind: 'wood', name: 'East Pine', x: 11, z: -3, maxHp: 100, yieldKind: 'wood', yieldAmount: 3 },
    { id: 'res-wood-4', kind: 'wood', name: 'Whispering Ash', x: -25, z: -5, maxHp: 100, yieldKind: 'wood', yieldAmount: 3 },
    { id: 'res-wood-5', kind: 'wood', name: 'South Grove', x: -12, z: 30, maxHp: 100, yieldKind: 'wood', yieldAmount: 3 },
    { id: 'res-wood-6', kind: 'wood', name: 'Northwood Cedar', x: 14, z: -24, maxHp: 100, yieldKind: 'wood', yieldAmount: 3 },
    { id: 'res-wood-7', kind: 'wood', name: 'Sunlit Canopy', x: -30, z: 24, maxHp: 100, yieldKind: 'wood', yieldAmount: 3 },
    { id: 'res-wood-8', kind: 'wood', name: 'Lakeside Birch', x: 24, z: -8, maxHp: 100, yieldKind: 'wood', yieldAmount: 3 },
    // 6 Stone Boulders
    { id: 'res-stone-1', kind: 'stone', name: 'Granite Outcrop', x: -14, z: 21, maxHp: 100, yieldKind: 'stone', yieldAmount: 3 },
    { id: 'res-stone-2', kind: 'stone', name: 'Shore Slate', x: 10, z: 23, maxHp: 100, yieldKind: 'stone', yieldAmount: 3 },
    { id: 'res-stone-3', kind: 'stone', name: 'West Boulder', x: -24, z: 8, maxHp: 100, yieldKind: 'stone', yieldAmount: 3 },
    { id: 'res-stone-4', kind: 'stone', name: 'Eastern Basalt', x: 28, z: -16, maxHp: 100, yieldKind: 'stone', yieldAmount: 3 },
    { id: 'res-stone-5', kind: 'stone', name: 'Highland Stone', x: -28, z: -34, maxHp: 100, yieldKind: 'stone', yieldAmount: 3 },
    { id: 'res-stone-6', kind: 'stone', name: 'Ruins Limestone', x: -6, z: -28, maxHp: 100, yieldKind: 'stone', yieldAmount: 3 },
    // 5 Aether Ore Veins
    { id: 'res-ore-1', kind: 'ore', name: 'Aether Vein West', x: -34, z: -10, maxHp: 120, yieldKind: 'ore', yieldAmount: 2 },
    { id: 'res-ore-2', kind: 'ore', name: 'Aether Vein East', x: 34, z: -28, maxHp: 120, yieldKind: 'ore', yieldAmount: 2 },
    { id: 'res-ore-3', kind: 'ore', name: 'Sanctuary Seam', x: -18, z: -42, maxHp: 120, yieldKind: 'ore', yieldAmount: 2 },
    { id: 'res-ore-4', kind: 'ore', name: 'Ridge Crystal Vein', x: 24, z: -48, maxHp: 120, yieldKind: 'ore', yieldAmount: 2 },
    { id: 'res-ore-5', kind: 'ore', name: 'Southwest Ore', x: -36, z: 42, maxHp: 120, yieldKind: 'ore', yieldAmount: 2 },
    // 5 Berry Bushes
    { id: 'res-berry-1', kind: 'berry', name: 'Sunberry Bush', x: -8, z: 24, maxHp: 60, yieldKind: 'berry', yieldAmount: 3 },
    { id: 'res-berry-2', kind: 'berry', name: 'Dewberry Bush', x: 13, z: 5, maxHp: 60, yieldKind: 'berry', yieldAmount: 3 },
    { id: 'res-berry-3', kind: 'berry', name: 'Glade Berry Bush', x: -11, z: -4, maxHp: 60, yieldKind: 'berry', yieldAmount: 3 },
    { id: 'res-berry-4', kind: 'berry', name: 'Meadow Berry Bush', x: 3, z: 27, maxHp: 60, yieldKind: 'berry', yieldAmount: 3 },
    { id: 'res-berry-5', kind: 'berry', name: 'Thicket Berry Bush', x: -22, z: 32, maxHp: 60, yieldKind: 'berry', yieldAmount: 3 },
];

export type WorkSuitabilityKind =
    | 'lumbering'
    | 'mining'
    | 'gathering'
    | 'handiwork'
    | 'transporting';

export const SPECIES_WORK_SUITABILITY: Readonly<
    Record<MonsterSpeciesId, Partial<Record<WorkSuitabilityKind, number>>>
> = {
    moss_hopper: { lumbering: 2, gathering: 2, transporting: 1 },
    aether_wisp: { handiwork: 2, transporting: 2 },
    shale_golem: { mining: 3, transporting: 2 },
};

export type BaseWorkerAIState =
    | 'idle'
    | 'work_gather'
    | 'work_craft'
    | 'transport'
    | 'rest'
    | 'return';

export interface BaseWorkerSyncState {
    uid: string;
    ownerPlayerId: string;
    species: MonsterSpeciesId;
    nickname: string;
    level: number;
    x: number;
    y: number;
    z: number;
    yaw: number;
    aiState: BaseWorkerAIState;
    activeWork: WorkSuitabilityKind | null;
    carryingKind: ResourceKind | null;
    carryingAmount: number;
    energy: number;
    maxEnergy: number;
    targetNodeId: string | null;
    targetStructureId: string | null;
}

export type SurvivalActionKind =
    | 'harvest_node'
    | 'craft_item'
    | 'equip_tool'
    | 'eat_food'
    | 'place_structure'
    | 'demolish_structure'
    | 'rest_bed'
    | 'assign_base_worker'
    | 'unassign_base_worker';

export type SurvivalEventKind =
    | 'node_hit'
    | 'node_depleted'
    | 'node_respawned'
    | 'item_crafted'
    | 'tool_equipped'
    | 'food_eaten'
    | 'structure_placed'
    | 'structure_demolished'
    | 'bed_rested'
    | 'worker_assigned'
    | 'worker_unassigned'
    | 'worker_delivered'
    | 'action_rejected';

export type SurvivalRejectionReason =
    | 'CELL_OCCUPIED'
    | 'INSUFFICIENT_RESOURCES'
    | 'WORKBENCH_REQUIRED'
    | 'MAX_BASE_WORKERS'
    | 'UNKNOWN_RECIPE'
    | 'UNKNOWN_NODE'
    | 'NODE_DEPLETED'
    | 'OUT_OF_RANGE'
    | 'TOOL_NOT_UNLOCKED'
    | 'NO_FOOD'
    | 'INVALID_STRUCTURE'
    | 'NOT_FOUND'
    | 'ALREADY_ASSIGNED'
    | 'BAD_REQUEST';

export interface PlayerSyncState {
    playerId: string;
    displayName: string;
    slotIndex: PlayerSlotIndex;
    seq: number;
    timestampMs: number;
    position: Vec3Tuple;
    velocity: Vec3Tuple;
    yawDeg: number;
    animState: PlayerTelemetry['state'];
    grounded: boolean;
    inWater: boolean;
    stamina: number;
    crystalsCollected: number;
    connected: boolean;
    rttMs?: number;
    hp?: number;
    maxHp?: number;
    combatState?: PlayerCombatState;
    activeCompanionId?: string | null;
    captureSpheres?: number;
    lootCount?: number;
    hunger?: number;
    maxHunger?: number;
    equippedTool?: ToolId;
    unlockedTools?: ToolId[];
}

export interface CoopNetworkMetrics {
    rttMs: number;
    jitterMs: number;
    bytesSentPerSec: number;
    bytesReceivedPerSec: number;
    packetsSentPerSec: number;
    packetsReceivedPerSec: number;
    reconcileCount: number;
    lastCorrectionMeters: number;
    tickRateHz: number;
}

export interface NetworkSimulationOptions {
    latencyMs?: number;
    jitterMs?: number;
    dropRate?: number;
    disconnectTemporaryMs?: number;
}

/** Backward-compatible Phase 1 packet contract. */
export interface PlayerSyncPacket {
    type: 'player_sync';
    protocolVersion: number;
    roomCode: string;
    playerId: string;
    displayName: string;
    seq: number;
    timestampMs: number;
    position: Vec3Tuple;
    velocity: Vec3Tuple;
    yawDeg: number;
    animState: PlayerTelemetry['state'];
    stamina: number;
    crystalsCollected: number;
}

/** Backward-compatible Phase 1 world event contract. */
export interface WorldEventPacket {
    type: 'world_event';
    protocolVersion: number;
    roomCode: string;
    eventId: string;
    kind: WorldEventKind;
    actorId: string;
    timestampMs: number;
    payload: Record<string, string | number | boolean>;
}

export type CoopPacket = PlayerSyncPacket | WorldEventPacket;

export interface RemotePeerSnapshot {
    playerId: string;
    displayName: string;
    slotIndex: PlayerSlotIndex;
    lastPacket: PlayerSyncPacket;
    lastSeenMs: number;
    connected?: boolean;
    rttMs?: number;
}

export interface CoopSessionStatus {
    state: CoopConnectionState;
    maxPartyPlayers: number;
    roomCode: string | null;
    localPlayerId: string;
    localDisplayName: string;
    localSlotIndex: PlayerSlotIndex;
    peerCount: number;
    connectedPlayers: number;
    peers: RemotePeerSnapshot[];
    players: PlayerSyncState[];
    collectedCrystals: string[];
    queuedOutgoingEvents: number;
    protocolVersion: number;
    wsEndpoint: string | null;
    lastError: string | null;
    metrics: CoopNetworkMetrics;
    monsters?: MonsterSyncState[];
    companions?: CompanionSyncState[];
    capturedRoster?: CapturedMonsterRecord[];
    sharedResources?: SharedResourceInventory;
    resourceNodes?: ResourceNodeSyncState[];
    structures?: PlacedStructureSyncState[];
    baseWorkers?: BaseWorkerSyncState[];
    persistenceMode?: string;
}

export type CoopRoomErrorCode =
    | 'ROOM_FULL'
    | 'ROOM_NOT_FOUND'
    | 'INVALID_ROOM_CODE'
    | 'PROTOCOL_MISMATCH'
    | 'BAD_MESSAGE'
    | 'NOT_IN_ROOM';

// ============================================================================
// Client -> Server WebSocket Messages
// ============================================================================

export interface C2SCreateRoomMessage {
    type: 'c2s_create_room';
    protocolVersion: number;
    sessionToken: string;
    playerId?: string;
    displayName: string;
    preferredRoomCode?: string;
}

export interface C2SJoinRoomMessage {
    type: 'c2s_join_room';
    protocolVersion: number;
    roomCode: string;
    sessionToken: string;
    playerId?: string;
    displayName: string;
    isReconnect?: boolean;
}

export interface C2SLeaveRoomMessage {
    type: 'c2s_leave_room';
    protocolVersion: number;
    roomCode: string;
}

export interface C2SPlayerStateMessage {
    type: 'c2s_player_state';
    protocolVersion: number;
    seq: number;
    timestampMs: number;
    position: Vec3Tuple;
    velocity: Vec3Tuple;
    yawDeg: number;
    animState: PlayerTelemetry['state'];
    grounded: boolean;
    inWater: boolean;
    stamina: number;
    crystalsCollected: number;
    combatState?: PlayerCombatState;
}

export interface C2SWorldEventMessage {
    type: 'c2s_world_event';
    protocolVersion: number;
    eventId: string;
    kind: WorldEventKind;
    timestampMs: number;
    payload: Record<string, string | number | boolean>;
}

export interface C2SCombatActionMessage {
    type: 'c2s_combat_action';
    protocolVersion?: number;
    seq: number;
    clientTime: number;
    action: CombatActionKind;
    targetMonsterId?: string | null;
    companionUid?: string | null;
    aimYaw: number;
    originX: number;
    originY: number;
    originZ: number;
    dirX: number;
    dirZ: number;
}

export interface C2SPingMessage {
    type: 'c2s_ping';
    clientTimeMs: number;
    seq?: number;
}

export interface C2SSurvivalActionMessage {
    type: 'c2s_survival_action';
    protocolVersion?: number;
    seq: number;
    clientTime: number;
    action: SurvivalActionKind;
    nodeId?: string | null;
    craftRecipeId?: CraftRecipeId | null;
    toolId?: ToolId | null;
    foodKind?: 'berry' | 'cooked_berry' | null;
    structureRecipeId?: ModularStructureRecipeId | null;
    structureId?: string | null;
    gridX?: number;
    gridZ?: number;
    layer?: 0 | 1 | 2;
    rotationYawDeg?: number;
    x?: number;
    y?: number;
    z?: number;
    companionUid?: string | null;
    workPreference?: WorkSuitabilityKind | null;
}

export type C2SMessage =
    | C2SCreateRoomMessage
    | C2SJoinRoomMessage
    | C2SLeaveRoomMessage
    | C2SPlayerStateMessage
    | C2SWorldEventMessage
    | C2SCombatActionMessage
    | C2SSurvivalActionMessage
    | C2SPingMessage;

// ============================================================================
// Server -> Client WebSocket Messages
// ============================================================================

export interface S2CRoomJoinedMessage {
    type: 's2c_room_joined';
    protocolVersion: number;
    roomCode: string;
    playerId: string;
    slotIndex: PlayerSlotIndex;
    displayName: string;
    reconnected: boolean;
    serverTimeMs: number;
    players: PlayerSyncState[];
    collectedCrystals: string[];
    monsters?: MonsterSyncState[];
    companions?: CompanionSyncState[];
    capturedRoster?: CapturedMonsterRecord[];
    sharedResources?: SharedResourceInventory;
    resourceNodes?: ResourceNodeSyncState[];
    structures?: PlacedStructureSyncState[];
    baseWorkers?: BaseWorkerSyncState[];
    persistenceMode?: string;
}

export interface S2CRoomSnapshotMessage {
    type: 's2c_room_snapshot';
    protocolVersion: number;
    roomCode: string;
    serverTimeMs: number;
    tickSeq: number;
    lastAckSeq: number;
    localState?: PlayerSyncState;
    players: PlayerSyncState[];
    collectedCrystals: string[];
    monsters?: MonsterSyncState[];
    companions?: CompanionSyncState[];
    capturedRoster?: CapturedMonsterRecord[];
    sharedResources?: SharedResourceInventory;
    resourceNodes?: ResourceNodeSyncState[];
    structures?: PlacedStructureSyncState[];
    baseWorkers?: BaseWorkerSyncState[];
    persistenceMode?: string;
}

export interface S2CRoomErrorMessage {
    type: 's2c_room_error';
    code: CoopRoomErrorCode | string;
    message: string;
    roomCode?: string;
}

export interface S2CWorldEventMessage {
    type: 's2c_world_event';
    protocolVersion: number;
    roomCode: string;
    eventId: string;
    kind: WorldEventKind;
    actorId: string;
    actorName?: string;
    slotIndex?: PlayerSlotIndex;
    timestampMs: number;
    payload: Record<string, string | number | boolean>;
    collectedCrystals?: string[];
}

export interface S2CPlayerJoinedMessage {
    type: 's2c_player_joined';
    roomCode: string;
    player: PlayerSyncState;
    serverTimeMs: number;
}

export interface S2CPlayerReconnectingMessage {
    type: 's2c_player_reconnecting';
    roomCode: string;
    playerId: string;
    displayName: string;
    slotIndex: PlayerSlotIndex;
    graceMs: number;
    serverTimeMs: number;
}

export interface S2CPlayerReconnectedMessage {
    type: 's2c_player_reconnected';
    roomCode: string;
    player: PlayerSyncState;
    serverTimeMs: number;
}

export interface S2CPlayerLeftMessage {
    type: 's2c_player_left';
    roomCode: string;
    playerId: string;
    displayName: string;
    slotIndex: PlayerSlotIndex;
    reason: 'leave' | 'timeout' | 'kicked';
    serverTimeMs: number;
}

export interface S2CKickedDuplicateMessage {
    type: 's2c_kicked_duplicate';
    roomCode: string;
    playerId: string;
    message: string;
}

export interface S2CPongMessage {
    type: 's2c_pong';
    clientTimeMs: number;
    serverTimeMs: number;
    seq?: number;
}

export interface S2CCombatEventMessage {
    type: 's2c_combat_event';
    seq: number;
    serverTime: number;
    event: CombatEventKind;
    actorId: string;
    targetId?: string;
    x: number;
    y: number;
    z: number;
    damage?: number;
    remainingHp?: number;
    captureSuccess?: boolean;
    captureChance?: number;
    reason?: string;
    lootItem?: string;
    capturedRecord?: CapturedMonsterRecord;
}

export interface S2CSurvivalEventMessage {
    type: 's2c_survival_event';
    seq: number;
    serverTime: number;
    roomCode: string;
    event: SurvivalEventKind;
    actorId: string;
    actorName?: string;
    targetId?: string;
    x?: number;
    y?: number;
    z?: number;
    resourceKind?: ResourceKind;
    amount?: number;
    recipeId?: string;
    toolId?: ToolId;
    structure?: PlacedStructureSyncState;
    worker?: BaseWorkerSyncState;
    sharedResources?: SharedResourceInventory;
    reason?: SurvivalRejectionReason | string;
    message?: string;
}

export type S2CMessage =
    | S2CRoomJoinedMessage
    | S2CRoomSnapshotMessage
    | S2CRoomErrorMessage
    | S2CWorldEventMessage
    | S2CPlayerJoinedMessage
    | S2CPlayerReconnectingMessage
    | S2CPlayerReconnectedMessage
    | S2CPlayerLeftMessage
    | S2CKickedDuplicateMessage
    | S2CPongMessage
    | S2CCombatEventMessage
    | S2CSurvivalEventMessage;

// ============================================================================
// Shared Helpers
// ============================================================================

export function computeCaptureChance(
    species: MonsterSpeciesId,
    hp: number,
    maxHp: number
): number {
    const safeMax = Math.max(1, maxHp);
    const missingRatio = Math.max(0, Math.min(1, 1 - hp / safeMax));
    const speciesBias =
        species === 'moss_hopper' ? 0.05 : species === 'shale_golem' ? -0.05 : 0;
    const raw = 0.25 + missingRatio * 0.68 + speciesBias;
    const clamped = Math.max(0.15, Math.min(0.92, raw));
    return Math.round(clamped * 100) / 100;
}

export function createEmptyNetworkMetrics(): CoopNetworkMetrics {
    return {
        rttMs: 0,
        jitterMs: 0,
        bytesSentPerSec: 0,
        bytesReceivedPerSec: 0,
        packetsSentPerSec: 0,
        packetsReceivedPerSec: 0,
        reconcileCount: 0,
        lastCorrectionMeters: 0,
        tickRateHz: 0,
    };
}

export function sanitizeRoomCode(raw: string): string {
    return raw
        .trim()
        .toUpperCase()
        .replace(/[^A-Z0-9_-]/g, '')
        .slice(0, 12);
}

export function isValidRoomCode(code: string): boolean {
    return /^[A-Z0-9][A-Z0-9_-]{2,11}$/.test(code);
}

export function sanitizeDisplayName(raw: string): string {
    const cleaned = raw.trim().replace(/\s+/g, ' ').slice(0, 16);
    return cleaned.length > 0 ? cleaned : 'Explorer';
}

export function playerSyncStateToPacket(
    roomCode: string,
    state: PlayerSyncState
): PlayerSyncPacket {
    return {
        type: 'player_sync',
        protocolVersion: PROTOCOL_VERSION,
        roomCode,
        playerId: state.playerId,
        displayName: state.displayName,
        seq: state.seq,
        timestampMs: state.timestampMs,
        position: { ...state.position },
        velocity: { ...state.velocity },
        yawDeg: state.yawDeg,
        animState: state.animState,
        stamina: state.stamina,
        crystalsCollected: state.crystalsCollected,
    };
}

/**
 * Backward-compatible offline stub preserved for fallback or Phase 1 callers.
 */
export class CoopSessionManagerStub {
    public readonly maxPlayers = MAX_PARTY_PLAYERS;
    protected state: CoopConnectionState = 'offline';
    protected roomCode: string | null = null;
    protected wsEndpoint: string | null = null;
    protected localPlayerId: string;
    protected localDisplayName = 'Explorer';
    protected localSlotIndex: PlayerSlotIndex = 0;
    protected seq = 0;
    protected lastError: string | null = null;
    protected readonly peers = new Map<string, RemotePeerSnapshot>();
    protected readonly outgoingEvents: WorldEventPacket[] = [];
    protected readonly eventListeners = new Set<(event: WorldEventPacket) => void>();

    constructor(localPlayerId = 'local-explorer-1') {
        this.localPlayerId = localPlayerId;
    }

    public connect(
        roomCode: string,
        wsEndpoint = 'wss://zaapworld-coop.onrender.com/ws'
    ): CoopSessionStatus {
        const sanitized = sanitizeRoomCode(roomCode) || 'SANCTUARY-01';
        this.roomCode = sanitized;
        this.wsEndpoint = wsEndpoint;
        this.state = 'offline';
        return this.getStatus();
    }

    public disconnect(): void {
        this.state = 'offline';
        this.roomCode = null;
        this.peers.clear();
        this.outgoingEvents.length = 0;
    }

    public buildPlayerSyncPacket(
        telemetry: PlayerTelemetry,
        displayName = 'Explorer'
    ): PlayerSyncPacket {
        this.seq += 1;
        return {
            type: 'player_sync',
            protocolVersion: PROTOCOL_VERSION,
            roomCode: this.roomCode ?? 'LOCAL-SOLO',
            playerId: this.localPlayerId,
            displayName,
            seq: this.seq,
            timestampMs: Date.now(),
            position: {
                x: Number(telemetry.position.x.toFixed(3)),
                y: Number(telemetry.position.y.toFixed(3)),
                z: Number(telemetry.position.z.toFixed(3)),
            },
            velocity: {
                x: Number(telemetry.velocity.x.toFixed(3)),
                y: Number(telemetry.velocity.y.toFixed(3)),
                z: Number(telemetry.velocity.z.toFixed(3)),
            },
            yawDeg: Number(telemetry.yawDeg.toFixed(1)),
            animState: telemetry.state,
            stamina: Math.round(telemetry.stamina),
            crystalsCollected: telemetry.crystalsCollected,
        };
    }

    public ingestPacket(packet: CoopPacket): boolean {
        if (packet.protocolVersion !== PROTOCOL_VERSION && packet.protocolVersion !== 1) {
            return false;
        }
        if (packet.type === 'player_sync') {
            if (packet.playerId === this.localPlayerId) {
                return false;
            }
            const existing = this.peers.get(packet.playerId);
            if (!existing && this.peers.size >= MAX_PARTY_PLAYERS - 1) {
                return false;
            }
            const slotIndex = (existing?.slotIndex ??
                (this.peers.size + 1)) as PlayerSlotIndex;
            this.peers.set(packet.playerId, {
                playerId: packet.playerId,
                displayName: packet.displayName,
                slotIndex,
                lastPacket: packet,
                lastSeenMs: Date.now(),
                connected: true,
            });
            return true;
        }

        for (const listener of this.eventListeners) {
            listener(packet);
        }
        return true;
    }

    public emitWorldEvent(
        kind: WorldEventKind,
        payload: Record<string, string | number | boolean>
    ): WorldEventPacket {
        const packet: WorldEventPacket = {
            type: 'world_event',
            protocolVersion: PROTOCOL_VERSION,
            roomCode: this.roomCode ?? 'LOCAL-SOLO',
            eventId: `${this.localPlayerId}-${Date.now()}-${this.outgoingEvents.length + 1}`,
            kind,
            actorId: this.localPlayerId,
            timestampMs: Date.now(),
            payload,
        };
        this.outgoingEvents.push(packet);
        if (this.outgoingEvents.length > 64) {
            this.outgoingEvents.shift();
        }
        return packet;
    }

    public onWorldEvent(listener: (event: WorldEventPacket) => void): () => void {
        this.eventListeners.add(listener);
        return () => {
            this.eventListeners.delete(listener);
        };
    }

    public getStatus(): CoopSessionStatus {
        const peers = Array.from(this.peers.values());
        return {
            state: this.state,
            maxPartyPlayers: MAX_PARTY_PLAYERS,
            roomCode: this.roomCode,
            localPlayerId: this.localPlayerId,
            localDisplayName: this.localDisplayName,
            localSlotIndex: this.localSlotIndex,
            peerCount: peers.length,
            connectedPlayers: this.state === 'connected' ? 1 + peers.length : 1,
            peers,
            players: [],
            collectedCrystals: [],
            queuedOutgoingEvents: this.outgoingEvents.length,
            protocolVersion: PROTOCOL_VERSION,
            wsEndpoint: this.wsEndpoint,
            lastError: this.lastError,
            metrics: createEmptyNetworkMetrics(),
            monsters: [],
            companions: [],
            capturedRoster: [],
            sharedResources: createDefaultSharedResources(),
            resourceNodes: [],
            structures: [],
            baseWorkers: [],
            persistenceMode: 'offline',
        };
    }
}
