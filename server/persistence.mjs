import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_DATA_FILE = path.resolve(__dirname, '../data/zaapworld_store.json');
const DEFAULT_SCHEMA_PATH = path.resolve(__dirname, './schema.sql');

const DEFAULT_SHARED_RESOURCES = Object.freeze({
    wood: 4,
    stone: 2,
    ore: 0,
    berry: 3,
    aether_shard: 0,
    cooked_berry: 1,
});

function cloneSharedResources(raw) {
    const src = raw && typeof raw === 'object' ? raw : {};
    return {
        wood: Number.isFinite(Number(src.wood)) ? Math.max(0, Math.floor(Number(src.wood))) : DEFAULT_SHARED_RESOURCES.wood,
        stone: Number.isFinite(Number(src.stone)) ? Math.max(0, Math.floor(Number(src.stone))) : DEFAULT_SHARED_RESOURCES.stone,
        ore: Number.isFinite(Number(src.ore)) ? Math.max(0, Math.floor(Number(src.ore))) : DEFAULT_SHARED_RESOURCES.ore,
        berry: Number.isFinite(Number(src.berry)) ? Math.max(0, Math.floor(Number(src.berry))) : DEFAULT_SHARED_RESOURCES.berry,
        aether_shard: Number.isFinite(Number(src.aether_shard))
            ? Math.max(0, Math.floor(Number(src.aether_shard)))
            : DEFAULT_SHARED_RESOURCES.aether_shard,
        cooked_berry: Number.isFinite(Number(src.cooked_berry))
            ? Math.max(0, Math.floor(Number(src.cooked_berry)))
            : DEFAULT_SHARED_RESOURCES.cooked_berry,
    };
}

function parseJsonColumn(value, fallback) {
    if (value === undefined || value === null) return fallback;
    if (typeof value === 'string') {
        try {
            return JSON.parse(value);
        } catch {
            return fallback;
        }
    }
    return value;
}

/**
 * Splits a SQL script into individual statements outside quotes and comments.
 */
export function splitSqlStatements(sqlText) {
    const statements = [];
    let current = '';
    let inSingleQuote = false;
    let inDoubleQuote = false;
    let inLineComment = false;
    let inBlockComment = false;

    for (let i = 0; i < sqlText.length; i++) {
        const ch = sqlText[i];
        const next = i + 1 < sqlText.length ? sqlText[i + 1] : '';

        if (inLineComment) {
            if (ch === '\n') {
                inLineComment = false;
                current += ch;
            }
            continue;
        }

        if (inBlockComment) {
            if (ch === '*' && next === '/') {
                inBlockComment = false;
                i += 1;
            }
            continue;
        }

        if (!inSingleQuote && !inDoubleQuote) {
            if (ch === '-' && next === '-') {
                inLineComment = true;
                i += 1;
                continue;
            }
            if (ch === '/' && next === '*') {
                inBlockComment = true;
                i += 1;
                continue;
            }
        }

        if (ch === "'" && !inDoubleQuote) {
            current += ch;
            if (inSingleQuote && next === "'") {
                current += next;
                i += 1;
            } else {
                inSingleQuote = !inSingleQuote;
            }
            continue;
        }

        if (ch === '"' && !inSingleQuote) {
            inDoubleQuote = !inDoubleQuote;
            current += ch;
            continue;
        }

        if (ch === ';' && !inSingleQuote && !inDoubleQuote) {
            const trimmed = current.trim();
            if (trimmed.length > 0) {
                statements.push(trimmed);
            }
            current = '';
            continue;
        }

        current += ch;
    }

    const tail = current.trim();
    if (tail.length > 0) {
        statements.push(tail);
    }
    return statements;
}

function shouldUseSsl(connectionString) {
    try {
        const parsed = new URL(connectionString);
        const sslMode = parsed.searchParams.get('sslmode');
        if (sslMode === 'disable') return false;
        if (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost') {
            return sslMode === 'require' || sslMode === 'verify-full';
        }
        return true;
    } catch {
        return true;
    }
}

function resolveNeonHttpEndpoint(connectionString, overrideEndpoint) {
    if (overrideEndpoint) return overrideEndpoint;
    const parsed = new URL(connectionString);
    const sslMode = parsed.searchParams.get('sslmode');
    const isLocal = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost';
    const protocol = sslMode === 'disable' && isLocal ? 'http:' : 'https:';
    return `${protocol}//${parsed.host}/sql`;
}

function normalizeRoomSnapshot(raw) {
    if (!raw || typeof raw !== 'object' || !raw.roomCode) {
        return null;
    }
    const now = Date.now();
    return {
        roomCode: String(raw.roomCode),
        worldSeed: Number.isFinite(Number(raw.worldSeed)) ? Number(raw.worldSeed) : 42019,
        createdAtMs: Number.isFinite(Number(raw.createdAtMs)) ? Number(raw.createdAtMs) : now,
        updatedAtMs: Number.isFinite(Number(raw.updatedAtMs)) ? Number(raw.updatedAtMs) : now,
        sharedResources: cloneSharedResources(raw.sharedResources),
        collectedCrystals: Array.isArray(raw.collectedCrystals)
            ? raw.collectedCrystals.map((c) => String(c))
            : [],
        resourceNodes: Array.isArray(raw.resourceNodes)
            ? raw.resourceNodes.map((n) => ({ ...n }))
            : [],
        structures: Array.isArray(raw.structures)
            ? raw.structures.map((s) => ({ ...s }))
            : [],
        baseWorkers: Array.isArray(raw.baseWorkers)
            ? raw.baseWorkers.map((w) => ({ ...w }))
            : [],
        players: Array.isArray(raw.players)
            ? raw.players.map((p) => ({
                  ...p,
                  position: p.position ? { ...p.position } : { x: 0, y: 2.2, z: 12 },
                  unlockedTools: Array.isArray(p.unlockedTools) ? [...p.unlockedTools] : ['hands'],
                  capturedRoster: Array.isArray(p.capturedRoster)
                      ? p.capturedRoster.map((r) => ({ ...r }))
                      : [],
              }))
            : [],
    };
}

/**
 * Durable persistence store for ZAAPworld Phase 4.
 * Supports Neon PostgreSQL (pg Pool or Neon Serverless HTTP /sql fallback),
 * injectable queryClient for deterministic SQL transaction testing, and
 * atomic (.tmp + rename) local JSON disk storage.
 */
export class PersistenceStore {
    constructor(options = {}) {
        this.databaseUrl = String(
            options.databaseUrl ??
                process.env.DATABASE_URL ??
                process.env.NEON_DATABASE_URL ??
                ''
        ).trim();
        this.dataFile = path.resolve(
            options.dataFile || process.env.ZAAP_DATA_FILE || DEFAULT_DATA_FILE
        );
        this.schemaPath = path.resolve(options.schemaPath || DEFAULT_SCHEMA_PATH);
        this.debounceMs = Math.max(
            25,
            Number(options.debounceMs ?? process.env.PERSISTENCE_DEBOUNCE_MS ?? 1200)
        );
        this.queryClient = options.queryClient ?? null;
        this.neonHttpEndpointOverride = options.neonHttpEndpoint ?? null;
        this.roomSnapshotProvider =
            typeof options.roomSnapshotProvider === 'function'
                ? options.roomSnapshotProvider
                : null;
        this.backupToDisk =
            options.backupToDisk !== undefined
                ? Boolean(options.backupToDisk)
                : Boolean(!this.queryClient || options.dataFile || process.env.ZAAP_DATA_FILE);

        this.pgPool = null;
        this.driver = 'file';
        this.mode = 'file';
        this.dbConfigured = Boolean(this.queryClient || this.databaseUrl);
        this.initialized = false;

        this.dirtyRooms = new Set();
        this.cachedRooms = new Map();
        this.debounceTimer = null;
        this.writeChain = Promise.resolve();

        this.totalFlushes = 0;
        this.lastFlushAtMs = null;
        this.lastError = null;
    }

    async init() {
        if (this.initialized) {
            return this.getStatus();
        }

        if (this.queryClient) {
            this.driver = 'query-client';
            this.mode = 'postgres';
            this.dbConfigured = true;
            await this.ensureSchema();
        } else if (this.databaseUrl) {
            this.dbConfigured = true;
            let loadedPg = false;
            try {
                const pgModule = await import('pg');
                const PoolCtor = pgModule.Pool || pgModule.default?.Pool;
                if (typeof PoolCtor === 'function') {
                    this.pgPool = new PoolCtor({
                        connectionString: this.databaseUrl,
                        ssl: shouldUseSsl(this.databaseUrl)
                            ? { rejectUnauthorized: false }
                            : false,
                        max: 5,
                    });
                    this.driver = 'pg';
                    this.mode = 'postgres';
                    loadedPg = true;
                }
            } catch {
                loadedPg = false;
            }

            if (!loadedPg) {
                this.driver = 'neon-http';
                this.mode = 'postgres';
            }

            try {
                await this.ensureSchema();
            } catch (err) {
                this.lastError = err instanceof Error ? err.message : String(err);
                throw err;
            }
        } else {
            this.driver = 'atomic-json';
            this.mode = 'file';
            this.dbConfigured = false;
            await fs.mkdir(path.dirname(this.dataFile), { recursive: true });
        }

        if (this.backupToDisk) {
            await fs.mkdir(path.dirname(this.dataFile), { recursive: true });
        }

        this.initialized = true;
        return this.getStatus();
    }

    async ensureSchema() {
        if (!this.dbConfigured) {
            return;
        }
        const schemaSql = await fs.readFile(this.schemaPath, 'utf8');
        const statements = splitSqlStatements(schemaSql);
        if (statements.length === 0) return;

        if (this.driver === 'neon-http') {
            for (const stmt of statements) {
                await this.executeNeonSql(stmt, []);
            }
            return;
        }

        await this.withSqlClient(async (client) => {
            for (const stmt of statements) {
                await client.query(stmt, []);
            }
        });
    }

    async loadAllRooms() {
        if (!this.initialized) {
            await this.init();
        }

        if (this.dbConfigured) {
            const loaded = await this.loadAllRoomsFromDb();
            this.cachedRooms.clear();
            for (const room of loaded) {
                this.cachedRooms.set(room.roomCode, room);
            }
            return loaded;
        }

        const loaded = await this.loadAllRoomsFromDisk();
        this.cachedRooms.clear();
        for (const room of loaded) {
            this.cachedRooms.set(room.roomCode, room);
        }
        return loaded;
    }

    markRoomDirty(roomCode) {
        if (!roomCode) return;
        this.dirtyRooms.add(String(roomCode));
        if (!this.debounceTimer) {
            this.debounceTimer = setTimeout(() => {
                this.debounceTimer = null;
                void this.flushNow().catch((err) => {
                    this.lastError = err instanceof Error ? err.message : String(err);
                });
            }, this.debounceMs);
            if (typeof this.debounceTimer.unref === 'function') {
                this.debounceTimer.unref();
            }
        }
    }

    async saveRoomNow(roomSnapshot) {
        const normalized = normalizeRoomSnapshot(roomSnapshot);
        if (!normalized) return null;

        return this.enqueueWrite(async () => {
            if (!this.initialized) {
                await this.init();
            }

            this.cachedRooms.set(normalized.roomCode, normalized);
            this.dirtyRooms.delete(normalized.roomCode);

            if (this.dbConfigured) {
                await this.saveRoomToDb(normalized);
                if (this.backupToDisk) {
                    try {
                        await this.writeDiskAtomically();
                    } catch {
                        // Backup write errors must not mask primary DB commit
                    }
                }
            } else {
                await this.writeDiskAtomically();
            }

            this.totalFlushes += 1;
            this.lastFlushAtMs = Date.now();
            this.lastError = null;
            return normalized;
        });
    }

    async flushNow() {
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
            this.debounceTimer = null;
        }

        return this.enqueueWrite(async () => {
            if (!this.initialized) {
                await this.init();
            }

            const dirtyList = Array.from(this.dirtyRooms);
            this.dirtyRooms.clear();

            if (dirtyList.length === 0) {
                return this.getStatus();
            }

            const snapshotsToWrite = [];
            for (const roomCode of dirtyList) {
                const provided = this.roomSnapshotProvider
                    ? this.roomSnapshotProvider(roomCode)
                    : this.cachedRooms.get(roomCode) ?? null;
                const normalized = normalizeRoomSnapshot(provided);
                if (normalized) {
                    this.cachedRooms.set(roomCode, normalized);
                    snapshotsToWrite.push(normalized);
                }
            }

            if (snapshotsToWrite.length === 0) {
                return this.getStatus();
            }

            try {
                if (this.dbConfigured) {
                    for (const snap of snapshotsToWrite) {
                        await this.saveRoomToDb(snap);
                    }
                    if (this.backupToDisk) {
                        try {
                            await this.writeDiskAtomically();
                        } catch {
                            // Non-fatal backup write failure
                        }
                    }
                } else {
                    await this.writeDiskAtomically();
                }
            } catch (err) {
                for (const code of dirtyList) {
                    this.dirtyRooms.add(code);
                }
                this.lastError = err instanceof Error ? err.message : String(err);
                throw err;
            }

            this.totalFlushes += 1;
            this.lastFlushAtMs = Date.now();
            this.lastError = null;
            return this.getStatus();
        });
    }

    getStatus() {
        return {
            mode: this.mode,
            dbConfigured: this.dbConfigured,
            dataFile: this.dataFile,
            pendingWrites: this.dirtyRooms.size,
            totalFlushes: this.totalFlushes,
            lastFlushAtMs: this.lastFlushAtMs,
            lastError: this.lastError,
        };
    }

    async close() {
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
            this.debounceTimer = null;
        }
        await this.writeChain.catch(() => undefined);
        if (this.pgPool) {
            const pool = this.pgPool;
            this.pgPool = null;
            await pool.end();
        }
    }

    // ========================================================================
    // Internal Serialization & Storage Backends
    // ========================================================================

    enqueueWrite(task) {
        const run = this.writeChain.then(task, task);
        this.writeChain = run.catch((err) => {
            this.lastError = err instanceof Error ? err.message : String(err);
        });
        return run;
    }

    async withSqlClient(fn) {
        if (this.queryClient) {
            if (typeof this.queryClient.connect === 'function') {
                const client = await this.queryClient.connect();
                try {
                    return await fn(client);
                } finally {
                    if (typeof client.release === 'function') {
                        client.release();
                    }
                }
            }
            return await fn(this.queryClient);
        }

        if (this.pgPool) {
            const client = await this.pgPool.connect();
            try {
                return await fn(client);
            } finally {
                client.release();
            }
        }

        throw new Error('No SQL client available for direct query execution');
    }

    async executeNeonSql(query, params = []) {
        const endpoint = resolveNeonHttpEndpoint(
            this.databaseUrl,
            this.neonHttpEndpointOverride
        );
        const res = await fetch(endpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Neon-Connection-String': this.databaseUrl,
            },
            body: JSON.stringify({ query, params }),
        });

        const text = await res.text();
        let data = {};
        if (text) {
            try {
                data = JSON.parse(text);
            } catch {
                data = { message: text };
            }
        }
        if (!res.ok) {
            throw new Error(data.message || `Neon HTTP SQL error (${res.status})`);
        }
        return data;
    }

    async executeNeonTransaction(statements) {
        const endpoint = resolveNeonHttpEndpoint(
            this.databaseUrl,
            this.neonHttpEndpointOverride
        );
        const res = await fetch(endpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Neon-Connection-String': this.databaseUrl,
            },
            body: JSON.stringify({
                queries: statements.map((s) => ({
                    query: s.sql,
                    params: s.params,
                })),
            }),
        });

        const text = await res.text();
        let data = {};
        if (text) {
            try {
                data = JSON.parse(text);
            } catch {
                data = { message: text };
            }
        }
        if (!res.ok) {
            throw new Error(data.message || `Neon HTTP SQL transaction error (${res.status})`);
        }
        return data;
    }

    buildRoomSaveStatements(snap) {
        const statements = [];
        statements.push({
            sql: `INSERT INTO zaap_rooms (
                room_code, world_seed, shared_resources, collected_crystals, resource_nodes,
                created_at_ms, updated_at_ms, updated_at
            ) VALUES ($1, $2, $3::jsonb, $4::jsonb, $5::jsonb, $6, $7, NOW())
            ON CONFLICT (room_code) DO UPDATE SET
                world_seed = EXCLUDED.world_seed,
                shared_resources = EXCLUDED.shared_resources,
                collected_crystals = EXCLUDED.collected_crystals,
                resource_nodes = EXCLUDED.resource_nodes,
                updated_at_ms = EXCLUDED.updated_at_ms,
                updated_at = NOW()`,
            params: [
                snap.roomCode,
                snap.worldSeed,
                JSON.stringify(snap.sharedResources),
                JSON.stringify(snap.collectedCrystals),
                JSON.stringify(snap.resourceNodes),
                snap.createdAtMs,
                snap.updatedAtMs,
            ],
        });

        for (const p of snap.players) {
            statements.push({
                sql: `INSERT INTO zaap_players (
                    room_code, player_id, session_token, display_name, slot_index,
                    pos_x, pos_y, pos_z, yaw_deg, hp, max_hp, hunger, max_hunger, stamina,
                    equipped_tool, unlocked_tools, capture_spheres, loot_count, crystals_collected,
                    captured_roster, updated_at_ms, updated_at
                ) VALUES (
                    $1, $2, $3, $4, $5,
                    $6, $7, $8, $9, $10, $11, $12, $13, $14,
                    $15, $16::jsonb, $17, $18, $19,
                    $20::jsonb, $21, NOW()
                )
                ON CONFLICT (room_code, player_id) DO UPDATE SET
                    session_token = EXCLUDED.session_token,
                    display_name = EXCLUDED.display_name,
                    slot_index = EXCLUDED.slot_index,
                    pos_x = EXCLUDED.pos_x,
                    pos_y = EXCLUDED.pos_y,
                    pos_z = EXCLUDED.pos_z,
                    yaw_deg = EXCLUDED.yaw_deg,
                    hp = EXCLUDED.hp,
                    max_hp = EXCLUDED.max_hp,
                    hunger = EXCLUDED.hunger,
                    max_hunger = EXCLUDED.max_hunger,
                    stamina = EXCLUDED.stamina,
                    equipped_tool = EXCLUDED.equipped_tool,
                    unlocked_tools = EXCLUDED.unlocked_tools,
                    capture_spheres = EXCLUDED.capture_spheres,
                    loot_count = EXCLUDED.loot_count,
                    crystals_collected = EXCLUDED.crystals_collected,
                    captured_roster = EXCLUDED.captured_roster,
                    updated_at_ms = EXCLUDED.updated_at_ms,
                    updated_at = NOW()`,
                params: [
                    snap.roomCode,
                    p.playerId,
                    p.sessionToken || '',
                    p.displayName || 'Explorer',
                    Number(p.slotIndex ?? 0),
                    Number(p.position?.x ?? 0),
                    Number(p.position?.y ?? 2.2),
                    Number(p.position?.z ?? 12),
                    Number(p.yawDeg ?? 0),
                    Math.round(Number(p.hp ?? 100)),
                    Math.round(Number(p.maxHp ?? 100)),
                    Number(p.hunger ?? 100),
                    Number(p.maxHunger ?? 100),
                    Number(p.stamina ?? 100),
                    p.equippedTool || 'hands',
                    JSON.stringify(p.unlockedTools || ['hands']),
                    Math.round(Number(p.captureSpheres ?? 12)),
                    Math.round(Number(p.lootCount ?? 0)),
                    Math.round(Number(p.crystalsCollected ?? 0)),
                    JSON.stringify(p.capturedRoster || []),
                    Number(p.updatedAtMs ?? snap.updatedAtMs),
                ],
            });
        }

        statements.push({
            sql: 'DELETE FROM zaap_structures WHERE room_code = $1',
            params: [snap.roomCode],
        });

        for (const s of snap.structures) {
            statements.push({
                sql: `INSERT INTO zaap_structures (
                    id, room_code, recipe_id, grid_x, grid_z, layer,
                    pos_x, pos_y, pos_z, rotation_yaw_deg,
                    owner_player_id, owner_name, created_at_ms
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
                ON CONFLICT (room_code, grid_x, grid_z, layer) DO UPDATE SET
                    id = EXCLUDED.id,
                    recipe_id = EXCLUDED.recipe_id,
                    pos_x = EXCLUDED.pos_x,
                    pos_y = EXCLUDED.pos_y,
                    pos_z = EXCLUDED.pos_z,
                    rotation_yaw_deg = EXCLUDED.rotation_yaw_deg,
                    owner_player_id = EXCLUDED.owner_player_id,
                    owner_name = EXCLUDED.owner_name,
                    created_at_ms = EXCLUDED.created_at_ms`,
                params: [
                    s.id,
                    snap.roomCode,
                    s.recipeId,
                    Number(s.gridX),
                    Number(s.gridZ),
                    Number(s.layer),
                    Number(s.x),
                    Number(s.y),
                    Number(s.z),
                    Number(s.rotationYawDeg ?? 0),
                    s.ownerPlayerId || '',
                    s.ownerName || 'Explorer',
                    Number(s.createdAtMs ?? snap.updatedAtMs),
                ],
            });
        }

        statements.push({
            sql: 'DELETE FROM zaap_base_workers WHERE room_code = $1',
            params: [snap.roomCode],
        });

        for (const w of snap.baseWorkers) {
            statements.push({
                sql: `INSERT INTO zaap_base_workers (
                    uid, room_code, owner_player_id, species, nickname, level,
                    pos_x, pos_y, pos_z, yaw, ai_state, active_work,
                    carrying_kind, carrying_amount, energy, max_energy,
                    target_node_id, target_structure_id, updated_at_ms
                ) VALUES (
                    $1, $2, $3, $4, $5, $6,
                    $7, $8, $9, $10, $11, $12,
                    $13, $14, $15, $16,
                    $17, $18, $19
                )
                ON CONFLICT (room_code, uid) DO UPDATE SET
                    owner_player_id = EXCLUDED.owner_player_id,
                    species = EXCLUDED.species,
                    nickname = EXCLUDED.nickname,
                    level = EXCLUDED.level,
                    pos_x = EXCLUDED.pos_x,
                    pos_y = EXCLUDED.pos_y,
                    pos_z = EXCLUDED.pos_z,
                    yaw = EXCLUDED.yaw,
                    ai_state = EXCLUDED.ai_state,
                    active_work = EXCLUDED.active_work,
                    carrying_kind = EXCLUDED.carrying_kind,
                    carrying_amount = EXCLUDED.carrying_amount,
                    energy = EXCLUDED.energy,
                    max_energy = EXCLUDED.max_energy,
                    target_node_id = EXCLUDED.target_node_id,
                    target_structure_id = EXCLUDED.target_structure_id,
                    updated_at_ms = EXCLUDED.updated_at_ms`,
                params: [
                    w.uid,
                    snap.roomCode,
                    w.ownerPlayerId || '',
                    w.species,
                    w.nickname,
                    Number(w.level ?? 1),
                    Number(w.x ?? 0),
                    Number(w.y ?? 2.2),
                    Number(w.z ?? 12),
                    Number(w.yaw ?? 0),
                    w.aiState || 'idle',
                    w.activeWork ?? null,
                    w.carryingKind ?? null,
                    Math.round(Number(w.carryingAmount ?? 0)),
                    Number(w.energy ?? 100),
                    Number(w.maxEnergy ?? 100),
                    w.targetNodeId ?? null,
                    w.targetStructureId ?? null,
                    snap.updatedAtMs,
                ],
            });
        }

        return statements;
    }

    async saveRoomToDb(snap) {
        const statements = this.buildRoomSaveStatements(snap);

        if (this.driver === 'neon-http') {
            await this.executeNeonTransaction(statements);
            return;
        }

        await this.withSqlClient(async (client) => {
            await client.query('BEGIN', []);
            try {
                for (const stmt of statements) {
                    await client.query(stmt.sql, stmt.params);
                }
                await client.query('COMMIT', []);
            } catch (err) {
                try {
                    await client.query('ROLLBACK', []);
                } catch {
                    // Ignore rollback failure
                }
                throw err;
            }
        });
    }

    async queryRows(sql, params = []) {
        if (this.driver === 'neon-http') {
            const res = await this.executeNeonSql(sql, params);
            return Array.isArray(res.rows) ? res.rows : [];
        }
        return this.withSqlClient(async (client) => {
            const res = await client.query(sql, params);
            return Array.isArray(res?.rows) ? res.rows : [];
        });
    }

    async loadAllRoomsFromDb() {
        const roomRows = await this.queryRows(
            `SELECT room_code, world_seed, shared_resources, collected_crystals, resource_nodes,
                    created_at_ms, updated_at_ms
             FROM zaap_rooms
             ORDER BY updated_at_ms DESC`
        );
        const playerRows = await this.queryRows(
            `SELECT room_code, player_id, session_token, display_name, slot_index,
                    pos_x, pos_y, pos_z, yaw_deg, hp, max_hp, hunger, max_hunger, stamina,
                    equipped_tool, unlocked_tools, capture_spheres, loot_count, crystals_collected,
                    captured_roster, updated_at_ms
             FROM zaap_players`
        );
        const structRows = await this.queryRows(
            `SELECT id, room_code, recipe_id, grid_x, grid_z, layer,
                    pos_x, pos_y, pos_z, rotation_yaw_deg,
                    owner_player_id, owner_name, created_at_ms
             FROM zaap_structures`
        );
        const workerRows = await this.queryRows(
            `SELECT uid, room_code, owner_player_id, species, nickname, level,
                    pos_x, pos_y, pos_z, yaw, ai_state, active_work,
                    carrying_kind, carrying_amount, energy, max_energy,
                    target_node_id, target_structure_id, updated_at_ms
             FROM zaap_base_workers`
        );

        const roomsMap = new Map();
        for (const r of roomRows) {
            const roomCode = String(r.room_code);
            roomsMap.set(roomCode, {
                roomCode,
                worldSeed: Number(r.world_seed ?? 42019),
                createdAtMs: Number(r.created_at_ms ?? Date.now()),
                updatedAtMs: Number(r.updated_at_ms ?? Date.now()),
                sharedResources: cloneSharedResources(
                    parseJsonColumn(r.shared_resources, DEFAULT_SHARED_RESOURCES)
                ),
                collectedCrystals: parseJsonColumn(r.collected_crystals, []),
                resourceNodes: parseJsonColumn(r.resource_nodes, []),
                structures: [],
                baseWorkers: [],
                players: [],
            });
        }

        for (const p of playerRows) {
            const room = roomsMap.get(String(p.room_code));
            if (!room) continue;
            room.players.push({
                playerId: String(p.player_id),
                sessionToken: String(p.session_token ?? ''),
                displayName: String(p.display_name ?? 'Explorer'),
                slotIndex: Number(p.slot_index ?? 0),
                position: {
                    x: Number(p.pos_x ?? 0),
                    y: Number(p.pos_y ?? 2.2),
                    z: Number(p.pos_z ?? 12),
                },
                yawDeg: Number(p.yaw_deg ?? 0),
                hp: Number(p.hp ?? 100),
                maxHp: Number(p.max_hp ?? 100),
                hunger: Number(p.hunger ?? 100),
                maxHunger: Number(p.max_hunger ?? 100),
                stamina: Number(p.stamina ?? 100),
                equippedTool: String(p.equipped_tool ?? 'hands'),
                unlockedTools: parseJsonColumn(p.unlocked_tools, ['hands']),
                captureSpheres: Number(p.capture_spheres ?? 12),
                lootCount: Number(p.loot_count ?? 0),
                crystalsCollected: Number(p.crystals_collected ?? 0),
                capturedRoster: parseJsonColumn(p.captured_roster, []),
                updatedAtMs: Number(p.updated_at_ms ?? Date.now()),
            });
        }

        for (const s of structRows) {
            const room = roomsMap.get(String(s.room_code));
            if (!room) continue;
            room.structures.push({
                id: String(s.id),
                recipeId: String(s.recipe_id),
                gridX: Number(s.grid_x),
                gridZ: Number(s.grid_z),
                layer: Number(s.layer),
                x: Number(s.pos_x),
                y: Number(s.pos_y),
                z: Number(s.pos_z),
                rotationYawDeg: Number(s.rotation_yaw_deg ?? 0),
                ownerPlayerId: String(s.owner_player_id ?? ''),
                ownerName: String(s.owner_name ?? 'Explorer'),
                createdAtMs: Number(s.created_at_ms ?? Date.now()),
            });
        }

        for (const w of workerRows) {
            const room = roomsMap.get(String(w.room_code));
            if (!room) continue;
            room.baseWorkers.push({
                uid: String(w.uid),
                ownerPlayerId: String(w.owner_player_id ?? ''),
                species: String(w.species),
                nickname: String(w.nickname),
                level: Number(w.level ?? 1),
                x: Number(w.pos_x ?? 0),
                y: Number(w.pos_y ?? 2.2),
                z: Number(w.pos_z ?? 12),
                yaw: Number(w.yaw ?? 0),
                aiState: String(w.ai_state ?? 'idle'),
                activeWork: w.active_work ?? null,
                carryingKind: w.carrying_kind ?? null,
                carryingAmount: Number(w.carrying_amount ?? 0),
                energy: Number(w.energy ?? 100),
                maxEnergy: Number(w.max_energy ?? 100),
                targetNodeId: w.target_node_id ?? null,
                targetStructureId: w.target_structure_id ?? null,
            });
        }

        return Array.from(roomsMap.values());
    }

    async loadAllRoomsFromDisk() {
        if (!existsSync(this.dataFile)) {
            return [];
        }
        try {
            const raw = await fs.readFile(this.dataFile, 'utf8');
            if (!raw.trim()) return [];
            const parsed = JSON.parse(raw);
            const roomsObj = parsed && typeof parsed.rooms === 'object' ? parsed.rooms : {};
            const list = [];
            for (const value of Object.values(roomsObj)) {
                const norm = normalizeRoomSnapshot(value);
                if (norm) list.push(norm);
            }
            return list;
        } catch (err) {
            this.lastError = err instanceof Error ? err.message : String(err);
            return [];
        }
    }

    async writeDiskAtomically() {
        const dir = path.dirname(this.dataFile);
        await fs.mkdir(dir, { recursive: true });
        const payload = {
            version: 1,
            updatedAtMs: Date.now(),
            rooms: Object.fromEntries(this.cachedRooms.entries()),
        };
        const json = JSON.stringify(payload, null, 2);
        const tmpFile = `${this.dataFile}.${process.pid}.${Date.now()}.tmp`;

        await fs.writeFile(tmpFile, json, 'utf8');
        try {
            await fs.rename(tmpFile, this.dataFile);
        } catch (err) {
            // Retry once on transient Windows file lock
            if (err && (err.code === 'EPERM' || err.code === 'EBUSY')) {
                await new Promise((r) => setTimeout(r, 15));
                await fs.rename(tmpFile, this.dataFile);
            } else {
                await fs.unlink(tmpFile).catch(() => undefined);
                throw err;
            }
        }
    }
}
