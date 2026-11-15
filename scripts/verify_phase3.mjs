import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

const TEST_PORT = Number(process.env.TEST_PORT || 3099);
const TEST_HOST = '127.0.0.1';
const BASE_HTTP = `http://${TEST_HOST}:${TEST_PORT}`;
const BASE_WS = `ws://${TEST_HOST}:${TEST_PORT}/ws`;

const TEST_GRACE_MS = 1600;
const TEST_RESPAWN_MS = 1300;
const PROTOCOL_VERSION = 2;

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============================================================================
// PART 1: Blender Source, GLB Binary Header & Manifest Audit
// ============================================================================

function parseGlbSummary(glbPath) {
    const buf = fs.readFileSync(glbPath);
    assert.ok(buf.length >= 20, `GLB file too small: ${glbPath}`);

    const magic = buf.readUInt32LE(0);
    const version = buf.readUInt32LE(4);
    const totalLength = buf.readUInt32LE(8);
    assert.equal(magic, 0x46546c67, `Invalid glTF magic in ${glbPath}`);
    assert.equal(version, 2, `Expected glTF version 2 in ${glbPath}`);
    assert.equal(totalLength, buf.length, `GLB header length mismatch in ${glbPath}`);

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

    const animDetails = animations.map((a) => ({
        name: a.name,
        channelCount: (a.channels || []).length,
        samplerCount: (a.samplers || []).length,
    }));

    return {
        fileSizeBytes: buf.length,
        nodeCount: nodes.length,
        meshCount: meshes.length,
        primitiveCount,
        materialCount: materials.length,
        triangleCount,
        animationNames: animations.map((a) => a.name),
        animDetails,
    };
}

function runAssetAudit() {
    console.log('\n=== [1/3] Blender Source, GLB Header & Preview Audit ===');
    const monsterKeys = [
        'monster_moss_hopper',
        'monster_aether_wisp',
        'monster_shale_golem',
    ];
    const requiredClips = ['Idle', 'Walk', 'Run', 'Attack', 'Hit', 'Die'];

    const manifestPath = path.join(ROOT_DIR, 'public', 'models', 'manifest.json');
    assert.ok(fs.existsSync(manifestPath), 'Missing public/models/manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    assert.ok(manifest.models, 'manifest.json missing models map');

    const report = {};

    for (const key of monsterKeys) {
        const blendPath = path.join(ROOT_DIR, 'blender_src', `${key}.blend`);
        assert.ok(fs.existsSync(blendPath), `Missing Blender file: ${blendPath}`);
        const blendBuf = fs.readFileSync(blendPath);
        assert.ok(
            blendBuf.length > 50_000,
            `Blender file suspiciously small (${blendBuf.length} B): ${blendPath}`
        );

        const glbPath = path.join(ROOT_DIR, 'public', 'models', `${key}.glb`);
        assert.ok(fs.existsSync(glbPath), `Missing GLB file: ${glbPath}`);
        const glbInfo = parseGlbSummary(glbPath);

        assert.ok(
            glbInfo.triangleCount > 100 && glbInfo.triangleCount <= 8000,
            `${key} triangleCount ${glbInfo.triangleCount} out of budget (100..8000)`
        );
        assert.ok(
            glbInfo.materialCount >= 1 && glbInfo.materialCount <= 16,
            `${key} materialCount ${glbInfo.materialCount} out of budget (1..16)`
        );
        assert.ok(
            glbInfo.nodeCount >= 4 && glbInfo.nodeCount <= 64,
            `${key} nodeCount ${glbInfo.nodeCount} out of budget (4..64)`
        );

        for (const clip of requiredClips) {
            assert.ok(
                glbInfo.animationNames.includes(clip),
                `${key}.glb missing required animation clip '${clip}' (found: ${glbInfo.animationNames.join(', ')})`
            );
        }

        const manifestEntry = manifest.models[key];
        assert.ok(manifestEntry, `manifest.json missing entry for ${key}`);
        assert.equal(
            manifestEntry.triangleCount,
            glbInfo.triangleCount,
            `manifest triangleCount mismatch for ${key}`
        );
        assert.equal(
            manifestEntry.fileSizeBytes,
            glbInfo.fileSizeBytes,
            `manifest fileSizeBytes mismatch for ${key}`
        );
        for (const clip of requiredClips) {
            assert.ok(
                Array.isArray(manifestEntry.animations) &&
                    manifestEntry.animations.includes(clip),
                `manifest.json for ${key} missing animation '${clip}'`
            );
        }

        const frontPng = path.join(
            ROOT_DIR,
            'scratch',
            'monster_previews',
            `${key}_front.png`
        );
        const backPng = path.join(
            ROOT_DIR,
            'scratch',
            'monster_previews',
            `${key}_back.png`
        );
        assert.ok(fs.existsSync(frontPng), `Missing preview ${frontPng}`);
        assert.ok(fs.existsSync(backPng), `Missing preview ${backPng}`);
        const frontHeader = fs.readFileSync(frontPng).subarray(0, 8);
        const backHeader = fs.readFileSync(backPng).subarray(0, 8);
        const pngSig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
        assert.ok(frontHeader.equals(pngSig), `Invalid PNG signature in ${frontPng}`);
        assert.ok(backHeader.equals(pngSig), `Invalid PNG signature in ${backPng}`);

        report[key] = {
            blendSizeBytes: blendBuf.length,
            glbSizeBytes: glbInfo.fileSizeBytes,
            nodeCount: glbInfo.nodeCount,
            meshCount: glbInfo.meshCount,
            materialCount: glbInfo.materialCount,
            triangleCount: glbInfo.triangleCount,
            animations: glbInfo.animationNames,
            animChannels: Object.fromEntries(
                glbInfo.animDetails.map((a) => [a.name, a.channelCount])
            ),
            boundingBoxSize: manifestEntry.boundingBox?.size,
            groundedAtYZero: manifestEntry.groundedAtYZero,
            frontPreviewBytes: fs.statSync(frontPng).size,
            backPreviewBytes: fs.statSync(backPng).size,
        };
        console.log(
            `  [PASS] ${key}: .blend=${blendBuf.length}B, .glb=${glbInfo.fileSizeBytes}B, tris=${glbInfo.triangleCount}, nodes=${glbInfo.nodeCount}, mats=${glbInfo.materialCount}, anims=[${glbInfo.animationNames.join(', ')}]`
        );
    }

    return report;
}

// ============================================================================
// PART 2: WebSocket Test Client Helper
// ============================================================================

class TestWsClient {
    constructor(name, sessionToken = `tok-${name}-${randomUUID().slice(0, 8)}`) {
        this.name = name;
        this.sessionToken = sessionToken;
        this.playerId = null;
        this.slotIndex = null;
        this.roomCode = null;
        this.ws = null;
        this.seq = 0;
        this.combatSeq = 0;
        this.virtualTimeMs = Date.now();
        this.messages = [];
        this.combatEvents = [];
        this.latestSnapshot = null;
        this.closeCode = null;
        this.closeReason = null;
        this.waiters = [];
    }

    async connect() {
        this.ws = new WebSocket(BASE_WS);
        this.closeCode = null;
        this.closeReason = null;

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
            } else if (msg.type === 's2c_combat_event') {
                this.combatEvents.push(msg);
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
        return this.waitForNextMessage(predicate, timeoutMs, label);
    }

    waitForNextMessage(predicate, timeoutMs = 4000, label = 'next_message') {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                const idx = this.waiters.indexOf(entry);
                if (idx !== -1) this.waiters.splice(idx, 1);
                reject(
                    new Error(
                        `[${this.name}] Timeout (${timeoutMs}ms) waiting for ${label}`
                    )
                );
            }, timeoutMs);
            const entry = { predicate, resolve, reject, timer, onClose: false };
            this.waiters.push(entry);
        });
    }

    waitForClose(timeoutMs = 3000) {
        if (this.closeCode !== null) {
            return Promise.resolve({
                code: this.closeCode,
                reason: this.closeReason,
            });
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
        y = 2.2,
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
        const curPos = this.getLocalPlayerState()?.position || { x: 0, y: 2.2, z: 12 };
        let cx = curPos.x;
        let cz = curPos.z;
        const startIdx = this.markIndex();
        for (let i = 0; i < 8; i++) {
            const dx = targetX - cx;
            const dz = targetZ - cz;
            const dist = Math.hypot(dx, dz);
            if (dist <= 24) {
                cx = targetX;
                cz = targetZ;
                this.sendState({ x: cx, y, z: cz, advanceTimeMs: 2000 });
                break;
            }
            const step = 24 / dist;
            cx += dx * step;
            cz += dz * step;
            this.sendState({ x: cx, y, z: cz, advanceTimeMs: 2000 });
        }
        await this.waitForMessageSince(
            startIdx,
            (m) => m.type === 's2c_room_snapshot' && m.lastAckSeq >= this.seq,
            2500,
            `movePlayerTo(${targetX}, ${targetZ}) ack`
        );
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
        const pos = this.getLocalPlayerState()?.position || { x: 0, y: 2.2, z: 12 };
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

    getLocalPlayerState() {
        if (!this.latestSnapshot) return null;
        if (this.latestSnapshot.localState) return this.latestSnapshot.localState;
        return (
            (this.latestSnapshot.players || []).find(
                (p) => p.playerId === this.playerId
            ) || null
        );
    }

    getMonster(monsterId) {
        return (
            (this.latestSnapshot?.monsters || []).find((m) => m.id === monsterId) ||
            null
        );
    }

    close() {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.close(1000, 'Client close');
        }
    }
}

// ============================================================================
// PART 3: Live Server + Multi-Client Phase 2 & Phase 3 Verification
// ============================================================================

async function startChildServer() {
    const child = spawn(process.execPath, [__filename, '--child-server'], {
        cwd: ROOT_DIR,
        env: {
            ...process.env,
            TEST_PORT: String(TEST_PORT),
        },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });

    let stdoutLog = '';
    let stderrLog = '';
    child.stdout.on('data', (chunk) => {
        stdoutLog += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
        stderrLog += chunk.toString();
    });

    let lastFetchErr = null;
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
        try {
            const res = await fetch(`${BASE_HTTP}/health`);
            if (res.ok) {
                const json = await res.json();
                return { child, health: json, getLogs: () => ({ stdoutLog, stderrLog }) };
            }
        } catch (err) {
            lastFetchErr = err;
        }
        await sleep(80);
    }
    child.kill();
    throw new Error(
        `Server failed to respond on ${BASE_HTTP}/health. LastErr=${lastFetchErr?.cause?.code || lastFetchErr?.message} Stdout=${stdoutLog} Stderr=${stderrLog}`
    );
}

async function runLiveIntegrationTests() {
    console.log(
        `\n=== [2/3] Starting Live Server on ${BASE_HTTP} (grace=${TEST_GRACE_MS}ms, respawn=${TEST_RESPAWN_MS}ms) ===`
    );
    const { child, health, getLogs } = await startChildServer();
    const results = {};

    try {
        assert.equal(health.status, 'ok');
        assert.equal(health.protocolVersion, 2);
        assert.equal(health.maxPartyPlayers, 3);
        assert.equal(health.tickRateHz, 15);
        console.log('  [PASS] GET /health verified:', JSON.stringify(health));

        // Verify GLB static serving with model/gltf-binary
        for (const mKey of [
            'monster_moss_hopper',
            'monster_aether_wisp',
            'monster_shale_golem',
        ]) {
            const headRes = await fetch(`${BASE_HTTP}/models/${mKey}.glb`, {
                method: 'HEAD',
            });
            assert.equal(headRes.status, 200, `HEAD /models/${mKey}.glb failed`);
            assert.equal(
                headRes.headers.get('content-type'),
                'model/gltf-binary',
                `Unexpected content-type for ${mKey}.glb`
            );
        }
        console.log(
            '  [PASS] Static GLB serving (model/gltf-binary) verified for all 3 monsters'
        );

        // --------------------------------------------------------------------
        // A. Phase 2 Regressions: Room Create, 3-Player Cap, ROOM_FULL, 4001 Kick, Anti-Cheat Clamp
        // --------------------------------------------------------------------
        console.log('\n--- Section A: Phase 2 Regressions ---');
        const p1 = new TestWsClient('Alpha');
        const p2 = new TestWsClient('Bravo');
        const p3 = new TestWsClient('Charlie');
        const p4 = new TestWsClient('Delta');

        await p1.connect();
        p1.send({
            type: 'c2s_create_room',
            protocolVersion: PROTOCOL_VERSION,
            sessionToken: p1.sessionToken,
            displayName: 'Alpha',
            preferredRoomCode: 'PH3TST',
        });
        const joined1 = await p1.waitForMessage(
            (m) => m.type === 's2c_room_joined',
            3000,
            'P1 room joined'
        );
        const roomCode = joined1.roomCode;
        assert.equal(roomCode, 'PH3TST');
        assert.equal(joined1.slotIndex, 0);

        await p2.connect();
        p2.send({
            type: 'c2s_join_room',
            protocolVersion: PROTOCOL_VERSION,
            roomCode,
            sessionToken: p2.sessionToken,
            displayName: 'Bravo',
        });
        const joined2 = await p2.waitForMessage(
            (m) => m.type === 's2c_room_joined',
            3000,
            'P2 room joined'
        );
        assert.equal(joined2.slotIndex, 1);

        await p3.connect();
        p3.send({
            type: 'c2s_join_room',
            protocolVersion: PROTOCOL_VERSION,
            roomCode,
            sessionToken: p3.sessionToken,
            displayName: 'Charlie',
        });
        const joined3 = await p3.waitForMessage(
            (m) => m.type === 's2c_room_joined',
            3000,
            'P3 room joined'
        );
        assert.equal(joined3.slotIndex, 2);

        // 4th player rejected with ROOM_FULL
        await p4.connect();
        p4.send({
            type: 'c2s_join_room',
            protocolVersion: PROTOCOL_VERSION,
            roomCode,
            sessionToken: p4.sessionToken,
            displayName: 'Delta',
        });
        const p4Err = await p4.waitForMessage(
            (m) => m.type === 's2c_room_error',
            3000,
            'P4 ROOM_FULL'
        );
        assert.equal(p4Err.code, 'ROOM_FULL');
        p4.close();
        console.log(
            '  [PASS] 3-player room created (slots 0,1,2) & 4th player rejected with ROOM_FULL'
        );

        // Advance P2 seq to 5, then test duplicate session kick (4001) + seq=1 reset
        const p2AckIdx = p2.markIndex();
        for (let i = 0; i < 5; i++) {
            p2.sendState({ x: -2.2, y: 2.2, z: 13.2, advanceTimeMs: 100 });
        }
        await p2.waitForMessageSince(
            p2AckIdx,
            (m) => m.type === 's2c_room_snapshot' && m.lastAckSeq >= 5,
            2500,
            'P2 ack seq 5'
        );

        const p2Dup = new TestWsClient('BravoDup', p2.sessionToken);
        await p2Dup.connect();
        const p2KickPromise = p2.waitForMessage(
            (m) => m.type === 's2c_kicked_duplicate',
            3000,
            'P2 kicked_duplicate'
        );
        const p2ClosePromise = p2.waitForClose(3000);

        p2Dup.send({
            type: 'c2s_join_room',
            protocolVersion: PROTOCOL_VERSION,
            roomCode,
            sessionToken: p2.sessionToken,
            displayName: 'Bravo',
        });
        const joined2Dup = await p2Dup.waitForMessage(
            (m) => m.type === 's2c_room_joined',
            3000,
            'P2Dup room joined'
        );
        const [kickedMsg, closeInfo] = await Promise.all([
            p2KickPromise,
            p2ClosePromise,
        ]);
        assert.equal(kickedMsg.type, 's2c_kicked_duplicate');
        assert.equal(closeInfo.code, 4001);
        assert.equal(joined2Dup.slotIndex, 1);
        assert.equal(joined2Dup.playerId, p2.playerId);
        assert.equal(joined2Dup.reconnected, true);

        const p2DupIdx = p2Dup.markIndex();
        p2Dup.sendState({ x: -2.0, y: 2.2, z: 13.0, advanceTimeMs: 200 });
        const snapAfterRebind = await p2Dup.waitForMessageSince(
            p2DupIdx,
            (m) => m.type === 's2c_room_snapshot' && m.lastAckSeq === 1,
            2500,
            'P2Dup seq=1 ack'
        );
        assert.equal(snapAfterRebind.lastAckSeq, 1);
        console.log(
            '  [PASS] Duplicate session kick (4001) + slot/identity handoff + seq=1 reset verified'
        );

        // Terrain height & island boundary clamp anti-cheat on P3 (seq=1 skips speed clamp)
        const p3Idx1 = p3.markIndex();
        p3.sendState({ x: 500, y: -200, z: 500, advanceTimeMs: 500 });
        const p3ClampSnap1 = await p3.waitForMessageSince(
            p3Idx1,
            (m) => m.type === 's2c_room_snapshot' && m.lastAckSeq >= 1,
            2500,
            'P3 boundary+floor clamp'
        );
        const p3State1 = p3ClampSnap1.localState;
        const p3Radius = Math.hypot(p3State1.position.x, p3State1.position.z);
        assert.ok(
            Math.abs(p3Radius - 108.5) < 0.05,
            `Expected radius clamped to 108.5, got ${p3Radius}`
        );
        assert.ok(
            p3State1.position.y > 5.0,
            `Expected underground y=-200 clamped to ridge terrain height (>5m), got ${p3State1.position.y}`
        );

        // Sky ceiling clamp test on P3
        const p3Idx2 = p3.markIndex();
        p3.sendState({
            x: p3State1.position.x,
            y: 999,
            z: p3State1.position.z,
            advanceTimeMs: 200,
        });
        const p3ClampSnap2 = await p3.waitForMessageSince(
            p3Idx2,
            (m) => m.type === 's2c_room_snapshot' && m.lastAckSeq >= 2,
            2500,
            'P3 ceiling clamp'
        );
        const p3State2 = p3ClampSnap2.localState;
        assert.ok(
            Math.abs(p3State2.position.y - (p3State1.position.y + 12.0)) < 0.1,
            `Expected sky y=999 clamped to terrainY + 12.0 (${p3State1.position.y + 12.0}), got ${p3State2.position.y}`
        );
        console.log(
            `  [PASS] Anti-cheat clamps verified: radial=${p3Radius.toFixed(2)}m (<=108.5m), terrainFloorY=${p3State1.position.y}m, skyCeilingY=${p3State2.position.y}m`
        );

        await p3.movePlayerTo(2.2, 13.2, 2.2);

        results.phase2Regressions = {
            roomCode,
            slotsAssigned: [joined1.slotIndex, joined2.slotIndex, joined3.slotIndex],
            fourthPlayerError: p4Err.code,
            duplicateKickCode: closeInfo.code,
            rebindSeq1Accepted: snapAfterRebind.lastAckSeq === 1,
            clampedRadius: Number(p3Radius.toFixed(3)),
            clampedFloorY: p3State1.position.y,
            clampedCeilingY: p3State2.position.y,
        };

        // --------------------------------------------------------------------
        // B. Wild Monster Sync & Aggro/Chase/Attack Transitions
        // --------------------------------------------------------------------
        console.log('\n--- Section B: Wild Monster Sync & AI Transitions ---');
        const [s1, s2, s3] = await Promise.all([
            p1.waitForNextMessage((m) => m.type === 's2c_room_snapshot', 2000),
            p2Dup.waitForNextMessage((m) => m.type === 's2c_room_snapshot', 2000),
            p3.waitForNextMessage((m) => m.type === 's2c_room_snapshot', 2000),
        ]);

        assert.equal(s1.monsters?.length, 6, 'P1 should see 6 wild monsters');
        assert.equal(s2.monsters?.length, 6, 'P2 should see 6 wild monsters');
        assert.equal(s3.monsters?.length, 6, 'P3 should see 6 wild monsters');

        const speciesCounts = { moss_hopper: 0, aether_wisp: 0, shale_golem: 0 };
        for (const m of s1.monsters) {
            speciesCounts[m.species] = (speciesCounts[m.species] || 0) + 1;
            const m2 = s2.monsters.find((x) => x.id === m.id);
            const m3 = s3.monsters.find((x) => x.id === m.id);
            assert.ok(m2 && m3, `Monster ${m.id} missing on P2 or P3`);
            assert.equal(m.hp, m2.hp);
            assert.equal(m.hp, m3.hp);
        }
        assert.deepEqual(speciesCounts, {
            moss_hopper: 2,
            aether_wisp: 2,
            shale_golem: 2,
        });
        console.log(
            '  [PASS] All 3 clients synced 6 wild monsters (2 moss_hopper, 2 aether_wisp, 2 shale_golem)'
        );

        // Move P1 to approach wild-moss_hopper-2 at (16, 14)
        const hopper2Init = p1.getMonster('wild-moss_hopper-2');
        assert.ok(hopper2Init, 'wild-moss_hopper-2 not found');
        const p1TeleIdx = p1.markIndex();
        await p1.movePlayerTo(hopper2Init.x, hopper2Init.z, hopper2Init.y);

        // Wait for monster to enter alert/chase/attack and emit monster_attack_telegraph
        const telegraphEv = await p1.waitForMessageSince(
            p1TeleIdx,
            (m) =>
                m.type === 's2c_combat_event' &&
                m.event === 'monster_attack_telegraph' &&
                m.actorId === 'wild-moss_hopper-2',
            4500,
            'wild-moss_hopper-2 telegraph'
        );
        assert.equal(telegraphEv.actorId, 'wild-moss_hopper-2');
        console.log(
            '  [PASS] Approaching wild-moss_hopper-2 triggered aggro -> chase -> attack telegraph'
        );

        results.wildMonsterSync = {
            monsterCount: 6,
            speciesCounts,
            aggroTelegraphActor: telegraphEv.actorId,
        };

        // --------------------------------------------------------------------
        // C. Real-Time Co-op Combat, Dodge i-frames, Kill, Loot/Sphere & Respawn
        // --------------------------------------------------------------------
        console.log('\n--- Section C: Real-Time Co-op Combat, Dodge i-frames & Respawn ---');

        // 1. Test melee_attack (24 dmg) and ranged_attack (18 dmg) on wild-moss_hopper-2 (maxHp=110)
        // This also locks wild-moss_hopper-2's aggro (targetPlayerId) onto P1!
        const h2BeforeAtk = p1.getMonster('wild-moss_hopper-2');
        await p1.movePlayerTo(h2BeforeAtk.x - 1.2, h2BeforeAtk.z, h2BeforeAtk.y);

        const p1MeleeIdx = p1.markIndex();
        const p3MeleeIdx = p3.markIndex();
        p1.sendCombatAction({
            action: 'melee_attack',
            targetMonsterId: 'wild-moss_hopper-2',
            originX: h2BeforeAtk.x - 1.2,
            originY: h2BeforeAtk.y,
            originZ: h2BeforeAtk.z,
            dirX: 1,
            dirZ: 0,
        });

        const [meleeEvP1, meleeEvP3] = await Promise.all([
            p1.waitForMessageSince(
                p1MeleeIdx,
                (m) =>
                    m.type === 's2c_combat_event' &&
                    m.event === 'melee_hit' &&
                    m.targetId === 'wild-moss_hopper-2',
                3000,
                'P1 melee_hit'
            ),
            p3.waitForMessageSince(
                p3MeleeIdx,
                (m) =>
                    m.type === 's2c_combat_event' &&
                    m.event === 'melee_hit' &&
                    m.targetId === 'wild-moss_hopper-2',
                3000,
                'P3 melee_hit sync'
            ),
        ]);
        assert.equal(meleeEvP1.damage, 24);
        assert.equal(meleeEvP1.remainingHp, 86);
        assert.equal(meleeEvP3.remainingHp, 86);

        await sleep(160);
        const h2BeforeRanged = p1.getMonster('wild-moss_hopper-2');
        await p1.movePlayerTo(h2BeforeRanged.x - 1.2, h2BeforeRanged.z, h2BeforeRanged.y);
        const p1RangedIdx = p1.markIndex();
        const p2RangedIdx = p2Dup.markIndex();
        p1.sendCombatAction({
            action: 'ranged_attack',
            targetMonsterId: 'wild-moss_hopper-2',
            originX: h2BeforeRanged.x - 1.2,
            originY: h2BeforeRanged.y,
            originZ: h2BeforeRanged.z,
            dirX: 1,
            dirZ: 0,
        });

        const [rangedCastEv, rangedHitEv] = await Promise.all([
            p1.waitForMessageSince(
                p1RangedIdx,
                (m) =>
                    m.type === 's2c_combat_event' &&
                    m.event === 'ranged_cast' &&
                    m.actorId === p1.playerId,
                3000,
                'ranged_cast'
            ),
            p2Dup.waitForMessageSince(
                p2RangedIdx,
                (m) =>
                    m.type === 's2c_combat_event' &&
                    m.event === 'ranged_hit' &&
                    m.targetId === 'wild-moss_hopper-2',
                3000,
                'P2 ranged_hit sync'
            ),
        ]);
        assert.equal(rangedHitEv.damage, 18);
        assert.equal(rangedHitEv.remainingHp, 68);
        console.log(
            '  [PASS] melee_attack (-24 -> 86 HP) & ranged_attack (-18 -> 68 HP) synced across all 3 clients'
        );

        // 2. Now wild-moss_hopper-2 is aggroed onto P1! Stand next to it, wait for monster_attack_telegraph targeting P1, and dodge_roll!
        const h2Pos = p1.getMonster('wild-moss_hopper-2');
        await p1.movePlayerTo(h2Pos.x - 0.8, h2Pos.z, h2Pos.y);
        const dodgeTeleIdx = p1.markIndex();
        await p1.waitForMessageSince(
            dodgeTeleIdx,
            (m) =>
                m.type === 's2c_combat_event' &&
                m.event === 'monster_attack_telegraph' &&
                m.actorId === 'wild-moss_hopper-2' &&
                m.targetId === p1.playerId,
            4500,
            'telegraph targeting P1 for dodge test'
        );
        const hpBeforeDodge = p1.getLocalPlayerState().hp;
        const dodgeEvIdx = p1.markIndex();
        await sleep(40);
        const h2Now = p1.getMonster('wild-moss_hopper-2');
        p1.sendCombatAction({
            action: 'dodge_roll',
            originX: h2Now.x - 0.8,
            originY: h2Now.y,
            originZ: h2Now.z,
        });

        await p1.waitForMessageSince(
            dodgeEvIdx,
            (m) =>
                m.type === 's2c_combat_event' &&
                m.event === 'player_dodge' &&
                m.actorId === p1.playerId &&
                m.targetId === 'wild-moss_hopper-2',
            3500,
            'player_dodge on monster attack'
        );
        const snapAfterDodge = await p1.waitForNextMessage(
            (m) => m.type === 's2c_room_snapshot',
            2000
        );
        assert.equal(
            snapAfterDodge.localState.hp,
            hpBeforeDodge,
            `Expected HP to remain ${hpBeforeDodge} during dodge i-frames, got ${snapAfterDodge.localState.hp}`
        );
        console.log(
            `  [PASS] Dodge roll i-frames verified: monster attack negated with player_dodge event (HP stayed ${snapAfterDodge.localState.hp})`
        );

        const spheresBeforeKill = p1.getLocalPlayerState().captureSpheres;
        const lootBeforeKill = p1.getLocalPlayerState().lootCount;
        const killStartIdx = p1.markIndex();

        for (let hit = 0; hit < 3; hit++) {
            await sleep(140);
            const curH2 = p1.getMonster('wild-moss_hopper-2');
            if (!curH2 || curH2.aiState === 'dead') break;
            await p1.movePlayerTo(curH2.x - 1.0, curH2.z, curH2.y);
            p1.sendCombatAction({
                action: 'melee_attack',
                targetMonsterId: 'wild-moss_hopper-2',
                originX: curH2.x - 1.0,
                originY: curH2.y,
                originZ: curH2.z,
                dirX: 1,
                dirZ: 0,
            });
        }

        const [deadEv, lootEv] = await Promise.all([
            p1.waitForMessageSince(
                killStartIdx,
                (m) =>
                    m.type === 's2c_combat_event' &&
                    m.event === 'monster_dead' &&
                    m.targetId === 'wild-moss_hopper-2',
                4000,
                'monster_dead'
            ),
            p1.waitForMessageSince(
                killStartIdx,
                (m) =>
                    m.type === 's2c_combat_event' &&
                    m.event === 'loot_drop' &&
                    m.targetId === 'wild-moss_hopper-2',
                4000,
                'loot_drop'
            ),
        ]);
        assert.equal(deadEv.remainingHp, 0);
        assert.ok(lootEv.lootItem, 'Expected lootItem in loot_drop event');

        const snapAfterKill = await p1.waitForMessageSince(
            killStartIdx,
            (m) =>
                m.type === 's2c_room_snapshot' &&
                m.monsters.find((x) => x.id === 'wild-moss_hopper-2')?.aiState ===
                    'dead',
            2500,
            'dead state snapshot'
        );
        assert.equal(
            snapAfterKill.localState.lootCount,
            lootBeforeKill + 1,
            'Expected lootCount +1 on monster kill'
        );
        assert.equal(
            snapAfterKill.localState.captureSpheres,
            spheresBeforeKill + 1,
            'Expected captureSpheres +1 on monster kill'
        );
        console.log(
            `  [PASS] Monster defeat verified: monster_dead + loot_drop ('${lootEv.lootItem}'), lootCount=${snapAfterKill.localState.lootCount}, captureSpheres=${snapAfterKill.localState.captureSpheres}`
        );

        // Wait for monster respawn (~1300ms)
        const respawnIdx = p1.markIndex();
        const respawnSnap = await p1.waitForMessageSince(
            respawnIdx,
            (m) => {
                if (m.type !== 's2c_room_snapshot') return false;
                const h2 = m.monsters.find((x) => x.id === 'wild-moss_hopper-2');
                return h2 && h2.aiState === 'patrol' && h2.hp === h2.maxHp;
            },
            3500,
            'wild-moss_hopper-2 respawn'
        );
        const h2Respawned = respawnSnap.monsters.find(
            (x) => x.id === 'wild-moss_hopper-2'
        );
        assert.equal(h2Respawned.hp, 110);
        assert.equal(h2Respawned.aiState, 'patrol');
        console.log(
            '  [PASS] Monster respawn verified: wild-moss_hopper-2 restored to 110/110 HP in patrol state'
        );

        results.combatAndDodge = {
            dodgeIframeHpPreserved: snapAfterDodge.localState.hp,
            meleeDamage: meleeEvP1.damage,
            rangedDamage: rangedHitEv.damage,
            lootDropped: lootEv.lootItem,
            spheresAfterKill: snapAfterKill.localState.captureSpheres,
            respawnedHp: h2Respawned.hp,
        };

        // --------------------------------------------------------------------
        // D. Simultaneous Capture Race Lock (CRITICAL)
        // --------------------------------------------------------------------
        console.log('\n--- Section D: Simultaneous Capture Race Lock (Promise.all) ---');
        const hopper1 = p1.getMonster('wild-moss_hopper-1');
        assert.ok(hopper1, 'wild-moss_hopper-1 not found');
        await Promise.all([
            p1.movePlayerTo(hopper1.x - 1.2, hopper1.z, hopper1.y),
            p2Dup.movePlayerTo(hopper1.x + 1.2, hopper1.z, hopper1.y),
            p3.movePlayerTo(hopper1.x, hopper1.z + 1.2, hopper1.y),
        ]);

        // Weaken wild-moss_hopper-1 with 4 melee hits (110 - 96 = 14 HP -> 89% capture chance!)
        const weakenIdx = p1.markIndex();
        for (let i = 0; i < 4; i++) {
            await sleep(130);
            const curH1 = p1.getMonster('wild-moss_hopper-1');
            await p1.movePlayerTo(curH1.x - 1.0, curH1.z, curH1.y);
            p1.sendCombatAction({
                action: 'melee_attack',
                targetMonsterId: 'wild-moss_hopper-1',
                originX: curH1.x - 1.0,
                originY: curH1.y,
                originZ: curH1.z,
                dirX: 1,
                dirZ: 0,
            });
        }

        const weakenedSnap = await p1.waitForMessageSince(
            weakenIdx,
            (m) =>
                m.type === 's2c_room_snapshot' &&
                m.monsters.find((x) => x.id === 'wild-moss_hopper-1')?.hp === 14,
            3000,
            'wild-moss_hopper-1 weakened to 14 HP'
        );
        const h1Weak = weakenedSnap.monsters.find(
            (x) => x.id === 'wild-moss_hopper-1'
        );
        assert.equal(h1Weak.hp, 14);

        // Sync P1, P2Dup, P3 positions right next to weakened monster
        await Promise.all([
            p1.movePlayerTo(h1Weak.x - 1.0, h1Weak.z, h1Weak.y),
            p2Dup.movePlayerTo(h1Weak.x + 1.0, h1Weak.z, h1Weak.y),
            p3.movePlayerTo(h1Weak.x, h1Weak.z + 1.0, h1Weak.y),
        ]);

        const p1SpheresBefore = p1.getLocalPlayerState().captureSpheres;
        const p2SpheresBefore = p2Dup.getLocalPlayerState().captureSpheres;

        const p1RaceIdx = p1.markIndex();
        const p2RaceIdx = p2Dup.markIndex();

        // FIRE SIMULTANEOUS THROW_CAPTURE AT THE EXACT SAME MILLISECOND!
        const curH1AtThrow = p1.getMonster('wild-moss_hopper-1');
        await Promise.all([
            Promise.resolve().then(() =>
                p1.sendCombatAction({
                    action: 'throw_capture',
                    targetMonsterId: 'wild-moss_hopper-1',
                    originX: curH1AtThrow.x - 1.0,
                    originY: curH1AtThrow.y,
                    originZ: curH1AtThrow.z,
                    dirX: 1,
                    dirZ: 0,
                })
            ),
            Promise.resolve().then(() =>
                p2Dup.sendCombatAction({
                    action: 'throw_capture',
                    targetMonsterId: 'wild-moss_hopper-1',
                    originX: curH1AtThrow.x + 1.0,
                    originY: curH1AtThrow.y,
                    originZ: curH1AtThrow.z,
                    dirX: -1,
                    dirZ: 0,
                })
            ),
        ]);

        const throwEv = await p1.waitForMessageSince(
            p1RaceIdx,
            (m) =>
                m.type === 's2c_combat_event' &&
                m.event === 'capture_throw' &&
                m.targetId === 'wild-moss_hopper-1',
            3000,
            'capture_throw broadcast'
        );
        const lockWinnerId = throwEv.actorId;
        const lockLoserClient = lockWinnerId === p1.playerId ? p2Dup : p1;
        const lockWinnerClient = lockWinnerId === p1.playerId ? p1 : p2Dup;
        const loserStartIdx = lockWinnerId === p1.playerId ? p2RaceIdx : p1RaceIdx;
        const winnerStartIdx = lockWinnerId === p1.playerId ? p1RaceIdx : p2RaceIdx;

        // The loser MUST receive an immediate capture_result with reason: 'CAPTURE_LOCKED'
        const loserImmediateEv = await lockLoserClient.waitForMessageSince(
            loserStartIdx,
            (m) =>
                m.type === 's2c_combat_event' &&
                m.event === 'capture_result' &&
                m.actorId === lockLoserClient.playerId &&
                m.targetId === 'wild-moss_hopper-1',
            3000,
            'Loser CAPTURE_LOCKED event'
        );
        assert.equal(loserImmediateEv.captureSuccess, false);
        assert.equal(
            loserImmediateEv.reason,
            'CAPTURE_LOCKED',
            `Expected simultaneous second thrower to get CAPTURE_LOCKED, got ${loserImmediateEv.reason}`
        );

        // Verify snapshot during the 1100ms capturing window shows aiState === 'capturing' and captureLockByPlayerId === lockWinnerId
        const capturingSnap = await p1.waitForMessageSince(
            p1RaceIdx,
            (m) =>
                m.type === 's2c_room_snapshot' &&
                m.monsters.find((x) => x.id === 'wild-moss_hopper-1')?.aiState ===
                    'capturing',
            1500,
            'capturing state snapshot'
        );
        const h1Capturing = capturingSnap.monsters.find(
            (x) => x.id === 'wild-moss_hopper-1'
        );
        assert.equal(h1Capturing.captureLockByPlayerId, lockWinnerId);

        // While capturing, have P3 attempt to melee_attack AND throw_capture to steal/kill
        const p3StealIdx = p3.markIndex();
        p3.sendCombatAction({
            action: 'melee_attack',
            targetMonsterId: 'wild-moss_hopper-1',
            originX: h1Capturing.x,
            originY: h1Capturing.y,
            originZ: h1Capturing.z + 1.0,
            dirX: 0,
            dirZ: -1,
        });
        p3.sendCombatAction({
            action: 'throw_capture',
            targetMonsterId: 'wild-moss_hopper-1',
            originX: h1Capturing.x,
            originY: h1Capturing.y,
            originZ: h1Capturing.z + 1.0,
            dirX: 0,
            dirZ: -1,
        });
        const p3StealEv = await p3.waitForMessageSince(
            p3StealIdx,
            (m) =>
                m.type === 's2c_combat_event' &&
                m.event === 'capture_result' &&
                m.actorId === p3.playerId &&
                m.reason === 'CAPTURE_LOCKED',
            2000,
            'P3 steal rejected with CAPTURE_LOCKED'
        );
        assert.equal(p3StealEv.reason, 'CAPTURE_LOCKED');

        // Wait for the winner's capture resolution (~1100ms)
        let finalCaptureEv = await lockWinnerClient.waitForMessageSince(
            winnerStartIdx,
            (m) =>
                m.type === 's2c_combat_event' &&
                m.event === 'capture_result' &&
                m.actorId === lockWinnerId &&
                m.reason !== 'CAPTURE_LOCKED',
            3000,
            'winner capture resolution'
        );

        // Verify sphere counts after simultaneous race: winner used 1 sphere, loser used 0 spheres!
        await Promise.all([
            p1.waitForNextMessage((m) => m.type === 's2c_room_snapshot', 1500),
            p2Dup.waitForNextMessage((m) => m.type === 's2c_room_snapshot', 1500),
        ]);
        const winnerSpheresAfterRace =
            lockWinnerClient.getLocalPlayerState().captureSpheres;
        const loserSpheresAfterRace =
            lockLoserClient.getLocalPlayerState().captureSpheres;
        const expectedWinnerBefore =
            lockWinnerClient === p1 ? p1SpheresBefore : p2SpheresBefore;
        const expectedLoserBefore =
            lockLoserClient === p1 ? p1SpheresBefore : p2SpheresBefore;

        assert.equal(
            winnerSpheresAfterRace,
            expectedWinnerBefore - 1,
            'Lock winner should deduct exactly 1 sphere'
        );
        assert.equal(
            loserSpheresAfterRace,
            expectedLoserBefore,
            'Lock loser (CAPTURE_LOCKED) must NOT deduct any spheres'
        );

        // Ensure P1 has a captured monster in roster (if RNG broke free or P2 won the race, have P1 capture a weakened monster)
        let p1CapturedRecord =
            lockWinnerClient === p1 && finalCaptureEv.captureSuccess
                ? finalCaptureEv.capturedRecord
                : null;

        let captureAttempts = 1;
        while (!p1CapturedRecord && captureAttempts < 8) {
            captureAttempts += 1;
            let targetId = 'wild-moss_hopper-1';
            let mState = p1.getMonster(targetId);
            if (!mState || mState.aiState === 'captured' || mState.aiState === 'dead') {
                targetId = 'wild-moss_hopper-2';
                mState = p1.getMonster(targetId);
            }
            await p1.movePlayerTo(mState.x - 1.0, mState.z, mState.y);
            while (p1.getMonster(targetId).hp > 25) {
                const cur = p1.getMonster(targetId);
                await p1.movePlayerTo(cur.x - 1.0, cur.z, cur.y);
                p1.sendCombatAction({
                    action: 'melee_attack',
                    targetMonsterId: targetId,
                    originX: cur.x - 1.0,
                    originY: cur.y,
                    originZ: cur.z,
                    dirX: 1,
                    dirZ: 0,
                });
                await sleep(150);
                await p1.waitForNextMessage(
                    (m) => m.type === 's2c_room_snapshot',
                    1000
                );
            }
            const cur = p1.getMonster(targetId);
            await p1.movePlayerTo(cur.x - 1.0, cur.z, cur.y);
            const retryIdx = p1.markIndex();
            p1.sendCombatAction({
                action: 'throw_capture',
                targetMonsterId: targetId,
                originX: cur.x - 1.0,
                originY: cur.y,
                originZ: cur.z,
                dirX: 1,
                dirZ: 0,
            });
            const resEv = await p1.waitForMessageSince(
                retryIdx,
                (m) =>
                    m.type === 's2c_combat_event' &&
                    m.event === 'capture_result' &&
                    m.actorId === p1.playerId,
                3000,
                'P1 retry capture_result'
            );
            if (resEv.captureSuccess) {
                p1CapturedRecord = resEv.capturedRecord;
                finalCaptureEv = resEv;
            }
        }

        assert.ok(p1CapturedRecord, 'Expected P1 to obtain CapturedMonsterRecord');
        await p1.waitForMessage(
            (m) =>
                m.type === 's2c_room_snapshot' &&
                Array.isArray(m.capturedRoster) &&
                m.capturedRoster.some((r) => r.uid === p1CapturedRecord.uid),
            2500,
            'P1 snapshot with capturedRoster'
        );
        const p3SnapCheck = await p3.waitForNextMessage(
            (m) => m.type === 's2c_room_snapshot',
            2000
        );
        assert.equal(
            p3SnapCheck.capturedRoster?.length || 0,
            0,
            'P3 must have 0 captured monsters'
        );
        console.log(
            `  [PASS] Simultaneous capture race lock verified: winner=${lockWinnerId}, loser got CAPTURE_LOCKED (0 spheres lost), P3 anti-kill/anti-steal held during capturing, capturedRecord=${p1CapturedRecord.uid} (${p1CapturedRecord.species})`
        );

        results.captureRaceLock = {
            lockWinnerId,
            loserRejectionReason: loserImmediateEv.reason,
            thirdPlayerStealRejection: p3StealEv.reason,
            winnerSpheresDelta: winnerSpheresAfterRace - expectedWinnerBefore,
            loserSpheresDelta: loserSpheresAfterRace - expectedLoserBefore,
            capturedRecord: p1CapturedRecord,
        };

        // --------------------------------------------------------------------
        // E. Temporary Disconnect + Reconnect Within Grace Window (Restoring Slot + Identity + Roster)
        // --------------------------------------------------------------------
        console.log('\n--- Section E: Temporary Disconnect + Reconnect Within Grace Window ---');
        const p1OriginalId = p1.playerId;
        const p2ReconnIdx = p2Dup.markIndex();
        p1.ws.terminate();
        const reconnectingNotice = await p2Dup.waitForMessageSince(
            p2ReconnIdx,
            (m) =>
                m.type === 's2c_player_reconnecting' && m.playerId === p1OriginalId,
            2500,
            's2c_player_reconnecting for P1'
        );
        assert.equal(reconnectingNotice.slotIndex, 0);

        await sleep(250);
        const p1Reconn = new TestWsClient('AlphaReconn', p1.sessionToken);
        await p1Reconn.connect();
        const p2ReconnDoneIdx = p2Dup.markIndex();
        p1Reconn.send({
            type: 'c2s_join_room',
            protocolVersion: PROTOCOL_VERSION,
            roomCode,
            sessionToken: p1.sessionToken,
            playerId: p1OriginalId,
            displayName: 'Alpha',
            isReconnect: true,
        });
        const joinedReconn = await p1Reconn.waitForMessage(
            (m) => m.type === 's2c_room_joined',
            3000,
            'P1 reconnected room_joined'
        );
        await p2Dup.waitForMessageSince(
            p2ReconnDoneIdx,
            (m) =>
                m.type === 's2c_player_reconnected' &&
                m.player.playerId === p1OriginalId,
            2500,
            's2c_player_reconnected for P1'
        );

        assert.equal(joinedReconn.reconnected, true);
        assert.equal(joinedReconn.slotIndex, 0);
        assert.equal(joinedReconn.playerId, p1OriginalId);
        assert.ok(
            Array.isArray(joinedReconn.capturedRoster) &&
                joinedReconn.capturedRoster.some((r) => r.uid === p1CapturedRecord.uid),
            'Reconnected P1 must restore capturedRoster!'
        );
        console.log(
            `  [PASS] Reconnect within grace window restored slotIndex=0, playerId=${p1OriginalId}, and capturedRoster (${joinedReconn.capturedRoster.length} monster: ${p1CapturedRecord.uid})`
        );

        results.graceReconnect = {
            restoredSlot: joinedReconn.slotIndex,
            restoredPlayerId: joinedReconn.playerId,
            restoredRosterCount: joinedReconn.capturedRoster.length,
        };

        // --------------------------------------------------------------------
        // F. Companion Summon, Combat Assist, Recall & Permanent Disconnect Cleanup
        // --------------------------------------------------------------------
        console.log('\n--- Section F: Companion Summon, Assist, Recall & Disconnect Cleanup ---');
        const assistTarget =
            p1Reconn.latestSnapshot.monsters.find(
                (m) =>
                    m.id === 'wild-moss_hopper-2' &&
                    m.aiState !== 'dead' &&
                    m.aiState !== 'captured'
            ) ||
            p1Reconn.latestSnapshot.monsters.find(
                (m) => m.aiState !== 'dead' && m.aiState !== 'captured'
            );
        assert.ok(assistTarget, 'No alive monster found for companion assist test');
        const targetInitialHp = assistTarget.hp;

        // Position P1Reconn ~4m from assistTarget, summon companion, then approach assistTarget
        await p1Reconn.movePlayerTo(
            assistTarget.x - 3.5,
            assistTarget.z - 3.5,
            assistTarget.y
        );

        const p2SummonIdx = p2Dup.markIndex();
        const p1SummonIdx = p1Reconn.markIndex();
        const p3SummonIdx = p3.markIndex();

        p1Reconn.sendCombatAction({
            action: 'summon_companion',
            companionUid: p1CapturedRecord.uid,
        });
        const summonEv = await p2Dup.waitForMessageSince(
            p2SummonIdx,
            (m) =>
                m.type === 's2c_combat_event' &&
                m.event === 'companion_summon' &&
                m.actorId === p1Reconn.playerId &&
                m.targetId === p1CapturedRecord.uid,
            3000,
            'companion_summon broadcast to P2'
        );
        assert.equal(summonEv.targetId, p1CapturedRecord.uid);

        // Verify all 3 clients receive the companion in snapshots
        const [compSnap1, compSnap2, compSnap3] = await Promise.all([
            p1Reconn.waitForMessageSince(
                p1SummonIdx,
                (m) =>
                    m.type === 's2c_room_snapshot' &&
                    (m.companions || []).some((c) => c.uid === p1CapturedRecord.uid),
                2500,
                'P1 companion snapshot'
            ),
            p2Dup.waitForMessageSince(
                p2SummonIdx,
                (m) =>
                    m.type === 's2c_room_snapshot' &&
                    (m.companions || []).some((c) => c.uid === p1CapturedRecord.uid),
                2500,
                'P2 companion snapshot'
            ),
            p3.waitForMessageSince(
                p3SummonIdx,
                (m) =>
                    m.type === 's2c_room_snapshot' &&
                    (m.companions || []).some((c) => c.uid === p1CapturedRecord.uid),
                2500,
                'P3 companion snapshot'
            ),
        ]);
        assert.equal(compSnap1.companions.length, 1);
        assert.equal(compSnap2.companions.length, 1);
        assert.equal(compSnap3.companions.length, 1);
        assert.equal(compSnap1.localState.activeCompanionId, p1CapturedRecord.uid);
        console.log(
            `  [PASS] Companion summoned (${p1CapturedRecord.uid}) and synced to P1, P2, P3 snapshots`
        );

        await p1Reconn.movePlayerTo(
            assistTarget.x - 1.2,
            assistTarget.z - 1.2,
            assistTarget.y
        );

        const compAttackEv = await p1Reconn.waitForMessageSince(
            p1SummonIdx,
            (m) =>
                m.type === 's2c_combat_event' &&
                m.event === 'companion_attack' &&
                m.actorId === p1CapturedRecord.uid &&
                m.targetId === assistTarget.id,
            5000,
            'companion_attack event'
        );
        assert.ok(compAttackEv.damage > 0, 'Expected companion_attack damage > 0');
        assert.ok(
            compAttackEv.remainingHp < targetInitialHp,
            `Expected monster HP to drop below ${targetInitialHp}, got ${compAttackEv.remainingHp}`
        );
        console.log(
            `  [PASS] Companion combat assist verified: attacked ${assistTarget.id} for ${compAttackEv.damage} dmg (HP ${targetInitialHp} -> ${compAttackEv.remainingHp})`
        );

        // Test recall_companion
        const p3RecallIdx = p3.markIndex();
        const p1RecallIdx = p1Reconn.markIndex();
        p1Reconn.sendCombatAction({
            action: 'recall_companion',
        });
        await p3.waitForMessageSince(
            p3RecallIdx,
            (m) =>
                m.type === 's2c_combat_event' &&
                m.event === 'companion_recall' &&
                m.actorId === p1Reconn.playerId &&
                m.targetId === p1CapturedRecord.uid,
            3000,
            'companion_recall broadcast'
        );
        const snapAfterRecall = await p1Reconn.waitForMessageSince(
            p1RecallIdx,
            (m) =>
                m.type === 's2c_room_snapshot' && (m.companions || []).length === 0,
            2500,
            'companions empty after recall'
        );
        assert.equal(snapAfterRecall.companions.length, 0);
        assert.equal(snapAfterRecall.localState.activeCompanionId, null);
        console.log('  [PASS] recall_companion removed companion across room snapshots');

        // Re-summon companion, then disconnect P1 permanently (let grace timer expire) and verify cleanup!
        const resummonIdx = p2Dup.markIndex();
        p1Reconn.sendCombatAction({
            action: 'summon_companion',
            companionUid: p1CapturedRecord.uid,
        });
        await p2Dup.waitForMessageSince(
            resummonIdx,
            (m) =>
                m.type === 's2c_room_snapshot' && (m.companions || []).length === 1,
            2500,
            'companion re-summoned before permanent disconnect'
        );

        const p2PermDiscIdx = p2Dup.markIndex();
        p1Reconn.ws.terminate();
        const [ownerLeftRecallEv, p1LeftEv] = await Promise.all([
            p2Dup.waitForMessageSince(
                p2PermDiscIdx,
                (m) =>
                    m.type === 's2c_combat_event' &&
                    m.event === 'companion_recall' &&
                    m.actorId === p1Reconn.playerId &&
                    m.reason === 'OWNER_LEFT',
                TEST_GRACE_MS + 2500,
                'companion_recall OWNER_LEFT on permanent disconnect'
            ),
            p2Dup.waitForMessageSince(
                p2PermDiscIdx,
                (m) =>
                    m.type === 's2c_player_left' &&
                    m.playerId === p1Reconn.playerId &&
                    m.reason === 'timeout',
                TEST_GRACE_MS + 2500,
                's2c_player_left timeout'
            ),
        ]);
        assert.equal(ownerLeftRecallEv.reason, 'OWNER_LEFT');
        assert.equal(p1LeftEv.reason, 'timeout');

        const snapAfterOwnerTimeout = await p2Dup.waitForMessageSince(
            p2PermDiscIdx,
            (m) =>
                m.type === 's2c_room_snapshot' && (m.companions || []).length === 0,
            2500,
            'companions cleaned up after owner timeout'
        );
        assert.equal(snapAfterOwnerTimeout.companions.length, 0);
        console.log(
            '  [PASS] Permanent disconnect cleanup verified: grace timeout evicted P1 and cleaned up active companion (OWNER_LEFT)'
        );

        results.companionLifecycle = {
            summonedUid: p1CapturedRecord.uid,
            assistTargetId: assistTarget.id,
            assistDamage: compAttackEv.damage,
            assistRemainingHp: compAttackEv.remainingHp,
            recalledCount: snapAfterRecall.companions.length,
            disconnectCleanupReason: ownerLeftRecallEv.reason,
        };

        p2Dup.close();
        p3.close();
    } finally {
        console.log('\n=== [3/3] Shutting Down Test Server Child Process ===');
        const exitPromise = new Promise((resolve) => {
            child.once('exit', (code, signal) => resolve({ code, signal }));
        });
        if (child.connected) {
            child.send('shutdown');
        } else {
            child.kill();
        }
        const exitStatus = await exitPromise;
        assert.equal(
            exitStatus.code,
            0,
            `Expected server child process to exit with code 0, got code=${exitStatus.code} signal=${exitStatus.signal}\nLogs: ${JSON.stringify(getLogs())}`
        );
        console.log('  [PASS] Test server child process exited cleanly with code 0');
        results.serverCleanExitCode = exitStatus.code;
    }

    return results;
}

async function runMainSuite() {
    const startedAt = Date.now();
    const assetAudit = runAssetAudit();
    const liveTests = await runLiveIntegrationTests();
    const elapsedMs = Date.now() - startedAt;

    console.log('\n============================================================');
    console.log(`ALL PHASE 3 VERIFICATION CHECKS PASSED in ${elapsedMs}ms`);
    console.log('============================================================');
    console.log(
        JSON.stringify(
            {
                status: 'PASS',
                elapsedMs,
                assetAudit,
                liveTests,
            },
            null,
            2
        )
    );
    process.exit(0);
}

if (process.argv.includes('--child-server')) {
    process.env.PORT = String(TEST_PORT);
    process.env.HOST = TEST_HOST;
    process.env.RECONNECT_GRACE_MS = String(TEST_GRACE_MS);
    process.env.MONSTER_RESPAWN_MS = String(TEST_RESPAWN_MS);

    const serverMod = await import('../server/index.mjs');
    process.on('message', (msg) => {
        if (msg === 'shutdown') {
            serverMod.shutdown();
        }
    });
    await serverMod.startServer(TEST_PORT, TEST_HOST);
    if (process.send) {
        process.send('listening');
    }
    setInterval(() => {}, 10_000);
} else {
    await runMainSuite();
}

