import http from 'node:http';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { PersistenceStore } from './persistence.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DIST_DIR = path.resolve(__dirname, '../dist');

const PORT = Number(process.env.PORT || 3001);
const HOST = process.env.HOST || '0.0.0.0';
const MAX_PARTY_PLAYERS = Math.min(
    3,
    Math.max(1, Number(process.env.MAX_PARTY_PLAYERS || 3))
);
const PROTOCOL_VERSION = 2;
const NETWORK_TICK_HZ = 15;
const TICK_INTERVAL_MS = 66;
const RECONNECT_GRACE_MS = Math.max(
    1000,
    Number(process.env.RECONNECT_GRACE_MS || 25_000)
);
const HEARTBEAT_INTERVAL_MS = 15_000;

const WORLD_HALF_SIZE = 120;
const PLAYABLE_MAX_RADIUS = 108.5;
const MAX_SPEED_MPS = 14.0;
const SPEED_SLACK_METERS = 2.2;
const MAX_CEILING_ABOVE_TERRAIN = 12.0;
const MAX_FLOOR_BELOW_TERRAIN = 0.05;

const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const VALID_ANIM_STATES = new Set([
    'idle',
    'walk',
    'run',
    'jump',
    'fall',
    'attack',
    'dodge',
    'hit',
    'throw',
    'gather',
    'build',
]);
const VALID_COMBAT_STATES = new Set(['idle', 'attack', 'dodge', 'hit', 'throw']);
const SLOT_SPAWN_OFFSETS = [
    { x: 0, z: 12 },
    { x: -2.2, z: 13.2 },
    { x: 2.2, z: 13.2 },
];

const PLAYER_MAX_HP = 100;
const PLAYER_MAX_HUNGER = 100;
const MAX_BASE_WORKERS = 3;
const BUILD_GRID_SIZE_METERS = 2.0;
const STARTING_CAPTURE_SPHERES = 12;
const MAX_CAPTURE_SPHERES = 24;
const DODGE_IFRAME_MS = 450;
const RESPAWN_IFRAME_MS = 2000;
const CAPTURE_RESOLVE_MS = 1100;
const MONSTER_RESPAWN_MS = Math.max(
    1000,
    Number(process.env.MONSTER_RESPAWN_MS || 25_000)
);
const RESOURCE_RESPAWN_MS = Math.max(
    250,
    Number(process.env.RESOURCE_RESPAWN_MS || 20_000)
);
const HUNGER_DECAY_PER_SEC = Math.max(
    0,
    Number(process.env.HUNGER_DECAY_PER_SEC ?? 0.35)
);
const WORKER_TICK_SCALE = Math.max(
    0.05,
    Number(process.env.WORKER_TICK_SCALE ?? 1.0)
);
const MONSTER_ACTIVE_DIST_M = 45;

const DEFAULT_SHARED_RESOURCES = Object.freeze({
    wood: 4,
    stone: 2,
    ore: 0,
    berry: 3,
    aether_shard: 0,
    cooked_berry: 1,
});

const TOOL_COMBAT_BONUSES = {
    hands: { meleeBonus: 0, rangedBonus: 0 },
    wood_axe: { meleeBonus: 6, rangedBonus: 0 },
    stone_pickaxe: { meleeBonus: 8, rangedBonus: 0 },
    aether_blade: { meleeBonus: 16, rangedBonus: 8 },
};

const CRAFT_RECIPES = {
    wood_axe: {
        recipeId: 'wood_axe',
        cost: { wood: 3, stone: 1 },
        requiresWorkbench: false,
        yieldItem: 'wood_axe',
        yieldAmount: 1,
        unlocksTool: 'wood_axe',
    },
    stone_pickaxe: {
        recipeId: 'stone_pickaxe',
        cost: { wood: 2, stone: 3 },
        requiresWorkbench: false,
        yieldItem: 'stone_pickaxe',
        yieldAmount: 1,
        unlocksTool: 'stone_pickaxe',
    },
    aether_blade: {
        recipeId: 'aether_blade',
        cost: { wood: 3, stone: 4, ore: 3, aether_shard: 2 },
        requiresWorkbench: true,
        yieldItem: 'aether_blade',
        yieldAmount: 1,
        unlocksTool: 'aether_blade',
    },
    capture_sphere_pack: {
        recipeId: 'capture_sphere_pack',
        cost: { stone: 2, ore: 1, aether_shard: 1 },
        requiresWorkbench: true,
        yieldItem: 'capture_sphere',
        yieldAmount: 4,
    },
    cooked_berry_batch: {
        recipeId: 'cooked_berry_batch',
        cost: { berry: 3, wood: 1 },
        requiresWorkbench: true,
        yieldItem: 'cooked_berry',
        yieldAmount: 2,
        resourceYieldKind: 'cooked_berry',
    },
};

const MODULAR_STRUCTURE_RECIPES = {
    wood_foundation: {
        recipeId: 'wood_foundation',
        layer: 0,
        cost: { wood: 2 },
        elevationOffsetY: 0,
        maxSlopeDeg: 28,
    },
    wood_wall: {
        recipeId: 'wood_wall',
        layer: 1,
        cost: { wood: 2 },
        elevationOffsetY: 0.35,
        maxSlopeDeg: 28,
    },
    wood_door: {
        recipeId: 'wood_door',
        layer: 1,
        cost: { wood: 2 },
        elevationOffsetY: 0.35,
        maxSlopeDeg: 28,
    },
    wood_roof: {
        recipeId: 'wood_roof',
        layer: 2,
        cost: { wood: 2 },
        elevationOffsetY: 2.95,
        maxSlopeDeg: 32,
    },
    workbench: {
        recipeId: 'workbench',
        layer: 1,
        cost: { wood: 4, stone: 2 },
        elevationOffsetY: 0.35,
        maxSlopeDeg: 22,
    },
    storage_chest: {
        recipeId: 'storage_chest',
        layer: 1,
        cost: { wood: 3, stone: 1 },
        elevationOffsetY: 0.35,
        maxSlopeDeg: 24,
    },
    straw_bed: {
        recipeId: 'straw_bed',
        layer: 1,
        cost: { wood: 3 },
        elevationOffsetY: 0.35,
        maxSlopeDeg: 22,
    },
};

const SEEDED_RESOURCE_NODES = [
    { id: 'res-wood-1', kind: 'wood', name: 'Sanctuary Oak', x: -12, z: 6, maxHp: 100, yieldKind: 'wood', yieldAmount: 3 },
    { id: 'res-wood-2', kind: 'wood', name: 'Meadow Timber', x: -18, z: 18, maxHp: 100, yieldKind: 'wood', yieldAmount: 3 },
    { id: 'res-wood-3', kind: 'wood', name: 'East Pine', x: 11, z: -3, maxHp: 100, yieldKind: 'wood', yieldAmount: 3 },
    { id: 'res-wood-4', kind: 'wood', name: 'Whispering Ash', x: -25, z: -5, maxHp: 100, yieldKind: 'wood', yieldAmount: 3 },
    { id: 'res-wood-5', kind: 'wood', name: 'South Grove', x: -12, z: 30, maxHp: 100, yieldKind: 'wood', yieldAmount: 3 },
    { id: 'res-wood-6', kind: 'wood', name: 'Northwood Cedar', x: 14, z: -24, maxHp: 100, yieldKind: 'wood', yieldAmount: 3 },
    { id: 'res-wood-7', kind: 'wood', name: 'Sunlit Canopy', x: -30, z: 24, maxHp: 100, yieldKind: 'wood', yieldAmount: 3 },
    { id: 'res-wood-8', kind: 'wood', name: 'Lakeside Birch', x: 24, z: -8, maxHp: 100, yieldKind: 'wood', yieldAmount: 3 },
    { id: 'res-stone-1', kind: 'stone', name: 'Granite Outcrop', x: -14, z: 21, maxHp: 100, yieldKind: 'stone', yieldAmount: 3 },
    { id: 'res-stone-2', kind: 'stone', name: 'Shore Slate', x: 10, z: 23, maxHp: 100, yieldKind: 'stone', yieldAmount: 3 },
    { id: 'res-stone-3', kind: 'stone', name: 'West Boulder', x: -24, z: 8, maxHp: 100, yieldKind: 'stone', yieldAmount: 3 },
    { id: 'res-stone-4', kind: 'stone', name: 'Eastern Basalt', x: 28, z: -16, maxHp: 100, yieldKind: 'stone', yieldAmount: 3 },
    { id: 'res-stone-5', kind: 'stone', name: 'Highland Stone', x: -28, z: -34, maxHp: 100, yieldKind: 'stone', yieldAmount: 3 },
    { id: 'res-stone-6', kind: 'stone', name: 'Ruins Limestone', x: -6, z: -28, maxHp: 100, yieldKind: 'stone', yieldAmount: 3 },
    { id: 'res-ore-1', kind: 'ore', name: 'Aether Vein West', x: -34, z: -10, maxHp: 120, yieldKind: 'ore', yieldAmount: 2 },
    { id: 'res-ore-2', kind: 'ore', name: 'Aether Vein East', x: 34, z: -28, maxHp: 120, yieldKind: 'ore', yieldAmount: 2 },
    { id: 'res-ore-3', kind: 'ore', name: 'Sanctuary Seam', x: -18, z: -42, maxHp: 120, yieldKind: 'ore', yieldAmount: 2 },
    { id: 'res-ore-4', kind: 'ore', name: 'Ridge Crystal Vein', x: 24, z: -48, maxHp: 120, yieldKind: 'ore', yieldAmount: 2 },
    { id: 'res-ore-5', kind: 'ore', name: 'Southwest Ore', x: -36, z: 42, maxHp: 120, yieldKind: 'ore', yieldAmount: 2 },
    { id: 'res-berry-1', kind: 'berry', name: 'Sunberry Bush', x: -8, z: 24, maxHp: 60, yieldKind: 'berry', yieldAmount: 3 },
    { id: 'res-berry-2', kind: 'berry', name: 'Dewberry Bush', x: 13, z: 5, maxHp: 60, yieldKind: 'berry', yieldAmount: 3 },
    { id: 'res-berry-3', kind: 'berry', name: 'Glade Berry Bush', x: -11, z: -4, maxHp: 60, yieldKind: 'berry', yieldAmount: 3 },
    { id: 'res-berry-4', kind: 'berry', name: 'Meadow Berry Bush', x: 3, z: 27, maxHp: 60, yieldKind: 'berry', yieldAmount: 3 },
    { id: 'res-berry-5', kind: 'berry', name: 'Thicket Berry Bush', x: -22, z: 32, maxHp: 60, yieldKind: 'berry', yieldAmount: 3 },
];

const SPECIES_WORK_SUITABILITY = {
    moss_hopper: { lumbering: 2, gathering: 2, transporting: 1 },
    aether_wisp: { handiwork: 2, transporting: 2 },
    shale_golem: { mining: 3, transporting: 2 },
};

const MONSTER_SPECIES_CONFIG = {
    moss_hopper: {
        species: 'moss_hopper',
        name: 'Moss Hopper',
        maxHp: 110,
        patrolSpeed: 2.2,
        chaseSpeed: 5.4,
        fleeSpeed: 6.2,
        aggroRadius: 15,
        leashRadius: 28,
        attackRange: 2.6,
        preferredMinRange: 0,
        attackDamage: 12,
        attackWindupMs: 320,
        attackCooldownMs: 1350,
        fleeHpRatio: 0.25,
        aoeRadius: 0,
        radius: 0.65,
        attackPower: 14,
        captureBias: 0.05,
        lootTable: ['Verdant Leaf', 'Spring Dew', 'Moss Petal'],
    },
    aether_wisp: {
        species: 'aether_wisp',
        name: 'Aether Wisp',
        maxHp: 85,
        patrolSpeed: 2.0,
        chaseSpeed: 4.8,
        fleeSpeed: 5.2,
        aggroRadius: 18,
        leashRadius: 32,
        attackRange: 13.0,
        preferredMinRange: 7.0,
        attackDamage: 14,
        attackWindupMs: 520,
        attackCooldownMs: 1800,
        fleeHpRatio: 0,
        aoeRadius: 0,
        radius: 0.65,
        attackPower: 18,
        captureBias: 0,
        lootTable: ['Aether Mote', 'Lumin Shard', 'Starlight Thread'],
    },
    shale_golem: {
        species: 'shale_golem',
        name: 'Shale Golem',
        maxHp: 180,
        patrolSpeed: 1.4,
        chaseSpeed: 3.1,
        fleeSpeed: 3.1,
        aggroRadius: 15,
        leashRadius: 30,
        attackRange: 3.6,
        preferredMinRange: 0,
        attackDamage: 24,
        attackWindupMs: 1050,
        attackCooldownMs: 2400,
        fleeHpRatio: 0,
        aoeRadius: 4.4,
        radius: 1.05,
        attackPower: 26,
        captureBias: -0.05,
        lootTable: ['Runic Shale', 'Amber Core', 'Basalt Fragment'],
    },
};

const WILD_MONSTER_SPAWNS = [
    { id: 'wild-moss_hopper-1', species: 'moss_hopper', level: 3, x: -16, z: -18 },
    { id: 'wild-moss_hopper-2', species: 'moss_hopper', level: 4, x: 16, z: 14 },
    { id: 'wild-aether_wisp-1', species: 'aether_wisp', level: 5, x: 10, z: -44 },
    { id: 'wild-aether_wisp-2', species: 'aether_wisp', level: 6, x: -38, z: -22 },
    { id: 'wild-shale_golem-1', species: 'shale_golem', level: 7, x: 42, z: -26 },
    { id: 'wild-shale_golem-2', species: 'shale_golem', level: 8, x: -46, z: 36 },
];

const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.mjs': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.glb': 'model/gltf-binary',
    '.gltf': 'model/gltf+json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.wasm': 'application/wasm',
    '.txt': 'text/plain; charset=utf-8',
};

// ============================================================================
// Analytical Terrain Heightfield (copied verbatim from CollisionWorld.ts)
// ============================================================================

function clamp(v, min, max) {
    return v < min ? min : v > max ? max : v;
}

function smoothstep(edge0, edge1, x) {
    const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
    return t * t * (3 - 2 * t);
}

function lerp(a, b, t) {
    return a + (b - a) * t;
}

function hash2D(ix, iz) {
    let n = Math.imul(ix, 374761393) + Math.imul(iz, 668265263);
    n = (n ^ (n >>> 13)) >>> 0;
    n = Math.imul(n, 1274126177) >>> 0;
    return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}

function valueNoise2D(x, z) {
    const ix = Math.floor(x);
    const iz = Math.floor(z);
    const fx = x - ix;
    const fz = z - iz;

    const u = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
    const v = fz * fz * fz * (fz * (fz * 6 - 15) + 10);

    const a = hash2D(ix, iz);
    const b = hash2D(ix + 1, iz);
    const c = hash2D(ix, iz + 1);
    const d = hash2D(ix + 1, iz + 1);

    return lerp(lerp(a, b, u), lerp(c, d, u), v);
}

function fbm2D(x, z) {
    let sum = 0;
    let amp = 0.55;
    let freq = 1;
    let norm = 0;
    for (let i = 0; i < 3; i++) {
        sum += (valueNoise2D(x * freq, z * freq) * 2 - 1) * amp;
        norm += amp;
        amp *= 0.5;
        freq *= 2.07;
    }
    return sum / norm;
}

function getNorthTrailCenterX(z) {
    const env = smoothstep(14, 2, z) * smoothstep(-44, -33, z);
    const phase = ((12 - z) / 52) * Math.PI * 1.75;
    return 6.2 * Math.sin(phase) * env;
}

function getSouthTrailCenterX(z) {
    const env = smoothstep(10, 22, z) * smoothstep(88, 72, z);
    const phase = ((z - 12) / 72) * Math.PI * 1.55;
    return 7.5 * Math.sin(phase) * env;
}

function sampleTrailMask(x, z) {
    let mask = 0;

    if (z >= -46 && z <= 16) {
        const cx = getNorthTrailCenterX(clamp(z, -43, 12));
        const dz = z < -43 ? -43 - z : z > 12 ? z - 12 : 0;
        const d = Math.hypot(x - cx, dz);
        const halfWidth = 3.2;
        mask = Math.max(mask, 1 - smoothstep(halfWidth * 0.45, halfWidth, d));
    }

    if (z >= 10 && z <= 88) {
        const cx = getSouthTrailCenterX(clamp(z, 12, 84));
        const dz = z < 12 ? 12 - z : z > 84 ? z - 84 : 0;
        const d = Math.hypot(x - cx, dz);
        const halfWidth = 3.0;
        mask = Math.max(mask, 1 - smoothstep(halfWidth * 0.45, halfWidth, d));
    }

    {
        const ax = 2;
        const az = 16;
        const bx = 14.5;
        const bz = 24;
        const abx = bx - ax;
        const abz = bz - az;
        const lenSq = abx * abx + abz * abz;
        const t = clamp(((x - ax) * abx + (z - az) * abz) / lenSq, 0, 1);
        const px = ax + abx * t;
        const pz = az + abz * t;
        const d = Math.hypot(x - px, z - pz);
        mask = Math.max(mask, 1 - smoothstep(1.3, 2.7, d));
    }

    return clamp(mask, 0, 1);
}

export function sampleIslandHeight(x, z) {
    const rolling =
        2.35 +
        1.65 * fbm2D(x * 0.018 + 3.1, z * 0.018 - 1.7) +
        0.55 * Math.sin(x * 0.055) * Math.cos(z * 0.052);

    const dSpawn = Math.hypot(x * 0.9, z - 6.5);
    const spawnFlat = 1 - smoothstep(10, 22, dSpawn);
    const spawnHeight = 2.2 + 0.08 * Math.sin(x * 0.14) * Math.cos(z * 0.14);
    let h = lerp(rolling, spawnHeight, spawnFlat * 0.92);

    const westKnoll = Math.exp(-((x + 48) * (x + 48) + (z + 16) * (z + 16)) / (2 * 16 * 16));
    const eastKnoll = Math.exp(-((x - 48) * (x - 48) + (z + 20) * (z + 20)) / (2 * 17 * 17));
    const southWestHill = Math.exp(-((x + 44) * (x + 44) + (z - 46) * (z - 46)) / (2 * 18 * 18));
    h += westKnoll * 3.1 + eastKnoll * 3.2 + southWestHill * 2.6;

    const dOutpostW = Math.hypot(x + 46, z + 16);
    const outpostWMask = 1 - smoothstep(5.5, 11, dOutpostW);
    h = lerp(h, 5.2, outpostWMask * 0.9);

    const dOutpostE = Math.hypot(x - 48, z + 20);
    const outpostEMask = 1 - smoothstep(5.5, 11, dOutpostE);
    h = lerp(h, 5.4, outpostEMask * 0.9);

    const dxPlat = x;
    const dzPlat = z + 48;
    const dPlat = Math.hypot(dxPlat, dzPlat);
    const anglePlat = Math.atan2(dzPlat, dxPlat);
    const platEdgeJitter = 1.1 * Math.sin(anglePlat * 4 + 0.4) + 0.7 * Math.cos(anglePlat * 3 - 0.9);
    const platInnerR = 11.2 + platEdgeJitter * 0.5;
    const southCorridor =
        smoothstep(14, 4.5, Math.abs(x - getNorthTrailCenterX(clamp(z, -42, 0)))) *
        smoothstep(-48, -36, z);
    const platOuterR = lerp(16.2 + platEdgeJitter, 28, southCorridor);
    const platMask = 1 - smoothstep(platInnerR, platOuterR, dPlat);
    h = lerp(h, 8.5, platMask);

    if (z >= -44 && z <= 4) {
        const trailCx = getNorthTrailCenterX(clamp(z, -43, 12));
        const dTrail = Math.abs(x - trailCx);
        const rampBlend =
            (1 - smoothstep(3.2, 8.8, dTrail)) *
            smoothstep(2, -5, z) *
            smoothstep(-45, -37, z);
        const rampProgress = smoothstep(-2, -37, z);
        const rampTargetH = lerp(2.2, 8.5, rampProgress);
        h = lerp(h, rampTargetH, rampBlend * 0.92);
    }

    const lx = x - 28;
    const lz = z - 28;
    const dLake = Math.hypot(lx, lz);
    const lakeAngle = Math.atan2(lz, lx);
    const lakeWobble = 1.6 * Math.sin(lakeAngle * 3 + 0.6) + 1.0 * Math.cos(lakeAngle * 2 - 0.4);
    const lakeShoreOuter = 20.5 + lakeWobble;
    const lakeBasinMask = 1 - smoothstep(3.5, lakeShoreOuter, dLake);
    const deepBowl = Math.pow(lakeBasinMask, 0.88);
    h = lerp(h, -1.42, deepBowl);

    const southTrailMask = sampleTrailMask(x, z);
    if (southTrailMask > 0 && z > 10) {
        const smoothPathNoise = 2.15 + 0.45 * Math.sin(z * 0.045);
        h = lerp(h, Math.max(0.45, Math.min(h, smoothPathNoise + 0.9)), southTrailMask * 0.35);
    }

    const radialDist = Math.hypot(x, z);
    if (radialDist > 76) {
        const ridgeRamp = smoothstep(78, 108, radialDist);
        const theta = Math.atan2(z, x);
        const ridgePeaks =
            11.2 +
            4.6 * (0.5 + 0.5 * Math.sin(theta * 5 + 0.9)) +
            3.2 * (0.5 + 0.5 * Math.cos(theta * 9 - 0.4)) +
            3.4 * (0.5 + 0.5 * fbm2D(x * 0.045 + 7.2, z * 0.045 - 4.8));
        const ridgeHeight = clamp(ridgePeaks, 10.2, 22.0);
        h = lerp(h, ridgeHeight, ridgeRamp);
    }

    return h;
}

export function getTerrainHeight(x, z) {
    const cx = clamp(x, -WORLD_HALF_SIZE, WORLD_HALF_SIZE);
    const cz = clamp(z, -WORLD_HALF_SIZE, WORLD_HALF_SIZE);
    return sampleIslandHeight(cx, cz);
}

// ============================================================================
// Sanitization & Room Helpers
// ============================================================================

function sanitizeRoomCode(raw) {
    if (typeof raw !== 'string') return '';
    return raw
        .trim()
        .toUpperCase()
        .replace(/[^A-Z0-9_-]/g, '')
        .slice(0, 12);
}

function isValidRoomCode(code) {
    return /^[A-Z0-9][A-Z0-9_-]{2,11}$/.test(code);
}

function sanitizeDisplayName(raw) {
    if (typeof raw !== 'string') return 'Explorer';
    const cleaned = raw.trim().replace(/\s+/g, ' ').slice(0, 16);
    return cleaned.length > 0 ? cleaned : 'Explorer';
}

function sanitizeToken(raw) {
    if (typeof raw !== 'string') return '';
    return raw.trim().slice(0, 64);
}

function sanitizePlayerId(raw) {
    if (typeof raw !== 'string') return '';
    const cleaned = raw.trim().replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 48);
    return cleaned;
}

function generateUniqueRoomCode(rooms, extraMap = null) {
    for (let attempt = 0; attempt < 32; attempt++) {
        const bytes = randomBytes(6);
        let code = '';
        for (let i = 0; i < 6; i++) {
            code += ROOM_CODE_ALPHABET[bytes[i] % ROOM_CODE_ALPHABET.length];
        }
        if (!rooms.has(code) && (!extraMap || !extraMap.has(code))) {
            return code;
        }
    }
    return `ZP${Date.now().toString(36).toUpperCase().slice(-6)}`;
}

function generatePlayerId() {
    return `exp-${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

function sendJson(ws, payload) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(payload));
}

function round3(n) {
    return Math.round(n * 1000) / 1000;
}

function directionToYawDeg(dx, dz) {
    return Number(((Math.atan2(-dx, -dz) * 180) / Math.PI).toFixed(1));
}

function clampToPlayableIsland(x, z) {
    const r = Math.hypot(x, z);
    if (r > PLAYABLE_MAX_RADIUS && r > 1e-6) {
        const s = PLAYABLE_MAX_RADIUS / r;
        return { x: x * s, z: z * s };
    }
    return { x, z };
}

function computeCaptureChance(species, hp, maxHp) {
    const cfg = MONSTER_SPECIES_CONFIG[species];
    const safeMax = Math.max(1, maxHp);
    const missingRatio = clamp(1 - hp / safeMax, 0, 1);
    const bias = cfg ? cfg.captureBias : 0;
    const raw = 0.25 + missingRatio * 0.68 + bias;
    return Math.round(clamp(raw, 0.15, 0.92) * 100) / 100;
}

function createInitialMonsters() {
    const monsters = new Map();
    for (let i = 0; i < WILD_MONSTER_SPAWNS.length; i++) {
        const spawn = WILD_MONSTER_SPAWNS[i];
        const cfg = MONSTER_SPECIES_CONFIG[spawn.species];
        const y = round3(getTerrainHeight(spawn.x, spawn.z));
        const angle = (i * 1.1) % (Math.PI * 2);
        monsters.set(spawn.id, {
            id: spawn.id,
            species: spawn.species,
            name: cfg.name,
            level: spawn.level,
            homeX: spawn.x,
            homeY: y,
            homeZ: spawn.z,
            x: spawn.x,
            y,
            z: spawn.z,
            yaw: directionToYawDeg(Math.cos(angle), Math.sin(angle)),
            vx: 0,
            vz: 0,
            hp: cfg.maxHp,
            maxHp: cfg.maxHp,
            aiState: 'patrol',
            targetPlayerId: null,
            targetCompanionId: null,
            captureLockByPlayerId: null,
            respawnRemainingMs: 0,
            attackCharge: 0,
            patrolAngle: angle,
            patrolTargetX: spawn.x + Math.cos(angle) * 3.5,
            patrolTargetZ: spawn.z + Math.sin(angle) * 3.5,
            stateTimerMs: 2200 + i * 350,
            attackWindupElapsedMs: 0,
            attackCooldownUntilMs: 0,
            telegraphEmitted: false,
            throttledAccumMs: 0,
            captureAttemptPlayerId: null,
            captureAttemptChance: 0,
            captureResolveAtMs: 0,
        });
    }
    return monsters;
}

function serializeMonster(m) {
    return {
        id: m.id,
        species: m.species,
        name: m.name,
        level: m.level,
        x: round3(m.x),
        y: round3(m.y),
        z: round3(m.z),
        yaw: m.yaw,
        vx: round3(m.vx),
        vz: round3(m.vz),
        hp: m.hp,
        maxHp: m.maxHp,
        aiState: m.aiState,
        targetPlayerId: m.targetPlayerId,
        targetCompanionId: m.targetCompanionId,
        captureLockByPlayerId: m.captureLockByPlayerId,
        respawnRemainingMs: Math.max(0, Math.round(m.respawnRemainingMs)),
        attackCharge: Number(clamp(m.attackCharge, 0, 1).toFixed(2)),
    };
}

function serializeMonsters(room) {
    const out = [];
    for (const m of room.monsters.values()) {
        out.push(serializeMonster(m));
    }
    return out;
}

function serializeCompanion(c) {
    return {
        uid: c.uid,
        ownerPlayerId: c.ownerPlayerId,
        species: c.species,
        nickname: c.nickname,
        level: c.level,
        x: round3(c.x),
        y: round3(c.y),
        z: round3(c.z),
        yaw: c.yaw,
        hp: c.hp,
        maxHp: c.maxHp,
        aiState: c.aiState,
        targetMonsterId: c.targetMonsterId,
    };
}

function serializeCompanions(room) {
    const out = [];
    for (const c of room.companions.values()) {
        out.push(serializeCompanion(c));
    }
    return out;
}

function broadcastCombatEvent(room, payload) {
    room.combatEventSeq += 1;
    broadcastToRoom(room, {
        type: 's2c_combat_event',
        seq: room.combatEventSeq,
        serverTime: Date.now(),
        ...payload,
    });
}

function sendCombatEventToPlayer(room, player, payload) {
    room.combatEventSeq += 1;
    sendJson(player.ws, {
        type: 's2c_combat_event',
        seq: room.combatEventSeq,
        serverTime: Date.now(),
        ...payload,
    });
}

// ============================================================================
// Room State, Survival Helpers & Persistence Authority
// ============================================================================

const rooms = new Map();
const persistedRooms = new Map();
const wsMeta = new WeakMap();
const wsAlive = new WeakMap();

function getTerrainSlopeDeg(x, z) {
    const eps = 0.5;
    const hL = getTerrainHeight(x - eps, z);
    const hR = getTerrainHeight(x + eps, z);
    const hD = getTerrainHeight(x, z - eps);
    const hU = getTerrainHeight(x, z + eps);
    const dhdx = (hR - hL) / (2 * eps);
    const dhdz = (hU - hD) / (2 * eps);
    const invLen = 1 / Math.hypot(-dhdx, 1, -dhdz);
    const normalY = clamp(invLen, -1, 1);
    return (Math.acos(normalY) * 180) / Math.PI;
}

function createInitialResourceNodes(restoredNodes = null) {
    const restoredById = new Map();
    if (Array.isArray(restoredNodes)) {
        for (const rn of restoredNodes) {
            if (rn && typeof rn.id === 'string') {
                restoredById.set(rn.id, rn);
            }
        }
    }

    const nodes = new Map();
    for (const def of SEEDED_RESOURCE_NODES) {
        const y = round3(getTerrainHeight(def.x, def.z));
        const saved = restoredById.get(def.id);
        const depleted = Boolean(saved?.depleted);
        const hp = depleted
            ? 0
            : Number.isFinite(Number(saved?.hp))
              ? clamp(Math.round(Number(saved.hp)), 0, def.maxHp)
              : def.maxHp;
        const respawnRemainingMs = depleted
            ? Math.max(250, Number(saved?.respawnRemainingMs ?? RESOURCE_RESPAWN_MS))
            : 0;
        nodes.set(def.id, {
            id: def.id,
            kind: def.kind,
            name: def.name,
            x: def.x,
            y,
            z: def.z,
            hp,
            maxHp: def.maxHp,
            yieldKind: def.yieldKind,
            yieldAmount: def.yieldAmount,
            depleted,
            respawnRemainingMs,
        });
    }
    return nodes;
}

function serializeResourceNode(n) {
    return {
        id: n.id,
        kind: n.kind,
        name: n.name,
        x: round3(n.x),
        y: round3(n.y),
        z: round3(n.z),
        hp: n.hp,
        maxHp: n.maxHp,
        depleted: Boolean(n.depleted),
        respawnRemainingMs: Math.max(0, Math.round(n.respawnRemainingMs || 0)),
    };
}

function serializeResourceNodes(room) {
    const out = [];
    for (const n of room.resourceNodes.values()) {
        out.push(serializeResourceNode(n));
    }
    return out;
}

function serializeStructures(room) {
    const out = [];
    for (const s of room.structures.values()) {
        out.push({ ...s });
    }
    return out;
}

function serializeBaseWorker(w) {
    return {
        uid: w.uid,
        ownerPlayerId: w.ownerPlayerId,
        species: w.species,
        nickname: w.nickname,
        level: w.level,
        x: round3(w.x),
        y: round3(w.y),
        z: round3(w.z),
        yaw: w.yaw,
        aiState: w.aiState,
        activeWork: w.activeWork,
        carryingKind: w.carryingKind,
        carryingAmount: w.carryingAmount,
        energy: Number(clamp(w.energy, 0, w.maxEnergy).toFixed(1)),
        maxEnergy: w.maxEnergy,
        targetNodeId: w.targetNodeId,
        targetStructureId: w.targetStructureId,
    };
}

function serializeBaseWorkers(room) {
    const out = [];
    for (const w of room.baseWorkers.values()) {
        out.push(serializeBaseWorker(w));
    }
    return out;
}

function serializeSavedPlayerRecord(player) {
    return {
        playerId: player.playerId,
        sessionToken: player.sessionToken || '',
        displayName: player.displayName,
        slotIndex: player.slotIndex,
        position: { ...player.state.position },
        yawDeg: player.state.yawDeg,
        hp: player.state.hp,
        maxHp: player.state.maxHp,
        hunger: player.state.hunger,
        maxHunger: player.state.maxHunger,
        stamina: player.state.stamina,
        equippedTool: player.state.equippedTool,
        unlockedTools: [...player.state.unlockedTools],
        captureSpheres: player.state.captureSpheres,
        lootCount: player.state.lootCount,
        crystalsCollected: player.state.crystalsCollected,
        capturedRoster: player.capturedRoster.map((r) => ({ ...r })),
        updatedAtMs: Date.now(),
    };
}

function recordSavedPlayer(room, player) {
    const saved = serializeSavedPlayerRecord(player);
    room.savedPlayersById.set(saved.playerId, saved);
    if (saved.sessionToken) {
        room.savedPlayersByToken.set(saved.sessionToken, saved);
    }
    const normName = sanitizeDisplayName(saved.displayName).toLowerCase();
    if (normName) {
        room.savedPlayersByName.set(normName, saved);
    }
    return saved;
}

function buildRoomSnapshot(room) {
    for (const player of room.players.values()) {
        recordSavedPlayer(room, player);
    }
    return {
        roomCode: room.code,
        worldSeed: 42019,
        createdAtMs: room.createdAtMs,
        updatedAtMs: Date.now(),
        sharedResources: { ...room.sharedResources },
        collectedCrystals: Array.from(room.collectedCrystals),
        resourceNodes: serializeResourceNodes(room),
        structures: serializeStructures(room),
        baseWorkers: serializeBaseWorkers(room),
        players: Array.from(room.savedPlayersById.values()),
    };
}

const persistenceStore = new PersistenceStore({
    databaseUrl: process.env.DATABASE_URL || process.env.NEON_DATABASE_URL || '',
    dataFile: process.env.ZAAP_DATA_FILE || path.resolve(__dirname, '../data/zaapworld_store.json'),
    roomSnapshotProvider: (roomCode) => {
        const active = rooms.get(roomCode);
        if (active) {
            const snap = buildRoomSnapshot(active);
            persistedRooms.set(roomCode, snap);
            return snap;
        }
        return persistedRooms.get(roomCode) ?? null;
    },
});

function markRoomDirty(room) {
    const snap = buildRoomSnapshot(room);
    persistedRooms.set(room.code, snap);
    persistenceStore.markRoomDirty(room.code);
}

function hasRoomStructureRecipe(room, recipeId) {
    for (const s of room.structures.values()) {
        if (s.recipeId === recipeId) return true;
    }
    return false;
}

function broadcastSurvivalEvent(room, payload) {
    room.survivalEventSeq += 1;
    broadcastToRoom(room, {
        type: 's2c_survival_event',
        seq: room.survivalEventSeq,
        serverTime: Date.now(),
        roomCode: room.code,
        sharedResources: { ...room.sharedResources },
        ...payload,
    });
}

function sendSurvivalEventToPlayer(room, player, payload) {
    room.survivalEventSeq += 1;
    sendJson(player.ws, {
        type: 's2c_survival_event',
        seq: room.survivalEventSeq,
        serverTime: Date.now(),
        roomCode: room.code,
        sharedResources: { ...room.sharedResources },
        ...payload,
    });
}

function createRoomRecord(code, restored = null) {
    const sharedResources = {
        ...DEFAULT_SHARED_RESOURCES,
        ...(restored?.sharedResources && typeof restored.sharedResources === 'object'
            ? restored.sharedResources
            : {}),
    };
    for (const k of Object.keys(DEFAULT_SHARED_RESOURCES)) {
        sharedResources[k] = Math.max(0, Math.floor(Number(sharedResources[k] ?? 0)));
    }

    const structures = new Map();
    if (Array.isArray(restored?.structures)) {
        for (const s of restored.structures) {
            if (!s || !Number.isInteger(s.gridX) || !Number.isInteger(s.gridZ)) continue;
            const layer = Number.isInteger(s.layer) ? s.layer : 1;
            const key = `${s.gridX}:${s.gridZ}:${layer}`;
            structures.set(key, {
                id: String(s.id || `struct-${s.gridX}_${s.gridZ}_${layer}`),
                recipeId: String(s.recipeId),
                gridX: s.gridX,
                gridZ: s.gridZ,
                layer,
                x: Number(s.x),
                y: Number(s.y),
                z: Number(s.z),
                rotationYawDeg: Number(s.rotationYawDeg ?? 0),
                ownerPlayerId: String(s.ownerPlayerId || ''),
                ownerName: String(s.ownerName || 'Explorer'),
                createdAtMs: Number(s.createdAtMs || Date.now()),
            });
        }
    }

    const baseWorkers = new Map();
    if (Array.isArray(restored?.baseWorkers)) {
        for (const w of restored.baseWorkers.slice(0, MAX_BASE_WORKERS)) {
            if (!w || !w.uid || !MONSTER_SPECIES_CONFIG[w.species]) continue;
            const clamped = clampToPlayableIsland(Number(w.x ?? 0), Number(w.z ?? 12));
            baseWorkers.set(String(w.uid), {
                uid: String(w.uid),
                ownerPlayerId: String(w.ownerPlayerId || ''),
                species: w.species,
                nickname: String(w.nickname || MONSTER_SPECIES_CONFIG[w.species].name),
                level: Math.max(1, Number(w.level ?? 1)),
                x: round3(clamped.x),
                y: round3(getTerrainHeight(clamped.x, clamped.z)),
                z: round3(clamped.z),
                yaw: Number(w.yaw ?? 0),
                aiState: w.aiState || 'idle',
                activeWork: w.activeWork ?? null,
                carryingKind: w.carryingKind ?? null,
                carryingAmount: Math.max(0, Number(w.carryingAmount ?? 0)),
                energy: clamp(Number(w.energy ?? 100), 0, Number(w.maxEnergy ?? 100)),
                maxEnergy: Math.max(1, Number(w.maxEnergy ?? 100)),
                targetNodeId: w.targetNodeId ?? null,
                targetStructureId: w.targetStructureId ?? null,
                workProgressMs: 0,
            });
        }
    }

    const savedPlayersById = new Map();
    const savedPlayersByToken = new Map();
    const savedPlayersByName = new Map();
    if (Array.isArray(restored?.players)) {
        for (const sp of restored.players) {
            if (!sp || !sp.playerId) continue;
            savedPlayersById.set(sp.playerId, sp);
            if (sp.sessionToken) savedPlayersByToken.set(sp.sessionToken, sp);
            const norm = sanitizeDisplayName(sp.displayName || '').toLowerCase();
            if (norm) savedPlayersByName.set(norm, sp);
        }
    }

    const room = {
        code,
        createdAtMs: Number(restored?.createdAtMs || Date.now()),
        tickSeq: 0,
        combatEventSeq: 0,
        survivalEventSeq: 0,
        lastTickAtMs: Date.now(),
        lastPeriodicPersistAtMs: Date.now(),
        wasRestored: Boolean(restored),
        players: new Map(),
        slots: Array(MAX_PARTY_PLAYERS).fill(null),
        sessionToPlayerId: new Map(),
        collectedCrystals: new Set(
            Array.isArray(restored?.collectedCrystals) ? restored.collectedCrystals : []
        ),
        seenEventIds: new Set(),
        graceTimers: new Map(),
        monsters: createInitialMonsters(),
        companions: new Map(),
        sharedResources,
        resourceNodes: createInitialResourceNodes(restored?.resourceNodes),
        structures,
        baseWorkers,
        savedPlayersById,
        savedPlayersByToken,
        savedPlayersByName,
    };
    rooms.set(code, room);
    return room;
}

function getRoomPlayersSorted(room) {
    return Array.from(room.players.values())
        .map((p) => p.state)
        .sort((a, b) => a.slotIndex - b.slotIndex);
}

function broadcastToRoom(room, payload, excludePlayerId = null) {
    const serialized = JSON.stringify(payload);
    for (const player of room.players.values()) {
        if (excludePlayerId && player.playerId === excludePlayerId) continue;
        if (player.connected && player.ws && player.ws.readyState === WebSocket.OPEN) {
            player.ws.send(serialized);
        }
    }
}

function clearPlayerGraceTimer(room, playerId) {
    const timer = room.graceTimers.get(playerId);
    if (timer) {
        clearTimeout(timer);
        room.graceTimers.delete(playerId);
    }
}

function deleteRoomIfEmpty(room) {
    if (room.players.size === 0) {
        for (const timer of room.graceTimers.values()) {
            clearTimeout(timer);
        }
        room.graceTimers.clear();
        const snap = buildRoomSnapshot(room);
        persistedRooms.set(room.code, snap);
        persistenceStore.markRoomDirty(room.code);
        rooms.delete(room.code);
    }
}

function removePlayerFromRoom(room, playerId, reason) {
    const player = room.players.get(playerId);
    if (!player) return;

    recordSavedPlayer(room, player);
    clearPlayerGraceTimer(room, playerId);
    if (player.ws) {
        wsMeta.delete(player.ws);
    }

    const activeCompanion = room.companions.get(playerId);
    if (activeCompanion) {
        room.companions.delete(playerId);
    }

    for (const monster of room.monsters.values()) {
        if (monster.targetPlayerId === playerId) {
            monster.targetPlayerId = null;
        }
        if (activeCompanion && monster.targetCompanionId === activeCompanion.uid) {
            monster.targetCompanionId = null;
        }
        if (monster.captureLockByPlayerId === playerId) {
            monster.captureLockByPlayerId = null;
            if (monster.aiState === 'capturing') {
                monster.aiState = 'alert';
                monster.stateTimerMs = 400;
            }
        }
    }

    room.players.delete(playerId);
    if (room.slots[player.slotIndex] === playerId) {
        room.slots[player.slotIndex] = null;
    }
    for (const [token, mappedId] of room.sessionToPlayerId.entries()) {
        if (mappedId === playerId) {
            room.sessionToPlayerId.delete(token);
        }
    }

    if (activeCompanion && room.players.size > 0) {
        broadcastCombatEvent(room, {
            event: 'companion_recall',
            actorId: playerId,
            targetId: activeCompanion.uid,
            x: activeCompanion.x,
            y: activeCompanion.y,
            z: activeCompanion.z,
            reason: 'OWNER_LEFT',
        });
    }

    broadcastToRoom(room, {
        type: 's2c_player_left',
        roomCode: room.code,
        playerId: player.playerId,
        displayName: player.displayName,
        slotIndex: player.slotIndex,
        reason,
        serverTimeMs: Date.now(),
    });

    if (room.players.size > 0) {
        markRoomDirty(room);
    }
    deleteRoomIfEmpty(room);
}

function leaveCurrentRoom(ws, reason = 'leave') {
    const meta = wsMeta.get(ws);
    if (!meta) return;
    wsMeta.delete(ws);

    const room = rooms.get(meta.roomCode);
    if (!room) return;
    const player = room.players.get(meta.playerId);
    if (!player || player.ws !== ws) return;

    player.ws = null;
    removePlayerFromRoom(room, player.playerId, reason);
}

function bindExistingPlayerSocket(room, existing, ws, sessionToken, displayName) {
    clearPlayerGraceTimer(room, existing.playerId);
    const wasDisconnected = !existing.connected;

    if (sessionToken) {
        room.sessionToPlayerId.set(sessionToken, existing.playerId);
        existing.sessionToken = sessionToken;
    }

    if (existing.ws && existing.ws !== ws) {
        const oldWs = existing.ws;
        wsMeta.delete(oldWs);
        if (
            oldWs.readyState === WebSocket.OPEN ||
            oldWs.readyState === WebSocket.CONNECTING
        ) {
            sendJson(oldWs, {
                type: 's2c_kicked_duplicate',
                roomCode: room.code,
                playerId: existing.playerId,
                message: '다른 연결에서 동일 세션으로 접속하여 연결이 전환되었습니다.',
            });
            try {
                oldWs.close(4001, 'Duplicate session');
            } catch {
                // Ignore close error
            }
        }
    }

    const now = Date.now();
    existing.ws = ws;
    existing.connected = true;
    existing.disconnectedAtMs = null;
    existing.lastAckSeq = 0;
    existing.lastCombatSeq = 0;
    existing.lastSurvivalSeq = 0;
    existing.lastClientTsMs = 0;
    existing.lastStateAtMs = now;
    if (displayName) {
        existing.displayName = displayName;
        existing.state.displayName = displayName;
    }
    existing.state.seq = 0;
    existing.state.connected = true;
    existing.state.timestampMs = now;

    wsMeta.set(ws, { roomCode: room.code, playerId: existing.playerId });

    sendJson(ws, {
        type: 's2c_room_joined',
        protocolVersion: PROTOCOL_VERSION,
        roomCode: room.code,
        playerId: existing.playerId,
        slotIndex: existing.slotIndex,
        displayName: existing.displayName,
        reconnected: true,
        serverTimeMs: Date.now(),
        players: getRoomPlayersSorted(room),
        collectedCrystals: Array.from(room.collectedCrystals),
        monsters: serializeMonsters(room),
        companions: serializeCompanions(room),
        capturedRoster: existing.capturedRoster,
        sharedResources: { ...room.sharedResources },
        resourceNodes: serializeResourceNodes(room),
        structures: serializeStructures(room),
        baseWorkers: serializeBaseWorkers(room),
        persistenceMode: persistenceStore.getStatus().mode,
    });

    if (wasDisconnected) {
        broadcastToRoom(
            room,
            {
                type: 's2c_player_reconnected',
                roomCode: room.code,
                player: existing.state,
                serverTimeMs: Date.now(),
            },
            existing.playerId
        );
    }
}

function findSavedPlayerMatch(room, requestedPlayerId, sessionToken, displayName) {
    if (requestedPlayerId) {
        const byId = room.savedPlayersById.get(requestedPlayerId);
        if (byId && !room.players.has(byId.playerId)) {
            return byId;
        }
    }
    if (sessionToken) {
        const byTok = room.savedPlayersByToken.get(sessionToken);
        if (byTok && !room.players.has(byTok.playerId)) {
            return byTok;
        }
    }
    const normName = sanitizeDisplayName(displayName).toLowerCase();
    if (normName) {
        const byName = room.savedPlayersByName.get(normName);
        if (byName && !room.players.has(byName.playerId)) {
            return byName;
        }
    }
    return null;
}

function addNewPlayerToRoom(room, ws, sessionToken, requestedPlayerId, displayName, reconnectedRoom = false) {
    const slotIndex = room.slots.indexOf(null);
    if (slotIndex === -1) {
        sendJson(ws, {
            type: 's2c_room_error',
            code: 'ROOM_FULL',
            message: '방 인원이 가득 찼습니다 (최대 3명).',
            roomCode: room.code,
        });
        return;
    }

    const savedMatch = findSavedPlayerMatch(room, requestedPlayerId, sessionToken, displayName);
    const playerId =
        requestedPlayerId && !room.players.has(requestedPlayerId)
            ? requestedPlayerId
            : savedMatch && !room.players.has(savedMatch.playerId)
              ? savedMatch.playerId
              : generatePlayerId();

    if (savedMatch && savedMatch.playerId !== playerId) {
        for (const worker of room.baseWorkers.values()) {
            if (worker.ownerPlayerId === savedMatch.playerId) {
                worker.ownerPlayerId = playerId;
            }
        }
    }

    const spawn = SLOT_SPAWN_OFFSETS[slotIndex] || SLOT_SPAWN_OFFSETS[0];
    let spawnX = spawn.x;
    let spawnZ = spawn.z;
    let spawnY = round3(getTerrainHeight(spawnX, spawnZ));
    let spawnYaw = 0;

    if (
        savedMatch?.position &&
        Number.isFinite(Number(savedMatch.position.x)) &&
        Number.isFinite(Number(savedMatch.position.z))
    ) {
        const clamped = clampToPlayableIsland(
            Number(savedMatch.position.x),
            Number(savedMatch.position.z)
        );
        spawnX = round3(clamped.x);
        spawnZ = round3(clamped.z);
        const minTerrainY = getTerrainHeight(spawnX, spawnZ);
        const savedY = Number(savedMatch.position.y);
        spawnY = round3(
            Number.isFinite(savedY)
                ? clamp(savedY, minTerrainY - MAX_FLOOR_BELOW_TERRAIN, minTerrainY + MAX_CEILING_ABOVE_TERRAIN)
                : minTerrainY
        );
        if (Number.isFinite(Number(savedMatch.yawDeg))) {
            spawnYaw = Number(Number(savedMatch.yawDeg).toFixed(1));
        }
    }

    const now = Date.now();
    const unlockedTools = Array.isArray(savedMatch?.unlockedTools)
        ? Array.from(
              new Set(
                  savedMatch.unlockedTools.filter((t) =>
                      Boolean(TOOL_COMBAT_BONUSES[t])
                  )
              )
          )
        : ['hands'];
    if (!unlockedTools.includes('hands')) {
        unlockedTools.unshift('hands');
    }
    const equippedTool =
        savedMatch?.equippedTool && unlockedTools.includes(savedMatch.equippedTool)
            ? savedMatch.equippedTool
            : 'hands';
    const restoredHunger = Number.isFinite(Number(savedMatch?.hunger))
        ? clamp(Number(savedMatch.hunger), 0, PLAYER_MAX_HUNGER)
        : PLAYER_MAX_HUNGER;
    const restoredHp = Number.isFinite(Number(savedMatch?.hp))
        ? clamp(Math.round(Number(savedMatch.hp)), 1, PLAYER_MAX_HP)
        : PLAYER_MAX_HP;

    const state = {
        playerId,
        displayName,
        slotIndex,
        seq: 0,
        timestampMs: now,
        position: { x: spawnX, y: spawnY, z: spawnZ },
        velocity: { x: 0, y: 0, z: 0 },
        yawDeg: spawnYaw,
        animState: 'idle',
        grounded: true,
        inWater: spawnY < 0,
        stamina: Number.isFinite(Number(savedMatch?.stamina))
            ? clamp(Math.round(Number(savedMatch.stamina)), 0, 100)
            : 100,
        crystalsCollected: room.collectedCrystals.size,
        connected: true,
        hp: restoredHp,
        maxHp: PLAYER_MAX_HP,
        combatState: 'idle',
        activeCompanionId: null,
        captureSpheres: Number.isFinite(Number(savedMatch?.captureSpheres))
            ? clamp(Math.round(Number(savedMatch.captureSpheres)), 0, MAX_CAPTURE_SPHERES)
            : STARTING_CAPTURE_SPHERES,
        lootCount: Number.isFinite(Number(savedMatch?.lootCount))
            ? Math.max(0, Math.round(Number(savedMatch.lootCount)))
            : 0,
        hunger: Number(restoredHunger.toFixed(1)),
        maxHunger: PLAYER_MAX_HUNGER,
        equippedTool,
        unlockedTools,
    };

    const record = {
        playerId,
        sessionToken,
        displayName,
        slotIndex,
        ws,
        connected: true,
        disconnectedAtMs: null,
        lastAckSeq: 0,
        lastCombatSeq: 0,
        lastSurvivalSeq: 0,
        lastStateAtMs: now,
        lastClientTsMs: 0,
        invulnerableUntilMs: 0,
        respawnedAtMs: 0,
        combatStateUntilMs: 0,
        lastMeleeAtMs: 0,
        lastRangedAtMs: 0,
        lastDodgeAtMs: 0,
        lastThrowAtMs: 0,
        lastGatherAtMs: 0,
        hungerFloat: restoredHunger,
        capturedRoster: Array.isArray(savedMatch?.capturedRoster)
            ? savedMatch.capturedRoster.map((r) => ({ ...r }))
            : [],
        state,
    };

    room.players.set(playerId, record);
    room.slots[slotIndex] = playerId;
    if (sessionToken) {
        room.sessionToPlayerId.set(sessionToken, playerId);
    }
    recordSavedPlayer(room, record);
    markRoomDirty(room);

    wsMeta.set(ws, { roomCode: room.code, playerId });

    sendJson(ws, {
        type: 's2c_room_joined',
        protocolVersion: PROTOCOL_VERSION,
        roomCode: room.code,
        playerId,
        slotIndex,
        displayName,
        reconnected: reconnectedRoom,
        serverTimeMs: now,
        players: getRoomPlayersSorted(room),
        collectedCrystals: Array.from(room.collectedCrystals),
        monsters: serializeMonsters(room),
        companions: serializeCompanions(room),
        capturedRoster: record.capturedRoster,
        sharedResources: { ...room.sharedResources },
        resourceNodes: serializeResourceNodes(room),
        structures: serializeStructures(room),
        baseWorkers: serializeBaseWorkers(room),
        persistenceMode: persistenceStore.getStatus().mode,
    });

    broadcastToRoom(
        room,
        {
            type: 's2c_player_joined',
            roomCode: room.code,
            player: state,
            serverTimeMs: now,
        },
        playerId
    );
}

function handleCreateRoom(ws, msg) {
    if (msg.protocolVersion !== PROTOCOL_VERSION) {
        sendJson(ws, {
            type: 's2c_room_error',
            code: 'PROTOCOL_MISMATCH',
            message: `프로토콜 버전이 일치하지 않습니다 (서버 v${PROTOCOL_VERSION}).`,
        });
        return;
    }

    leaveCurrentRoom(ws, 'leave');

    const displayName = sanitizeDisplayName(msg.displayName);
    const sessionToken = sanitizeToken(msg.sessionToken) || randomUUID();
    const requestedPlayerId = sanitizePlayerId(msg.playerId);

    let code = '';
    let restoredSnapshot = null;
    if (typeof msg.preferredRoomCode === 'string' && msg.preferredRoomCode.trim().length > 0) {
        const sanitized = sanitizeRoomCode(msg.preferredRoomCode);
        if (!isValidRoomCode(sanitized)) {
            sendJson(ws, {
                type: 's2c_room_error',
                code: 'INVALID_ROOM_CODE',
                message: '올바른 방 코드를 입력하세요 (영문/숫자 3~12자).',
            });
            return;
        }
        if (rooms.has(sanitized)) {
            code = generateUniqueRoomCode(rooms, persistedRooms);
        } else {
            code = sanitized;
            restoredSnapshot = persistedRooms.get(sanitized) ?? null;
        }
    } else {
        code = generateUniqueRoomCode(rooms, persistedRooms);
    }

    const room = createRoomRecord(code, restoredSnapshot);
    addNewPlayerToRoom(
        room,
        ws,
        sessionToken,
        requestedPlayerId,
        displayName,
        Boolean(restoredSnapshot)
    );
}

function handleJoinRoom(ws, msg) {
    if (msg.protocolVersion !== PROTOCOL_VERSION) {
        sendJson(ws, {
            type: 's2c_room_error',
            code: 'PROTOCOL_MISMATCH',
            message: `프로토콜 버전이 일치하지 않습니다 (서버 v${PROTOCOL_VERSION}).`,
        });
        return;
    }

    const roomCode = sanitizeRoomCode(msg.roomCode);
    if (!isValidRoomCode(roomCode)) {
        sendJson(ws, {
            type: 's2c_room_error',
            code: 'INVALID_ROOM_CODE',
            message: '올바른 방 코드를 입력하세요 (영문/숫자 3~12자).',
        });
        return;
    }

    let room = rooms.get(roomCode);
    let recreatedRoom = false;
    if (!room) {
        const persisted = persistedRooms.get(roomCode);
        if (persisted) {
            room = createRoomRecord(roomCode, persisted);
            recreatedRoom = Boolean(msg.isReconnect);
        } else if (!msg.isReconnect) {
            sendJson(ws, {
                type: 's2c_room_error',
                code: 'ROOM_NOT_FOUND',
                message: '존재하지 않는 방 코드입니다.',
                roomCode,
            });
            return;
        } else {
            // Render restart resilience: auto-recreate room seamlessly for reconnecting players
            room = createRoomRecord(roomCode);
            recreatedRoom = true;
        }
    }

    const currentMeta = wsMeta.get(ws);
    if (currentMeta && currentMeta.roomCode !== roomCode) {
        leaveCurrentRoom(ws, 'leave');
    }

    const displayName = sanitizeDisplayName(msg.displayName);
    const sessionToken = sanitizeToken(msg.sessionToken) || randomUUID();
    const requestedPlayerId = sanitizePlayerId(msg.playerId);

    let existingId = room.sessionToPlayerId.get(sessionToken);
    if (!existingId && requestedPlayerId && room.players.has(requestedPlayerId)) {
        existingId = requestedPlayerId;
    }

    if (existingId && room.players.has(existingId)) {
        const existing = room.players.get(existingId);
        bindExistingPlayerSocket(room, existing, ws, sessionToken, displayName);
        return;
    }

    addNewPlayerToRoom(
        room,
        ws,
        sessionToken,
        requestedPlayerId,
        displayName,
        recreatedRoom
    );
}

function handlePlayerState(ws, msg) {
    const meta = wsMeta.get(ws);
    if (!meta) return;
    const room = rooms.get(meta.roomCode);
    if (!room) return;
    const player = room.players.get(meta.playerId);
    if (!player || player.ws !== ws) return;

    const seq = Number(msg.seq);
    if (!Number.isInteger(seq) || seq <= player.lastAckSeq) {
        return;
    }

    const pos = msg.position;
    const vel = msg.velocity;
    if (
        !pos ||
        !vel ||
        !Number.isFinite(pos.x) ||
        !Number.isFinite(pos.y) ||
        !Number.isFinite(pos.z) ||
        !Number.isFinite(vel.x) ||
        !Number.isFinite(vel.y) ||
        !Number.isFinite(vel.z)
    ) {
        return;
    }

    const now = Date.now();
    if (player.respawnedAtMs > 0 && now - player.respawnedAtMs < 650) {
        const home = SLOT_SPAWN_OFFSETS[player.slotIndex] || SLOT_SPAWN_OFFSETS[0];
        if (Math.hypot(pos.x - home.x, pos.z - home.z) > 8.0) {
            return;
        }
    }

    let px = pos.x;
    let py = pos.y;
    let pz = pos.z;

    // 1. Speed clamp against previous authoritative state (skip on seq === 1 initial sync)
    if (player.lastAckSeq > 0) {
        const serverDt = (now - player.lastStateAtMs) / 1000;
        const rawClientDt =
            player.lastClientTsMs > 0 && Number.isFinite(msg.timestampMs)
                ? (msg.timestampMs - player.lastClientTsMs) / 1000
                : serverDt;
        const dtSec = clamp(
            Math.max(serverDt, Number.isFinite(rawClientDt) ? rawClientDt : 0),
            0.05,
            2.0
        );
        const maxHorizDist = MAX_SPEED_MPS * dtSec + SPEED_SLACK_METERS;
        const dx = px - player.state.position.x;
        const dz = pz - player.state.position.z;
        const horizDist = Math.hypot(dx, dz);
        if (horizDist > maxHorizDist && horizDist > 1e-6) {
            const scale = maxHorizDist / horizDist;
            px = player.state.position.x + dx * scale;
            pz = player.state.position.z + dz * scale;
        }
    }

    // 2. Playable island boundary clamp (r <= 108.5)
    const radialDist = Math.hypot(px, pz);
    if (radialDist > PLAYABLE_MAX_RADIUS) {
        const scale = PLAYABLE_MAX_RADIUS / radialDist;
        px *= scale;
        pz *= scale;
    }

    // 3. Analytical terrain height validation (prevent underground fall or sky flight)
    const terrainY = getTerrainHeight(px, pz);
    if (py < terrainY - MAX_FLOOR_BELOW_TERRAIN) {
        py = terrainY;
    } else if (py > terrainY + MAX_CEILING_ABOVE_TERRAIN) {
        py = terrainY + MAX_CEILING_ABOVE_TERRAIN;
    }

    const yawDeg = Number.isFinite(msg.yawDeg) ? Number(msg.yawDeg.toFixed(1)) : player.state.yawDeg;
    const animState = VALID_ANIM_STATES.has(msg.animState) ? msg.animState : 'idle';
    const stamina = Number.isFinite(msg.stamina) ? clamp(Math.round(msg.stamina), 0, 100) : player.state.stamina;
    const crystalsCollected = Number.isFinite(msg.crystalsCollected)
        ? Math.max(0, Math.round(msg.crystalsCollected))
        : player.state.crystalsCollected;

    const activeCombatState =
        now < player.combatStateUntilMs
            ? player.state.combatState
            : VALID_COMBAT_STATES.has(msg.combatState)
              ? msg.combatState
              : VALID_COMBAT_STATES.has(animState)
                ? animState
                : 'idle';

    player.lastAckSeq = seq;
    player.lastStateAtMs = now;
    player.lastClientTsMs = Number.isFinite(msg.timestampMs) ? msg.timestampMs : now;

    player.state = {
        playerId: player.playerId,
        displayName: player.displayName,
        slotIndex: player.slotIndex,
        seq,
        timestampMs: now,
        position: { x: round3(px), y: round3(py), z: round3(pz) },
        velocity: {
            x: round3(clamp(vel.x, -16, 16)),
            y: round3(clamp(vel.y, -35, 35)),
            z: round3(clamp(vel.z, -16, 16)),
        },
        yawDeg,
        animState,
        grounded: Boolean(msg.grounded),
        inWater: Boolean(msg.inWater) || py < 0,
        stamina,
        crystalsCollected,
        connected: true,
        hp: player.state.hp,
        maxHp: player.state.maxHp,
        combatState: activeCombatState,
        activeCompanionId: player.state.activeCompanionId,
        captureSpheres: player.state.captureSpheres,
        lootCount: player.state.lootCount,
        hunger: Number(clamp(player.hungerFloat ?? player.state.hunger ?? PLAYER_MAX_HUNGER, 0, PLAYER_MAX_HUNGER).toFixed(1)),
        maxHunger: PLAYER_MAX_HUNGER,
        equippedTool: player.state.equippedTool || 'hands',
        unlockedTools: Array.isArray(player.state.unlockedTools)
            ? player.state.unlockedTools
            : ['hands'],
    };
}

function getValidatedActionOriginAndDir(player, msg) {
    const pPos = player.state.position;
    let ox = pPos.x;
    let oy = pPos.y;
    let oz = pPos.z;
    if (
        Number.isFinite(msg.originX) &&
        Number.isFinite(msg.originZ) &&
        Math.hypot(msg.originX - pPos.x, msg.originZ - pPos.z) <= 3.5
    ) {
        const clamped = clampToPlayableIsland(msg.originX, msg.originZ);
        ox = clamped.x;
        oz = clamped.z;
        oy = Number.isFinite(msg.originY) ? msg.originY : getTerrainHeight(ox, oz);
    }

    const aimYaw = Number.isFinite(msg.aimYaw) ? msg.aimYaw : player.state.yawDeg;
    let dx = Number.isFinite(msg.dirX) ? msg.dirX : 0;
    let dz = Number.isFinite(msg.dirZ) ? msg.dirZ : 0;
    const len = Math.hypot(dx, dz);
    if (len > 1e-4) {
        dx /= len;
        dz /= len;
    } else {
        const rad = (aimYaw * Math.PI) / 180;
        dx = -Math.sin(rad);
        dz = -Math.cos(rad);
    }
    return { ox, oy, oz, dx, dz, aimYaw };
}

function isMonsterTargetable(m) {
    return (
        m &&
        m.aiState !== 'dead' &&
        m.aiState !== 'captured' &&
        m.aiState !== 'capturing'
    );
}

function applyDamageToMonster(
    room,
    monster,
    attackerPlayer,
    damage,
    knockDirX,
    knockDirZ,
    eventType,
    now,
    actorIdOverride = null
) {
    if (!isMonsterTargetable(monster)) return false;

    const cfg = MONSTER_SPECIES_CONFIG[monster.species];
    monster.hp = Math.max(0, Math.round(monster.hp - damage));

    const kLen = Math.hypot(knockDirX, knockDirZ);
    const nx = kLen > 1e-4 ? knockDirX / kLen : 0;
    const nz = kLen > 1e-4 ? knockDirZ / kLen : 0;

    if (monster.hp > 0) {
        monster.vx = round3(nx * 4.5);
        monster.vz = round3(nz * 4.5);
        const pushed = clampToPlayableIsland(monster.x + nx * 0.45, monster.z + nz * 0.45);
        monster.x = round3(pushed.x);
        monster.z = round3(pushed.z);
        monster.y = round3(getTerrainHeight(monster.x, monster.z));
    }

    broadcastCombatEvent(room, {
        event: eventType,
        actorId: actorIdOverride || attackerPlayer.playerId,
        targetId: monster.id,
        x: monster.x,
        y: monster.y,
        z: monster.z,
        damage,
        remainingHp: monster.hp,
    });

    if (monster.hp <= 0) {
        monster.aiState = 'dead';
        monster.vx = 0;
        monster.vz = 0;
        monster.attackCharge = 0;
        monster.targetPlayerId = null;
        monster.targetCompanionId = null;
        monster.captureLockByPlayerId = null;
        monster.respawnRemainingMs = MONSTER_RESPAWN_MS;

        broadcastCombatEvent(room, {
            event: 'monster_dead',
            actorId: attackerPlayer.playerId,
            targetId: monster.id,
            x: monster.x,
            y: monster.y,
            z: monster.z,
            remainingHp: 0,
        });

        const lootTable = cfg?.lootTable || ['Aether Shard'];
        const lootItem = lootTable[room.tickSeq % lootTable.length];
        attackerPlayer.state.lootCount += 1;
        attackerPlayer.state.captureSpheres = Math.min(
            MAX_CAPTURE_SPHERES,
            attackerPlayer.state.captureSpheres + 1
        );

        broadcastCombatEvent(room, {
            event: 'loot_drop',
            actorId: attackerPlayer.playerId,
            targetId: monster.id,
            x: monster.x,
            y: monster.y,
            z: monster.z,
            lootItem,
        });
        markRoomDirty(room);
        return true;
    }

    if (attackerPlayer) {
        monster.targetPlayerId = attackerPlayer.playerId;
    }

    if (cfg && cfg.fleeHpRatio > 0 && monster.hp / monster.maxHp < cfg.fleeHpRatio) {
        monster.aiState = 'flee';
        monster.attackCharge = 0;
    } else if (monster.aiState !== 'attack' || monster.attackCharge < 0.35) {
        monster.aiState = 'hit';
        monster.stateTimerMs = 260;
        monster.attackCharge = 0;
    }
    return true;
}

function applyDamageToPlayer(room, player, monster, damage, now) {
    if (!player || !player.connected || player.state.hp <= 0) return;

    const pos = player.state.position;
    if (now < player.invulnerableUntilMs) {
        broadcastCombatEvent(room, {
            event: 'player_dodge',
            actorId: player.playerId,
            targetId: monster.id,
            x: pos.x,
            y: pos.y,
            z: pos.z,
        });
        return;
    }

    player.state.hp = Math.max(0, player.state.hp - damage);
    player.state.combatState = 'hit';
    player.combatStateUntilMs = now + 260;

    broadcastCombatEvent(room, {
        event: 'player_hit',
        actorId: monster.id,
        targetId: player.playerId,
        x: pos.x,
        y: pos.y,
        z: pos.z,
        damage,
        remainingHp: player.state.hp,
    });

    if (player.state.hp <= 0) {
        const respawnOffset = SLOT_SPAWN_OFFSETS[player.slotIndex] || SLOT_SPAWN_OFFSETS[0];
        const rx = respawnOffset.x;
        const rz = respawnOffset.z;
        const ry = round3(getTerrainHeight(rx, rz));

        player.state.hp = PLAYER_MAX_HP;
        player.hungerFloat = Math.max(player.hungerFloat ?? PLAYER_MAX_HUNGER, 60);
        player.state.hunger = Number(player.hungerFloat.toFixed(1));
        player.state.position = { x: rx, y: ry, z: rz };
        player.state.velocity = { x: 0, y: 0, z: 0 };
        player.state.grounded = true;
        player.state.inWater = ry < 0;
        player.state.combatState = 'idle';
        player.combatStateUntilMs = 0;
        player.invulnerableUntilMs = now + RESPAWN_IFRAME_MS;
        player.respawnedAtMs = now;
        player.lastStateAtMs = now;

        for (const m of room.monsters.values()) {
            if (m.targetPlayerId === player.playerId) {
                m.targetPlayerId = null;
            }
        }

        broadcastCombatEvent(room, {
            event: 'player_respawn',
            actorId: player.playerId,
            x: rx,
            y: ry,
            z: rz,
            remainingHp: PLAYER_MAX_HP,
        });
    }
}

function resolveMonsterCapture(room, monster, now) {
    const playerId = monster.captureLockByPlayerId;
    const player = playerId ? room.players.get(playerId) : null;
    const cfg = MONSTER_SPECIES_CONFIG[monster.species];
    const chance = monster.captureAttemptChance || computeCaptureChance(monster.species, monster.hp, monster.maxHp);
    const success = Math.random() <= chance;

    monster.captureLockByPlayerId = null;
    monster.captureAttemptPlayerId = null;
    monster.captureResolveAtMs = 0;

    if (success) {
        monster.aiState = 'captured';
        monster.vx = 0;
        monster.vz = 0;
        monster.attackCharge = 0;
        monster.targetPlayerId = null;
        monster.targetCompanionId = null;
        monster.respawnRemainingMs = MONSTER_RESPAWN_MS;

        const capturedRecord = {
            uid: `cap-${randomUUID().replace(/-/g, '').slice(0, 10)}`,
            species: monster.species,
            nickname: monster.name,
            level: monster.level,
            hp: monster.maxHp,
            maxHp: monster.maxHp,
            attackPower: cfg ? cfg.attackPower : 16,
        };

        if (player) {
            player.capturedRoster.push(capturedRecord);
        }
        markRoomDirty(room);

        broadcastCombatEvent(room, {
            event: 'capture_result',
            actorId: playerId || 'unknown',
            targetId: monster.id,
            x: monster.x,
            y: monster.y,
            z: monster.z,
            captureSuccess: true,
            captureChance: chance,
            capturedRecord,
        });
        return;
    }

    if (cfg && cfg.fleeHpRatio > 0 && monster.hp / monster.maxHp < cfg.fleeHpRatio) {
        monster.aiState = 'flee';
    } else {
        monster.aiState = 'chase';
        if (player && player.connected) {
            monster.targetPlayerId = player.playerId;
        }
    }

    broadcastCombatEvent(room, {
        event: 'capture_result',
        actorId: playerId || 'unknown',
        targetId: monster.id,
        x: monster.x,
        y: monster.y,
        z: monster.z,
        captureSuccess: false,
        captureChance: chance,
        reason: 'BROKE_FREE',
    });
}

function handleCombatAction(ws, msg) {
    const meta = wsMeta.get(ws);
    if (!meta) {
        sendJson(ws, {
            type: 's2c_room_error',
            code: 'NOT_IN_ROOM',
            message: '방에 참가한 상태에서만 전투 액션을 사용할 수 있습니다.',
        });
        return;
    }
    if (msg.protocolVersion !== undefined && msg.protocolVersion !== PROTOCOL_VERSION) {
        sendJson(ws, {
            type: 's2c_room_error',
            code: 'PROTOCOL_MISMATCH',
            message: `프로토콜 버전이 일치하지 않습니다 (서버 v${PROTOCOL_VERSION}).`,
        });
        return;
    }

    const room = rooms.get(meta.roomCode);
    if (!room) return;
    const player = room.players.get(meta.playerId);
    if (!player || player.ws !== ws) return;

    const seq = Number(msg.seq);
    if (Number.isInteger(seq)) {
        if (seq <= player.lastCombatSeq) return;
        player.lastCombatSeq = seq;
    }

    const now = Date.now();
    const { ox, oy, oz, dx, dz } = getValidatedActionOriginAndDir(player, msg);

    switch (msg.action) {
        case 'melee_attack': {
            if (now - player.lastMeleeAtMs < 110) return;
            player.lastMeleeAtMs = now;
            player.state.combatState = 'attack';
            player.combatStateUntilMs = now + 280;

            const hits = [];
            if (typeof msg.targetMonsterId === 'string' && msg.targetMonsterId) {
                const targeted = room.monsters.get(msg.targetMonsterId);
                if (isMonsterTargetable(targeted)) {
                    const cfg = MONSTER_SPECIES_CONFIG[targeted.species];
                    const dist = Math.hypot(targeted.x - ox, targeted.z - oz);
                    if (dist <= 4.5 + (cfg?.radius || 0.7) && Math.abs(targeted.y - oy) <= 4.0) {
                        hits.push(targeted);
                    }
                }
            }

            if (hits.length === 0) {
                for (const m of room.monsters.values()) {
                    if (!isMonsterTargetable(m)) continue;
                    const cfg = MONSTER_SPECIES_CONFIG[m.species];
                    const mx = m.x - ox;
                    const mz = m.z - oz;
                    const dist = Math.hypot(mx, mz);
                    if (dist > 4.2 + (cfg?.radius || 0.7) || Math.abs(m.y - oy) > 4.0) continue;
                    const dot = dist > 1e-4 ? (mx / dist) * dx + (mz / dist) * dz : 1;
                    if (dist <= 2.4 || dot >= 0.1) {
                        hits.push(m);
                    }
                }
            }

            const toolMeleeBonus =
                TOOL_COMBAT_BONUSES[player.state.equippedTool || 'hands']?.meleeBonus || 0;
            const meleeDamage = 24 + toolMeleeBonus;
            for (const target of hits.slice(0, 2)) {
                const kdx = target.x - ox;
                const kdz = target.z - oz;
                applyDamageToMonster(room, target, player, meleeDamage, kdx, kdz, 'melee_hit', now);
            }
            break;
        }

        case 'ranged_attack': {
            if (now - player.lastRangedAtMs < 140) return;
            player.lastRangedAtMs = now;
            player.state.combatState = 'attack';
            player.combatStateUntilMs = now + 260;

            broadcastCombatEvent(room, {
                event: 'ranged_cast',
                actorId: player.playerId,
                targetId: typeof msg.targetMonsterId === 'string' && msg.targetMonsterId ? msg.targetMonsterId : undefined,
                x: round3(ox),
                y: round3(oy + 1.1),
                z: round3(oz),
            });

            let bestTarget = null;
            let bestDist = Infinity;

            if (typeof msg.targetMonsterId === 'string' && msg.targetMonsterId) {
                const targeted = room.monsters.get(msg.targetMonsterId);
                if (isMonsterTargetable(targeted)) {
                    const cfg = MONSTER_SPECIES_CONFIG[targeted.species];
                    const tx = targeted.x - ox;
                    const tz = targeted.z - oz;
                    const dist = Math.hypot(tx, tz);
                    const dot = dist > 1e-4 ? (tx / dist) * dx + (tz / dist) * dz : 1;
                    if (dist <= 18.5 + (cfg?.radius || 0.7) && (dist <= 3.5 || dot >= 0.2)) {
                        bestTarget = targeted;
                    }
                }
            }

            if (!bestTarget) {
                for (const m of room.monsters.values()) {
                    if (!isMonsterTargetable(m)) continue;
                    const cfg = MONSTER_SPECIES_CONFIG[m.species];
                    const mx = m.x - ox;
                    const mz = m.z - oz;
                    const proj = mx * dx + mz * dz;
                    if (proj < -0.5 || proj > 18.5) continue;
                    const perp = Math.abs(mx * dz - mz * dx);
                    if (perp <= (cfg?.radius || 0.7) + 1.35 && proj < bestDist) {
                        bestDist = proj;
                        bestTarget = m;
                    }
                }
            }

            if (bestTarget) {
                const toolRangedBonus =
                    TOOL_COMBAT_BONUSES[player.state.equippedTool || 'hands']?.rangedBonus || 0;
                const rangedDamage = 18 + toolRangedBonus;
                applyDamageToMonster(
                    room,
                    bestTarget,
                    player,
                    rangedDamage,
                    bestTarget.x - ox,
                    bestTarget.z - oz,
                    'ranged_hit',
                    now
                );
            }
            break;
        }

        case 'dodge_roll': {
            if (now - player.lastDodgeAtMs < 350) return;
            player.lastDodgeAtMs = now;
            player.invulnerableUntilMs = Math.max(player.invulnerableUntilMs, now + DODGE_IFRAME_MS);
            player.state.combatState = 'dodge';
            player.combatStateUntilMs = now + DODGE_IFRAME_MS;

            broadcastCombatEvent(room, {
                event: 'player_dodge',
                actorId: player.playerId,
                x: player.state.position.x,
                y: player.state.position.y,
                z: player.state.position.z,
            });
            break;
        }

        case 'throw_capture': {
            if (player.state.captureSpheres <= 0) {
                sendCombatEventToPlayer(room, player, {
                    event: 'capture_result',
                    actorId: player.playerId,
                    targetId: typeof msg.targetMonsterId === 'string' && msg.targetMonsterId ? msg.targetMonsterId : undefined,
                    x: round3(ox),
                    y: round3(oy),
                    z: round3(oz),
                    captureSuccess: false,
                    reason: 'NO_SPHERES',
                });
                return;
            }

            let target = null;
            if (typeof msg.targetMonsterId === 'string' && msg.targetMonsterId) {
                target = room.monsters.get(msg.targetMonsterId) || null;
            } else {
                let bestScore = Infinity;
                for (const m of room.monsters.values()) {
                    if (m.aiState === 'dead' || m.aiState === 'captured') continue;
                    const dist = Math.hypot(m.x - ox, m.z - oz);
                    if (dist > 20) continue;
                    const dot = dist > 1e-4 ? ((m.x - ox) / dist) * dx + ((m.z - oz) / dist) * dz : 1;
                    if (dot >= 0.1 || dist <= 10) {
                        const score = dist - dot * 4;
                        if (score < bestScore) {
                            bestScore = score;
                            target = m;
                        }
                    }
                }
            }

            if (!target) {
                sendCombatEventToPlayer(room, player, {
                    event: 'capture_result',
                    actorId: player.playerId,
                    x: round3(ox),
                    y: round3(oy),
                    z: round3(oz),
                    captureSuccess: false,
                    reason: 'NO_TARGET',
                });
                return;
            }

            const dist = Math.hypot(target.x - ox, target.z - oz);
            if (dist > 20.5) {
                sendCombatEventToPlayer(room, player, {
                    event: 'capture_result',
                    actorId: player.playerId,
                    targetId: target.id,
                    x: target.x,
                    y: target.y,
                    z: target.z,
                    captureSuccess: false,
                    reason: 'OUT_OF_RANGE',
                });
                return;
            }

            if (target.aiState === 'dead' || target.aiState === 'captured') {
                sendCombatEventToPlayer(room, player, {
                    event: 'capture_result',
                    actorId: player.playerId,
                    targetId: target.id,
                    x: target.x,
                    y: target.y,
                    z: target.z,
                    captureSuccess: false,
                    reason: 'INVALID_TARGET',
                });
                return;
            }

            // CRITICAL ATOMIC CAPTURE LOCK CHECK:
            if (target.aiState === 'capturing' || target.captureLockByPlayerId !== null) {
                sendCombatEventToPlayer(room, player, {
                    event: 'capture_result',
                    actorId: player.playerId,
                    targetId: target.id,
                    x: target.x,
                    y: target.y,
                    z: target.z,
                    captureSuccess: false,
                    reason: 'CAPTURE_LOCKED',
                });
                return;
            }

            // Acquire lock atomically & deduct 1 sphere
            player.state.captureSpheres = Math.max(0, player.state.captureSpheres - 1);
            player.state.combatState = 'throw';
            player.combatStateUntilMs = now + 350;

            const chance = computeCaptureChance(target.species, target.hp, target.maxHp);
            target.captureLockByPlayerId = player.playerId;
            target.aiState = 'capturing';
            target.vx = 0;
            target.vz = 0;
            target.attackCharge = 0;
            target.captureAttemptPlayerId = player.playerId;
            target.captureAttemptChance = chance;
            target.captureResolveAtMs = now + CAPTURE_RESOLVE_MS;

            broadcastCombatEvent(room, {
                event: 'capture_throw',
                actorId: player.playerId,
                targetId: target.id,
                x: target.x,
                y: target.y,
                z: target.z,
                captureChance: chance,
            });
            break;
        }

        case 'summon_companion': {
            let record = null;
            if (typeof msg.companionUid === 'string' && msg.companionUid) {
                record = player.capturedRoster.find((r) => r.uid === msg.companionUid) || null;
            } else if (player.capturedRoster.length > 0) {
                record = player.capturedRoster[0];
            }

            if (!record) {
                sendCombatEventToPlayer(room, player, {
                    event: 'companion_recall',
                    actorId: player.playerId,
                    x: round3(ox),
                    y: round3(oy),
                    z: round3(oz),
                    reason: 'NO_CAPTURED_MONSTER',
                });
                return;
            }

            const existingComp = room.companions.get(player.playerId);
            if (existingComp && existingComp.uid !== record.uid) {
                room.companions.delete(player.playerId);
                broadcastCombatEvent(room, {
                    event: 'companion_recall',
                    actorId: player.playerId,
                    targetId: existingComp.uid,
                    x: existingComp.x,
                    y: existingComp.y,
                    z: existingComp.z,
                    reason: 'REPLACED',
                });
            }

            const rightX = -dz;
            const rightZ = dx;
            const spawnPt = clampToPlayableIsland(
                player.state.position.x + rightX * 2.2 - dx * 1.4,
                player.state.position.z + rightZ * 2.2 - dz * 1.4
            );
            const sy = round3(getTerrainHeight(spawnPt.x, spawnPt.z));

            const comp = {
                uid: record.uid,
                ownerPlayerId: player.playerId,
                species: record.species,
                nickname: record.nickname,
                level: record.level,
                x: round3(spawnPt.x),
                y: sy,
                z: round3(spawnPt.z),
                yaw: player.state.yawDeg,
                hp: record.maxHp,
                maxHp: record.maxHp,
                attackPower: record.attackPower,
                aiState: 'follow',
                targetMonsterId: null,
                attackCooldownUntilMs: 0,
                hitUntilMs: 0,
            };
            room.companions.set(player.playerId, comp);
            player.state.activeCompanionId = comp.uid;

            broadcastCombatEvent(room, {
                event: 'companion_summon',
                actorId: player.playerId,
                targetId: comp.uid,
                x: comp.x,
                y: comp.y,
                z: comp.z,
            });
            break;
        }

        case 'recall_companion': {
            const comp = room.companions.get(player.playerId);
            if (!comp) return;
            room.companions.delete(player.playerId);
            player.state.activeCompanionId = null;
            broadcastCombatEvent(room, {
                event: 'companion_recall',
                actorId: player.playerId,
                targetId: comp.uid,
                x: comp.x,
                y: comp.y,
                z: comp.z,
            });
            break;
        }

        default:
            break;
    }
}

function moveMonsterToward(m, targetX, targetZ, speed, dtSec) {
    const dx = targetX - m.x;
    const dz = targetZ - m.z;
    const dist = Math.hypot(dx, dz);
    if (dist < 1e-4) {
        m.vx = 0;
        m.vz = 0;
        return 0;
    }
    const nx = dx / dist;
    const nz = dz / dist;
    const step = Math.min(dist, speed * dtSec);
    const next = clampToPlayableIsland(m.x + nx * step, m.z + nz * step);
    m.x = round3(next.x);
    m.z = round3(next.z);
    m.y = round3(getTerrainHeight(m.x, m.z));
    m.vx = round3(nx * speed);
    m.vz = round3(nz * speed);
    m.yaw = directionToYawDeg(nx, nz);
    return dist - step;
}

function findNearestCombatTargetForMonster(room, m, maxDist) {
    let best = null;
    let bestDist = maxDist;

    for (const player of room.players.values()) {
        if (!player.connected || player.state.hp <= 0) continue;
        const dist = Math.hypot(player.state.position.x - m.x, player.state.position.z - m.z);
        const homeDist = Math.hypot(player.state.position.x - m.homeX, player.state.position.z - m.homeZ);
        if (dist < bestDist && homeDist <= MONSTER_SPECIES_CONFIG[m.species].leashRadius) {
            bestDist = dist;
            best = { kind: 'player', id: player.playerId, ref: player, x: player.state.position.x, y: player.state.position.y, z: player.state.position.z, dist };
        }
    }

    for (const comp of room.companions.values()) {
        if (comp.hp <= 0) continue;
        const dist = Math.hypot(comp.x - m.x, comp.z - m.z);
        if (dist < bestDist) {
            bestDist = dist;
            best = { kind: 'companion', id: comp.uid, ref: comp, x: comp.x, y: comp.y, z: comp.z, dist };
        }
    }

    return best;
}

function resolveCurrentMonsterTarget(room, m, leashRadius) {
    if (m.targetPlayerId) {
        const p = room.players.get(m.targetPlayerId);
        if (p && p.connected && p.state.hp > 0) {
            const homeDist = Math.hypot(p.state.position.x - m.homeX, p.state.position.z - m.homeZ);
            if (homeDist <= leashRadius) {
                return {
                    kind: 'player',
                    id: p.playerId,
                    ref: p,
                    x: p.state.position.x,
                    y: p.state.position.y,
                    z: p.state.position.z,
                    dist: Math.hypot(p.state.position.x - m.x, p.state.position.z - m.z),
                };
            }
        }
        m.targetPlayerId = null;
    }

    if (m.targetCompanionId) {
        for (const comp of room.companions.values()) {
            if (comp.uid === m.targetCompanionId && comp.hp > 0) {
                const homeDist = Math.hypot(comp.x - m.homeX, comp.z - m.homeZ);
                if (homeDist <= leashRadius) {
                    return {
                        kind: 'companion',
                        id: comp.uid,
                        ref: comp,
                        x: comp.x,
                        y: comp.y,
                        z: comp.z,
                        dist: Math.hypot(comp.x - m.x, comp.z - m.z),
                    };
                }
            }
        }
        m.targetCompanionId = null;
    }

    return null;
}

function updateRoomMonsters(room, dtMs, now) {
    for (const m of room.monsters.values()) {
        const cfg = MONSTER_SPECIES_CONFIG[m.species];

        if (m.aiState === 'capturing') {
            m.vx = 0;
            m.vz = 0;
            m.attackCharge = 0;
            if (now >= m.captureResolveAtMs) {
                resolveMonsterCapture(room, m, now);
            }
            continue;
        }

        if (m.aiState === 'dead' || m.aiState === 'captured') {
            m.vx = 0;
            m.vz = 0;
            m.attackCharge = 0;
            m.respawnRemainingMs = Math.max(0, m.respawnRemainingMs - dtMs);
            if (m.respawnRemainingMs <= 0) {
                m.x = m.homeX;
                m.y = m.homeY;
                m.z = m.homeZ;
                m.hp = m.maxHp;
                m.aiState = 'patrol';
                m.targetPlayerId = null;
                m.targetCompanionId = null;
                m.captureLockByPlayerId = null;
                m.stateTimerMs = 2000;
            }
            continue;
        }

        // Distance-based AI throttling when no connected player is within 45m
        let nearestPlayerDist = Infinity;
        for (const player of room.players.values()) {
            if (!player.connected) continue;
            const d = Math.hypot(player.state.position.x - m.x, player.state.position.z - m.z);
            if (d < nearestPlayerDist) nearestPlayerDist = d;
        }

        let stepDtMs = dtMs + m.throttledAccumMs;
        if (nearestPlayerDist > MONSTER_ACTIVE_DIST_M) {
            m.throttledAccumMs += dtMs;
            if (m.throttledAccumMs < 400) {
                continue;
            }
            stepDtMs = m.throttledAccumMs;
        }
        m.throttledAccumMs = 0;
        const dtSec = Math.min(0.5, stepDtMs / 1000);

        if (m.aiState === 'hit') {
            m.vx *= Math.exp(-8 * dtSec);
            m.vz *= Math.exp(-8 * dtSec);
            m.stateTimerMs -= stepDtMs;
            if (m.stateTimerMs <= 0) {
                if (cfg.fleeHpRatio > 0 && m.hp / m.maxHp < cfg.fleeHpRatio) {
                    m.aiState = 'flee';
                } else if (m.targetPlayerId || m.targetCompanionId) {
                    m.aiState = 'chase';
                } else {
                    m.aiState = 'alert';
                    m.stateTimerMs = 400;
                }
            }
            continue;
        }

        if (m.aiState === 'patrol' || m.aiState === 'rest' || m.aiState === 'observe') {
            m.attackCharge = 0;
            const spotted = findNearestCombatTargetForMonster(room, m, cfg.aggroRadius);
            if (spotted) {
                if (spotted.kind === 'player') m.targetPlayerId = spotted.id;
                else m.targetCompanionId = spotted.id;
                m.aiState = 'alert';
                m.stateTimerMs = 380;
                m.vx = 0;
                m.vz = 0;
                m.yaw = directionToYawDeg(spotted.x - m.x, spotted.z - m.z);
                continue;
            }

            m.stateTimerMs -= stepDtMs;
            if (m.aiState === 'patrol') {
                const rem = moveMonsterToward(m, m.patrolTargetX, m.patrolTargetZ, cfg.patrolSpeed, dtSec);
                if (rem < 0.35 || m.stateTimerMs <= 0) {
                    m.vx = 0;
                    m.vz = 0;
                    m.aiState = (room.tickSeq + m.level) % 2 === 0 ? 'rest' : 'observe';
                    m.stateTimerMs = 1800 + (m.level * 200);
                }
            } else {
                m.vx = 0;
                m.vz = 0;
                if (m.aiState === 'observe') {
                    m.yaw = Number(((m.yaw + 28 * dtSec + 360) % 360).toFixed(1));
                }
                if (m.stateTimerMs <= 0) {
                    m.patrolAngle = (m.patrolAngle + 1.85) % (Math.PI * 2);
                    const radius = 3.0 + (m.level % 3) * 1.4;
                    const pt = clampToPlayableIsland(
                        m.homeX + Math.cos(m.patrolAngle) * radius,
                        m.homeZ + Math.sin(m.patrolAngle) * radius
                    );
                    m.patrolTargetX = round3(pt.x);
                    m.patrolTargetZ = round3(pt.z);
                    m.aiState = 'patrol';
                    m.stateTimerMs = 3500;
                }
            }
            continue;
        }

        if (m.aiState === 'alert') {
            m.vx = 0;
            m.vz = 0;
            const target = resolveCurrentMonsterTarget(room, m, cfg.leashRadius) ||
                findNearestCombatTargetForMonster(room, m, cfg.aggroRadius);
            if (!target) {
                m.aiState = 'return';
                continue;
            }
            m.yaw = directionToYawDeg(target.x - m.x, target.z - m.z);
            m.stateTimerMs -= stepDtMs;
            if (m.stateTimerMs <= 0) {
                m.aiState = cfg.fleeHpRatio > 0 && m.hp / m.maxHp < cfg.fleeHpRatio ? 'flee' : 'chase';
            }
            continue;
        }

        if (m.aiState === 'return') {
            m.attackCharge = 0;
            m.targetPlayerId = null;
            m.targetCompanionId = null;
            m.hp = Math.min(m.maxHp, Math.round(m.hp + 6 * dtSec));
            const rem = moveMonsterToward(m, m.homeX, m.homeZ, cfg.chaseSpeed, dtSec);
            if (rem < 1.2) {
                m.vx = 0;
                m.vz = 0;
                m.hp = m.maxHp;
                m.aiState = 'patrol';
                m.stateTimerMs = 2000;
            }
            continue;
        }

        if (m.aiState === 'flee') {
            m.attackCharge = 0;
            const target = resolveCurrentMonsterTarget(room, m, cfg.leashRadius * 1.25) ||
                findNearestCombatTargetForMonster(room, m, cfg.aggroRadius * 1.25);
            if (!target || target.dist > cfg.aggroRadius * 1.35) {
                m.aiState = 'return';
                continue;
            }
            const awayX = m.x - target.x;
            const awayZ = m.z - target.z;
            const awayLen = Math.hypot(awayX, awayZ) || 1;
            const fleeDest = clampToPlayableIsland(
                m.x + (awayX / awayLen) * 5,
                m.z + (awayZ / awayLen) * 5
            );
            const homeDist = Math.hypot(fleeDest.x - m.homeX, fleeDest.z - m.homeZ);
            if (homeDist > cfg.leashRadius * 1.1) {
                m.aiState = 'return';
            } else {
                moveMonsterToward(m, fleeDest.x, fleeDest.z, cfg.fleeSpeed, dtSec);
            }
            continue;
        }

        const target = resolveCurrentMonsterTarget(room, m, cfg.leashRadius) ||
            findNearestCombatTargetForMonster(room, m, cfg.aggroRadius);
        if (!target) {
            m.aiState = 'return';
            m.attackCharge = 0;
            continue;
        }

        if (target.kind === 'player') {
            m.targetPlayerId = target.id;
            m.targetCompanionId = null;
        } else {
            m.targetCompanionId = target.id;
            m.targetPlayerId = null;
        }

        if (m.aiState === 'chase') {
            m.attackCharge = 0;
            m.yaw = directionToYawDeg(target.x - m.x, target.z - m.z);

            if (cfg.fleeHpRatio > 0 && m.hp / m.maxHp < cfg.fleeHpRatio) {
                m.aiState = 'flee';
                continue;
            }

            if (cfg.preferredMinRange > 0 && target.dist < cfg.preferredMinRange * 0.85) {
                // Aether Wisp kites back to keep comfortable bolt range (7-13m)
                const awayX = m.x - target.x;
                const awayZ = m.z - target.z;
                const al = Math.hypot(awayX, awayZ) || 1;
                moveMonsterToward(m, m.x + (awayX / al) * 4, m.z + (awayZ / al) * 4, cfg.chaseSpeed * 0.85, dtSec);
                m.yaw = directionToYawDeg(target.x - m.x, target.z - m.z);
            } else if (target.dist > cfg.attackRange * 0.9) {
                moveMonsterToward(m, target.x, target.z, cfg.chaseSpeed, dtSec);
            } else {
                m.vx = 0;
                m.vz = 0;
            }

            if (target.dist <= cfg.attackRange && now >= m.attackCooldownUntilMs) {
                m.aiState = 'attack';
                m.attackWindupElapsedMs = 0;
                m.attackCharge = 0.05;
                m.telegraphEmitted = false;
                m.vx = 0;
                m.vz = 0;
            }
            continue;
        }

        if (m.aiState === 'attack') {
            m.vx = 0;
            m.vz = 0;
            m.yaw = directionToYawDeg(target.x - m.x, target.z - m.z);

            if (!m.telegraphEmitted) {
                m.telegraphEmitted = true;
                broadcastCombatEvent(room, {
                    event: 'monster_attack_telegraph',
                    actorId: m.id,
                    targetId: target.id,
                    x: m.x,
                    y: m.y,
                    z: m.z,
                });
            }

            m.attackWindupElapsedMs += stepDtMs;
            m.attackCharge = clamp(m.attackWindupElapsedMs / cfg.attackWindupMs, 0, 1);

            if (m.attackWindupElapsedMs >= cfg.attackWindupMs) {
                m.attackCharge = 0;
                m.attackCooldownUntilMs = now + cfg.attackCooldownMs;

                if (m.species === 'moss_hopper' && target.dist > 1.2) {
                    const lx = target.x - m.x;
                    const lz = target.z - m.z;
                    const ld = Math.hypot(lx, lz) || 1;
                    const lunged = clampToPlayableIsland(
                        m.x + (lx / ld) * Math.min(1.2, target.dist * 0.5),
                        m.z + (lz / ld) * Math.min(1.2, target.dist * 0.5)
                    );
                    m.x = round3(lunged.x);
                    m.z = round3(lunged.z);
                    m.y = round3(getTerrainHeight(m.x, m.z));
                }

                broadcastCombatEvent(room, {
                    event: 'monster_attack_hit',
                    actorId: m.id,
                    targetId: target.id,
                    x: target.x,
                    y: target.y,
                    z: target.z,
                    damage: cfg.attackDamage,
                });

                if (cfg.aoeRadius > 0) {
                    // Shale Golem AoE strike hits all players and companions in AoE radius
                    for (const p of room.players.values()) {
                        if (!p.connected || p.state.hp <= 0) continue;
                        const pDist = Math.hypot(p.state.position.x - m.x, p.state.position.z - m.z);
                        if (pDist <= cfg.aoeRadius) {
                            applyDamageToPlayer(room, p, m, cfg.attackDamage, now);
                        }
                    }
                    for (const comp of room.companions.values()) {
                        const cDist = Math.hypot(comp.x - m.x, comp.z - m.z);
                        if (cDist <= cfg.aoeRadius) {
                            comp.hp = Math.max(0, comp.hp - cfg.attackDamage);
                            comp.aiState = 'hit';
                            comp.hitUntilMs = now + 260;
                        }
                    }
                } else if (target.kind === 'player') {
                    const hitDist = Math.hypot(target.ref.state.position.x - m.x, target.ref.state.position.z - m.z);
                    const hitLimit = cfg.attackRange + (m.species === 'aether_wisp' ? 2.2 : 1.4);
                    if (hitDist <= hitLimit) {
                        applyDamageToPlayer(room, target.ref, m, cfg.attackDamage, now);
                    }
                } else if (target.kind === 'companion') {
                    const cDist = Math.hypot(target.ref.x - m.x, target.ref.z - m.z);
                    if (cDist <= cfg.attackRange + 1.8) {
                        target.ref.hp = Math.max(0, target.ref.hp - cfg.attackDamage);
                        target.ref.aiState = 'hit';
                        target.ref.hitUntilMs = now + 260;
                    }
                }

                m.aiState = cfg.fleeHpRatio > 0 && m.hp / m.maxHp < cfg.fleeHpRatio ? 'flee' : 'chase';
            }
        }
    }
}

function updateRoomCompanions(room, dtMs, now) {
    const dtSec = Math.min(0.25, dtMs / 1000);
    for (const [ownerId, comp] of room.companions.entries()) {
        const owner = room.players.get(ownerId);
        if (!owner) {
            room.companions.delete(ownerId);
            continue;
        }
        if (comp.hp <= 0) {
            room.companions.delete(ownerId);
            owner.state.activeCompanionId = null;
            broadcastCombatEvent(room, {
                event: 'companion_recall',
                actorId: ownerId,
                targetId: comp.uid,
                x: comp.x,
                y: comp.y,
                z: comp.z,
                reason: 'FAINTED',
            });
            continue;
        }
        if (!owner.connected) {
            continue;
        }

        const ox = owner.state.position.x;
        const oz = owner.state.position.z;
        const yawRad = (owner.state.yawDeg * Math.PI) / 180;
        const fwdX = -Math.sin(yawRad);
        const fwdZ = -Math.cos(yawRad);
        const rightX = -fwdZ;
        const rightZ = fwdX;

        if (now < comp.hitUntilMs) {
            comp.aiState = 'hit';
        }

        // Find nearest aggroed or nearby wild monster (NEVER dead/captured/capturing)
        let target = null;
        let bestScore = Infinity;
        for (const m of room.monsters.values()) {
            if (!isMonsterTargetable(m)) continue;
            const distFromOwner = Math.hypot(m.x - ox, m.z - oz);
            const distFromComp = Math.hypot(m.x - comp.x, m.z - comp.z);
            const isAggroedOnOwner = m.targetPlayerId === ownerId || m.targetCompanionId === comp.uid;
            if ((isAggroedOnOwner && distFromOwner <= 22) || distFromOwner <= 14 || distFromComp <= 12) {
                const score = (isAggroedOnOwner ? 0 : 8) + distFromComp;
                if (score < bestScore) {
                    bestScore = score;
                    target = m;
                }
            }
        }

        if (target) {
            comp.targetMonsterId = target.id;
            const dx = target.x - comp.x;
            const dz = target.z - comp.z;
            const dist = Math.hypot(dx, dz);
            comp.yaw = directionToYawDeg(dx, dz);
            const attackRange = comp.species === 'aether_wisp' ? 8.5 : 2.5;

            if (dist > attackRange) {
                if (now >= comp.hitUntilMs) comp.aiState = 'assist_chase';
                const step = Math.min(dist, 5.8 * dtSec);
                const nx = dx / (dist || 1);
                const nz = dz / (dist || 1);
                const next = clampToPlayableIsland(comp.x + nx * step, comp.z + nz * step);
                comp.x = round3(next.x);
                comp.z = round3(next.z);
                comp.y = round3(getTerrainHeight(comp.x, comp.z));
            } else {
                if (now >= comp.hitUntilMs) comp.aiState = 'assist_attack';
                if (now >= comp.attackCooldownUntilMs) {
                    comp.attackCooldownUntilMs = now + 1100;
                    applyDamageToMonster(
                        room,
                        target,
                        owner,
                        comp.attackPower,
                        dx,
                        dz,
                        'companion_attack',
                        now,
                        comp.uid
                    );
                }
            }
        } else {
            comp.targetMonsterId = null;
            if (now >= comp.hitUntilMs) comp.aiState = 'follow';
            const followPt = clampToPlayableIsland(
                ox - fwdX * 2.4 + rightX * 2.2,
                oz - fwdZ * 2.4 + rightZ * 2.2
            );
            const dx = followPt.x - comp.x;
            const dz = followPt.z - comp.z;
            const dist = Math.hypot(dx, dz);
            if (dist > 0.75) {
                const speed = Math.min(9.5, 4.2 + dist * 0.55);
                const step = Math.min(dist, speed * dtSec);
                const next = clampToPlayableIsland(
                    comp.x + (dx / dist) * step,
                    comp.z + (dz / dist) * step
                );
                comp.x = round3(next.x);
                comp.z = round3(next.z);
                comp.y = round3(getTerrainHeight(comp.x, comp.z));
                comp.yaw = directionToYawDeg(dx, dz);
            } else {
                comp.yaw = owner.state.yawDeg;
            }
        }
    }
}

function hasSharedResources(shared, cost) {
    if (!cost || typeof cost !== 'object') return true;
    for (const [kind, rawReq] of Object.entries(cost)) {
        const req = Math.max(0, Number(rawReq || 0));
        if ((shared[kind] || 0) < req) return false;
    }
    return true;
}

function deductSharedResources(shared, cost) {
    if (!cost || typeof cost !== 'object') return;
    for (const [kind, rawReq] of Object.entries(cost)) {
        const req = Math.max(0, Number(rawReq || 0));
        shared[kind] = Math.max(0, Math.floor((shared[kind] || 0) - req));
    }
}

function rejectSurvivalAction(room, player, reason, message, extra = {}) {
    sendSurvivalEventToPlayer(room, player, {
        event: 'action_rejected',
        actorId: player.playerId,
        actorName: player.displayName,
        reason,
        message,
        ...extra,
    });
}

function findNearestStructure(room, recipeId, x, z, maxDist = Infinity) {
    let best = null;
    let bestDist = maxDist;
    for (const s of room.structures.values()) {
        if (recipeId && s.recipeId !== recipeId) continue;
        const d = Math.hypot(s.x - x, s.z - z);
        if (d <= bestDist) {
            bestDist = d;
            best = s;
        }
    }
    return best ? { structure: best, dist: bestDist } : null;
}

function findBaseAnchor(room, preferredRecipeOrder = ['storage_chest', 'workbench', 'straw_bed']) {
    for (const recipeId of preferredRecipeOrder) {
        const found = findNearestStructure(room, recipeId, 0, 12, Infinity);
        if (found) {
            return {
                x: found.structure.x,
                y: found.structure.y,
                z: found.structure.z,
                structureId: found.structure.id,
            };
        }
    }
    return {
        x: 0,
        y: round3(getTerrainHeight(0, 12)),
        z: 12,
        structureId: null,
    };
}

function computeHarvestDamage(equippedTool, nodeKind) {
    switch (equippedTool) {
        case 'wood_axe':
            return nodeKind === 'wood' ? 50 : 35;
        case 'stone_pickaxe':
            return nodeKind === 'stone' || nodeKind === 'ore' ? 50 : 35;
        case 'aether_blade':
            return 50;
        case 'hands':
        default:
            return 25;
    }
}

function moveWorkerToward(w, targetX, targetZ, speed, dtSec) {
    const dx = targetX - w.x;
    const dz = targetZ - w.z;
    const dist = Math.hypot(dx, dz);
    if (dist < 1e-4) return 0;
    const step = Math.min(dist, speed * dtSec);
    const nx = dx / dist;
    const nz = dz / dist;
    const next = clampToPlayableIsland(w.x + nx * step, w.z + nz * step);
    w.x = round3(next.x);
    w.z = round3(next.z);
    w.y = round3(getTerrainHeight(w.x, w.z));
    w.yaw = directionToYawDeg(nx, nz);
    return dist - step;
}

function selectBestNodeForWorker(room, w) {
    let preferredKinds = ['wood', 'berry'];
    if (w.species === 'shale_golem') {
        preferredKinds = ['stone', 'ore'];
    } else if (w.species === 'aether_wisp') {
        preferredKinds = ['berry', 'wood'];
    }

    let best = null;
    let bestScore = Infinity;
    for (const node of room.resourceNodes.values()) {
        if (node.depleted || node.hp <= 0) continue;
        const dist = Math.hypot(node.x - w.x, node.z - w.z);
        const prefIndex = preferredKinds.indexOf(node.kind);
        const penalty = prefIndex === 0 ? 0 : prefIndex === 1 ? 8 : 40;
        const score = dist + penalty;
        if (score < bestScore) {
            bestScore = score;
            best = node;
        }
    }
    return best;
}

function handleSurvivalAction(ws, msg) {
    const meta = wsMeta.get(ws);
    if (!meta) {
        sendJson(ws, {
            type: 's2c_room_error',
            code: 'NOT_IN_ROOM',
            message: '방에 참가한 상태에서만 생존 액션을 전송할 수 있습니다.',
        });
        return;
    }
    const room = rooms.get(meta.roomCode);
    if (!room) return;
    const player = room.players.get(meta.playerId);
    if (!player || player.ws !== ws) return;

    if (
        msg.protocolVersion !== undefined &&
        Number(msg.protocolVersion) !== PROTOCOL_VERSION
    ) {
        sendJson(ws, {
            type: 's2c_room_error',
            code: 'PROTOCOL_MISMATCH',
            message: `프로토콜 버전 불일치 (서버 v${PROTOCOL_VERSION})`,
        });
        return;
    }

    const seq = Number(msg.seq);
    if (Number.isInteger(seq)) {
        if (seq <= player.lastSurvivalSeq) return;
        player.lastSurvivalSeq = seq;
    }

    const now = Date.now();
    const action = typeof msg.action === 'string' ? msg.action : '';

    switch (action) {
        case 'harvest_node': {
            const nodeId = typeof msg.nodeId === 'string' ? msg.nodeId.trim() : '';
            const node = nodeId ? room.resourceNodes.get(nodeId) : null;
            if (!node) {
                rejectSurvivalAction(room, player, 'UNKNOWN_NODE', '존재하지 않는 자원 노드입니다.', {
                    targetId: nodeId || undefined,
                });
                return;
            }
            if (node.depleted || node.hp <= 0) {
                rejectSurvivalAction(room, player, 'NODE_DEPLETED', '이미 고갈된 자원입니다.', {
                    targetId: node.id,
                    x: node.x,
                    y: node.y,
                    z: node.z,
                });
                return;
            }

            const refX =
                Number.isFinite(Number(msg.x)) &&
                Math.hypot(Number(msg.x) - player.state.position.x, Number(msg.z) - player.state.position.z) <= 3.0
                    ? Number(msg.x)
                    : player.state.position.x;
            const refZ =
                Number.isFinite(Number(msg.z)) &&
                Math.hypot(Number(msg.x) - player.state.position.x, Number(msg.z) - player.state.position.z) <= 3.0
                    ? Number(msg.z)
                    : player.state.position.z;

            if (Math.hypot(node.x - refX, node.z - refZ) > 5.8) {
                rejectSurvivalAction(room, player, 'OUT_OF_RANGE', '자원과 너무 멀리 떨어져 있습니다.', {
                    targetId: node.id,
                    x: node.x,
                    y: node.y,
                    z: node.z,
                });
                return;
            }

            player.lastGatherAtMs = now;
            const equipped = player.state.equippedTool || 'hands';
            const dmg = computeHarvestDamage(equipped, node.kind);
            node.hp = Math.max(0, node.hp - dmg);

            if (node.hp > 0) {
                markRoomDirty(room);
                broadcastSurvivalEvent(room, {
                    event: 'node_hit',
                    actorId: player.playerId,
                    actorName: player.displayName,
                    targetId: node.id,
                    x: node.x,
                    y: node.y,
                    z: node.z,
                    resourceKind: node.yieldKind,
                    amount: dmg,
                });
            } else {
                node.depleted = true;
                node.respawnRemainingMs = RESOURCE_RESPAWN_MS;
                let yieldAmount = node.yieldAmount;
                if (
                    node.kind === 'wood' &&
                    (equipped === 'wood_axe' || equipped === 'aether_blade')
                ) {
                    yieldAmount += 1;
                } else if (
                    node.kind === 'stone' &&
                    (equipped === 'stone_pickaxe' || equipped === 'aether_blade')
                ) {
                    yieldAmount += 1;
                }
                room.sharedResources[node.yieldKind] =
                    (room.sharedResources[node.yieldKind] || 0) + yieldAmount;

                if (node.kind === 'ore') {
                    const shardBonus =
                        equipped === 'stone_pickaxe' || equipped === 'aether_blade' ? 2 : 1;
                    room.sharedResources.aether_shard =
                        (room.sharedResources.aether_shard || 0) + shardBonus;
                }

                markRoomDirty(room);
                broadcastSurvivalEvent(room, {
                    event: 'node_depleted',
                    actorId: player.playerId,
                    actorName: player.displayName,
                    targetId: node.id,
                    x: node.x,
                    y: node.y,
                    z: node.z,
                    resourceKind: node.yieldKind,
                    amount: yieldAmount,
                });
            }
            break;
        }

        case 'craft_item': {
            const recipeId = typeof msg.craftRecipeId === 'string' ? msg.craftRecipeId.trim() : '';
            const recipe = CRAFT_RECIPES[recipeId];
            if (!recipe) {
                rejectSurvivalAction(room, player, 'UNKNOWN_RECIPE', '알 수 없는 제작 레시피입니다.', {
                    recipeId: recipeId || undefined,
                });
                return;
            }
            if (recipe.requiresWorkbench && !hasRoomStructureRecipe(room, 'workbench')) {
                rejectSurvivalAction(
                    room,
                    player,
                    'WORKBENCH_REQUIRED',
                    '제작대(Workbench)가 설치되어 있어야 제작할 수 있습니다.',
                    { recipeId }
                );
                return;
            }
            if (!hasSharedResources(room.sharedResources, recipe.cost)) {
                rejectSurvivalAction(
                    room,
                    player,
                    'INSUFFICIENT_RESOURCES',
                    '제작에 필요한 자원이 부족합니다.',
                    { recipeId }
                );
                return;
            }

            deductSharedResources(room.sharedResources, recipe.cost);

            if (recipe.unlocksTool) {
                if (!player.state.unlockedTools.includes(recipe.unlocksTool)) {
                    player.state.unlockedTools.push(recipe.unlocksTool);
                }
                player.state.equippedTool = recipe.unlocksTool;
            } else if (recipeId === 'capture_sphere_pack') {
                player.state.captureSpheres = Math.min(
                    MAX_CAPTURE_SPHERES,
                    player.state.captureSpheres + recipe.yieldAmount
                );
            } else if (recipe.resourceYieldKind) {
                room.sharedResources[recipe.resourceYieldKind] =
                    (room.sharedResources[recipe.resourceYieldKind] || 0) + recipe.yieldAmount;
            }

            markRoomDirty(room);
            broadcastSurvivalEvent(room, {
                event: 'item_crafted',
                actorId: player.playerId,
                actorName: player.displayName,
                recipeId,
                toolId: recipe.unlocksTool || undefined,
                resourceKind: recipe.resourceYieldKind || undefined,
                amount: recipe.yieldAmount,
                x: player.state.position.x,
                y: player.state.position.y,
                z: player.state.position.z,
            });
            break;
        }

        case 'equip_tool': {
            const toolId = typeof msg.toolId === 'string' ? msg.toolId.trim() : '';
            if (!TOOL_COMBAT_BONUSES[toolId]) {
                rejectSurvivalAction(room, player, 'BAD_REQUEST', '잘못된 도구 ID입니다.', {
                    toolId: toolId || undefined,
                });
                return;
            }
            if (!player.state.unlockedTools.includes(toolId)) {
                rejectSurvivalAction(
                    room,
                    player,
                    'TOOL_NOT_UNLOCKED',
                    '아직 제작하지 않은 도구입니다.',
                    { toolId }
                );
                return;
            }
            player.state.equippedTool = toolId;
            markRoomDirty(room);
            broadcastSurvivalEvent(room, {
                event: 'tool_equipped',
                actorId: player.playerId,
                actorName: player.displayName,
                toolId,
            });
            break;
        }

        case 'eat_food': {
            let chosenKind = null;
            if (msg.foodKind === 'cooked_berry' || msg.foodKind === 'berry') {
                if ((room.sharedResources[msg.foodKind] || 0) >= 1) {
                    chosenKind = msg.foodKind;
                }
            } else if ((room.sharedResources.cooked_berry || 0) >= 1) {
                chosenKind = 'cooked_berry';
            } else if ((room.sharedResources.berry || 0) >= 1) {
                chosenKind = 'berry';
            }

            if (!chosenKind) {
                rejectSurvivalAction(room, player, 'NO_FOOD', '먹을 수 있는 식량이 없습니다.');
                return;
            }

            room.sharedResources[chosenKind] = Math.max(0, (room.sharedResources[chosenKind] || 0) - 1);
            const hungerGain = chosenKind === 'cooked_berry' ? 35 : 14;
            const hpGain = chosenKind === 'cooked_berry' ? 20 : 6;
            player.hungerFloat = clamp(
                (player.hungerFloat ?? player.state.hunger ?? PLAYER_MAX_HUNGER) + hungerGain,
                0,
                PLAYER_MAX_HUNGER
            );
            player.state.hunger = Math.round(player.hungerFloat);
            player.state.hp = Math.min(player.state.maxHp, player.state.hp + hpGain);

            markRoomDirty(room);
            broadcastSurvivalEvent(room, {
                event: 'food_eaten',
                actorId: player.playerId,
                actorName: player.displayName,
                resourceKind: chosenKind,
                amount: 1,
                x: player.state.position.x,
                y: player.state.position.y,
                z: player.state.position.z,
            });
            break;
        }

        case 'place_structure': {
            const recipeId =
                typeof msg.structureRecipeId === 'string' ? msg.structureRecipeId.trim() : '';
            const recipe = MODULAR_STRUCTURE_RECIPES[recipeId];
            if (!recipe) {
                rejectSurvivalAction(room, player, 'UNKNOWN_RECIPE', '알 수 없는 건축 레시피입니다.', {
                    recipeId: recipeId || undefined,
                });
                return;
            }

            let gridX;
            let gridZ;
            if (Number.isFinite(Number(msg.gridX)) && Number.isFinite(Number(msg.gridZ))) {
                gridX = Math.round(Number(msg.gridX));
                gridZ = Math.round(Number(msg.gridZ));
            } else if (Number.isFinite(Number(msg.x)) && Number.isFinite(Number(msg.z))) {
                gridX = Math.round(Number(msg.x) / BUILD_GRID_SIZE_METERS);
                gridZ = Math.round(Number(msg.z) / BUILD_GRID_SIZE_METERS);
            } else {
                gridX = Math.round(player.state.position.x / BUILD_GRID_SIZE_METERS);
                gridZ = Math.round(player.state.position.z / BUILD_GRID_SIZE_METERS);
            }

            const sx = round3(gridX * BUILD_GRID_SIZE_METERS);
            const sz = round3(gridZ * BUILD_GRID_SIZE_METERS);
            if (Math.hypot(sx, sz) > PLAYABLE_MAX_RADIUS - 2) {
                rejectSurvivalAction(
                    room,
                    player,
                    'OUT_OF_RANGE',
                    '섬 외곽 경계 밖에는 건축할 수 없습니다.',
                    { recipeId, x: sx, z: sz }
                );
                return;
            }

            const layer = recipe.layer;
            const cellKey = `${gridX}:${gridZ}:${layer}`;
            if (room.structures.has(cellKey)) {
                rejectSurvivalAction(
                    room,
                    player,
                    'CELL_OCCUPIED',
                    '해당 건축 칸에는 이미 구조물이 설치되어 있습니다.',
                    { recipeId, x: sx, z: sz }
                );
                return;
            }

            const groundY = getTerrainHeight(sx, sz);
            if (groundY < -0.15) {
                rejectSurvivalAction(
                    room,
                    player,
                    'INVALID_STRUCTURE',
                    '물 위에는 건축할 수 없습니다.',
                    { recipeId, x: sx, y: round3(groundY), z: sz }
                );
                return;
            }

            const foundation = room.structures.get(`${gridX}:${gridZ}:0`);
            const slopeDeg = getTerrainSlopeDeg(sx, sz);
            if (!foundation && slopeDeg > recipe.maxSlopeDeg) {
                rejectSurvivalAction(
                    room,
                    player,
                    'INVALID_STRUCTURE',
                    '경사가 너무 급해 건축할 수 없습니다.',
                    { recipeId, x: sx, y: round3(groundY), z: sz }
                );
                return;
            }

            if (!hasSharedResources(room.sharedResources, recipe.cost)) {
                rejectSurvivalAction(
                    room,
                    player,
                    'INSUFFICIENT_RESOURCES',
                    '건축에 필요한 자원이 부족합니다.',
                    { recipeId, x: sx, z: sz }
                );
                return;
            }

            deductSharedResources(room.sharedResources, recipe.cost);

            const baseSurfaceY = foundation ? foundation.y : groundY;
            const sy = round3(baseSurfaceY + recipe.elevationOffsetY);
            const rawYaw = Number(msg.rotationYawDeg);
            const rotationYawDeg = Number.isFinite(rawYaw)
                ? (((Math.round(rawYaw / 90) * 90) % 360) + 360) % 360
                : 0;

            const structure = {
                id: `struct-${gridX}_${gridZ}_${layer}-${randomUUID().slice(0, 6)}`,
                recipeId,
                gridX,
                gridZ,
                layer,
                x: sx,
                y: sy,
                z: sz,
                rotationYawDeg,
                ownerPlayerId: player.playerId,
                ownerName: player.displayName,
                createdAtMs: now,
            };
            room.structures.set(cellKey, structure);

            markRoomDirty(room);
            broadcastSurvivalEvent(room, {
                event: 'structure_placed',
                actorId: player.playerId,
                actorName: player.displayName,
                targetId: structure.id,
                recipeId,
                x: structure.x,
                y: structure.y,
                z: structure.z,
                structure,
            });
            break;
        }

        case 'demolish_structure': {
            let foundKey = null;
            let foundStruct = null;

            if (typeof msg.structureId === 'string' && msg.structureId.trim()) {
                const targetId = msg.structureId.trim();
                for (const [k, s] of room.structures.entries()) {
                    if (s.id === targetId) {
                        foundKey = k;
                        foundStruct = s;
                        break;
                    }
                }
            } else if (
                Number.isFinite(Number(msg.gridX)) &&
                Number.isFinite(Number(msg.gridZ))
            ) {
                const gx = Math.round(Number(msg.gridX));
                const gz = Math.round(Number(msg.gridZ));
                if (Number.isInteger(msg.layer)) {
                    const key = `${gx}:${gz}:${msg.layer}`;
                    if (room.structures.has(key)) {
                        foundKey = key;
                        foundStruct = room.structures.get(key);
                    }
                } else {
                    for (const l of [2, 1, 0]) {
                        const key = `${gx}:${gz}:${l}`;
                        if (room.structures.has(key)) {
                            foundKey = key;
                            foundStruct = room.structures.get(key);
                            break;
                        }
                    }
                }
            }

            if (!foundStruct || !foundKey) {
                rejectSurvivalAction(room, player, 'NOT_FOUND', '철거할 구조물을 찾지 못했습니다.');
                return;
            }

            room.structures.delete(foundKey);
            const recipe = MODULAR_STRUCTURE_RECIPES[foundStruct.recipeId];
            if (recipe?.cost) {
                for (const [kind, amt] of Object.entries(recipe.cost)) {
                    const refund = Math.floor(Number(amt || 0) * 0.5);
                    if (refund > 0) {
                        room.sharedResources[kind] = (room.sharedResources[kind] || 0) + refund;
                    }
                }
            }

            markRoomDirty(room);
            broadcastSurvivalEvent(room, {
                event: 'structure_demolished',
                actorId: player.playerId,
                actorName: player.displayName,
                targetId: foundStruct.id,
                recipeId: foundStruct.recipeId,
                x: foundStruct.x,
                y: foundStruct.y,
                z: foundStruct.z,
            });
            break;
        }

        case 'rest_bed': {
            let bed = null;
            if (typeof msg.structureId === 'string' && msg.structureId.trim()) {
                for (const s of room.structures.values()) {
                    if (s.id === msg.structureId.trim() && s.recipeId === 'straw_bed') {
                        bed = s;
                        break;
                    }
                }
            } else {
                const found = findNearestStructure(
                    room,
                    'straw_bed',
                    player.state.position.x,
                    player.state.position.z,
                    Infinity
                );
                bed = found ? found.structure : null;
            }

            if (!bed) {
                rejectSurvivalAction(room, player, 'NOT_FOUND', '설치된 밀짚 침대가 없습니다.');
                return;
            }

            const dist = Math.hypot(
                bed.x - player.state.position.x,
                bed.z - player.state.position.z
            );
            if (dist > 6.5) {
                rejectSurvivalAction(room, player, 'OUT_OF_RANGE', '침대와 너무 멀리 떨어져 있습니다.', {
                    targetId: bed.id,
                    x: bed.x,
                    y: bed.y,
                    z: bed.z,
                });
                return;
            }

            player.state.hp = player.state.maxHp;
            player.state.stamina = 100;
            markRoomDirty(room);
            broadcastSurvivalEvent(room, {
                event: 'bed_rested',
                actorId: player.playerId,
                actorName: player.displayName,
                targetId: bed.id,
                recipeId: 'straw_bed',
                x: bed.x,
                y: bed.y,
                z: bed.z,
            });
            break;
        }

        case 'assign_base_worker': {
            if (room.baseWorkers.size >= MAX_BASE_WORKERS) {
                rejectSurvivalAction(
                    room,
                    player,
                    'MAX_BASE_WORKERS',
                    `거점 일꾼은 최대 ${MAX_BASE_WORKERS}마리까지만 배치할 수 있습니다.`
                );
                return;
            }

            let record = null;
            if (typeof msg.companionUid === 'string' && msg.companionUid.trim()) {
                const targetUid = msg.companionUid.trim();
                if (room.baseWorkers.has(targetUid)) {
                    rejectSurvivalAction(
                        room,
                        player,
                        'ALREADY_ASSIGNED',
                        '이미 거점에 배치된 몬스터입니다.',
                        { targetId: targetUid }
                    );
                    return;
                }
                record = player.capturedRoster.find((r) => r.uid === targetUid) || null;
            } else {
                record = player.capturedRoster.find((r) => !room.baseWorkers.has(r.uid)) || null;
            }

            if (!record) {
                rejectSurvivalAction(
                    room,
                    player,
                    'NOT_FOUND',
                    '거점에 배치할 수 있는 포획 몬스터가 없습니다.'
                );
                return;
            }

            if (room.baseWorkers.has(record.uid)) {
                rejectSurvivalAction(
                    room,
                    player,
                    'ALREADY_ASSIGNED',
                    '이미 거점에 배치된 몬스터입니다.',
                    { targetId: record.uid }
                );
                return;
            }

            // If this captured monster is currently deployed as a combat companion, recall it
            const activeComp = room.companions.get(player.playerId);
            if (activeComp && activeComp.uid === record.uid) {
                room.companions.delete(player.playerId);
                player.state.activeCompanionId = null;
                broadcastCombatEvent(room, {
                    event: 'companion_recall',
                    actorId: player.playerId,
                    targetId: activeComp.uid,
                    x: activeComp.x,
                    y: activeComp.y,
                    z: activeComp.z,
                    reason: 'ASSIGNED_TO_BASE',
                });
            }

            const anchor = findBaseAnchor(room, ['workbench', 'storage_chest', 'straw_bed']);
            const slotOffset = (room.baseWorkers.size - 1) * 1.4;
            const spawnPt = clampToPlayableIsland(anchor.x + slotOffset, anchor.z + 1.4);

            const suitMap = SPECIES_WORK_SUITABILITY[record.species] || { transporting: 1 };
            let defaultWork = 'transporting';
            if (record.species === 'moss_hopper') defaultWork = 'lumbering';
            else if (record.species === 'aether_wisp') defaultWork = 'handiwork';
            else if (record.species === 'shale_golem') defaultWork = 'mining';
            const activeWork =
                typeof msg.workPreference === 'string' && suitMap[msg.workPreference]
                    ? msg.workPreference
                    : defaultWork;

            const worker = {
                uid: record.uid,
                ownerPlayerId: player.playerId,
                species: record.species,
                nickname:
                    record.nickname ||
                    MONSTER_SPECIES_CONFIG[record.species]?.name ||
                    record.species,
                level: record.level || 1,
                x: round3(spawnPt.x),
                y: round3(getTerrainHeight(spawnPt.x, spawnPt.z)),
                z: round3(spawnPt.z),
                yaw: 0,
                aiState: 'idle',
                activeWork,
                carryingKind: null,
                carryingAmount: 0,
                energy: 100,
                maxEnergy: 100,
                targetNodeId: null,
                targetStructureId: anchor.structureId,
                workProgressMs: 0,
            };
            room.baseWorkers.set(worker.uid, worker);

            markRoomDirty(room);
            broadcastSurvivalEvent(room, {
                event: 'worker_assigned',
                actorId: player.playerId,
                actorName: player.displayName,
                targetId: worker.uid,
                x: worker.x,
                y: worker.y,
                z: worker.z,
                worker: serializeBaseWorker(worker),
            });
            break;
        }

        case 'unassign_base_worker': {
            let target = null;
            if (typeof msg.companionUid === 'string' && msg.companionUid.trim()) {
                target = room.baseWorkers.get(msg.companionUid.trim()) || null;
            } else {
                for (const w of room.baseWorkers.values()) {
                    if (w.ownerPlayerId === player.playerId) {
                        target = w;
                        break;
                    }
                }
                if (!target) {
                    target = room.baseWorkers.values().next().value || null;
                }
            }

            if (!target) {
                rejectSurvivalAction(room, player, 'NOT_FOUND', '해제할 거점 일꾼을 찾지 못했습니다.');
                return;
            }

            const removed = serializeBaseWorker(target);
            room.baseWorkers.delete(target.uid);
            markRoomDirty(room);
            broadcastSurvivalEvent(room, {
                event: 'worker_unassigned',
                actorId: player.playerId,
                actorName: player.displayName,
                targetId: removed.uid,
                x: removed.x,
                y: removed.y,
                z: removed.z,
                worker: removed,
            });
            break;
        }

        default:
            rejectSurvivalAction(room, player, 'BAD_REQUEST', `지원되지 않는 액션입니다: ${action}`);
            break;
    }
}

function updateRoomResourceNodes(room, dtMs) {
    for (const node of room.resourceNodes.values()) {
        if (!node.depleted) continue;
        node.respawnRemainingMs = Math.max(0, node.respawnRemainingMs - dtMs);
        if (node.respawnRemainingMs === 0) {
            node.depleted = false;
            node.hp = node.maxHp;
            markRoomDirty(room);
            broadcastSurvivalEvent(room, {
                event: 'node_respawned',
                actorId: 'world',
                targetId: node.id,
                x: node.x,
                y: node.y,
                z: node.z,
                resourceKind: node.yieldKind,
            });
        }
    }
}

function updateRoomPlayerHunger(room, dtMs, now) {
    const dtSec = dtMs / 1000;
    for (const player of room.players.values()) {
        if (!player.connected || player.state.hp <= 0) continue;
        player.hungerFloat = clamp(
            (player.hungerFloat ?? player.state.hunger ?? PLAYER_MAX_HUNGER) -
                HUNGER_DECAY_PER_SEC * dtSec,
            0,
            PLAYER_MAX_HUNGER
        );
        player.state.hunger = Math.round(player.hungerFloat);
        if (player.hungerFloat <= 0 && HUNGER_DECAY_PER_SEC > 0 && player.state.hp > 5) {
            player.state.hp = Math.max(5, Math.round(player.state.hp - 0.5 * dtSec));
        }
    }

    if (room.players.size > 0 && now - room.lastPeriodicPersistAtMs >= 8000) {
        room.lastPeriodicPersistAtMs = now;
        markRoomDirty(room);
    }
}

function updateRoomBaseWorkers(room, dtMs) {
    if (room.baseWorkers.size === 0) return;

    const scaledDtMs = dtMs * WORKER_TICK_SCALE;
    const scaledDtSec = scaledDtMs / 1000;
    const workerSpeed = 3.8;
    const anchor = findBaseAnchor(room, ['storage_chest', 'workbench', 'straw_bed']);
    const bedAnchor = findBaseAnchor(room, ['straw_bed', 'storage_chest', 'workbench']);

    for (const w of room.baseWorkers.values()) {
        if (w.aiState === 'rest') {
            const dist = Math.hypot(bedAnchor.x - w.x, bedAnchor.z - w.z);
            if (dist > 1.6) {
                moveWorkerToward(w, bedAnchor.x, bedAnchor.z, workerSpeed, scaledDtSec);
            } else {
                w.energy = clamp(w.energy + 20 * scaledDtSec, 0, w.maxEnergy);
                if (w.energy >= 95) {
                    w.energy = w.maxEnergy;
                    w.aiState = 'idle';
                    w.workProgressMs = 0;
                }
            }
            continue;
        }

        if (w.aiState !== 'transport' && w.energy <= 15) {
            w.aiState = 'rest';
            w.targetNodeId = null;
            w.targetStructureId = bedAnchor.structureId;
            w.workProgressMs = 0;
            continue;
        }

        if (w.aiState === 'idle') {
            const wb = findNearestStructure(room, 'workbench', w.x, w.z, Infinity);
            if (
                w.species === 'aether_wisp' &&
                wb &&
                (room.sharedResources.berry || 0) >= 2 &&
                (room.sharedResources.wood || 0) >= 1
            ) {
                w.aiState = 'work_craft';
                w.activeWork = 'handiwork';
                w.targetStructureId = wb.structure.id;
                w.targetNodeId = null;
                w.workProgressMs = 0;
                continue;
            }

            const node = selectBestNodeForWorker(room, w);
            if (node) {
                w.aiState = 'work_gather';
                w.activeWork =
                    node.kind === 'stone' || node.kind === 'ore'
                        ? 'mining'
                        : node.kind === 'wood'
                          ? 'lumbering'
                          : 'gathering';
                w.targetNodeId = node.id;
                w.workProgressMs = 0;
            }
            continue;
        }

        if (w.aiState === 'work_gather') {
            const node = w.targetNodeId ? room.resourceNodes.get(w.targetNodeId) : null;
            if (!node || node.depleted || node.hp <= 0) {
                w.aiState = 'idle';
                w.targetNodeId = null;
                w.workProgressMs = 0;
                continue;
            }
            const dist = Math.hypot(node.x - w.x, node.z - w.z);
            if (dist > 1.8) {
                moveWorkerToward(w, node.x, node.z, workerSpeed, scaledDtSec);
                continue;
            }

            const suit = SPECIES_WORK_SUITABILITY[w.species]?.[w.activeWork] || 1;
            w.workProgressMs += scaledDtMs * (1 + (suit - 1) * 0.25);
            w.energy = Math.max(0, w.energy - 2.2 * scaledDtSec);

            if (w.workProgressMs >= 2600) {
                const carryAmount = Math.max(1, Math.min(2, suit));
                w.carryingKind = node.yieldKind;
                w.carryingAmount = carryAmount;
                w.aiState = 'transport';
                w.activeWork = 'transporting';
                w.targetStructureId = anchor.structureId;
                w.workProgressMs = 0;

                node.hp = Math.max(0, node.hp - 35);
                if (node.hp <= 0) {
                    node.depleted = true;
                    node.respawnRemainingMs = RESOURCE_RESPAWN_MS;
                    markRoomDirty(room);
                    broadcastSurvivalEvent(room, {
                        event: 'node_depleted',
                        actorId: w.uid,
                        actorName: w.nickname,
                        targetId: node.id,
                        x: node.x,
                        y: node.y,
                        z: node.z,
                        resourceKind: node.yieldKind,
                        amount: 0,
                    });
                }
            }
            continue;
        }

        if (w.aiState === 'work_craft') {
            const wb = findNearestStructure(room, 'workbench', w.x, w.z, Infinity)?.structure || null;
            if (!wb) {
                w.aiState = 'idle';
                w.workProgressMs = 0;
                continue;
            }
            const dist = Math.hypot(wb.x - w.x, wb.z - w.z);
            if (dist > 1.8) {
                moveWorkerToward(w, wb.x, wb.z, workerSpeed, scaledDtSec);
                continue;
            }

            w.workProgressMs += scaledDtMs * 1.25;
            w.energy = Math.max(0, w.energy - 2.0 * scaledDtSec);
            if (w.workProgressMs >= 2800) {
                if ((room.sharedResources.berry || 0) >= 2 && (room.sharedResources.wood || 0) >= 1) {
                    room.sharedResources.berry -= 2;
                    room.sharedResources.wood -= 1;
                    w.carryingKind = 'cooked_berry';
                    w.carryingAmount = 2;
                    w.aiState = 'transport';
                    w.activeWork = 'transporting';
                    w.targetStructureId = anchor.structureId;
                    w.workProgressMs = 0;
                } else {
                    w.aiState = 'idle';
                    w.workProgressMs = 0;
                }
            }
            continue;
        }

        if (w.aiState === 'transport') {
            const dist = Math.hypot(anchor.x - w.x, anchor.z - w.z);
            if (dist > 1.8) {
                moveWorkerToward(w, anchor.x, anchor.z, workerSpeed, scaledDtSec);
                continue;
            }

            if (w.carryingKind && w.carryingAmount > 0) {
                const kind = w.carryingKind;
                const amount = w.carryingAmount;
                room.sharedResources[kind] = (room.sharedResources[kind] || 0) + amount;
                w.carryingKind = null;
                w.carryingAmount = 0;
                markRoomDirty(room);
                broadcastSurvivalEvent(room, {
                    event: 'worker_delivered',
                    actorId: w.uid,
                    actorName: w.nickname,
                    targetId: anchor.structureId || undefined,
                    x: w.x,
                    y: w.y,
                    z: w.z,
                    resourceKind: kind,
                    amount,
                    worker: serializeBaseWorker(w),
                });
            }
            w.aiState = w.energy <= 20 ? 'rest' : 'return';
            w.workProgressMs = 0;
            continue;
        }

        if (w.aiState === 'return') {
            const dist = Math.hypot(anchor.x - w.x, anchor.z - w.z);
            if (dist > 2.2) {
                moveWorkerToward(w, anchor.x, anchor.z, workerSpeed, scaledDtSec);
            } else {
                w.aiState = 'idle';
                w.workProgressMs = 0;
            }
        }
    }
}

function updateRoomCombatWorld(room, dtMs, now) {
    for (const player of room.players.values()) {
        if (player.combatStateUntilMs > 0 && now >= player.combatStateUntilMs) {
            player.combatStateUntilMs = 0;
            if (player.state.combatState !== 'idle') {
                player.state.combatState = 'idle';
            }
        }
    }
    updateRoomMonsters(room, dtMs, now);
    updateRoomCompanions(room, dtMs, now);
    updateRoomResourceNodes(room, dtMs);
    updateRoomPlayerHunger(room, dtMs, now);
    updateRoomBaseWorkers(room, dtMs);
}

function handleWorldEvent(ws, msg) {
    const meta = wsMeta.get(ws);
    if (!meta) {
        sendJson(ws, {
            type: 's2c_room_error',
            code: 'NOT_IN_ROOM',
            message: '방에 참가한 상태에서만 이벤트를 전송할 수 있습니다.',
        });
        return;
    }
    const room = rooms.get(meta.roomCode);
    if (!room) return;
    const player = room.players.get(meta.playerId);
    if (!player || player.ws !== ws) return;

    const eventId =
        typeof msg.eventId === 'string' && msg.eventId.trim().length > 0
            ? msg.eventId.trim().slice(0, 96)
            : randomUUID();

    if (room.seenEventIds.has(eventId)) return;
    room.seenEventIds.add(eventId);
    if (room.seenEventIds.size > 512) {
        const oldest = room.seenEventIds.values().next().value;
        if (oldest !== undefined) room.seenEventIds.delete(oldest);
    }

    const payload =
        msg.payload && typeof msg.payload === 'object' ? { ...msg.payload } : {};

    if (msg.kind === 'crystal_collected' && typeof payload.crystalId === 'string') {
        const crystalId = payload.crystalId.trim().slice(0, 48);
        if (crystalId) {
            room.collectedCrystals.add(crystalId);
            player.state.crystalsCollected = room.collectedCrystals.size;
            markRoomDirty(room);
        }
    }

    broadcastToRoom(
        room,
        {
            type: 's2c_world_event',
            protocolVersion: PROTOCOL_VERSION,
            roomCode: room.code,
            eventId,
            kind: msg.kind,
            actorId: player.playerId,
            actorName: player.displayName,
            slotIndex: player.slotIndex,
            timestampMs: Date.now(),
            payload,
            collectedCrystals: Array.from(room.collectedCrystals),
        },
        player.playerId
    );
}

function handleClientMessage(ws, rawData) {
    let msg;
    try {
        const text = typeof rawData === 'string' ? rawData : rawData.toString('utf8');
        msg = JSON.parse(text);
    } catch {
        sendJson(ws, {
            type: 's2c_room_error',
            code: 'BAD_MESSAGE',
            message: '잘못된 JSON 메시지 형식입니다.',
        });
        return;
    }

    if (!msg || typeof msg.type !== 'string') return;

    switch (msg.type) {
        case 'c2s_create_room':
            handleCreateRoom(ws, msg);
            break;
        case 'c2s_join_room':
            handleJoinRoom(ws, msg);
            break;
        case 'c2s_leave_room':
            leaveCurrentRoom(ws, 'leave');
            break;
        case 'c2s_player_state':
            handlePlayerState(ws, msg);
            break;
        case 'c2s_world_event':
            handleWorldEvent(ws, msg);
            break;
        case 'c2s_combat_action':
            handleCombatAction(ws, msg);
            break;
        case 'c2s_survival_action':
            handleSurvivalAction(ws, msg);
            break;
        case 'c2s_ping':
            sendJson(ws, {
                type: 's2c_pong',
                clientTimeMs: Number(msg.clientTimeMs) || Date.now(),
                serverTimeMs: Date.now(),
                seq: typeof msg.seq === 'number' ? msg.seq : undefined,
            });
            break;
        default:
            break;
    }
}

function handleSocketClose(ws) {
    const meta = wsMeta.get(ws);
    if (!meta) return;
    wsMeta.delete(ws);

    const room = rooms.get(meta.roomCode);
    if (!room) return;
    const player = room.players.get(meta.playerId);
    if (!player || player.ws !== ws) return;

    player.ws = null;
    player.connected = false;
    player.disconnectedAtMs = Date.now();
    player.state.connected = false;
    recordSavedPlayer(room, player);
    markRoomDirty(room);

    broadcastToRoom(
        room,
        {
            type: 's2c_player_reconnecting',
            roomCode: room.code,
            playerId: player.playerId,
            displayName: player.displayName,
            slotIndex: player.slotIndex,
            graceMs: RECONNECT_GRACE_MS,
            serverTimeMs: Date.now(),
        },
        player.playerId
    );

    clearPlayerGraceTimer(room, player.playerId);
    const timer = setTimeout(() => {
        room.graceTimers.delete(player.playerId);
        const current = room.players.get(player.playerId);
        if (current && !current.connected) {
            removePlayerFromRoom(room, player.playerId, 'timeout');
        }
    }, RECONNECT_GRACE_MS);
    room.graceTimers.set(player.playerId, timer);
}

// ============================================================================
// HTTP Static Server + Health Check
// ============================================================================

function getTotalConnectedPlayers() {
    let count = 0;
    for (const room of rooms.values()) {
        for (const player of room.players.values()) {
            if (player.connected) count += 1;
        }
    }
    return count;
}

async function handleHttpRequest(req, res) {
    const method = req.method || 'GET';

    let pathname = '/';
    try {
        const parsed = new URL(req.url || '/', 'http://127.0.0.1');
        pathname = decodeURIComponent(parsed.pathname);
    } catch {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Bad Request');
        return;
    }

    if (method === 'POST' && pathname === '/api/persistence/flush') {
        for (const room of rooms.values()) {
            markRoomDirty(room);
        }
        await persistenceStore.flushNow();
        const body = JSON.stringify({
            ok: true,
            persistence: persistenceStore.getStatus(),
        });
        res.writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
        });
        res.end(body);
        return;
    }

    if (method !== 'GET' && method !== 'HEAD') {
        res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Method Not Allowed');
        return;
    }

    if (pathname === '/health') {
        const body = JSON.stringify({
            status: 'ok',
            service: 'zaapworld-coop',
            protocolVersion: PROTOCOL_VERSION,
            maxPartyPlayers: MAX_PARTY_PLAYERS,
            tickRateHz: NETWORK_TICK_HZ,
            activeRooms: rooms.size,
            persistedRooms: persistedRooms.size,
            connectedPlayers: getTotalConnectedPlayers(),
            persistence: persistenceStore.getStatus(),
            uptimeSec: Math.round(process.uptime()),
            timestamp: new Date().toISOString(),
        });
        res.writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
        });
        res.end(method === 'HEAD' ? undefined : body);
        return;
    }

    if (!existsSync(DIST_DIR)) {
        res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Production build not found in dist/. Run npm run build first.');
        return;
    }

    const relPath = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const candidatePath = path.resolve(DIST_DIR, relPath);
    if (
        candidatePath !== DIST_DIR &&
        !candidatePath.startsWith(DIST_DIR + path.sep)
    ) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Forbidden');
        return;
    }

    let filePath = candidatePath;
    let stat = null;
    try {
        stat = await fs.stat(filePath);
    } catch {
        stat = null;
    }

    if (!stat || !stat.isFile()) {
        const ext = path.extname(pathname).toLowerCase();
        const isAssetPath =
            pathname.startsWith('/models/') ||
            pathname.startsWith('/assets/') ||
            Boolean(ext);
        if (isAssetPath) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('Not Found');
            return;
        }
        // SPA fallback to dist/index.html
        filePath = path.join(DIST_DIR, 'index.html');
        try {
            stat = await fs.stat(filePath);
        } catch {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('index.html not found');
            return;
        }
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    const isModel = pathname.startsWith('/models/') || ext === '.glb';
    const isHashedAsset = pathname.startsWith('/assets/');
    const cacheControl = isHashedAsset
        ? 'public, max-age=31536000, immutable'
        : isModel
          ? 'public, max-age=86400'
          : ext === '.html'
            ? 'no-cache'
            : 'public, max-age=3600';

    const headers = {
        'Content-Type': contentType,
        'Content-Length': stat.size,
        'Cache-Control': cacheControl,
        'X-Content-Type-Options': 'nosniff',
    };

    if (method === 'HEAD') {
        res.writeHead(200, headers);
        res.end();
        return;
    }

    const content = await fs.readFile(filePath);
    res.writeHead(200, headers);
    res.end(content);
}

// ============================================================================
// Server Startup & 15 Hz Authoritative Snapshot Broadcast Loop
// ============================================================================

const httpServer = http.createServer((req, res) => {
    void handleHttpRequest(req, res).catch((err) => {
        console.error('[HTTP Error]', err);
        if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        }
        res.end('Internal Server Error');
    });
});

const wss = new WebSocketServer({
    server: httpServer,
    path: '/ws',
    maxPayload: 64 * 1024,
});

wss.on('connection', (ws) => {
    wsAlive.set(ws, true);
    ws.on('pong', () => {
        wsAlive.set(ws, true);
    });
    ws.on('message', (data) => {
        handleClientMessage(ws, data);
    });
    ws.on('close', () => {
        handleSocketClose(ws);
    });
    ws.on('error', () => {
        handleSocketClose(ws);
    });
});

let tickInterval = null;
let heartbeatInterval = null;
let isShuttingDown = false;

export async function startServer(port = PORT, host = HOST) {
    await persistenceStore.init();
    const restoredRooms = await persistenceStore.loadAllRooms();
    for (const snap of restoredRooms) {
        if (snap && typeof snap.roomCode === 'string' && snap.roomCode) {
            persistedRooms.set(snap.roomCode, snap);
        }
    }

    if (!tickInterval) {
        tickInterval = setInterval(() => {
            const now = Date.now();
            for (const room of rooms.values()) {
                room.tickSeq += 1;
                const dtMs = clamp(now - room.lastTickAtMs, 10, 250);
                room.lastTickAtMs = now;
                if (room.players.size === 0) continue;

                updateRoomCombatWorld(room, dtMs, now);

                const players = getRoomPlayersSorted(room);
                const collectedCrystals = Array.from(room.collectedCrystals);
                const monsters = serializeMonsters(room);
                const companions = serializeCompanions(room);
                const sharedResources = { ...room.sharedResources };
                const resourceNodes = serializeResourceNodes(room);
                const structures = serializeStructures(room);
                const baseWorkers = serializeBaseWorkers(room);
                const persistenceMode = persistenceStore.getStatus().mode;
                for (const player of room.players.values()) {
                    if (
                        !player.connected ||
                        !player.ws ||
                        player.ws.readyState !== WebSocket.OPEN
                    ) {
                        continue;
                    }
                    sendJson(player.ws, {
                        type: 's2c_room_snapshot',
                        protocolVersion: PROTOCOL_VERSION,
                        roomCode: room.code,
                        serverTimeMs: now,
                        tickSeq: room.tickSeq,
                        lastAckSeq: player.lastAckSeq,
                        localState: player.state,
                        players,
                        collectedCrystals,
                        monsters,
                        companions,
                        capturedRoster: player.capturedRoster,
                        sharedResources,
                        resourceNodes,
                        structures,
                        baseWorkers,
                        persistenceMode,
                    });
                }
            }
        }, TICK_INTERVAL_MS);
    }

    if (!heartbeatInterval) {
        heartbeatInterval = setInterval(() => {
            for (const ws of wss.clients) {
                if (wsAlive.get(ws) === false) {
                    ws.terminate();
                    continue;
                }
                wsAlive.set(ws, false);
                try {
                    ws.ping();
                } catch {
                    ws.terminate();
                }
            }
        }, HEARTBEAT_INTERVAL_MS);
    }

    return new Promise((resolve) => {
        httpServer.listen(port, host, () => {
            const pStatus = persistenceStore.getStatus();
            console.log(
                `ZAAPworld Co-op Server listening on http://${host}:${port} (ws://${host}:${port}/ws, ${NETWORK_TICK_HZ}Hz, persistence=${pStatus.mode}, restoredRooms=${persistedRooms.size})`
            );
            resolve(httpServer);
        });
    });
}

export async function shutdown() {
    if (isShuttingDown) return;
    isShuttingDown = true;

    if (tickInterval) {
        clearInterval(tickInterval);
        tickInterval = null;
    }
    if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
        heartbeatInterval = null;
    }
    for (const room of rooms.values()) {
        markRoomDirty(room);
        for (const timer of room.graceTimers.values()) {
            clearTimeout(timer);
        }
        room.graceTimers.clear();
    }

    try {
        await persistenceStore.flushNow();
        await persistenceStore.close();
    } catch (err) {
        console.error('[Persistence] Failed to flush on shutdown:', err);
    }

    for (const ws of wss.clients) {
        try {
            ws.close(1001, 'Server shutting down');
        } catch {
            // Ignore
        }
    }
    setTimeout(() => process.exit(0), 2500).unref();
    wss.close(() => {
        httpServer.close(() => {
            process.exit(0);
        });
    });
}

process.on('SIGINT', () => {
    void shutdown();
});
process.on('SIGTERM', () => {
    void shutdown();
});

const isMainEntry =
    process.argv[1] &&
    path.resolve(process.argv[1]) === path.resolve(__filename);

if (isMainEntry) {
    void startServer();
}
