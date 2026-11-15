import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { PersistenceStore, splitSqlStatements } from '../server/persistence.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

const HOST = '127.0.0.1';
const PROTOCOL_VERSION = 2;
const RESOURCE_RESPAWN_MS = 1200;
const MONSTER_RESPAWN_MS = 1200;
const HUNGER_DECAY_PER_SEC = 2.5;
const WORKER_TICK_SCALE = 12;
const RECONNECT_GRACE_MS = 2200;
const MAX_BASE_WORKERS = 3;

const EXPECTED_MODEL_KEYS = [
    'player_explorer',
    'tree_canopy',
    'tree_pine',
    'rock_cluster',
    'ancient_ruin',
    'vital_crystal',
    'bush_flower',
    'monster_moss_hopper',
    'monster_aether_wisp',
    'monster_shale_golem',
    'build_workbench',
    'build_chest',
    'build_bed',
];

const EXPECTED_BLEND_KEYS = [
    'monster_moss_hopper',
    'monster_aether_wisp',
    'monster_shale_golem',
    'build_workbench',
    'build_chest',
    'build_bed',
];

const ALL_CRAFT_RECIPES = [
    'wood_axe',
    'stone_pickaxe',
    'aether_blade',
    'capture_sphere_pack',
    'cooked_berry_batch',
];

const ALL_STRUCTURE_RECIPES = [
    'wood_foundation',
    'wood_wall',
    'wood_door',
    'wood_roof',
    'workbench',
    'storage_chest',
    'straw_bed',
];

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getFreePort(host = HOST) {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.unref();
        srv.on('error', reject);
        srv.listen(0, host, () => {
            const addr = srv.address();
            const port = typeof addr === 'object' && addr ? addr.port : 0;
            srv.close((err) => {
                if (err) reject(err);
                else resolve(port);
            });
        });
    });
}

// ============================================================================
// PART 1: Asset Audit (13 GLBs, Manifest & Blender Sources)
// ============================================================================

function parseGlbSummary(glbPath) {
    const buf = fs.readFileSync(glbPath);
    assert.ok(buf.length >= 20, `GLB file too small: ${glbPath}`);

    const magic = buf.readUInt32LE(0);
    const version = buf.readUInt32LE(4);
    const totalLength = buf.readUInt32LE(8);
    assert.equal(magic, 0x46546c67, `Invalid glTF magic in ${glbPath}`);
    assert.equal(version, 2, `Expected glTF version 2 in ${glbPath}`);
    assert.equal(totalLength, buf.length, `GLB length mismatch in ${glbPath}`);

    const chunk0Length = buf.readUInt32LE(12);
    const chunk0Type = buf.readUInt32LE(16);
    assert.equal(chunk0Type, 0x4e4f534a, `Expected JSON chunk first in ${glbPath}`);

    const jsonText = buf.subarray(20, 20 + chunk0Length).toString('utf8');
    const gltf = JSON.parse(jsonText);

    const nodes = gltf.nodes || [];
    const meshes = gltf.meshes || [];
    const materials = gltf.materials || [];
    const animations = gltf.animations || [];
    const accessors = gltf.accessors || [];

    let triangleCount = 0;
    let primitiveCount = 0;
    for (const mesh of meshes) {
        for (const prim of mesh.primitives || []) {
            primitiveCount += 1;
            const mode = prim.mode === undefined ? 4 : prim.mode;
            if (mode !== 4) continue;
            if (prim.indices !== undefined && accessors[prim.indices]) {
                triangleCount += Math.floor(accessors[prim.indices].count / 3);
            } else if (
                prim.attributes?.POSITION !== undefined &&
                accessors[prim.attributes.POSITION]
            ) {
                triangleCount += Math.floor(
                    accessors[prim.attributes.POSITION].count / 3
                );
            }
        }
    }

    return {
        fileSizeBytes: buf.length,
        nodeCount: nodes.length,
        meshCount: meshes.length,
        primitiveCount,
        materialCount: materials.length,
        triangleCount,
        animationNames: animations.map((a) => a.name),
    };
}

function runAssetAudit() {
    console.log('\n=== [1/4] Asset Audit (13 Models + Manifest + Blender Sources) ===');
    const manifestPath = path.join(ROOT_DIR, 'public', 'models', 'manifest.json');
    assert.ok(fs.existsSync(manifestPath), 'Missing public/models/manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    assert.ok(manifest.models && typeof manifest.models === 'object', 'manifest.json missing models map');

    const manifestKeys = Object.keys(manifest.models);
    assert.equal(
        manifestKeys.length,
        13,
        `Expected 13 models in manifest.json, found ${manifestKeys.length}`
    );

    const models = {};
    const blendPresent = [];
    const blendMissing = [];

    for (const key of EXPECTED_MODEL_KEYS) {
        const entry = manifest.models[key];
        assert.ok(entry, `manifest.json missing entry for '${key}'`);
        assert.equal(entry.key, key, `manifest entry key mismatch for '${key}'`);
        assert.equal(entry.path, `/models/${key}.glb`, `manifest path mismatch for '${key}'`);

        const glbPath = path.join(ROOT_DIR, 'public', 'models', `${key}.glb`);
        assert.ok(fs.existsSync(glbPath), `Missing GLB file: ${glbPath}`);

        const info = parseGlbSummary(glbPath);
        assert.ok(
            info.triangleCount > 0 && info.triangleCount <= 5000,
            `${key} triangleCount ${info.triangleCount} exceeds 5000 budget`
        );
        assert.equal(
            info.triangleCount,
            entry.triangleCount,
            `${key} GLB triangleCount (${info.triangleCount}) != manifest (${entry.triangleCount})`
        );
        assert.equal(
            info.fileSizeBytes,
            entry.fileSizeBytes,
            `${key} GLB fileSizeBytes (${info.fileSizeBytes}) != manifest (${entry.fileSizeBytes})`
        );

        const blendPath = path.join(ROOT_DIR, 'blender_src', `${key}.blend`);
        const hasBlend = fs.existsSync(blendPath);
        if (hasBlend) {
            const blendBytes = fs.statSync(blendPath).size;
            assert.ok(blendBytes > 50_000, `Blender source too small (${blendBytes}B): ${blendPath}`);
            blendPresent.push(key);
        } else {
            blendMissing.push(key);
        }

        models[key] = {
            glbBytes: info.fileSizeBytes,
            triangleCount: info.triangleCount,
            nodeCount: info.nodeCount,
            materialCount: info.materialCount,
            hasBlend,
        };

        console.log(
            `  [PASS] ${key}: glb=${info.fileSizeBytes}B, tris=${info.triangleCount} (<=5000), nodes=${info.nodeCount}, mats=${info.materialCount}, blend=${hasBlend}`
        );
    }

    for (const reqBlendKey of EXPECTED_BLEND_KEYS) {
        assert.ok(
            blendPresent.includes(reqBlendKey),
            `Missing Phase 3/4 Blender source blender_src/${reqBlendKey}.blend`
        );
    }

    if (blendMissing.length > 0) {
        console.log(
            `  [INFO] ${blendPresent.length}/13 .blend files in blender_src/; Phase 1/2 models (${blendMissing.join(', ')}) were exported directly to GLB by scripts/generate_blender_assets.py without .blend files.`
        );
    }

    return {
        modelCount: manifestKeys.length,
        blendPresentCount: blendPresent.length,
        blendMissingKeys: blendMissing,
        models,
    };
}

// ============================================================================
// PART 2: Typecheck & Production Build Audit
// ============================================================================

function runTypecheckAndBuildAudit() {
    console.log('\n=== [2/4] TypeScript & Vite Production Build Audit ===');
    const tscRes = spawnSync(
        process.execPath,
        ['./node_modules/typescript/bin/tsc', '--noEmit'],
        { cwd: ROOT_DIR, encoding: 'utf8' }
    );
    assert.equal(
        tscRes.status,
        0,
        `tsc --noEmit failed (exit=${tscRes.status}):\n${tscRes.stdout}\n${tscRes.stderr}`
    );
    console.log('  [PASS] tsc --noEmit -> exit 0');

    const viteRes = spawnSync(
        process.execPath,
        ['./node_modules/vite/bin/vite.js', 'build'],
        { cwd: ROOT_DIR, encoding: 'utf8' }
    );
    assert.equal(
        viteRes.status,
        0,
        `vite build failed (exit=${viteRes.status}):\n${viteRes.stdout}\n${viteRes.stderr}`
    );
    console.log('  [PASS] vite.js build -> exit 0');

    return {
        tscExitCode: tscRes.status,
        viteExitCode: viteRes.status,
    };
}

// ============================================================================
// PART 3: PostgreSQL SQL Transaction Audit (Mock queryClient + schema.sql)
// ============================================================================

async function runSqlPersistenceAudit() {
    console.log('\n=== [3/4] PersistenceStore PostgreSQL Schema & Transaction Audit ===');
    const schemaPath = path.join(ROOT_DIR, 'server', 'schema.sql');
    const schemaSql = fs.readFileSync(schemaPath, 'utf8');
    const expectedStatements = splitSqlStatements(schemaSql);
    assert.ok(expectedStatements.length >= 10, 'Expected schema.sql to contain Phase 1-4 DDL statements');

    const recordedQueries = [];
    let forceFailureOnNextMatch = null;
    const mockQueryClient = {
        async connect() {
            return {
                async query(sql, params = []) {
                    const text = String(sql).trim();
                    recordedQueries.push({ sql: text, params });
                    if (forceFailureOnNextMatch && text.includes(forceFailureOnNextMatch)) {
                        forceFailureOnNextMatch = null;
                        throw new Error('Simulated SQL write failure');
                    }
                    if (text.startsWith('SELECT ')) {
                        return { rows: [] };
                    }
                    return { rows: [], rowCount: 1 };
                },
                release() {},
            };
        },
    };

    const tempBackupPath = path.join(os.tmpdir(), `zaap-sql-mock-${randomUUID().slice(0, 8)}.json`);
    const store = new PersistenceStore({
        queryClient: mockQueryClient,
        schemaPath,
        dataFile: tempBackupPath,
        backupToDisk: false,
        debounceMs: 50,
    });

    try {
        const initStatus = await store.init();
        assert.equal(initStatus.mode, 'postgres');
        assert.equal(initStatus.dbConfigured, true);

        const initSqlJoined = recordedQueries.map((q) => q.sql).join('\n');
        assert.equal(
            recordedQueries.length,
            expectedStatements.length,
            `Expected ${expectedStatements.length} schema statements executed, got ${recordedQueries.length}`
        );
        for (const tbl of ['zaap_rooms', 'zaap_players', 'zaap_structures', 'zaap_base_workers']) {
            assert.ok(
                initSqlJoined.includes(`CREATE TABLE IF NOT EXISTS ${tbl}`),
                `schema.sql missing CREATE TABLE IF NOT EXISTS ${tbl}`
            );
        }
        console.log(
            `  [PASS] PersistenceStore.init() applied all ${expectedStatements.length} statements from server/schema.sql (zaap_rooms, zaap_players, zaap_structures, zaap_base_workers)`
        );

        recordedQueries.length = 0;
        const sampleSnap = {
            roomCode: 'SQLTST',
            worldSeed: 42019,
            createdAtMs: Date.now() - 1000,
            updatedAtMs: Date.now(),
            sharedResources: { wood: 9, stone: 6, ore: 2, berry: 5, aether_shard: 1, cooked_berry: 2 },
            collectedCrystals: ['crystal-1'],
            resourceNodes: [{ id: 'res-wood-1', hp: 50, depleted: false, respawnRemainingMs: 0 }],
            structures: [
                {
                    id: 'struct-0_5_0-abc123',
                    recipeId: 'wood_foundation',
                    gridX: 0,
                    gridZ: 5,
                    layer: 0,
                    x: 0,
                    y: 2.294,
                    z: 10,
                    rotationYawDeg: 0,
                    ownerPlayerId: 'exp-sql-1',
                    ownerName: 'Alpha',
                    createdAtMs: Date.now(),
                },
            ],
            baseWorkers: [
                {
                    uid: 'cap-worker-1',
                    ownerPlayerId: 'exp-sql-1',
                    species: 'moss_hopper',
                    nickname: 'Moss Hopper',
                    level: 3,
                    x: 0,
                    y: 2.28,
                    z: 12,
                    yaw: 0,
                    aiState: 'work_gather',
                    activeWork: 'lumbering',
                    carryingKind: null,
                    carryingAmount: 0,
                    energy: 95,
                    maxEnergy: 100,
                    targetNodeId: 'res-wood-1',
                    targetStructureId: null,
                },
            ],
            players: [
                {
                    playerId: 'exp-sql-1',
                    sessionToken: 'tok-sql-1',
                    displayName: 'Alpha',
                    slotIndex: 0,
                    position: { x: 0, y: 2.28, z: 12 },
                    yawDeg: 0,
                    hp: 92,
                    maxHp: 100,
                    hunger: 84,
                    maxHunger: 100,
                    stamina: 100,
                    equippedTool: 'aether_blade',
                    unlockedTools: ['hands', 'wood_axe', 'aether_blade'],
                    captureSpheres: 14,
                    lootCount: 2,
                    crystalsCollected: 1,
                    capturedRoster: [
                        {
                            uid: 'cap-worker-1',
                            species: 'moss_hopper',
                            nickname: 'Moss Hopper',
                            level: 3,
                            hp: 110,
                            maxHp: 110,
                            attackPower: 14,
                        },
                    ],
                    updatedAtMs: Date.now(),
                },
            ],
        };

        await store.saveRoomNow(sampleSnap);
        assert.equal(recordedQueries[0].sql, 'BEGIN', 'Expected transaction to start with BEGIN');
        assert.equal(
            recordedQueries[recordedQueries.length - 1].sql,
            'COMMIT',
            'Expected transaction to finish with COMMIT'
        );
        assert.ok(
            !recordedQueries.some((q) => q.sql === 'ROLLBACK'),
            'Unexpected ROLLBACK during valid saveRoomNow'
        );

        const upsertTargets = [
            { table: 'zaap_rooms', conflict: 'ON CONFLICT (room_code) DO UPDATE' },
            { table: 'zaap_players', conflict: 'ON CONFLICT (room_code, player_id) DO UPDATE' },
            { table: 'zaap_structures', conflict: 'ON CONFLICT (room_code, grid_x, grid_z, layer) DO UPDATE' },
            { table: 'zaap_base_workers', conflict: 'ON CONFLICT (room_code, uid) DO UPDATE' },
        ];
        for (const item of upsertTargets) {
            const match = recordedQueries.find(
                (q) =>
                    q.sql.includes(`INSERT INTO ${item.table}`) &&
                    q.sql.includes(item.conflict)
            );
            assert.ok(match, `Missing parameterized upsert for ${item.table}`);
            assert.ok(Array.isArray(match.params) && match.params.length > 0, `Expected parameterized params for ${item.table}`);
        }
        const playerInsert = recordedQueries.find((q) => q.sql.includes('INSERT INTO zaap_players'));
        assert.ok(
            playerInsert.params.some((p) => typeof p === 'string' && p.includes('cap-worker-1')),
            'Expected capturedRoster JSONB parameter inside zaap_players upsert'
        );
        console.log(
            `  [PASS] saveRoomNow() executed BEGIN -> parameterized INSERT ... ON CONFLICT DO UPDATE (zaap_rooms, zaap_players[+captured_roster JSONB], zaap_structures, zaap_base_workers) -> COMMIT (${recordedQueries.length} queries)`
        );

        // Verify rollback path on SQL error during flushNow()
        recordedQueries.length = 0;
        store.roomSnapshotProvider = () => sampleSnap;
        store.markRoomDirty('SQLTST');
        forceFailureOnNextMatch = 'INSERT INTO zaap_structures';
        await assert.rejects(() => store.flushNow(), /Simulated SQL write failure/);
        assert.ok(
            recordedQueries.some((q) => q.sql === 'BEGIN') &&
                recordedQueries.some((q) => q.sql === 'ROLLBACK') &&
                !recordedQueries.some((q) => q.sql === 'COMMIT'),
            'Expected ROLLBACK and no COMMIT when SQL query fails inside transaction'
        );
        console.log('  [PASS] Simulated SQL error executed ROLLBACK without partial COMMIT');

        return {
            schemaStatementsApplied: expectedStatements.length,
            txQueryCount: recordedQueries.length,
            tablesVerified: upsertTargets.map((t) => t.table),
            rollbackVerified: true,
        };
    } finally {
        await store.close();
        if (fs.existsSync(tempBackupPath)) {
            fs.unlinkSync(tempBackupPath);
        }
    }
}

// ============================================================================
// PART 4: Live Authoritative Server WebSocket Test Client & Process Manager
// ============================================================================

class TestWsClient {
    constructor(name, wsUrl, sessionToken = `tok-${name}-${randomUUID().slice(0, 8)}`) {
        this.name = name;
        this.wsUrl = wsUrl;
        this.sessionToken = sessionToken;
        this.playerId = null;
        this.slotIndex = null;
        this.roomCode = null;
        this.ws = null;
        this.seq = 0;
        this.combatSeq = 0;
        this.survivalSeq = 0;
        this.virtualTimeMs = Date.now();
        this.messages = [];
        this.latestSnapshot = null;
        this.closeCode = null;
        this.closeReason = null;
        this.waiters = [];
    }

    async connect(wsUrlOverride = null) {
        const targetUrl = wsUrlOverride || this.wsUrl;
        this.wsUrl = targetUrl;
        this.ws = new WebSocket(targetUrl);
        this.closeCode = null;
        this.closeReason = null;
        this.seq = 0;
        this.combatSeq = 0;
        this.survivalSeq = 0;

        this.ws.on('message', (data) => {
            const text = typeof data === 'string' ? data : data.toString('utf8');
            let msg;
            try {
                msg = JSON.parse(text);
            } catch {
                return;
            }
            this.messages.push(msg);
            if (msg.type === 's2c_room_joined') {
                this.playerId = msg.playerId;
                this.slotIndex = msg.slotIndex;
                this.roomCode = msg.roomCode;
                this.latestSnapshot = msg;
            } else if (msg.type === 's2c_room_snapshot') {
                this.latestSnapshot = msg;
            }

            for (let i = this.waiters.length - 1; i >= 0; i--) {
                const w = this.waiters[i];
                if (w.predicate(msg)) {
                    this.waiters.splice(i, 1);
                    clearTimeout(w.timer);
                    w.resolve(msg);
                }
            }
        });

        this.ws.on('close', (code, reason) => {
            this.closeCode = code;
            this.closeReason = reason?.toString() || '';
            for (let i = this.waiters.length - 1; i >= 0; i--) {
                const w = this.waiters[i];
                if (w.onClose) {
                    this.waiters.splice(i, 1);
                    clearTimeout(w.timer);
                    w.resolve({ type: '__closed__', code, reason: this.closeReason });
                }
            }
        });

        await new Promise((resolve, reject) => {
            this.ws.once('open', resolve);
            this.ws.once('error', reject);
        });
    }

    send(payload) {
        assert.ok(
            this.ws && this.ws.readyState === WebSocket.OPEN,
            `Client ${this.name} socket not open`
        );
        this.ws.send(JSON.stringify(payload));
    }

    markIndex() {
        return this.messages.length;
    }

    waitForMessage(predicate, timeoutMs = 4000, label = 'message') {
        return this.waitForMessageSince(0, predicate, timeoutMs, label);
    }

    waitForMessageSince(startIndex, predicate, timeoutMs = 4000, label = 'message_since') {
        for (let i = startIndex; i < this.messages.length; i++) {
            if (predicate(this.messages[i])) {
                return Promise.resolve(this.messages[i]);
            }
        }
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                const idx = this.waiters.indexOf(entry);
                if (idx !== -1) this.waiters.splice(idx, 1);
                reject(new Error(`[${this.name}] Timeout (${timeoutMs}ms) waiting for ${label}`));
            }, timeoutMs);
            const entry = { predicate, resolve, reject, timer, onClose: false };
            this.waiters.push(entry);
        });
    }

    waitForNextMessage(predicate, timeoutMs = 4000, label = 'next_message') {
        return this.waitForMessageSince(this.messages.length, predicate, timeoutMs, label);
    }

    waitForClose(timeoutMs = 3000) {
        if (this.closeCode !== null) {
            return Promise.resolve({ code: this.closeCode, reason: this.closeReason });
        }
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                reject(new Error(`[${this.name}] Timeout waiting for socket close`));
            }, timeoutMs);
            this.waiters.push({
                predicate: () => false,
                resolve: (ev) => resolve({ code: ev.code, reason: ev.reason }),
                reject,
                timer,
                onClose: true,
            });
        });
    }

    sendState({
        x = 0,
        y = 2.28,
        z = 12,
        vx = 0,
        vy = 0,
        vz = 0,
        yawDeg = 0,
        animState = 'idle',
        combatState = 'idle',
        grounded = true,
        inWater = false,
        stamina = 100,
        crystalsCollected = 0,
        advanceTimeMs = 1500,
    } = {}) {
        this.seq += 1;
        this.virtualTimeMs += advanceTimeMs;
        this.send({
            type: 'c2s_player_state',
            protocolVersion: PROTOCOL_VERSION,
            seq: this.seq,
            timestampMs: this.virtualTimeMs,
            position: { x, y, z },
            velocity: { x: vx, y: vy, z: vz },
            yawDeg,
            animState,
            combatState,
            grounded,
            inWater,
            stamina,
            crystalsCollected,
        });
        return this.seq;
    }

    async movePlayerTo(targetX, targetZ, y = 2.5) {
        const startIdx = this.markIndex();
        for (let i = 0; i < 12; i++) {
            const curPos = this.getLocalPlayerState()?.position || { x: 0, y: 2.28, z: 12 };
            const dx = targetX - curPos.x;
            const dz = targetZ - curPos.z;
            const dist = Math.hypot(dx, dz);
            if (dist <= 0.35 && i > 0) {
                break;
            }
            const stepDist = Math.min(dist, 20);
            const nx = dist <= 20 ? targetX : curPos.x + (dx / dist) * stepDist;
            const nz = dist <= 20 ? targetZ : curPos.z + (dz / dist) * stepDist;
            const seqSent = this.sendState({ x: nx, y, z: nz, advanceTimeMs: 1800 });
            const ackSnap = await this.waitForMessageSince(
                startIdx,
                (m) => m.type === 's2c_room_snapshot' && m.lastAckSeq >= seqSent,
                3000,
                `movePlayerTo(${targetX.toFixed(1)}, ${targetZ.toFixed(1)}) ack`
            );
            const ackPos = ackSnap.localState?.position;
            if (ackPos && Math.hypot(targetX - ackPos.x, targetZ - ackPos.z) <= 0.5) {
                break;
            }
            await sleep(25);
        }
    }

    sendCombatAction({
        action,
        targetMonsterId = null,
        companionUid = null,
        aimYaw = 0,
        originX,
        originY,
        originZ,
        dirX = 0,
        dirZ = -1,
    }) {
        const pos = this.getLocalPlayerState()?.position || { x: 0, y: 2.28, z: 12 };
        this.combatSeq += 1;
        this.send({
            type: 'c2s_combat_action',
            protocolVersion: PROTOCOL_VERSION,
            seq: this.combatSeq,
            clientTime: Date.now(),
            action,
            targetMonsterId,
            companionUid,
            aimYaw,
            originX: originX ?? pos.x,
            originY: originY ?? pos.y,
            originZ: originZ ?? pos.z,
            dirX,
            dirZ,
        });
        return this.combatSeq;
    }

    sendSurvivalAction(payload) {
        this.survivalSeq += 1;
        this.send({
            type: 'c2s_survival_action',
            protocolVersion: PROTOCOL_VERSION,
            seq: this.survivalSeq,
            clientTime: Date.now(),
            ...payload,
        });
        return this.survivalSeq;
    }

    getLocalPlayerState() {
        if (!this.latestSnapshot) return null;
        if (this.latestSnapshot.localState) return this.latestSnapshot.localState;
        return (
            (this.latestSnapshot.players || []).find((p) => p.playerId === this.playerId) || null
        );
    }

    getMonster(monsterId) {
        return (this.latestSnapshot?.monsters || []).find((m) => m.id === monsterId) || null;
    }

    getResourceNode(nodeId) {
        return (this.latestSnapshot?.resourceNodes || []).find((n) => n.id === nodeId) || null;
    }

    close() {
        if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
            this.ws.close(1000, 'Client close');
        }
    }
}

async function spawnServerProcess(port, persistenceFilePath) {
    const child = spawn(process.execPath, ['server/index.mjs'], {
        cwd: ROOT_DIR,
        env: {
            ...process.env,
            PORT: String(port),
            HOST,
            RECONNECT_GRACE_MS: String(RECONNECT_GRACE_MS),
            MONSTER_RESPAWN_MS: String(MONSTER_RESPAWN_MS),
            RESOURCE_RESPAWN_MS: String(RESOURCE_RESPAWN_MS),
            HUNGER_DECAY_PER_SEC: String(HUNGER_DECAY_PER_SEC),
            WORKER_TICK_SCALE: String(WORKER_TICK_SCALE),
            PERSISTENCE_DEBOUNCE_MS: '250',
            ZAAP_DATA_FILE: persistenceFilePath,
            PERSISTENCE_FILE_PATH: persistenceFilePath,
            DATABASE_URL: '',
            NEON_DATABASE_URL: '',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdoutLog = '';
    let stderrLog = '';
    child.stdout.on('data', (chunk) => {
        stdoutLog += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
        stderrLog += chunk.toString();
    });

    const baseHttp = `http://${HOST}:${port}`;
    const baseWs = `ws://${HOST}:${port}/ws`;
    let lastFetchErr = null;
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
        if (child.exitCode !== null) {
            throw new Error(
                `Server exited early with code ${child.exitCode}. Stdout=${stdoutLog} Stderr=${stderrLog}`
            );
        }
        try {
            const res = await fetch(`${baseHttp}/health`);
            if (res.ok) {
                const health = await res.json();
                return {
                    child,
                    port,
                    baseHttp,
                    baseWs,
                    health,
                    getLogs: () => ({ stdoutLog, stderrLog }),
                };
            }
        } catch (err) {
            lastFetchErr = err;
        }
        await sleep(80);
    }

    child.kill('SIGKILL');
    throw new Error(
        `Server failed to respond on ${baseHttp}/health. LastErr=${lastFetchErr?.cause?.code || lastFetchErr?.message} Stdout=${stdoutLog} Stderr=${stderrLog}`
    );
}

async function stopChildProcess(child) {
    if (!child || child.exitCode !== null || child.signalCode !== null) {
        return;
    }
    const exited = new Promise((resolve) => {
        child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    child.kill('SIGTERM');
    const timeout = sleep(2000).then(() => {
        if (child.exitCode === null && child.signalCode === null) {
            child.kill('SIGKILL');
        }
    });
    await Promise.race([exited, timeout.then(() => exited)]);
}

async function harvestNodeUntilDepleted(client, nodeId) {
    let node = client.getResourceNode(nodeId);
    assert.ok(node, `Resource node '${nodeId}' not found`);
    if (node.depleted) {
        await client.waitForMessageSince(
            client.markIndex(),
            (m) =>
                m.type === 's2c_room_snapshot' &&
                !m.resourceNodes?.find((n) => n.id === nodeId)?.depleted,
            RESOURCE_RESPAWN_MS + 2000,
            `${nodeId} respawn before harvest`
        );
        node = client.getResourceNode(nodeId);
    }

    await client.movePlayerTo(node.x, node.z, node.y);
    const hitEvents = [];
    let depletedEvt = null;

    for (let swing = 0; swing < 8; swing++) {
        const idx = client.markIndex();
        client.sendSurvivalAction({
            action: 'harvest_node',
            nodeId,
            x: node.x,
            z: node.z,
        });
        const ev = await client.waitForMessageSince(
            idx,
            (m) =>
                m.type === 's2c_survival_event' &&
                m.targetId === nodeId &&
                (m.event === 'node_hit' || m.event === 'node_depleted'),
            2500,
            `${nodeId} harvest event`
        );
        if (ev.event === 'node_hit') {
            hitEvents.push(ev);
        } else if (ev.event === 'node_depleted') {
            depletedEvt = ev;
            break;
        }
    }

    assert.ok(depletedEvt, `Expected '${nodeId}' to deplete`);
    return { hitEvents, depletedEvt };
}

async function captureMonsterForPlayer(client, monsterId) {
    for (let attempt = 0; attempt < 8; attempt++) {
        let m = client.getMonster(monsterId);
        if (!m || m.aiState === 'dead' || m.aiState === 'captured') {
            await client.waitForMessageSince(
                client.markIndex(),
                (msg) => {
                    if (msg.type !== 's2c_room_snapshot') return false;
                    const found = (msg.monsters || []).find((x) => x.id === monsterId);
                    return found && found.aiState !== 'dead' && found.aiState !== 'captured';
                },
                MONSTER_RESPAWN_MS + 2500,
                `${monsterId} respawn for capture`
            );
            m = client.getMonster(monsterId);
        }

        while (m.hp > 25) {
            await client.movePlayerTo(m.x - 1.0, m.z, m.y);
            const idx = client.markIndex();
            client.sendCombatAction({
                action: m.hp <= 45 ? 'ranged_attack' : 'melee_attack',
                targetMonsterId: monsterId,
                originX: m.x - 1.0,
                originY: m.y,
                originZ: m.z,
                dirX: 1,
                dirZ: 0,
            });
            await sleep(160);
            const snap = await client.waitForMessageSince(
                idx,
                (msg) => msg.type === 's2c_room_snapshot',
                1500,
                `snapshot after softening ${monsterId}`
            );
            m = snap.monsters.find((x) => x.id === monsterId);
            if (!m || m.aiState === 'dead' || m.aiState === 'captured') break;
        }

        if (!m || m.aiState === 'dead' || m.aiState === 'captured') {
            continue;
        }

        await client.movePlayerTo(m.x - 1.0, m.z, m.y);
        const throwIdx = client.markIndex();
        client.sendCombatAction({
            action: 'throw_capture',
            targetMonsterId: monsterId,
            originX: m.x - 1.0,
            originY: m.y,
            originZ: m.z,
            dirX: 1,
            dirZ: 0,
        });
        const res = await client.waitForMessageSince(
            throwIdx,
            (msg) =>
                msg.type === 's2c_combat_event' &&
                msg.event === 'capture_result' &&
                msg.actorId === client.playerId &&
                msg.targetId === monsterId,
            3500,
            `${client.name} capture_result on ${monsterId}`
        );
        if (res.captureSuccess && res.capturedRecord) {
            await client.waitForMessageSince(
                throwIdx,
                (msg) =>
                    msg.type === 's2c_room_snapshot' &&
                    (msg.capturedRoster || []).some((r) => r.uid === res.capturedRecord.uid),
                2000,
                `${client.name} roster snapshot update`
            );
            return res.capturedRecord;
        }
    }
    throw new Error(`Failed to capture ${monsterId} for ${client.name} after retries`);
}

function findSafeParkSpot(client) {
    const monsters = client.latestSnapshot?.monsters || [];
    let best = { x: 0, z: 54, minDist: -1 };
    for (const radius of [36, 48, 60, 72]) {
        for (let angleDeg = 0; angleDeg < 360; angleDeg += 15) {
            const rad = (angleDeg * Math.PI) / 180;
            const x = Number((Math.cos(rad) * radius).toFixed(2));
            const z = Number((Math.sin(rad) * radius).toFixed(2));
            const minDist = monsters.reduce(
                (acc, m) => Math.min(acc, Math.hypot(m.x - x, m.z - z)),
                Infinity
            );
            if (minDist > best.minDist) {
                best = { x, z, minDist };
            }
        }
    }
    return best;
}

async function takeOneMonsterHit(client, otherClients, monsterId) {
    const safe = findSafeParkSpot(client);
    assert.ok(
        safe.minDist >= 28,
        `Expected safe park spot >= 28m from all monsters, got ${safe.minDist.toFixed(1)}m at (${safe.x}, ${safe.z})`
    );
    await Promise.all(
        otherClients.map(async (other) => {
            await other.movePlayerTo(safe.x, safe.z, 2.5);
            const pos = other.getLocalPlayerState()?.position;
            assert.ok(
                pos && Math.hypot(pos.x - safe.x, pos.z - safe.z) <= 1.5,
                `Expected ${other.name} to reach safe spot (${safe.x}, ${safe.z})`
            );
        })
    );

    // Wait briefly for target monster to clear any previous player aggro
    const otherIds = new Set(otherClients.map((c) => c.playerId));
    const clearDeadline = Date.now() + 2500;
    while (Date.now() < clearDeadline) {
        const curM = client.getMonster(monsterId);
        if (
            curM &&
            curM.aiState !== 'dead' &&
            curM.aiState !== 'captured' &&
            (!curM.targetPlayerId || !otherIds.has(curM.targetPlayerId))
        ) {
            break;
        }
        await sleep(200);
    }

    const hitIdx = client.markIndex();
    const deadline = Date.now() + 12000;
    let aggroTapped = false;

    while (Date.now() < deadline) {
        for (let i = hitIdx; i < client.messages.length; i++) {
            const msg = client.messages[i];
            if (
                msg.type === 's2c_combat_event' &&
                msg.event === 'player_hit' &&
                msg.targetId === client.playerId
            ) {
                await client.movePlayerTo(safe.x, safe.z, 2.5);
                await client.waitForNextMessage((m) => m.type === 's2c_room_snapshot', 1500);
                return msg;
            }
        }

        const m = client.getMonster(monsterId);
        if (m && m.aiState !== 'dead' && m.aiState !== 'captured') {
            const me = client.getLocalPlayerState()?.position;
            const dist = me ? Math.hypot(me.x - m.x, me.z - m.z) : 99;
            if (dist > 1.25) {
                await client.movePlayerTo(m.x - 0.7, m.z, m.y);
            }
            if (!aggroTapped && m.targetPlayerId !== client.playerId && m.hp > 50) {
                aggroTapped = true;
                client.sendCombatAction({
                    action: 'melee_attack',
                    targetMonsterId: monsterId,
                    originX: m.x - 0.7,
                    originY: m.y,
                    originZ: m.z,
                    dirX: 1,
                    dirZ: 0,
                });
            }
        }
        await sleep(250);
    }

    const diag = client.getLocalPlayerState();
    const diagM = client.getMonster(monsterId);
    const recentCombat = client.messages
        .slice(hitIdx)
        .filter((m) => m.type === 's2c_combat_event')
        .slice(-10);
    throw new Error(
        `[${client.name}] Timeout (12000ms) waiting for ${client.name} player_hit by ${monsterId}; ` +
            `playerState=${JSON.stringify(diag)} lastAckSeq=${client.latestSnapshot?.lastAckSeq} seq=${client.seq} ` +
            `monster=${JSON.stringify(diagM)} recentCombat=${JSON.stringify(recentCombat)}`
    );
}

async function runLiveServerSuite() {
    console.log('\n=== [4/4] Live Authoritative Server Phase 4 Integration Suite ===');
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zaapworld-phase4-'));
    const tempPersistenceFile = path.join(tempDir, 'zaapworld_store.json');
    const summary = {};

    let proc1 = null;
    let proc2 = null;
    const activeClients = [];

    try {
        const port1 = await getFreePort(HOST);
        proc1 = await spawnServerProcess(port1, tempPersistenceFile);
        console.log(
            `  [INFO] Spawned server #1 on ${proc1.baseHttp} (persistence=${proc1.health.persistence?.mode}, dataFile=${proc1.health.persistence?.dataFile})`
        );
        assert.equal(proc1.health.status, 'ok');
        assert.equal(proc1.health.protocolVersion, 2);
        assert.equal(proc1.health.maxPartyPlayers, 3);
        assert.equal(
            path.resolve(proc1.health.persistence?.dataFile || ''),
            path.resolve(tempPersistenceFile),
            'Server should use isolated temporary persistence file'
        );

        // --------------------------------------------------------------------
        // (a) Phase 2-3 Regressions
        // --------------------------------------------------------------------
        console.log('\n--- (a) Phase 2-3 Regressions ---');
        const p1 = new TestWsClient('Alpha', proc1.baseWs);
        let p2 = new TestWsClient('Bravo', proc1.baseWs);
        const p3 = new TestWsClient('Charlie', proc1.baseWs);
        const p4 = new TestWsClient('Delta', proc1.baseWs);
        activeClients.push(p1, p2, p3, p4);

        await p1.connect();
        p1.send({
            type: 'c2s_create_room',
            protocolVersion: PROTOCOL_VERSION,
            sessionToken: p1.sessionToken,
            displayName: 'Alpha',
            preferredRoomCode: 'PH4TST',
        });
        const joined1 = await p1.waitForMessage((m) => m.type === 's2c_room_joined', 3000, 'P1 joined');
        const roomCode = joined1.roomCode;
        assert.equal(roomCode, 'PH4TST');
        assert.equal(joined1.slotIndex, 0);

        await p2.connect();
        p2.send({
            type: 'c2s_join_room',
            protocolVersion: PROTOCOL_VERSION,
            roomCode,
            sessionToken: p2.sessionToken,
            displayName: 'Bravo',
        });
        const joined2 = await p2.waitForMessage((m) => m.type === 's2c_room_joined', 3000, 'P2 joined');
        assert.equal(joined2.slotIndex, 1);

        await p3.connect();
        p3.send({
            type: 'c2s_join_room',
            protocolVersion: PROTOCOL_VERSION,
            roomCode,
            sessionToken: p3.sessionToken,
            displayName: 'Charlie',
        });
        const joined3 = await p3.waitForMessage((m) => m.type === 's2c_room_joined', 3000, 'P3 joined');
        assert.equal(joined3.slotIndex, 2);

        await p4.connect();
        p4.send({
            type: 'c2s_join_room',
            protocolVersion: PROTOCOL_VERSION,
            roomCode,
            sessionToken: p4.sessionToken,
            displayName: 'Delta',
        });
        const p4Err = await p4.waitForMessage((m) => m.type === 's2c_room_error', 3000, 'P4 ROOM_FULL');
        assert.equal(p4Err.code, 'ROOM_FULL');
        p4.close();
        console.log('  [PASS] 3-player room cap verified (4th rejected with ROOM_FULL)');

        // Duplicate connection kick (reconnect with same playerId -> 4001)
        const p2AckIdx = p2.markIndex();
        p2.sendState({ x: -2.2, y: 2.28, z: 13.2, advanceTimeMs: 200 });
        await p2.waitForMessageSince(p2AckIdx, (m) => m.type === 's2c_room_snapshot' && m.lastAckSeq >= 1, 2000);

        const p2Dup = new TestWsClient('BravoDup', proc1.baseWs, p2.sessionToken);
        activeClients.push(p2Dup);
        await p2Dup.connect();
        const p2ClosePromise = p2.waitForClose(3000);
        const p2KickMsgPromise = p2.waitForMessage((m) => m.type === 's2c_kicked_duplicate', 3000);
        p2Dup.send({
            type: 'c2s_join_room',
            protocolVersion: PROTOCOL_VERSION,
            roomCode,
            sessionToken: `tok-dup-${randomUUID().slice(0, 6)}`,
            playerId: p2.playerId,
            displayName: 'Bravo',
        });
        const [joined2Dup, p2Close, p2KickMsg] = await Promise.all([
            p2Dup.waitForMessage((m) => m.type === 's2c_room_joined', 3000, 'P2Dup joined'),
            p2ClosePromise,
            p2KickMsgPromise,
        ]);
        assert.equal(p2KickMsg.type, 's2c_kicked_duplicate');
        assert.equal(p2Close.code, 4001);
        assert.equal(joined2Dup.playerId, p2.playerId);
        assert.equal(joined2Dup.slotIndex, 1);
        p2 = p2Dup;
        console.log('  [PASS] Duplicate connection kick verified (WS code 4001 + playerId handoff)');

        // Anti-cheat clamp (out-of-bounds radius + underground/sky + speed teleport)
        const p3Idx1 = p3.markIndex();
        p3.sendState({ x: 500, y: -200, z: 500, advanceTimeMs: 500 });
        const p3Clamp1 = await p3.waitForMessageSince(
            p3Idx1,
            (m) => m.type === 's2c_room_snapshot' && m.lastAckSeq >= 1,
            2500,
            'P3 OOB clamp'
        );
        const r1 = Math.hypot(p3Clamp1.localState.position.x, p3Clamp1.localState.position.z);
        assert.ok(Math.abs(r1 - 108.5) < 0.05, `Expected radius clamped to 108.5, got ${r1}`);

        const p3Idx2 = p3.markIndex();
        p3.sendState({
            x: p3Clamp1.localState.position.x - 90,
            y: 999,
            z: p3Clamp1.localState.position.z,
            advanceTimeMs: 100,
        });
        const p3Clamp2 = await p3.waitForMessageSince(
            p3Idx2,
            (m) => m.type === 's2c_room_snapshot' && m.lastAckSeq >= 2,
            2500,
            'P3 speed+sky clamp'
        );
        const speedStep = Math.hypot(
            p3Clamp2.localState.position.x - p3Clamp1.localState.position.x,
            p3Clamp2.localState.position.z - p3Clamp1.localState.position.z
        );
        assert.ok(speedStep < 25, `Expected speed teleport clamped (<25m), moved ${speedStep.toFixed(2)}m`);
        const safeP3 = findSafeParkSpot(p3);
        await p3.movePlayerTo(safeP3.x, safeP3.z, 2.3);
        console.log(
            `  [PASS] Anti-cheat clamps verified (radius=${r1.toFixed(2)}m, teleportStep=${speedStep.toFixed(2)}m)`
        );

        // Wild monster AI, combat, death, respawn
        const h2 = p1.getMonster('wild-moss_hopper-2');
        assert.ok(h2, 'wild-moss_hopper-2 missing');
        const aggroIdx = p1.markIndex();
        await p1.movePlayerTo(h2.x, h2.z, h2.y);
        const teleEv = await p1.waitForMessageSince(
            aggroIdx,
            (m) =>
                m.type === 's2c_combat_event' &&
                m.event === 'monster_attack_telegraph' &&
                m.actorId === 'wild-moss_hopper-2',
            4500,
            'wild-moss_hopper-2 aggro telegraph'
        );
        assert.equal(teleEv.actorId, 'wild-moss_hopper-2');

        const combatIdx = p1.markIndex();
        for (let hit = 0; hit < 6; hit++) {
            const cur = p1.getMonster('wild-moss_hopper-2');
            if (!cur || cur.aiState === 'dead') break;
            await p1.movePlayerTo(cur.x - 1.0, cur.z, cur.y);
            p1.sendCombatAction({
                action: 'melee_attack',
                targetMonsterId: 'wild-moss_hopper-2',
                originX: cur.x - 1.0,
                originY: cur.y,
                originZ: cur.z,
                dirX: 1,
                dirZ: 0,
            });
            await sleep(140);
        }
        const deadEv = await p1.waitForMessageSince(
            combatIdx,
            (m) =>
                m.type === 's2c_combat_event' &&
                m.event === 'monster_dead' &&
                m.targetId === 'wild-moss_hopper-2',
            3500,
            'wild-moss_hopper-2 dead'
        );
        assert.equal(deadEv.remainingHp, 0);

        const respawnSnap = await p1.waitForMessageSince(
            combatIdx,
            (m) => {
                if (m.type !== 's2c_room_snapshot') return false;
                const m2 = m.monsters?.find((x) => x.id === 'wild-moss_hopper-2');
                return m2 && m2.aiState === 'patrol' && m2.hp === m2.maxHp;
            },
            3500,
            'wild-moss_hopper-2 respawn'
        );
        assert.equal(respawnSnap.monsters.find((x) => x.id === 'wild-moss_hopper-2').hp, 110);
        console.log('  [PASS] Wild monster AI aggro, combat kill & respawn verified');

        // Concurrent capture race lock
        const h1Init = p1.getMonster('wild-moss_hopper-1');
        assert.ok(h1Init, 'wild-moss_hopper-1 missing');
        for (let i = 0; i < 4; i++) {
            const cur = p1.getMonster('wild-moss_hopper-1');
            await p1.movePlayerTo(cur.x - 1.0, cur.z, cur.y);
            p1.sendCombatAction({
                action: 'melee_attack',
                targetMonsterId: 'wild-moss_hopper-1',
                originX: cur.x - 1.0,
                originY: cur.y,
                originZ: cur.z,
                dirX: 1,
                dirZ: 0,
            });
            await sleep(150);
        }
        const h1WeakSnap = await p1.waitForMessageSince(
            Math.max(0, p1.markIndex() - 5),
            (m) =>
                m.type === 's2c_room_snapshot' &&
                (m.monsters?.find((x) => x.id === 'wild-moss_hopper-1')?.hp ?? 110) <= 20,
            2500,
            'wild-moss_hopper-1 weakened'
        );
        const h1Weak = h1WeakSnap.monsters.find((x) => x.id === 'wild-moss_hopper-1');
        await Promise.all([
            p1.movePlayerTo(h1Weak.x - 1.0, h1Weak.z, h1Weak.y),
            p2.movePlayerTo(h1Weak.x + 1.0, h1Weak.z, h1Weak.y),
        ]);

        const raceIdx1 = p1.markIndex();
        const raceIdx2 = p2.markIndex();
        const h1AtThrow = p1.getMonster('wild-moss_hopper-1');
        await Promise.all([
            Promise.resolve().then(() =>
                p1.sendCombatAction({
                    action: 'throw_capture',
                    targetMonsterId: 'wild-moss_hopper-1',
                    originX: h1AtThrow.x - 1.0,
                    originY: h1AtThrow.y,
                    originZ: h1AtThrow.z,
                    dirX: 1,
                    dirZ: 0,
                })
            ),
            Promise.resolve().then(() =>
                p2.sendCombatAction({
                    action: 'throw_capture',
                    targetMonsterId: 'wild-moss_hopper-1',
                    originX: h1AtThrow.x + 1.0,
                    originY: h1AtThrow.y,
                    originZ: h1AtThrow.z,
                    dirX: -1,
                    dirZ: 0,
                })
            ),
        ]);

        const throwEv = await p1.waitForMessageSince(
            raceIdx1,
            (m) =>
                m.type === 's2c_combat_event' &&
                m.event === 'capture_throw' &&
                m.targetId === 'wild-moss_hopper-1',
            3000,
            'race capture_throw'
        );
        const lockLoser = throwEv.actorId === p1.playerId ? p2 : p1;
        const lockWinner = throwEv.actorId === p1.playerId ? p1 : p2;
        const loserIdx = throwEv.actorId === p1.playerId ? raceIdx2 : raceIdx1;
        const winnerIdx = throwEv.actorId === p1.playerId ? raceIdx1 : raceIdx2;

        const loserEv = await lockLoser.waitForMessageSince(
            loserIdx,
            (m) =>
                m.type === 's2c_combat_event' &&
                m.event === 'capture_result' &&
                m.actorId === lockLoser.playerId,
            3000,
            'race loser rejection'
        );
        assert.equal(loserEv.captureSuccess, false);
        assert.equal(loserEv.reason, 'CAPTURE_LOCKED');

        await lockWinner.waitForMessageSince(
            winnerIdx,
            (m) =>
                m.type === 's2c_combat_event' &&
                m.event === 'capture_result' &&
                m.actorId === lockWinner.playerId &&
                m.reason !== 'CAPTURE_LOCKED',
            3000,
            'race winner resolve'
        );
        const safePark = findSafeParkSpot(p2);
        await p2.movePlayerTo(safePark.x, safePark.z, 2.3);
        console.log(
            `  [PASS] Concurrent capture race lock verified (winner=${lockWinner.playerId}, loser reason=${loserEv.reason})`
        );

        summary.phase2_3Regressions = {
            roomCode,
            fourthPlayerError: p4Err.code,
            duplicateKickCode: p2Close.code,
            clampedRadius: Number(r1.toFixed(3)),
            captureLockRejection: loserEv.reason,
        };

        // --------------------------------------------------------------------
        // (b) Resource Harvesting + Workbench Pre-Check
        // --------------------------------------------------------------------
        console.log('\n--- (b) Resource Harvesting, 2x Tool Bonus & Node Respawn ---');
        // Verify WORKBENCH_REQUIRED before any workbench is placed
        const wbRejectIdx = p1.markIndex();
        p1.sendSurvivalAction({
            action: 'craft_item',
            craftRecipeId: 'aether_blade',
        });
        const wbRejectEv = await p1.waitForMessageSince(
            wbRejectIdx,
            (m) => m.type === 's2c_survival_event' && m.event === 'action_rejected',
            2500,
            'WORKBENCH_REQUIRED rejection'
        );
        assert.equal(wbRejectEv.reason, 'WORKBENCH_REQUIRED');
        console.log('  [PASS] Crafting aether_blade without workbench rejected with WORKBENCH_REQUIRED');

        // Harvest wood with hands (25 dmg/hit), deplete, wait >1200ms for respawn
        const woodBeforeHands = p1.latestSnapshot.sharedResources.wood;
        const wood1Res = await harvestNodeUntilDepleted(p1, 'res-wood-1');
        assert.equal(wood1Res.hitEvents[0].amount, 25, 'Hands should deal 25 harvest damage per hit');
        assert.equal(wood1Res.depletedEvt.sharedResources.wood, woodBeforeHands + 3);

        const respawnNodeIdx = p1.markIndex();
        const respawnNodeEv = await p1.waitForMessageSince(
            respawnNodeIdx,
            (m) =>
                m.type === 's2c_survival_event' &&
                m.event === 'node_respawned' &&
                m.targetId === 'res-wood-1',
            RESOURCE_RESPAWN_MS + 2500,
            'res-wood-1 node_respawned'
        );
        assert.equal(respawnNodeEv.targetId, 'res-wood-1');
        const snapAfterNodeRespawn = await p1.waitForMessageSince(
            respawnNodeIdx,
            (m) =>
                m.type === 's2c_room_snapshot' &&
                m.resourceNodes?.find((n) => n.id === 'res-wood-1')?.depleted === false,
            2000,
            'res-wood-1 depleted === false'
        );
        assert.equal(snapAfterNodeRespawn.resourceNodes.find((n) => n.id === 'res-wood-1').hp, 100);
        console.log('  [PASS] Wood node harvested with hands (25 dmg/hit), depleted (+3 wood), and respawned (>1200ms)');

        // Harvest stone & berry with hands
        const stoneBefore = p1.latestSnapshot.sharedResources.stone;
        const stone1Res = await harvestNodeUntilDepleted(p1, 'res-stone-1');
        assert.equal(stone1Res.depletedEvt.sharedResources.stone, stoneBefore + 3);

        const berryBefore = p1.latestSnapshot.sharedResources.berry;
        const berry1Res = await harvestNodeUntilDepleted(p1, 'res-berry-1');
        assert.equal(berry1Res.depletedEvt.sharedResources.berry, berryBefore + 3);

        // Craft wood_axe (no workbench needed) & verify 2x wood harvest damage (50 vs 25) + bonus yield
        const craftAxeIdx = p1.markIndex();
        p1.sendSurvivalAction({ action: 'craft_item', craftRecipeId: 'wood_axe' });
        const craftAxeEv = await p1.waitForMessageSince(
            craftAxeIdx,
            (m) =>
                m.type === 's2c_survival_event' &&
                m.event === 'item_crafted' &&
                m.recipeId === 'wood_axe',
            2500,
            'wood_axe crafted'
        );
        assert.equal(craftAxeEv.toolId, 'wood_axe');
        await p1.waitForNextMessage((m) => m.type === 's2c_room_snapshot', 1500);
        assert.equal(p1.getLocalPlayerState().equippedTool, 'wood_axe');

        const wood2Res = await harvestNodeUntilDepleted(p1, 'res-wood-2');
        assert.equal(
            wood2Res.hitEvents[0].amount,
            50,
            'wood_axe should deal 2x (50 vs 25) harvest damage on wood'
        );
        assert.equal(wood2Res.depletedEvt.amount, 4, 'wood_axe should yield 4 (3+1) wood');
        console.log('  [PASS] wood_axe 2x harvest bonus verified (50 dmg/hit vs 25, yield 4 wood)');

        // Craft stone_pickaxe & verify 2x stone/ore harvest bonus + harvest ore nodes
        const craftPickIdx = p1.markIndex();
        p1.sendSurvivalAction({ action: 'craft_item', craftRecipeId: 'stone_pickaxe' });
        await p1.waitForMessageSince(
            craftPickIdx,
            (m) =>
                m.type === 's2c_survival_event' &&
                m.event === 'item_crafted' &&
                m.recipeId === 'stone_pickaxe',
            2500,
            'stone_pickaxe crafted'
        );
        await p1.waitForNextMessage((m) => m.type === 's2c_room_snapshot', 1500);
        assert.equal(p1.getLocalPlayerState().equippedTool, 'stone_pickaxe');

        const stone2Res = await harvestNodeUntilDepleted(p1, 'res-stone-2');
        assert.equal(stone2Res.hitEvents[0].amount, 50, 'stone_pickaxe should deal 2x (50) on stone');

        const oreBefore = stone2Res.depletedEvt.sharedResources.ore;
        const shardBefore = stone2Res.depletedEvt.sharedResources.aether_shard;
        const ore1Res = await harvestNodeUntilDepleted(p1, 'res-ore-1');
        assert.equal(ore1Res.hitEvents[0].amount, 50, 'stone_pickaxe should deal 2x (50) on ore');
        const ore2Res = await harvestNodeUntilDepleted(p1, 'res-ore-2');
        assert.equal(ore2Res.depletedEvt.sharedResources.ore, oreBefore + 4);
        assert.equal(ore2Res.depletedEvt.sharedResources.aether_shard, shardBefore + 4);

        // Gather extra wood/stone so all crafting + 7 modular structures have ample materials
        for (const extraNode of ['res-wood-3', 'res-wood-4', 'res-wood-5', 'res-wood-6', 'res-wood-7', 'res-wood-8']) {
            await harvestNodeUntilDepleted(p1, extraNode);
        }
        await harvestNodeUntilDepleted(p1, 'res-stone-3');
        await harvestNodeUntilDepleted(p1, 'res-stone-4');

        summary.harvesting = {
            handsWoodDmg: wood1Res.hitEvents[0].amount,
            woodAxeDmg: wood2Res.hitEvents[0].amount,
            stonePickaxeDmg: stone2Res.hitEvents[0].amount,
            respawnedNodeId: respawnNodeEv.targetId,
            sharedResourcesAfterHarvest: p1.latestSnapshot.sharedResources,
        };

        // --------------------------------------------------------------------
        // (c) Crafting & Tools
        // --------------------------------------------------------------------
        console.log('\n--- (c) Crafting All 5 Recipes & Tool Combat Bonuses ---');
        await p1.movePlayerTo(2, 12, 2.28);
        const placeWbIdx = p1.markIndex();
        p1.sendSurvivalAction({
            action: 'place_structure',
            structureRecipeId: 'workbench',
            gridX: 1,
            gridZ: 6,
            rotationYawDeg: 0,
        });
        const placedWbEv = await p1.waitForMessageSince(
            placeWbIdx,
            (m) =>
                m.type === 's2c_survival_event' &&
                m.event === 'structure_placed' &&
                m.recipeId === 'workbench',
            2500,
            'workbench placed'
        );
        assert.equal(placedWbEv.structure.recipeId, 'workbench');

        // Craft aether_blade
        const craftBladeIdx = p1.markIndex();
        p1.sendSurvivalAction({ action: 'craft_item', craftRecipeId: 'aether_blade' });
        const bladeEv = await p1.waitForMessageSince(
            craftBladeIdx,
            (m) =>
                m.type === 's2c_survival_event' &&
                m.event === 'item_crafted' &&
                m.recipeId === 'aether_blade',
            2500,
            'aether_blade crafted'
        );
        assert.equal(bladeEv.toolId, 'aether_blade');

        // Craft capture_sphere_pack (+4 spheres)
        // Use whichever player has <= 20 spheres so +4 does not clamp at MAX_CAPTURE_SPHERES (24)
        const sphereCrafter = p1.getLocalPlayerState().captureSpheres <= 20 ? p1 : p2;
        const spheresBeforeCraft = sphereCrafter.getLocalPlayerState().captureSpheres;
        const craftSphereIdx = sphereCrafter.markIndex();
        sphereCrafter.sendSurvivalAction({ action: 'craft_item', craftRecipeId: 'capture_sphere_pack' });
        const sphereCraftEv = await sphereCrafter.waitForMessageSince(
            craftSphereIdx,
            (m) =>
                m.type === 's2c_survival_event' &&
                m.event === 'item_crafted' &&
                m.recipeId === 'capture_sphere_pack',
            2500,
            'capture_sphere_pack crafted'
        );
        assert.equal(sphereCraftEv.amount, 4);
        await sphereCrafter.waitForNextMessage((m) => m.type === 's2c_room_snapshot', 1500);
        assert.equal(
            sphereCrafter.getLocalPlayerState().captureSpheres,
            spheresBeforeCraft + 4,
            'capture_sphere_pack must grant +4 capture spheres'
        );

        // Craft cooked_berry_batch (+2 cooked_berry)
        const cookedBeforeCraft = p1.latestSnapshot.sharedResources.cooked_berry;
        const craftCookedIdx = p1.markIndex();
        p1.sendSurvivalAction({ action: 'craft_item', craftRecipeId: 'cooked_berry_batch' });
        const cookedCraftEv = await p1.waitForMessageSince(
            craftCookedIdx,
            (m) =>
                m.type === 's2c_survival_event' &&
                m.event === 'item_crafted' &&
                m.recipeId === 'cooked_berry_batch',
            2500,
            'cooked_berry_batch crafted'
        );
        assert.equal(cookedCraftEv.amount, 2);
        assert.equal(cookedCraftEv.sharedResources.cooked_berry, cookedBeforeCraft + 2);

        const snapTools = await p1.waitForNextMessage((m) => m.type === 's2c_room_snapshot', 1500);
        for (const t of ['hands', 'wood_axe', 'stone_pickaxe', 'aether_blade']) {
            assert.ok(
                snapTools.localState.unlockedTools.includes(t),
                `Expected unlockedTools to include '${t}'`
            );
        }

        // Verify equip_tool switches PlayerSyncState.equippedTool & combat damage bonuses on Shale Golem (180 HP)
        let golem = p1.getMonster('wild-shale_golem-1');
        assert.ok(golem, 'wild-shale_golem-1 missing');
        await p1.movePlayerTo(golem.x - 1.2, golem.z, golem.y);

        const toolCombatMeasured = {};
        for (const [toolId, expectedMelee] of [
            ['wood_axe', 30],
            ['stone_pickaxe', 32],
            ['aether_blade', 40],
        ]) {
            const eqIdx = p1.markIndex();
            p1.sendSurvivalAction({ action: 'equip_tool', toolId });
            await p1.waitForMessageSince(
                eqIdx,
                (m) =>
                    m.type === 's2c_survival_event' &&
                    m.event === 'tool_equipped' &&
                    m.toolId === toolId,
                2500,
                `equip ${toolId}`
            );
            await p1.waitForMessageSince(
                eqIdx,
                (m) => m.type === 's2c_room_snapshot' && m.localState?.equippedTool === toolId,
                2000,
                `snapshot equippedTool === ${toolId}`
            );

            golem = p1.getMonster('wild-shale_golem-1');
            await p1.movePlayerTo(golem.x - 1.2, golem.z, golem.y);
            const atkIdx = p1.markIndex();
            p1.sendCombatAction({
                action: 'melee_attack',
                targetMonsterId: 'wild-shale_golem-1',
                originX: golem.x - 1.2,
                originY: golem.y,
                originZ: golem.z,
                dirX: 1,
                dirZ: 0,
            });
            const hitEv = await p1.waitForMessageSince(
                atkIdx,
                (m) =>
                    m.type === 's2c_combat_event' &&
                    m.event === 'melee_hit' &&
                    m.targetId === 'wild-shale_golem-1',
                2500,
                `melee_hit with ${toolId}`
            );
            assert.equal(hitEv.damage, expectedMelee, `Expected ${toolId} melee damage ${expectedMelee}, got ${hitEv.damage}`);
            toolCombatMeasured[toolId] = { melee: hitEv.damage };
            await sleep(160);
        }

        // Also test aether_blade ranged bonus (18 + 8 = 26)
        golem = p1.getMonster('wild-shale_golem-1');
        const rngIdx = p1.markIndex();
        p1.sendCombatAction({
            action: 'ranged_attack',
            targetMonsterId: 'wild-shale_golem-1',
            originX: golem.x - 1.2,
            originY: golem.y,
            originZ: golem.z,
            dirX: 1,
            dirZ: 0,
        });
        const rngEv = await p1.waitForMessageSince(
            rngIdx,
            (m) =>
                m.type === 's2c_combat_event' &&
                m.event === 'ranged_hit' &&
                m.targetId === 'wild-shale_golem-1',
            2500,
            'aether_blade ranged_hit'
        );
        assert.equal(rngEv.damage, 26, `Expected aether_blade ranged damage 26, got ${rngEv.damage}`);
        toolCombatMeasured.aether_blade.ranged = rngEv.damage;

        const safeAfterCombat = findSafeParkSpot(p1);
        await p1.movePlayerTo(safeAfterCombat.x, safeAfterCombat.z, 2.5);

        console.log(
            `  [PASS] All 5 craft recipes verified + tool combat bonuses verified: ${JSON.stringify(toolCombatMeasured)}`
        );

        summary.craftingAndTools = {
            workbenchRejection: wbRejectEv.reason,
            recipesCrafted: ALL_CRAFT_RECIPES,
            captureSpherePackDelta: 4,
            cookedBerryBatchDelta: 2,
            toolCombatMeasured,
        };

        // --------------------------------------------------------------------
        // (d) Survival Vitals (Hunger Decay, eat_food, straw_bed rest_bed)
        // --------------------------------------------------------------------
        console.log('\n--- (d) Survival Vitals (Hunger Decay, eat_food, rest_bed) ---');
        let snapH0 = await p3.waitForNextMessage((m) => m.type === 's2c_room_snapshot', 1500);
        if (snapH0.localState.hunger < 15) {
            p3.sendSurvivalAction({ action: 'eat_food', foodKind: 'berry' });
            snapH0 = await p3.waitForNextMessage(
                (m) => m.type === 's2c_room_snapshot' && m.localState.hunger >= 15,
                2000
            );
        }
        const hunger0 = snapH0.localState.hunger;
        await sleep(1800);
        const snapH1 = await p3.waitForNextMessage((m) => m.type === 's2c_room_snapshot', 1500);
        const hunger1 = snapH1.localState.hunger;
        assert.ok(
            hunger1 < hunger0,
            `Expected hunger decay over 1.8s (HUNGER_DECAY_PER_SEC=2.5), got ${hunger0} -> ${hunger1}`
        );
        console.log(`  [PASS] Hunger decay observed on P3: ${hunger0} -> ${hunger1}`);

        // Take 1 hit on P2 then immediately eat_food ('berry') before passive regen ticks HP back to 100
        if (p2.getLocalPlayerState().hp > 94) {
            await takeOneMonsterHit(p2, [p1, p3], 'wild-moss_hopper-2');
        }

        // eat_food ('berry' on P2)
        const p2StateBeforeEat = p2.getLocalPlayerState();
        const berryCountBefore = p2.latestSnapshot.sharedResources.berry;
        const eatBerryIdx = p2.markIndex();
        p2.sendSurvivalAction({ action: 'eat_food', foodKind: 'berry' });
        const eatBerryEv = await p2.waitForMessageSince(
            eatBerryIdx,
            (m) =>
                m.type === 's2c_survival_event' &&
                m.event === 'food_eaten' &&
                m.actorId === p2.playerId &&
                m.resourceKind === 'berry',
            2500,
            'P2 eat berry'
        );
        assert.equal(eatBerryEv.sharedResources.berry, berryCountBefore - 1);
        const p2SnapAfterEat = await p2.waitForNextMessage((m) => m.type === 's2c_room_snapshot', 1500);
        assert.equal(
            p2SnapAfterEat.localState.hp,
            Math.min(100, p2StateBeforeEat.hp + 6),
            'Eating berry should restore +6 HP'
        );
        assert.ok(
            p2SnapAfterEat.localState.hunger > p2StateBeforeEat.hunger || p2StateBeforeEat.hunger >= 99,
            'Eating berry should restore hunger'
        );

        // Take 1 hit on P3 then immediately eat_food ('cooked_berry')
        if (p3.getLocalPlayerState().hp > 94) {
            await takeOneMonsterHit(p3, [p1, p2], 'wild-moss_hopper-2');
        }
        const p3StateBeforeEat = p3.getLocalPlayerState();
        const cookedCountBefore = p3.latestSnapshot.sharedResources.cooked_berry;
        const eatCookedIdx = p3.markIndex();
        p3.sendSurvivalAction({ action: 'eat_food', foodKind: 'cooked_berry' });
        const eatCookedEv = await p3.waitForMessageSince(
            eatCookedIdx,
            (m) =>
                m.type === 's2c_survival_event' &&
                m.event === 'food_eaten' &&
                m.actorId === p3.playerId &&
                m.resourceKind === 'cooked_berry',
            2500,
            'P3 eat cooked_berry'
        );
        assert.equal(eatCookedEv.sharedResources.cooked_berry, cookedCountBefore - 1);
        const p3SnapAfterEat = await p3.waitForNextMessage((m) => m.type === 's2c_room_snapshot', 1500);
        assert.equal(
            p3SnapAfterEat.localState.hp,
            Math.min(100, p3StateBeforeEat.hp + 20),
            'Eating cooked_berry should restore +20 HP'
        );
        assert.ok(
            p3SnapAfterEat.localState.hunger > p3StateBeforeEat.hunger || p3StateBeforeEat.hunger >= 99,
            'Eating cooked_berry should restore hunger'
        );
        console.log(
            `  [PASS] eat_food verified: berry (HP ${p2StateBeforeEat.hp}->${p2SnapAfterEat.localState.hp}, hunger ${p2StateBeforeEat.hunger}->${p2SnapAfterEat.localState.hunger}) & cooked_berry (HP ${p3StateBeforeEat.hp}->${p3SnapAfterEat.localState.hp}, hunger ${p3StateBeforeEat.hunger}->${p3SnapAfterEat.localState.hunger})`
        );

        // Place straw_bed, take hit on P1, walk near straw_bed, call rest_bed
        await p1.movePlayerTo(4, 12, 2.28);
        const bedPlaceIdx = p1.markIndex();
        p1.sendSurvivalAction({
            action: 'place_structure',
            structureRecipeId: 'straw_bed',
            gridX: 2,
            gridZ: 6,
            rotationYawDeg: 0,
        });
        const bedEv = await p1.waitForMessageSince(
            bedPlaceIdx,
            (m) =>
                m.type === 's2c_survival_event' &&
                m.event === 'structure_placed' &&
                m.recipeId === 'straw_bed',
            2500,
            'straw_bed placed'
        );
        if (p1.getLocalPlayerState().hp >= 95) {
            await takeOneMonsterHit(p1, [p2, p3], 'wild-moss_hopper-2');
        }
        const p1HpDamaged = p1.getLocalPlayerState().hp;
        assert.ok(p1HpDamaged < 100, `Expected P1 HP < 100 after monster hit, got ${p1HpDamaged}`);

        await p1.movePlayerTo(bedEv.structure.x, bedEv.structure.z, bedEv.structure.y);
        // Send slightly reduced stamina via player_state to verify stamina === 100 restoration too
        p1.sendState({
            x: bedEv.structure.x,
            y: bedEv.structure.y,
            z: bedEv.structure.z,
            stamina: 45,
            advanceTimeMs: 300,
        });
        await p1.waitForNextMessage((m) => m.type === 's2c_room_snapshot', 1500);

        const restIdx = p1.markIndex();
        p1.sendSurvivalAction({ action: 'rest_bed', structureId: bedEv.structure.id });
        await p1.waitForMessageSince(
            restIdx,
            (m) =>
                m.type === 's2c_survival_event' &&
                m.event === 'bed_rested' &&
                m.actorId === p1.playerId,
            2500,
            'bed_rested'
        );
        const snapAfterRest = await p1.waitForNextMessage((m) => m.type === 's2c_room_snapshot', 1500);
        assert.equal(snapAfterRest.localState.hp, 100, 'Expected HP === 100 after rest_bed');
        assert.equal(snapAfterRest.localState.stamina, 100, 'Expected stamina === 100 after rest_bed');
        console.log(
            `  [PASS] rest_bed verified: HP ${p1HpDamaged}->${snapAfterRest.localState.hp}, stamina 45->${snapAfterRest.localState.stamina} (note: server/index.mjs:3499-3500 restores HP+stamina; hunger=${snapAfterRest.localState.hunger} is restored by eat_food)`
        );

        summary.survivalVitals = {
            hungerDecayObserved: [hunger0, hunger1],
            berryHpGain: p2SnapAfterEat.localState.hp - p2StateBeforeEat.hp,
            cookedBerryHpGain: p3SnapAfterEat.localState.hp - p3StateBeforeEat.hp,
            restBedHp: snapAfterRest.localState.hp,
            restBedStamina: snapAfterRest.localState.stamina,
            restBedHungerNote: snapAfterRest.localState.hunger,
        };

        // --------------------------------------------------------------------
        // (e) Modular Base Building (All 7 Recipes, Concurrency Race & Demolish Refund)
        // --------------------------------------------------------------------
        console.log('\n--- (e) Modular Base Building, Promise.all Race & Demolish Refund ---');
        await p1.movePlayerTo(0, 12, 2.28);
        const remainingPlacements = [
            { recipeId: 'wood_foundation', gridX: 0, gridZ: 5, layer: 0 },
            { recipeId: 'wood_wall', gridX: 0, gridZ: 5, layer: 1 },
            { recipeId: 'wood_roof', gridX: 0, gridZ: 5, layer: 2 },
            { recipeId: 'wood_door', gridX: 1, gridZ: 5, layer: 1 },
            { recipeId: 'storage_chest', gridX: 2, gridZ: 5, layer: 1 },
        ];
        for (const item of remainingPlacements) {
            const idx = p1.markIndex();
            p1.sendSurvivalAction({
                action: 'place_structure',
                structureRecipeId: item.recipeId,
                gridX: item.gridX,
                gridZ: item.gridZ,
                layer: item.layer,
                rotationYawDeg: 90,
            });
            const ev = await p1.waitForMessageSince(
                idx,
                (m) =>
                    m.type === 's2c_survival_event' &&
                    m.event === 'structure_placed' &&
                    m.recipeId === item.recipeId,
                2500,
                `place ${item.recipeId}`
            );
            assert.equal(ev.structure.layer, item.layer);
        }

        const [sP1, sP2, sP3] = await Promise.all([
            p1.waitForNextMessage((m) => m.type === 's2c_room_snapshot', 1500),
            p2.waitForNextMessage((m) => m.type === 's2c_room_snapshot', 1500),
            p3.waitForNextMessage((m) => m.type === 's2c_room_snapshot', 1500),
        ]);
        for (const rId of ALL_STRUCTURE_RECIPES) {
            assert.ok(sP1.structures.some((s) => s.recipeId === rId), `P1 missing ${rId}`);
            assert.ok(sP2.structures.some((s) => s.recipeId === rId), `P2 missing ${rId}`);
            assert.ok(sP3.structures.some((s) => s.recipeId === rId), `P3 missing ${rId}`);
        }
        assert.equal(sP1.structures.length, 7);
        console.log('  [PASS] All 7 MODULAR_STRUCTURE_RECIPES placed & synchronized across P1/P2/P3');

        // Concurrent Promise.all placement race at (-1, 5, 1)
        await Promise.all([p1.movePlayerTo(-3, 15, 2.3), p2.movePlayerTo(-3, 15, 2.3)]);
        const raceBuildIdx1 = p1.markIndex();
        const raceBuildIdx2 = p2.markIndex();
        await Promise.all([
            Promise.resolve().then(() =>
                p1.sendSurvivalAction({
                    action: 'place_structure',
                    structureRecipeId: 'wood_wall',
                    gridX: -1,
                    gridZ: 5,
                    layer: 1,
                })
            ),
            Promise.resolve().then(() =>
                p2.sendSurvivalAction({
                    action: 'place_structure',
                    structureRecipeId: 'wood_wall',
                    gridX: -1,
                    gridZ: 5,
                    layer: 1,
                })
            ),
        ]);

        const [evBuild1, evBuild2] = await Promise.all([
            p1.waitForMessageSince(
                raceBuildIdx1,
                (m) =>
                    m.type === 's2c_survival_event' &&
                    m.actorId === p1.playerId &&
                    (m.event === 'structure_placed' || m.event === 'action_rejected'),
                2500,
                'P1 concurrent build result'
            ),
            p2.waitForMessageSince(
                raceBuildIdx2,
                (m) =>
                    m.type === 's2c_survival_event' &&
                    m.actorId === p2.playerId &&
                    (m.event === 'structure_placed' || m.event === 'action_rejected'),
                2500,
                'P2 concurrent build result'
            ),
        ]);
        const buildOutcomes = [evBuild1, evBuild2];
        const buildWinnerEv = buildOutcomes.find((e) => e.event === 'structure_placed' && e.structure?.gridX === -1);
        const buildLoserEv = buildOutcomes.find((e) => e.event === 'action_rejected');
        assert.ok(buildWinnerEv, 'Expected strictly one concurrent build_place winner');
        assert.ok(buildLoserEv, 'Expected strictly one concurrent build_place rejection');
        assert.equal(buildLoserEv.reason, 'CELL_OCCUPIED');
        console.log('  [PASS] Concurrent Promise.all structure placement race resolved (1 placed, 1 CELL_OCCUPIED)');

        // Wait for fresh snapshot so resBeforeDemo includes the concurrent winner's deduction
        const snapBeforeDemo = await p1.waitForNextMessage((m) => m.type === 's2c_room_snapshot', 1500);
        const resBeforeDemo = { ...snapBeforeDemo.sharedResources };
        const demoIdx = p1.markIndex();
        p1.sendSurvivalAction({
            action: 'demolish_structure',
            structureId: placedWbEv.structure.id,
        });
        const demoEv = await p1.waitForMessageSince(
            demoIdx,
            (m) =>
                m.type === 's2c_survival_event' &&
                m.event === 'structure_demolished' &&
                m.targetId === placedWbEv.structure.id,
            2500,
            'workbench demolished'
        );
        assert.equal(demoEv.sharedResources.wood, resBeforeDemo.wood + Math.floor(4 * 0.5));
        assert.equal(demoEv.sharedResources.stone, resBeforeDemo.stone + Math.floor(2 * 0.5));

        const snapAfterDemo = await p1.waitForNextMessage((m) => m.type === 's2c_room_snapshot', 1500);
        assert.ok(!snapAfterDemo.structures.some((s) => s.id === placedWbEv.structure.id));

        // Top up wood/stone if needed before rebuilding workbench (cost { wood: 4, stone: 2 })
        if (demoEv.sharedResources.wood < 4) {
            await harvestNodeUntilDepleted(p1, 'res-wood-1');
        }
        if (demoEv.sharedResources.stone < 2) {
            await harvestNodeUntilDepleted(p1, 'res-stone-1');
        }
        await p1.movePlayerTo(2, 12, 2.28);

        // Rebuild workbench on exact same cell
        const rebuildIdx = p1.markIndex();
        p1.sendSurvivalAction({
            action: 'place_structure',
            structureRecipeId: 'workbench',
            gridX: 1,
            gridZ: 6,
            layer: placedWbEv.structure.layer,
        });
        await p1.waitForMessageSince(
            rebuildIdx,
            (m) =>
                m.type === 's2c_survival_event' &&
                m.event === 'structure_placed' &&
                m.recipeId === 'workbench',
            2500,
            'workbench rebuilt on demolished cell'
        );
        console.log('  [PASS] demolish_structure refunded floor(cost*0.5) (+2 wood, +1 stone), removed structure & freed cell');

        summary.building = {
            placedRecipeCount: ALL_STRUCTURE_RECIPES.length,
            concurrentRaceRejection: buildLoserEv.reason,
            demolishRefundVerified: { wood: 2, stone: 1 },
        };

        // --------------------------------------------------------------------
        // (f) Monster Base Worker Automation
        // --------------------------------------------------------------------
        console.log('\n--- (f) Monster Base Worker Automation ---');
        // Capture until P1 has >=2, P2 has >=1, P3 has >=1 (at least 4 total across party)
        while (p1.latestSnapshot.capturedRoster.length < 2) {
            await captureMonsterForPlayer(p1, 'wild-moss_hopper-1');
        }
        while (p2.latestSnapshot.capturedRoster.length < 1) {
            await captureMonsterForPlayer(p2, 'wild-moss_hopper-2');
        }
        while (p3.latestSnapshot.capturedRoster.length < 1) {
            await captureMonsterForPlayer(p3, 'wild-aether_wisp-1');
        }

        const p1Cap1 = p1.latestSnapshot.capturedRoster[0];
        const p1Cap2 = p1.latestSnapshot.capturedRoster[1];
        const p2Cap1 = p2.latestSnapshot.capturedRoster[0];
        const p3Cap1 = p3.latestSnapshot.capturedRoster[0];

        // Summon p1Cap1 as active combat companion, then assign as base worker -> verify auto-recall
        const sumIdx = p1.markIndex();
        p1.sendCombatAction({ action: 'summon_companion', companionUid: p1Cap1.uid });
        await p1.waitForMessageSince(
            sumIdx,
            (m) =>
                m.type === 's2c_room_snapshot' &&
                (m.companions || []).some((c) => c.uid === p1Cap1.uid),
            2500,
            'companion summoned before assign_base_worker'
        );

        const assign1Idx = p1.markIndex();
        p1.sendSurvivalAction({ action: 'assign_base_worker', companionUid: p1Cap1.uid });
        const [autoRecallEv, assign1Ev] = await Promise.all([
            p1.waitForMessageSince(
                assign1Idx,
                (m) =>
                    m.type === 's2c_combat_event' &&
                    m.event === 'companion_recall' &&
                    m.targetId === p1Cap1.uid &&
                    m.reason === 'ASSIGNED_TO_BASE',
                2500,
                'auto companion_recall ASSIGNED_TO_BASE'
            ),
            p1.waitForMessageSince(
                assign1Idx,
                (m) =>
                    m.type === 's2c_survival_event' &&
                    m.event === 'worker_assigned' &&
                    m.targetId === p1Cap1.uid,
                2500,
                'worker_assigned #1'
            ),
        ]);
        assert.equal(autoRecallEv.reason, 'ASSIGNED_TO_BASE');
        assert.equal(assign1Ev.worker.uid, p1Cap1.uid);

        const snapAfterAssign1 = await p1.waitForNextMessage((m) => m.type === 's2c_room_snapshot', 1500);
        assert.equal(snapAfterAssign1.companions.length, 0);
        assert.equal(snapAfterAssign1.localState.activeCompanionId, null);
        assert.equal(snapAfterAssign1.baseWorkers.length, 1);
        console.log('  [PASS] assign_base_worker auto-recalled active combat companion (ASSIGNED_TO_BASE)');

        // Assign 2nd and 3rd workers, then verify 4th is rejected with MAX_BASE_WORKERS
        const assign2Idx = p1.markIndex();
        p1.sendSurvivalAction({ action: 'assign_base_worker', companionUid: p1Cap2.uid });
        await p1.waitForMessageSince(
            assign2Idx,
            (m) => m.type === 's2c_survival_event' && m.event === 'worker_assigned' && m.targetId === p1Cap2.uid,
            2500
        );

        const assign3Idx = p2.markIndex();
        p2.sendSurvivalAction({ action: 'assign_base_worker', companionUid: p2Cap1.uid });
        await p2.waitForMessageSince(
            assign3Idx,
            (m) => m.type === 's2c_survival_event' && m.event === 'worker_assigned' && m.targetId === p2Cap1.uid,
            2500
        );

        const assign4Idx = p3.markIndex();
        p3.sendSurvivalAction({ action: 'assign_base_worker', companionUid: p3Cap1.uid });
        const reject4Ev = await p3.waitForMessageSince(
            assign4Idx,
            (m) => m.type === 's2c_survival_event' && m.event === 'action_rejected',
            2500,
            '4th worker MAX_BASE_WORKERS rejection'
        );
        assert.equal(reject4Ev.reason, 'MAX_BASE_WORKERS');
        console.log(`  [PASS] Assigned ${MAX_BASE_WORKERS} workers & 4th rejected with MAX_BASE_WORKERS`);

        // Observe autonomous ticks (WORKER_TICK_SCALE=12) transitioning AI states & delivering resources
        const observedWorkerStates = new Set();
        const obsIdx = p1.markIndex();
        const deliveredEv = await p1.waitForMessageSince(
            obsIdx,
            (m) => {
                if (m.type === 's2c_room_snapshot') {
                    for (const w of m.baseWorkers || []) {
                        observedWorkerStates.add(w.aiState);
                    }
                }
                return m.type === 's2c_survival_event' && m.event === 'worker_delivered';
            },
            9000,
            'autonomous worker_delivered event'
        );
        assert.ok(deliveredEv.amount > 0, 'Expected worker_delivered amount > 0');
        assert.ok(observedWorkerStates.size >= 2, `Expected worker AI state transitions, saw [${Array.from(observedWorkerStates).join(', ')}]`);

        // Unassign 3rd worker (leaving 2 active workers for restart persistence test)
        const unassignIdx = p2.markIndex();
        p2.sendSurvivalAction({ action: 'unassign_base_worker', companionUid: p2Cap1.uid });
        const unassignEv = await p2.waitForMessageSince(
            unassignIdx,
            (m) =>
                m.type === 's2c_survival_event' &&
                m.event === 'worker_unassigned' &&
                m.targetId === p2Cap1.uid,
            2500,
            'worker_unassigned'
        );
        assert.equal(unassignEv.targetId, p2Cap1.uid);
        const snapAfterUnassign = await p1.waitForNextMessage(
            (m) => m.type === 's2c_room_snapshot' && (m.baseWorkers || []).length === 2,
            2000,
            'baseWorkers === 2 after unassign'
        );
        assert.equal(snapAfterUnassign.baseWorkers.length, 2);
        console.log(
            `  [PASS] Base workers transitioned [${Array.from(observedWorkerStates).join(', ')}], delivered +${deliveredEv.amount} ${deliveredEv.resourceKind}, and unassign_base_worker removed ${p2Cap1.uid}`
        );

        summary.baseWorkers = {
            autoRecallReason: autoRecallEv.reason,
            fourthWorkerRejection: reject4Ev.reason,
            observedAiStates: Array.from(observedWorkerStates),
            deliveredSample: {
                workerUid: deliveredEv.actorId,
                resourceKind: deliveredEv.resourceKind,
                amount: deliveredEv.amount,
            },
            remainingWorkerCountAfterUnassign: snapAfterUnassign.baseWorkers.length,
        };

        // --------------------------------------------------------------------
        // (g) Live Child-Process Flush, Kill, Restart & 100% State Recovery
        // --------------------------------------------------------------------
        console.log('\n--- (g) Live Server Flush, Restart & 100% State Recovery ---');
        const flushRes = await fetch(`${proc1.baseHttp}/api/persistence/flush`, { method: 'POST' });
        assert.equal(flushRes.status, 200, 'POST /api/persistence/flush failed');
        const flushJson = await flushRes.json();
        assert.equal(flushJson.ok, true);
        assert.ok(fs.existsSync(tempPersistenceFile), 'Expected temp persistence file to exist after flush');

        // Kill child process #1 cleanly & read exact flushed snapshot from disk
        for (const c of activeClients) c.close();
        await stopChildProcess(proc1.child);
        proc1 = null;

        const diskData = JSON.parse(fs.readFileSync(tempPersistenceFile, 'utf8'));
        const savedRoom = diskData.rooms?.[roomCode];
        assert.ok(savedRoom, `Saved room '${roomCode}' missing in flushed persistence file`);

        // Spawn fresh server child process #2 pointing to exact same persistence file
        const port2 = await getFreePort(HOST);
        proc2 = await spawnServerProcess(port2, tempPersistenceFile);
        assert.ok(proc2.health.persistedRooms >= 1, 'Restarted server must report persistedRooms >= 1');
        console.log(
            `  [INFO] Spawned restarted server #2 on ${proc2.baseHttp} (persistedRooms=${proc2.health.persistedRooms})`
        );

        const r1Client = new TestWsClient('AlphaRestored', proc2.baseWs, p1.sessionToken);
        const r2Client = new TestWsClient('BravoRestored', proc2.baseWs, p2.sessionToken);
        const r3Client = new TestWsClient('CharlieRestored', proc2.baseWs, p3.sessionToken);
        activeClients.push(r1Client, r2Client, r3Client);

        await Promise.all([r1Client.connect(), r2Client.connect(), r3Client.connect()]);
        const joinPairs = [
            { client: r1Client, orig: p1 },
            { client: r2Client, orig: p2 },
            { client: r3Client, orig: p3 },
        ];
        const joinedRestoredList = [];
        for (const { client, orig } of joinPairs) {
            client.send({
                type: 'c2s_join_room',
                protocolVersion: PROTOCOL_VERSION,
                roomCode,
                sessionToken: orig.sessionToken,
                playerId: orig.playerId,
                displayName: orig.name === 'BravoDup' ? 'Bravo' : orig.name,
                isReconnect: true,
            });
            const jr = await client.waitForMessage((m) => m.type === 's2c_room_joined', 3000, `${client.name} joined`);
            joinedRestoredList.push({ jr, origId: orig.playerId });
        }

        const primaryRestored = joinedRestoredList[0].jr;
        assert.deepEqual(
            primaryRestored.sharedResources,
            savedRoom.sharedResources,
            'Restored sharedResources mismatch'
        );
        assert.deepEqual(
            primaryRestored.structures.map((s) => ({
                id: s.id,
                recipeId: s.recipeId,
                gridX: s.gridX,
                gridZ: s.gridZ,
                layer: s.layer,
                rotationYawDeg: s.rotationYawDeg,
            })),
            savedRoom.structures.map((s) => ({
                id: s.id,
                recipeId: s.recipeId,
                gridX: s.gridX,
                gridZ: s.gridZ,
                layer: s.layer,
                rotationYawDeg: s.rotationYawDeg,
            })),
            'Restored placedStructures mismatch'
        );
        assert.deepEqual(
            primaryRestored.baseWorkers.map((w) => ({
                uid: w.uid,
                ownerPlayerId: w.ownerPlayerId,
                species: w.species,
            })),
            savedRoom.baseWorkers.map((w) => ({
                uid: w.uid,
                ownerPlayerId: w.ownerPlayerId,
                species: w.species,
            })),
            'Restored baseWorkers mismatch'
        );

        for (const { jr, origId } of joinedRestoredList) {
            assert.equal(jr.playerId, origId, 'Restored playerId mismatch');
            const savedPlayer = savedRoom.players.find((sp) => sp.playerId === origId);
            const liveRestoredPlayer = jr.players.find((rp) => rp.playerId === origId);
            assert.ok(savedPlayer && liveRestoredPlayer, `Missing saved/restored player ${origId}`);
            assert.equal(liveRestoredPlayer.hp, savedPlayer.hp, `Restored hp mismatch for ${origId}`);
            assert.ok(
                Math.abs(liveRestoredPlayer.hunger - savedPlayer.hunger) <= 1.0,
                `Restored hunger mismatch for ${origId}: ${liveRestoredPlayer.hunger} vs ${savedPlayer.hunger}`
            );
            assert.deepEqual(
                liveRestoredPlayer.unlockedTools,
                savedPlayer.unlockedTools,
                `Restored unlockedTools mismatch for ${origId}`
            );
            assert.equal(
                liveRestoredPlayer.equippedTool,
                savedPlayer.equippedTool,
                `Restored equippedTool mismatch for ${origId}`
            );
            assert.equal(
                liveRestoredPlayer.captureSpheres,
                savedPlayer.captureSpheres,
                `Restored captureSpheres mismatch for ${origId}`
            );
            assert.deepEqual(
                jr.capturedRoster.map((c) => c.uid),
                savedPlayer.capturedRoster.map((c) => c.uid),
                `Restored capturedRoster mismatch for ${origId}`
            );
        }

        console.log(
            `  [PASS] 100% restart state recovery verified across all 3 players (structures=${primaryRestored.structures.length}, workers=${primaryRestored.baseWorkers.length}, sharedResources=${JSON.stringify(primaryRestored.sharedResources)})`
        );

        summary.restartRecovery = {
            persistedRoomsOnBoot: proc2.health.persistedRooms,
            restoredStructures: primaryRestored.structures.length,
            restoredBaseWorkers: primaryRestored.baseWorkers.length,
            restoredSharedResources: primaryRestored.sharedResources,
            restoredPlayersCount: joinedRestoredList.length,
        };

        return summary;
    } finally {
        for (const c of activeClients) {
            try {
                c.close();
            } catch {
                // ignore
            }
        }
        await stopChildProcess(proc1?.child);
        await stopChildProcess(proc2?.child);
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
}

async function main() {
    const startedAt = Date.now();
    const assetAudit = runAssetAudit();
    const buildAudit = runTypecheckAndBuildAudit();
    const sqlAudit = await runSqlPersistenceAudit();
    const liveSuite = await runLiveServerSuite();
    const elapsedMs = Date.now() - startedAt;

    console.log('\n============================================================');
    console.log(`ALL PHASE 4 VERIFICATION CHECKS PASSED in ${elapsedMs}ms`);
    console.log('============================================================');
    console.log(
        JSON.stringify(
            {
                status: 'PASS',
                elapsedMs,
                assetAudit,
                buildAudit,
                sqlAudit,
                liveSuite,
            },
            null,
            2
        )
    );
    console.log('PASS');
    process.exit(0);
}

await main();
