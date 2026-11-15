import * as pc from 'playcanvas';
import {
    ISLAND_MAX_RADIUS,
    PLAYER_MAX_HP,
    SLOT_PALETTE,
    type CombatEventKind,
    type PlayerCombatState,
    type PlayerSlotIndex,
    type PlayerSyncState,
} from '../shared/NetworkProtocol';
import type { ICollisionWorld, LoadedModelBundle } from '../types/interfaces';

export interface RemoteNameplateInfo {
    playerId: string;
    displayName: string;
    slotIndex: 0 | 1 | 2;
    colorHex: string;
    state: string;
    combatState: PlayerCombatState;
    hp: number;
    maxHp: number;
    connected: boolean;
    screenX: number;
    screenY: number;
    visible: boolean;
    distanceMeters: number;
}

const INTERP_DELAY_MS = 100;
const MAX_EXTRAPOLATION_MS = 220;
const TELEPORT_SNAP_METERS = 12;
const WALK_SPEED_REF = 5.8;
const SPRINT_SPEED_REF = 9.8;
const NAMEPLATE_HEAD_OFFSET_Y = 2.05;
const MODEL_YAW_OFFSET_DEG = 180;
const MAX_BUFFER_SNAPSHOTS = 32;
const BUFFER_RETENTION_MS = 1200;

const JOINT_NAMES = [
    'Root',
    'Hips',
    'Torso',
    'Head',
    'Backpack',
    'Cape',
    'Arm_L',
    'ForeArm_L',
    'Arm_R',
    'ForeArm_R',
    'Leg_L',
    'Shin_L',
    'Leg_R',
    'Shin_R',
] as const;

type JointName = (typeof JOINT_NAMES)[number];

type MaterialRole = 'cape' | 'tunic' | 'trim' | 'core' | 'other';

interface JointBinding {
    node: pc.GraphNode;
    restPos: pc.Vec3;
    restRot: pc.Quat;
}

interface ClonedMaterialEntry {
    material: pc.StandardMaterial;
    role: MaterialRole;
    baseDiffuse: pc.Color;
    baseEmissive: pc.Color;
    baseEmissiveIntensity: number;
    baseOpacity: number;
    baseBlendType: number;
    baseDepthWrite: boolean;
}

interface SnapshotSample {
    sampleTimeMs: number;
    seq: number;
    rawTimestampMs: number;
    position: pc.Vec3;
    velocity: pc.Vec3;
    yawDeg: number;
    animState: PlayerSyncState['animState'];
    grounded: boolean;
}

type LocomotionClipState = 'idle' | 'walk' | 'run' | 'jump' | 'fall';

function resolveLocomotionState(
    animState: PlayerSyncState['animState'],
    grounded: boolean,
    vx = 0,
    vz = 0
): LocomotionClipState {
    if (!grounded) return animState === 'jump' ? 'jump' : 'fall';
    if (
        animState === 'idle' ||
        animState === 'walk' ||
        animState === 'run' ||
        animState === 'jump' ||
        animState === 'fall'
    ) {
        return animState;
    }
    const speedSq = vx * vx + vz * vz;
    if (speedSq > 14) return 'run';
    if (speedSq > 0.12) return 'walk';
    return 'idle';
}

function resolveCombatStateFromSync(p: PlayerSyncState): PlayerCombatState {
    if (p.combatState && p.combatState !== 'idle') return p.combatState;
    if (
        p.animState === 'attack' ||
        p.animState === 'dodge' ||
        p.animState === 'hit' ||
        p.animState === 'throw'
    ) {
        return p.animState;
    }
    return 'idle';
}

interface RemotePlayerActor {
    playerId: string;
    displayName: string;
    slotIndex: PlayerSlotIndex;
    connected: boolean;
    state: PlayerSyncState['animState'];
    locomotionState: LocomotionClipState;
    grounded: boolean;
    hasInitialPosition: boolean;
    hp: number;
    maxHp: number;
    combatState: PlayerCombatState;
    lastCombatState: PlayerCombatState;
    combatAnimTimer: number;
    combatAnimDuration: number;
    combatSwingDir: number;
    hitFlashTimer: number;
    activeCueTint: 'slot' | 'hit' | 'dodge' | 'attack';

    rootEntity: pc.Entity;
    visualPivot: pc.Entity;
    modelEntity: pc.Entity;
    footRingEntity: pc.Entity;
    footRingMaterial: pc.StandardMaterial;
    clonedMaterials: ClonedMaterialEntry[];

    joints: Map<JointName, JointBinding>;
    animComponent: pc.AnimComponent | null;
    animClipMap: Map<'idle' | 'walk' | 'run' | 'jump', string>;
    activeAnimState: string | null;

    snapshots: SnapshotSample[];
    lastIngestedSeq: number;
    lastIngestedTimestampMs: number;
    lastIngestedPos: pc.Vec3;
    lastIngestedYawDeg: number;

    displayPos: pc.Vec3;
    displayVel: pc.Vec3;
    displayYawDeg: number;
    prevYawDeg: number;
    yawRateDegPerSec: number;
    wasGrounded: boolean;
    prevVelY: number;

    idleTime: number;
    stridePhase: number;
    locomotionBlend: number;
    runBlend: number;
    airBlend: number;
    idleNeutralBlend: number;
    landingSquash: number;

    lastAppliedConnected: boolean;
    lastPulseOpacity: number;
    pulsePhase: number;
}

function clamp(v: number, min: number, max: number): number {
    return v < min ? min : v > max ? max : v;
}

function lerp(a: number, b: number, t: number): number {
    return a + (b - a) * t;
}

function normalizeAngleDeg(angle: number): number {
    let a = ((angle % 360) + 540) % 360 - 180;
    if (a < -180) a += 360;
    return a;
}

function lerpAngleDeg(a: number, b: number, t: number): number {
    const diff = normalizeAngleDeg(b - a);
    return normalizeAngleDeg(a + diff * t);
}

function normalizeSlotIndex(slotIndex: number): PlayerSlotIndex {
    if (slotIndex === 1) return 1;
    if (slotIndex === 2) return 2;
    return 0;
}

function classifyMaterialRole(matName: string, entityName: string): MaterialRole {
    const m = matName.toLowerCase();
    const e = entityName.toLowerCase();

    if (m.includes('cape')) return 'cape';
    if (m.includes('aethercore') || m.includes('coreglow')) return 'core';
    if (m.includes('tunicteal') || m.includes('goggle')) return 'trim';
    if (m.includes('tunic')) return 'tunic';

    // When using procedural fallback materials (unnamed), inspect mesh entity names
    if (m.length === 0) {
        if (e.includes('cape_geo')) return 'cape';
        if (e.includes('core_geo')) return 'core';
        if (e.includes('bib_geo')) return 'trim';
        if (
            e.includes('torso_geo') ||
            e.includes('hips_geo') ||
            e.includes('arm_l_geo') ||
            e.includes('arm_r_geo') ||
            e.includes('leg_l_geo') ||
            e.includes('leg_r_geo')
        ) {
            return 'tunic';
        }
    }

    return 'other';
}

export class RemotePlayerManager {
    private readonly app: pc.Application;
    private readonly collisionWorld: ICollisionWorld;
    private readonly playerBundle: LoadedModelBundle;

    private readonly actors = new Map<string, RemotePlayerActor>();
    private readonly footRingMesh: pc.Mesh;

    private simClockMs = 0;
    private clockOffsetMs = 0;
    private hasClockAnchor = false;
    private disposed = false;

    private readonly tmpHeadWorld = new pc.Vec3();
    private readonly tmpScreen = new pc.Vec3();
    private readonly tmpToHead = new pc.Vec3();
    private readonly tmpVec = new pc.Vec3();
    private readonly tmpQuat = new pc.Quat();
    private readonly tmpRotQuat = new pc.Quat();

    private readonly onPostUpdateBound: () => void;

    constructor(
        app: pc.Application,
        collisionWorld: ICollisionWorld,
        playerBundle: LoadedModelBundle
    ) {
        this.app = app;
        this.collisionWorld = collisionWorld;
        this.playerBundle = playerBundle;

        this.footRingMesh = pc.Mesh.fromGeometry(
            this.app.graphicsDevice,
            new pc.TorusGeometry({
                tubeRadius: 0.032,
                ringRadius: 0.56,
                segments: 28,
                sides: 8,
            })
        );
        this.footRingMesh.incRefCount();

        this.onPostUpdateBound = () => {
            this.applyAllProceduralPolish();
        };
        this.app.on('postupdate', this.onPostUpdateBound);
    }

    public syncRoomPlayers(
        localPlayerId: string,
        players: PlayerSyncState[],
        serverTimestampMs: number
    ): void {
        if (this.disposed) return;

        const safeServerMs = Number.isFinite(serverTimestampMs)
            ? serverTimestampMs
            : Date.now();
        if (!this.hasClockAnchor) {
            this.clockOffsetMs = this.simClockMs - safeServerMs;
            this.hasClockAnchor = true;
        } else {
            const expectedServerMs = this.simClockMs - this.clockOffsetMs;
            const driftMs = safeServerMs - expectedServerMs;
            if (Math.abs(driftMs) > 1000) {
                this.clockOffsetMs = this.simClockMs - safeServerMs;
            } else {
                this.clockOffsetMs = lerp(
                    this.clockOffsetMs,
                    this.simClockMs - safeServerMs,
                    0.08
                );
            }
        }
        const sampleTimeMs = safeServerMs + this.clockOffsetMs;

        const activeRemoteIds = new Set<string>();

        for (const p of players) {
            if (!p || p.playerId === localPlayerId) continue;
            activeRemoteIds.add(p.playerId);

            const slotIndex = normalizeSlotIndex(p.slotIndex);
            let actor = this.actors.get(p.playerId);
            if (!actor) {
                actor = this.createActor(p, slotIndex);
                this.actors.set(p.playerId, actor);
            }

            actor.displayName = p.displayName || `Explorer ${slotIndex + 1}`;
            actor.connected = p.connected;
            actor.state = p.animState;
            actor.locomotionState = resolveLocomotionState(
                p.animState,
                p.grounded,
                p.velocity.x,
                p.velocity.z
            );
            actor.grounded = p.grounded;

            const incomingHp =
                typeof p.hp === 'number' && Number.isFinite(p.hp) ? p.hp : actor.hp;
            const incomingMaxHp =
                typeof p.maxHp === 'number' && Number.isFinite(p.maxHp) && p.maxHp > 0
                    ? p.maxHp
                    : actor.maxHp;
            const tookDamage = incomingHp < actor.hp - 0.1;
            actor.hp = Math.max(0, Math.min(incomingMaxHp, incomingHp));
            actor.maxHp = incomingMaxHp;

            const incomingCombatState = resolveCombatStateFromSync(p);
            actor.combatState = incomingCombatState;
            if (tookDamage) {
                this.startRemoteCombatCue(actor, 'hit');
            } else if (
                incomingCombatState !== 'idle' &&
                incomingCombatState !== actor.lastCombatState
            ) {
                this.startRemoteCombatCue(actor, incomingCombatState);
            }
            actor.lastCombatState = incomingCombatState;

            if (actor.slotIndex !== slotIndex) {
                actor.slotIndex = slotIndex;
                this.applySlotTint(actor, slotIndex);
            }

            if (actor.lastAppliedConnected !== p.connected) {
                this.applyConnectedVisualState(actor, p.connected);
            }

            const posChanged =
                Math.abs(p.position.x - actor.lastIngestedPos.x) > 1e-4 ||
                Math.abs(p.position.y - actor.lastIngestedPos.y) > 1e-4 ||
                Math.abs(p.position.z - actor.lastIngestedPos.z) > 1e-4;
            const yawChanged = Math.abs(p.yawDeg - actor.lastIngestedYawDeg) > 1e-2;
            const seqChanged = p.seq !== actor.lastIngestedSeq;
            const tsChanged = p.timestampMs !== actor.lastIngestedTimestampMs;
            const lastSnap = actor.snapshots[actor.snapshots.length - 1];
            const stateChanged =
                !lastSnap ||
                p.animState !== lastSnap.animState ||
                p.grounded !== lastSnap.grounded;

            if (
                !actor.hasInitialPosition ||
                seqChanged ||
                tsChanged ||
                posChanged ||
                yawChanged ||
                stateChanged
            ) {
                this.pushSnapshot(actor, p, sampleTimeMs);
            }
        }

        // Remove remote players that have left the room
        for (const [id, actor] of this.actors.entries()) {
            if (!activeRemoteIds.has(id)) {
                this.destroyActor(actor);
                this.actors.delete(id);
            }
        }
    }

    public update(
        dt: number,
        cameraEntity: pc.Entity,
        canvasWidth: number,
        canvasHeight: number
    ): RemoteNameplateInfo[] {
        if (this.disposed) return [];

        const clampedDt = Math.max(0.0001, Math.min(0.05, dt));
        this.simClockMs += clampedDt * 1000;
        const renderTimeMs = this.simClockMs - INTERP_DELAY_MS;

        const nameplates: RemoteNameplateInfo[] = [];
        const camera = cameraEntity?.camera ?? null;
        const camPos = cameraEntity?.getPosition() ?? null;
        const camForward = cameraEntity?.forward ?? null;
        const farClip = camera?.farClip ?? 180;

        for (const actor of this.actors.values()) {
            this.updateActorTransformAndAnim(actor, clampedDt, renderTimeMs);
            nameplates.push(
                this.buildNameplate(
                    actor,
                    camera,
                    camPos,
                    camForward,
                    farClip,
                    canvasWidth,
                    canvasHeight
                )
            );
        }

        nameplates.sort((a, b) => a.slotIndex - b.slotIndex);
        return nameplates;
    }

    public getRemotePlayerCount(): number {
        return this.actors.size;
    }

    public dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.app.off('postupdate', this.onPostUpdateBound);

        for (const actor of this.actors.values()) {
            this.destroyActor(actor);
        }
        this.actors.clear();

        this.footRingMesh.decRefCount();
    }

    private createActor(
        initialState: PlayerSyncState,
        slotIndex: PlayerSlotIndex
    ): RemotePlayerActor {
        const rootEntity = new pc.Entity(`RemotePlayer_${initialState.playerId}`);
        const visualPivot = new pc.Entity('RemoteVisualPivot');
        const modelEntity = this.playerBundle.instantiate(
            `remote_explorer_${initialState.playerId}`
        );
        modelEntity.setLocalEulerAngles(0, MODEL_YAW_OFFSET_DEG, 0);
        visualPivot.addChild(modelEntity);
        rootEntity.addChild(visualPivot);

        const palette = SLOT_PALETTE[slotIndex] ?? SLOT_PALETTE[0];
        const footRingMaterial = new pc.StandardMaterial();
        footRingMaterial.name = `RemoteSlotRingMat_${initialState.playerId}`;
        footRingMaterial.diffuse = new pc.Color(palette.rgb[0], palette.rgb[1], palette.rgb[2]);
        footRingMaterial.emissive = new pc.Color(palette.rgb[0], palette.rgb[1], palette.rgb[2]);
        footRingMaterial.emissiveIntensity = 1.7;
        footRingMaterial.opacity = 0.86;
        footRingMaterial.blendType = pc.BLEND_NORMAL;
        footRingMaterial.depthWrite = false;
        footRingMaterial.useLighting = false;
        footRingMaterial.update();

        const footRingEntity = new pc.Entity('SlotFootRing');
        footRingEntity.addComponent('render', {
            meshInstances: [new pc.MeshInstance(this.footRingMesh, footRingMaterial)],
            castShadows: false,
            receiveShadows: false,
        });
        footRingEntity.setLocalPosition(0, 0.05, 0);
        rootEntity.addChild(footRingEntity);

        const clonedMaterials = this.cloneAndCollectMaterials(modelEntity);
        const joints = this.bindJointNodes(modelEntity);
        const { animComponent, animClipMap, activeAnimState } = this.setupGlbAnimations(
            modelEntity,
            this.playerBundle
        );

        const startX = initialState.position.x;
        const startY = initialState.position.y;
        const startZ = initialState.position.z;
        rootEntity.setPosition(startX, startY, startZ);
        rootEntity.setLocalEulerAngles(0, initialState.yawDeg, 0);
        this.app.root.addChild(rootEntity);

        const actor: RemotePlayerActor = {
            playerId: initialState.playerId,
            displayName: initialState.displayName || `Explorer ${slotIndex + 1}`,
            slotIndex,
            connected: initialState.connected,
            state: initialState.animState,
            grounded: initialState.grounded,
            hasInitialPosition: false,

            rootEntity,
            visualPivot,
            modelEntity,
            footRingEntity,
            footRingMaterial,
            clonedMaterials,

            joints,
            animComponent,
            animClipMap,
            activeAnimState,

            snapshots: [],
            lastIngestedSeq: initialState.seq - 1,
            lastIngestedTimestampMs: initialState.timestampMs - 1,
            lastIngestedPos: new pc.Vec3(startX, startY, startZ),
            lastIngestedYawDeg: initialState.yawDeg,

            displayPos: new pc.Vec3(startX, startY, startZ),
            displayVel: new pc.Vec3(
                initialState.velocity.x,
                initialState.velocity.y,
                initialState.velocity.z
            ),
            displayYawDeg: initialState.yawDeg,
            prevYawDeg: initialState.yawDeg,
            yawRateDegPerSec: 0,
            wasGrounded: initialState.grounded,
            prevVelY: initialState.velocity.y,

            locomotionState: resolveLocomotionState(
                initialState.animState,
                initialState.grounded,
                initialState.velocity.x,
                initialState.velocity.z
            ),
            hp:
                typeof initialState.hp === 'number' && Number.isFinite(initialState.hp)
                    ? initialState.hp
                    : PLAYER_MAX_HP,
            maxHp:
                typeof initialState.maxHp === 'number' &&
                Number.isFinite(initialState.maxHp) &&
                initialState.maxHp > 0
                    ? initialState.maxHp
                    : PLAYER_MAX_HP,
            combatState: resolveCombatStateFromSync(initialState),
            lastCombatState: resolveCombatStateFromSync(initialState),
            combatAnimTimer: 0,
            combatAnimDuration: 0.34,
            combatSwingDir: 1,
            hitFlashTimer: 0,
            activeCueTint: 'slot',

            idleTime: 0,
            stridePhase: 0,
            locomotionBlend: 0,
            runBlend: 0,
            airBlend: initialState.grounded ? 0 : 1,
            idleNeutralBlend: initialState.animState === 'idle' ? 1 : 0,
            landingSquash: 0,

            lastAppliedConnected: true,
            lastPulseOpacity: 1,
            pulsePhase: slotIndex * 1.4,
        };

        this.applySlotTint(actor, slotIndex);
        if (!initialState.connected) {
            this.applyConnectedVisualState(actor, false);
        }

        return actor;
    }

    private destroyActor(actor: RemotePlayerActor): void {
        actor.rootEntity.destroy();
        actor.footRingMaterial.destroy();
        for (const entry of actor.clonedMaterials) {
            entry.material.destroy();
        }
        actor.clonedMaterials.length = 0;
    }

    private cloneAndCollectMaterials(modelEntity: pc.Entity): ClonedMaterialEntry[] {
        const entries: ClonedMaterialEntry[] = [];
        const sourceToClone = new Map<pc.Material, ClonedMaterialEntry>();

        const visit = (node: pc.GraphNode): void => {
            if (node instanceof pc.Entity && node.render) {
                for (const mi of node.render.meshInstances) {
                    const orig = mi.material;
                    if (!(orig instanceof pc.StandardMaterial)) continue;

                    let clonedEntry = sourceToClone.get(orig);
                    if (!clonedEntry) {
                        const cloned = orig.clone();
                        cloned.name = `${orig.name || 'Mat'}_RemoteClone`;
                        clonedEntry = {
                            material: cloned,
                            role: classifyMaterialRole(orig.name || '', node.name),
                            baseDiffuse: orig.diffuse.clone(),
                            baseEmissive: orig.emissive.clone(),
                            baseEmissiveIntensity: orig.emissiveIntensity,
                            baseOpacity: orig.opacity,
                            baseBlendType: orig.blendType,
                            baseDepthWrite: orig.depthWrite,
                        };
                        sourceToClone.set(orig, clonedEntry);
                        entries.push(clonedEntry);
                    }
                    mi.material = clonedEntry.material;
                }
            }
            for (const child of node.children) {
                visit(child);
            }
        };

        visit(modelEntity);
        return entries;
    }

    private applySlotTint(actor: RemotePlayerActor, slotIndex: PlayerSlotIndex): void {
        const palette = SLOT_PALETTE[slotIndex] ?? SLOT_PALETTE[0];
        const [sr, sg, sb] = palette.rgb;

        actor.footRingMaterial.diffuse.set(sr, sg, sb);
        actor.footRingMaterial.emissive.set(sr, sg, sb);
        actor.footRingMaterial.update();

        for (const entry of actor.clonedMaterials) {
            const mat = entry.material;
            if (entry.role === 'cape') {
                mat.diffuse.set(
                    lerp(entry.baseDiffuse.r, sr, 0.86),
                    lerp(entry.baseDiffuse.g, sg, 0.86),
                    lerp(entry.baseDiffuse.b, sb, 0.86)
                );
                mat.emissive.set(sr * 0.16, sg * 0.16, sb * 0.16);
                mat.emissiveIntensity = 1.0;
                mat.update();
            } else if (entry.role === 'tunic') {
                mat.diffuse.set(
                    lerp(entry.baseDiffuse.r, sr, 0.72),
                    lerp(entry.baseDiffuse.g, sg, 0.72),
                    lerp(entry.baseDiffuse.b, sb, 0.72)
                );
                mat.update();
            } else if (entry.role === 'trim') {
                mat.diffuse.set(
                    lerp(entry.baseDiffuse.r, sr, 0.65),
                    lerp(entry.baseDiffuse.g, sg, 0.65),
                    lerp(entry.baseDiffuse.b, sb, 0.65)
                );
                mat.update();
            } else if (entry.role === 'core') {
                mat.diffuse.set(sr, sg, sb);
                mat.emissive.set(sr, sg, sb);
                mat.emissiveIntensity = Math.max(2.2, entry.baseEmissiveIntensity);
                mat.update();
            }
        }
    }

    private applyConnectedVisualState(
        actor: RemotePlayerActor,
        connected: boolean
    ): void {
        actor.lastAppliedConnected = connected;

        if (connected) {
            actor.lastPulseOpacity = 1;
            actor.footRingMaterial.opacity = 0.86;
            actor.footRingMaterial.emissiveIntensity = 1.7;
            actor.footRingMaterial.update();

            for (const entry of actor.clonedMaterials) {
                const mat = entry.material;
                mat.opacity = entry.baseOpacity;
                mat.blendType = entry.baseBlendType;
                mat.depthWrite = entry.baseDepthWrite;
                mat.update();
            }
        } else {
            const dimOpacity = 0.5;
            actor.lastPulseOpacity = dimOpacity;
            actor.footRingMaterial.opacity = 0.4;
            actor.footRingMaterial.emissiveIntensity = 0.85;
            actor.footRingMaterial.update();

            for (const entry of actor.clonedMaterials) {
                const mat = entry.material;
                mat.blendType = pc.BLEND_NORMAL;
                mat.depthWrite = false;
                mat.opacity = dimOpacity;
                mat.update();
            }
        }
    }

    private pushSnapshot(
        actor: RemotePlayerActor,
        p: PlayerSyncState,
        sampleTimeMs: number
    ): void {
        const last = actor.snapshots[actor.snapshots.length - 1];
        const monotonicTimeMs = last
            ? Math.max(sampleTimeMs, last.sampleTimeMs + 1)
            : sampleTimeMs;

        // If the remote peer was idle/unchanged for >140ms, insert a hold anchor
        // right before the new snapshot so interpolation starts smoothly now.
        if (last && monotonicTimeMs - last.sampleTimeMs > 140) {
            actor.snapshots.push({
                sampleTimeMs: monotonicTimeMs - 67,
                seq: last.seq,
                rawTimestampMs: last.rawTimestampMs,
                position: last.position.clone(),
                velocity: last.velocity.clone(),
                yawDeg: last.yawDeg,
                animState: last.animState,
                grounded: last.grounded,
            });
        }

        actor.snapshots.push({
            sampleTimeMs: monotonicTimeMs,
            seq: p.seq,
            rawTimestampMs: p.timestampMs,
            position: new pc.Vec3(p.position.x, p.position.y, p.position.z),
            velocity: new pc.Vec3(p.velocity.x, p.velocity.y, p.velocity.z),
            yawDeg: normalizeAngleDeg(p.yawDeg),
            animState: p.animState,
            grounded: p.grounded,
        });

        while (actor.snapshots.length > MAX_BUFFER_SNAPSHOTS) {
            actor.snapshots.shift();
        }

        if (!actor.hasInitialPosition) {
            actor.hasInitialPosition = true;
            actor.displayPos.set(p.position.x, p.position.y, p.position.z);
            actor.displayVel.set(p.velocity.x, p.velocity.y, p.velocity.z);
            actor.displayYawDeg = normalizeAngleDeg(p.yawDeg);
            actor.prevYawDeg = actor.displayYawDeg;
            actor.rootEntity.setPosition(actor.displayPos);
            actor.rootEntity.setLocalEulerAngles(0, actor.displayYawDeg, 0);
        }

        actor.lastIngestedSeq = p.seq;
        actor.lastIngestedTimestampMs = p.timestampMs;
        actor.lastIngestedPos.set(p.position.x, p.position.y, p.position.z);
        actor.lastIngestedYawDeg = p.yawDeg;
    }

    private updateActorTransformAndAnim(
        actor: RemotePlayerActor,
        dt: number,
        renderTimeMs: number
    ): void {
        actor.idleTime += dt;
        actor.prevYawDeg = actor.displayYawDeg;
        const prevDisplayX = actor.displayPos.x;
        const prevDisplayZ = actor.displayPos.z;

        // Prune stale snapshots older than BUFFER_RETENTION_MS while keeping at least 2
        while (
            actor.snapshots.length > 2 &&
            actor.snapshots[1].sampleTimeMs < renderTimeMs - BUFFER_RETENTION_MS
        ) {
            actor.snapshots.shift();
        }

        const snaps = actor.snapshots;
        if (snaps.length > 0) {
            const first = snaps[0];
            const last = snaps[snaps.length - 1];

            if (renderTimeMs <= first.sampleTimeMs) {
                this.applyTargetSample(
                    actor,
                    first.position,
                    first.velocity,
                    first.yawDeg,
                    first.animState,
                    first.grounded
                );
            } else if (renderTimeMs >= last.sampleTimeMs) {
                const rawExtrapMs = renderTimeMs - last.sampleTimeMs;
                const maxExtrap = actor.connected ? MAX_EXTRAPOLATION_MS : 40;
                const extrapSec = Math.min(maxExtrap, Math.max(0, rawExtrapMs)) / 1000;

                this.tmpVec.set(
                    last.position.x + last.velocity.x * extrapSec,
                    last.position.y + last.velocity.y * extrapSec,
                    last.position.z + last.velocity.z * extrapSec
                );

                // Clamp extrapolated planar position to playable island boundary
                const planarDist = Math.hypot(this.tmpVec.x, this.tmpVec.z);
                if (planarDist > ISLAND_MAX_RADIUS) {
                    const s = ISLAND_MAX_RADIUS / planarDist;
                    this.tmpVec.x *= s;
                    this.tmpVec.z *= s;
                }
                const terrainY = this.collisionWorld.getTerrainHeight(
                    this.tmpVec.x,
                    this.tmpVec.z
                );
                const lastTerrainY = this.collisionWorld.getTerrainHeight(
                    last.position.x,
                    last.position.z
                );
                if (
                    this.tmpVec.y < terrainY ||
                    (last.grounded && Math.abs(last.position.y - lastTerrainY) < 0.25)
                ) {
                    this.tmpVec.y = terrainY;
                }

                this.applyTargetSample(
                    actor,
                    this.tmpVec,
                    last.velocity,
                    last.yawDeg,
                    last.animState,
                    last.grounded
                );
            } else {
                // Find bracketing pair [a, b]
                let idx = snaps.length - 2;
                for (let i = 0; i < snaps.length - 1; i++) {
                    if (
                        renderTimeMs >= snaps[i].sampleTimeMs &&
                        renderTimeMs <= snaps[i + 1].sampleTimeMs
                    ) {
                        idx = i;
                        break;
                    }
                }
                const a = snaps[idx];
                const b = snaps[idx + 1];
                const segDistSq =
                    (b.position.x - a.position.x) * (b.position.x - a.position.x) +
                    (b.position.y - a.position.y) * (b.position.y - a.position.y) +
                    (b.position.z - a.position.z) * (b.position.z - a.position.z);

                if (segDistSq > TELEPORT_SNAP_METERS * TELEPORT_SNAP_METERS) {
                    this.applyTargetSample(
                        actor,
                        b.position,
                        b.velocity,
                        b.yawDeg,
                        b.animState,
                        b.grounded
                    );
                } else {
                    const span = Math.max(1, b.sampleTimeMs - a.sampleTimeMs);
                    const t = clamp((renderTimeMs - a.sampleTimeMs) / span, 0, 1);

                    this.tmpVec.set(
                        lerp(a.position.x, b.position.x, t),
                        lerp(a.position.y, b.position.y, t),
                        lerp(a.position.z, b.position.z, t)
                    );
                    const interpVelX = lerp(a.velocity.x, b.velocity.x, t);
                    const interpVelY = lerp(a.velocity.y, b.velocity.y, t);
                    const interpVelZ = lerp(a.velocity.z, b.velocity.z, t);
                    const interpYaw = lerpAngleDeg(a.yawDeg, b.yawDeg, t);
                    const activeState = t < 0.5 ? a.animState : b.animState;
                    const activeGrounded = t < 0.5 ? a.grounded : b.grounded;

                    actor.displayVel.set(interpVelX, interpVelY, interpVelZ);
                    this.applyTargetSample(
                        actor,
                        this.tmpVec,
                        actor.displayVel,
                        interpYaw,
                        activeState,
                        activeGrounded
                    );
                }
            }
        }

        // Apply world transform & angular velocity tracking
        actor.rootEntity.setPosition(actor.displayPos);
        actor.rootEntity.setLocalEulerAngles(0, actor.displayYawDeg, 0);
        actor.yawRateDegPerSec =
            normalizeAngleDeg(actor.displayYawDeg - actor.prevYawDeg) / dt;

        // Subtle foot ring rotation & reconnect pulsing
        actor.footRingEntity.rotate(0, 32 * dt, 0);
        if (!actor.connected) {
            const pulse = 0.48 + 0.16 * Math.sin(actor.idleTime * 5.2 + actor.pulsePhase);
            const ringScale = 0.94 + 0.08 * Math.sin(actor.idleTime * 5.2 + actor.pulsePhase);
            actor.footRingEntity.setLocalScale(ringScale, 1, ringScale);
            if (Math.abs(pulse - actor.lastPulseOpacity) > 0.03) {
                actor.lastPulseOpacity = pulse;
                actor.footRingMaterial.opacity = pulse * 0.85;
                actor.footRingMaterial.update();
                for (const entry of actor.clonedMaterials) {
                    entry.material.opacity = pulse;
                    entry.material.update();
                }
            }
        } else {
            actor.footRingEntity.setLocalScale(1, 1, 1);
        }

        // Landing squash detection
        if (actor.grounded && !actor.wasGrounded && actor.prevVelY < -2.2) {
            actor.landingSquash = Math.min(1.0, Math.abs(actor.prevVelY) / 14.0);
        }
        actor.wasGrounded = actor.grounded;
        actor.prevVelY = actor.displayVel.y;

        // Animation timers & GLB AnimComponent
        const deltaPlanar = Math.hypot(
            actor.displayPos.x - prevDisplayX,
            actor.displayPos.z - prevDisplayZ
        );
        const actualHorizSpeed =
            deltaPlanar < TELEPORT_SNAP_METERS ? deltaPlanar / dt : 0;
        const horizSpeed = Math.max(
            Math.hypot(actor.displayVel.x, actor.displayVel.z),
            actualHorizSpeed
        );
        const isRunning = actor.state === 'run' || horizSpeed > WALK_SPEED_REF + 0.6;
        const targetLocomotion = actor.grounded
            ? clamp(
                  actor.state === 'idle'
                      ? 0
                      : Math.max(horizSpeed / WALK_SPEED_REF, actor.state === 'walk' ? 0.55 : 1),
                  0,
                  1
              )
            : 0;
        const targetRun =
            actor.grounded && isRunning
                ? clamp(
                      Math.max(
                          (horizSpeed - WALK_SPEED_REF) /
                              (SPRINT_SPEED_REF - WALK_SPEED_REF),
                          actor.state === 'run' ? 0.75 : 0
                      ),
                      0,
                      1
                  )
                : 0;
        const targetAir = actor.grounded ? 0 : 1;
        const targetIdleNeutral =
            actor.grounded && actor.locomotionState === 'idle' && actor.combatAnimTimer <= 0
                ? 1
                : 0;

        const blendRate = 1 - Math.exp(-12 * dt);
        actor.locomotionBlend = lerp(actor.locomotionBlend, targetLocomotion, blendRate);
        actor.runBlend = lerp(actor.runBlend, targetRun, blendRate);
        actor.airBlend = lerp(actor.airBlend, targetAir, 1 - Math.exp(-14 * dt));
        actor.idleNeutralBlend = lerp(
            actor.idleNeutralBlend,
            targetIdleNeutral,
            1 - Math.exp(-10 * dt)
        );

        if (
            actor.grounded &&
            (horizSpeed > 0.2 ||
                actor.locomotionState === 'walk' ||
                actor.locomotionState === 'run')
        ) {
            const strideFreq = lerp(7.2, 13.0, actor.runBlend);
            actor.stridePhase += dt * strideFreq;
        }

        if (actor.combatAnimTimer > 0) {
            actor.combatAnimTimer = Math.max(0, actor.combatAnimTimer - dt);
            if (actor.combatAnimTimer <= 0 && actor.combatState !== 'idle') {
                actor.combatState = 'idle';
            }
        }
        if (actor.hitFlashTimer > 0) {
            actor.hitFlashTimer = Math.max(0, actor.hitFlashTimer - dt);
        }
        this.updateActorCombatTint(actor);

        actor.landingSquash = Math.max(0, actor.landingSquash - dt * 5.2);
        this.updateActorGlbAnim(actor, horizSpeed);
    }

    private applyTargetSample(
        actor: RemotePlayerActor,
        targetPos: pc.Vec3,
        targetVel: pc.Vec3,
        targetYawDeg: number,
        targetState: PlayerSyncState['animState'],
        targetGrounded: boolean
    ): void {
        const snapSq =
            (targetPos.x - actor.displayPos.x) * (targetPos.x - actor.displayPos.x) +
            (targetPos.y - actor.displayPos.y) * (targetPos.y - actor.displayPos.y) +
            (targetPos.z - actor.displayPos.z) * (targetPos.z - actor.displayPos.z);

        if (snapSq > TELEPORT_SNAP_METERS * TELEPORT_SNAP_METERS) {
            actor.landingSquash = 0;
        }
        actor.displayPos.copy(targetPos);
        actor.displayYawDeg = targetYawDeg;
        actor.displayVel.copy(targetVel);
        actor.state = targetState;
        actor.grounded = targetGrounded;
    }

    /**
     * Immediately surface a combat cue or HP update on a remote player from a server combat event.
     */
    public triggerRemoteCombatCue(
        playerId: string,
        kind: CombatEventKind | PlayerCombatState,
        hp?: number,
        maxHp?: number
    ): void {
        const actor = this.actors.get(playerId);
        if (!actor) return;

        if (typeof maxHp === 'number' && Number.isFinite(maxHp) && maxHp > 0) {
            actor.maxHp = maxHp;
        }
        if (typeof hp === 'number' && Number.isFinite(hp)) {
            actor.hp = Math.max(0, Math.min(actor.maxHp, hp));
        }

        if (kind === 'melee_hit' || kind === 'ranged_cast' || kind === 'attack') {
            this.startRemoteCombatCue(actor, 'attack');
        } else if (kind === 'player_dodge' || kind === 'dodge') {
            this.startRemoteCombatCue(actor, 'dodge');
        } else if (
            kind === 'player_hit' ||
            kind === 'monster_attack_hit' ||
            kind === 'hit'
        ) {
            this.startRemoteCombatCue(actor, 'hit');
        } else if (kind === 'capture_throw' || kind === 'throw') {
            this.startRemoteCombatCue(actor, 'throw');
        } else if (kind === 'player_respawn') {
            actor.combatState = 'idle';
            actor.combatAnimTimer = 0;
            actor.hitFlashTimer = 0;
            actor.hp = actor.maxHp;
            this.updateActorCombatTint(actor);
        }
    }

    private startRemoteCombatCue(actor: RemotePlayerActor, state: PlayerCombatState): void {
        if (state === 'idle') return;
        actor.combatState = state;
        if (state === 'attack') {
            actor.combatSwingDir = actor.combatSwingDir >= 0 ? -1 : 1;
            actor.combatAnimDuration = 0.34;
            actor.combatAnimTimer = 0.34;
        } else if (state === 'dodge') {
            actor.combatAnimDuration = 0.42;
            actor.combatAnimTimer = 0.42;
        } else if (state === 'hit') {
            actor.combatAnimDuration = 0.30;
            actor.combatAnimTimer = 0.30;
            actor.hitFlashTimer = 0.24;
        } else if (state === 'throw') {
            actor.combatAnimDuration = 0.36;
            actor.combatAnimTimer = 0.36;
        }
    }

    private updateActorCombatTint(actor: RemotePlayerActor): void {
        let desiredTint: RemotePlayerActor['activeCueTint'] = 'slot';
        if (actor.hitFlashTimer > 0) {
            desiredTint = 'hit';
        } else if (actor.combatAnimTimer > 0 && actor.combatState === 'dodge') {
            desiredTint = 'dodge';
        } else if (
            actor.combatAnimTimer > 0 &&
            (actor.combatState === 'attack' || actor.combatState === 'throw')
        ) {
            desiredTint = 'attack';
        }

        if (desiredTint === 'slot') {
            if (actor.activeCueTint !== 'slot') {
                actor.activeCueTint = 'slot';
                actor.footRingEntity.setLocalScale(1, 1, 1);
                this.applySlotTint(actor, actor.slotIndex);
            }
            return;
        }

        actor.activeCueTint = desiredTint;
        if (desiredTint === 'hit') {
            actor.footRingMaterial.emissive.set(1.0, 0.24, 0.2);
            actor.footRingMaterial.opacity = 0.95;
            actor.footRingEntity.setLocalScale(1.16, 1, 1.16);
        } else if (desiredTint === 'dodge') {
            actor.footRingMaterial.emissive.set(0.42, 0.92, 1.0);
            actor.footRingMaterial.opacity = 0.92;
            actor.footRingEntity.setLocalScale(1.24, 1, 1.24);
        } else {
            actor.footRingMaterial.emissive.set(1.0, 0.78, 0.32);
            actor.footRingMaterial.opacity = 0.88;
            actor.footRingEntity.setLocalScale(1.12, 1, 1.12);
        }
        actor.footRingMaterial.update();
    }

    private updateActorGlbAnim(actor: RemotePlayerActor, horizSpeed: number): void {
        if (!actor.animComponent || !actor.animComponent.baseLayer) return;

        let targetClip: string | undefined;
        if (
            !actor.grounded ||
            actor.locomotionState === 'jump' ||
            actor.locomotionState === 'fall'
        ) {
            targetClip =
                actor.animClipMap.get('jump') ??
                actor.animClipMap.get('run') ??
                actor.animClipMap.get('idle');
        } else if (
            actor.locomotionState === 'run' ||
            (actor.combatState === 'dodge' && actor.combatAnimTimer > 0)
        ) {
            targetClip =
                actor.animClipMap.get('run') ??
                actor.animClipMap.get('walk') ??
                actor.animClipMap.get('idle');
        } else if (actor.locomotionState === 'walk') {
            targetClip = actor.animClipMap.get('walk') ?? actor.animClipMap.get('idle');
        } else {
            targetClip = actor.animClipMap.get('idle');
        }

        if (targetClip && targetClip !== actor.activeAnimState) {
            actor.activeAnimState = targetClip;
            actor.animComponent.baseLayer.transition(targetClip, 0.16);
        }

        if (actor.activeAnimState === 'walk') {
            actor.animComponent.speed = clamp(
                Math.max(horizSpeed, 3.2) / WALK_SPEED_REF,
                0.55,
                1.35
            );
        } else if (actor.activeAnimState === 'run') {
            actor.animComponent.speed = clamp(
                Math.max(horizSpeed, 6.8) / SPRINT_SPEED_REF,
                0.75,
                1.3
            );
        } else {
            actor.animComponent.speed = 1.0;
        }
    }

    private applyAllProceduralPolish(): void {
        if (this.disposed) return;
        for (const actor of this.actors.values()) {
            this.applyActorProceduralPolish(actor);
        }
    }

    private applyActorProceduralPolish(actor: RemotePlayerActor): void {
        const forwardLean =
            actor.locomotionBlend * lerp(5, 13, actor.runBlend) +
            actor.airBlend * (actor.displayVel.y > 0 ? -4 : 6);
        const turnBank =
            clamp(actor.yawRateDegPerSec * 0.045, -10, 10) * actor.locomotionBlend;

        const squashY = 1 - actor.landingSquash * 0.2;
        const squashXZ = 1 + actor.landingSquash * 0.14;

        let combatPitch = 0;
        let combatRoll = 0;
        let combatScaleXZ = 1;
        let combatScaleY = 1;
        if (actor.combatAnimTimer > 0 && actor.combatAnimDuration > 0) {
            const p = 1 - actor.combatAnimTimer / actor.combatAnimDuration;
            const pulse = Math.sin(p * Math.PI);
            if (actor.combatState === 'dodge') {
                combatPitch = 16 * pulse;
                combatScaleXZ = 1.08;
                combatScaleY = 0.86;
            } else if (actor.combatState === 'hit') {
                combatPitch = -14 * pulse;
                combatRoll = 8 * Math.sin(p * Math.PI * 3);
                combatScaleXZ = 1 + 0.08 * pulse;
                combatScaleY = 1 - 0.08 * pulse;
            } else if (actor.combatState === 'attack') {
                combatPitch = 10 * pulse;
                combatRoll = -6 * actor.combatSwingDir * pulse;
            } else if (actor.combatState === 'throw') {
                combatPitch = 8 * pulse;
            }
        }

        actor.visualPivot.setLocalEulerAngles(-forwardLean - combatPitch, 0, turnBank + combatRoll);
        actor.visualPivot.setLocalScale(squashXZ * combatScaleXZ, squashY * combatScaleY, squashXZ * combatScaleXZ);

        const mappedClipKey: 'idle' | 'walk' | 'run' | 'jump' =
            actor.locomotionState === 'fall' || actor.locomotionState === 'jump' || !actor.grounded
                ? 'jump'
                : actor.locomotionState === 'run'
                  ? 'run'
                  : actor.locomotionState === 'walk'
                    ? 'walk'
                    : 'idle';
        const glbDrivingActive =
            actor.animComponent !== null &&
            actor.activeAnimState !== null &&
            actor.animClipMap.has(mappedClipKey);

        const phase = actor.stridePhase;
        const strideSin = Math.sin(phase);
        const strideCos = Math.cos(phase);
        const doubleCos = Math.cos(phase * 2);
        const loco = actor.locomotionBlend;
        const run = actor.runBlend;
        const air = actor.airBlend;
        const groundWeight = 1 - air;
        const speedNorm = clamp(
            Math.hypot(actor.displayVel.x, actor.displayVel.z) / SPRINT_SPEED_REF,
            0,
            1
        );

        if (glbDrivingActive) {
            if (actor.idleNeutralBlend > 0.02) {
                const legNames: JointName[] = ['Leg_L', 'Shin_L', 'Leg_R', 'Shin_R'];
                for (const legName of legNames) {
                    const legJoint = actor.joints.get(legName);
                    if (!legJoint) continue;
                    this.tmpRotQuat.slerp(
                        legJoint.node.getLocalRotation(),
                        legJoint.restRot,
                        actor.idleNeutralBlend
                    );
                    legJoint.node.setLocalRotation(this.tmpRotQuat);
                }
            }

            const capeJoint = actor.joints.get('Cape');
            if (capeJoint) {
                const flutterPitch =
                    Math.sin(actor.idleTime * 3.1) * 2.5 +
                    Math.sin(phase * 2) * 5.0 * loco +
                    speedNorm * 4.0;
                const flutterRoll =
                    Math.sin(actor.idleTime * 2.1) * 2.2 + turnBank * 0.65;
                this.tmpQuat.setFromEulerAngles(flutterPitch, 0, flutterRoll);
                this.tmpRotQuat.mul2(capeJoint.node.getLocalRotation(), this.tmpQuat);
                capeJoint.node.setLocalRotation(this.tmpRotQuat);
            }
            this.applyActorCombatPoseOverlay(actor);
            return;
        }

        // Full procedural fallback animation matching PlayerController quality
        const capeBillow =
            6 +
            speedNorm * 28 +
            air * 22 +
            Math.sin(actor.idleTime * 2.3) * 3.5 +
            Math.sin(phase * 2) * 7 * loco;
        const capeSwayZ = Math.sin(actor.idleTime * 1.7) * 2.5 + turnBank * 0.6;
        this.applyJointRotationOffset(actor, 'Cape', capeBillow, 0, capeSwayZ);

        const breath = Math.sin(actor.idleTime * 2.2);
        const hipBobY =
            (-doubleCos * 0.5 + 0.5) * lerp(0.035, 0.075, run) * loco * groundWeight -
            actor.landingSquash * 0.08 +
            breath * 0.008 * (1 - loco);
        const hipYaw = strideSin * lerp(4, 8, run) * loco * groundWeight;
        this.applyJointPositionOffset(actor, 'Hips', 0, hipBobY, 0);
        this.applyJointRotationOffset(actor, 'Hips', 0, hipYaw, 0);

        const torsoPitch =
            -breath * 1.4 * (1 - loco) -
            lerp(4, 11, run) * loco * groundWeight -
            air * (actor.displayVel.y > 0 ? -4 : 6);
        const torsoYaw = -hipYaw * 1.15;
        this.applyJointRotationOffset(actor, 'Torso', torsoPitch, torsoYaw, 0);

        const headYaw = clamp(actor.yawRateDegPerSec * 0.05, -14, 14) - torsoYaw * 0.5;
        const headPitch =
            -torsoPitch * 0.45 +
            breath * 1.0 * (1 - loco) +
            air * (actor.displayVel.y > 0 ? -8 : 6);
        this.applyJointRotationOffset(actor, 'Head', headPitch, headYaw, 0);

        const packPitch = -doubleCos * 3.0 * loco * groundWeight;
        this.applyJointRotationOffset(actor, 'Backpack', packPitch, 0, 0);

        const legAmp = lerp(28, 52, run) * loco * groundWeight;
        const legLAngle = -strideSin * legAmp - air * (actor.displayVel.y > 0 ? 34 : 18);
        const legRAngle = strideSin * legAmp - air * (actor.displayVel.y > 0 ? -18 : 10);
        const kneeLAngle =
            Math.max(0, -strideCos) * lerp(36, 62, run) * loco * groundWeight +
            air * (actor.displayVel.y > 0 ? 52 : 28) +
            actor.landingSquash * 32;
        const kneeRAngle =
            Math.max(0, strideCos) * lerp(36, 62, run) * loco * groundWeight +
            air * (actor.displayVel.y > 0 ? 24 : 22) +
            actor.landingSquash * 32;

        this.applyJointRotationOffset(actor, 'Leg_L', legLAngle, 0, 0);
        this.applyJointRotationOffset(actor, 'Leg_R', legRAngle, 0, 0);
        this.applyJointRotationOffset(actor, 'Shin_L', kneeLAngle, 0, 0);
        this.applyJointRotationOffset(actor, 'Shin_R', kneeRAngle, 0, 0);

        const armAmp = lerp(24, 48, run) * loco * groundWeight;
        const armLAngle = strideSin * armAmp - air * (actor.displayVel.y > 0 ? 45 : 22);
        const armRAngle = -strideSin * armAmp - air * (actor.displayVel.y > 0 ? 30 : 22);
        const armRoll = (1 - loco) * 5 + air * 22;
        const elbowBase = lerp(12, 56, run) * loco + (1 - loco) * 10 + air * 32;
        const forearmLAngle = -(elbowBase + Math.max(0, strideSin) * 18 * loco);
        const forearmRAngle = -(elbowBase + Math.max(0, -strideSin) * 18 * loco);

        this.applyJointRotationOffset(actor, 'Arm_L', armLAngle, 0, armRoll);
        this.applyJointRotationOffset(actor, 'Arm_R', armRAngle, 0, -armRoll);
        this.applyJointRotationOffset(actor, 'ForeArm_L', forearmLAngle, 0, 0);
        this.applyJointRotationOffset(actor, 'ForeArm_R', forearmRAngle, 0, 0);
        this.applyActorCombatPoseOverlay(actor);
    }

    private applyActorCombatPoseOverlay(actor: RemotePlayerActor): void {
        if (actor.combatAnimTimer <= 0 || actor.combatAnimDuration <= 0) return;
        const p = 1 - actor.combatAnimTimer / actor.combatAnimDuration;
        const pulse = Math.sin(p * Math.PI);

        if (actor.combatState === 'attack') {
            const swingYaw = (-58 + p * 124) * actor.combatSwingDir;
            this.applyJointRotationOffset(actor, 'Torso', -14 * pulse, swingYaw * 0.25, 0);
            this.applyJointRotationOffset(actor, 'Arm_R', -72 * pulse, swingYaw, -26 * pulse);
            this.applyJointRotationOffset(actor, 'ForeArm_R', -34 * pulse, 0, 0);
            this.applyJointRotationOffset(actor, 'Arm_L', 20 * pulse, 0, 18 * pulse);
        } else if (actor.combatState === 'dodge') {
            this.applyJointRotationOffset(actor, 'Torso', 28 * pulse, 0, 0);
            this.applyJointRotationOffset(actor, 'Arm_L', 34 * pulse, 0, 18 * pulse);
            this.applyJointRotationOffset(actor, 'Arm_R', 34 * pulse, 0, -18 * pulse);
        } else if (actor.combatState === 'hit') {
            this.applyJointRotationOffset(actor, 'Torso', -24 * pulse, 0, 10 * pulse);
            this.applyJointRotationOffset(actor, 'Head', -18 * pulse, 0, 0);
            this.applyJointRotationOffset(actor, 'Arm_L', -24 * pulse, 0, 32 * pulse);
            this.applyJointRotationOffset(actor, 'Arm_R', -24 * pulse, 0, -32 * pulse);
        } else if (actor.combatState === 'throw') {
            const throwSnap = p < 0.45 ? -95 * (p / 0.45) : -95 + 145 * ((p - 0.45) / 0.55);
            this.applyJointRotationOffset(actor, 'Torso', -12 * pulse, -18 * pulse, 0);
            this.applyJointRotationOffset(actor, 'Arm_R', throwSnap, 14 * pulse, -12 * pulse);
            this.applyJointRotationOffset(actor, 'ForeArm_R', -26 * (1 - p), 0, 0);
        }
    }

    private bindJointNodes(modelEntity: pc.Entity): Map<JointName, JointBinding> {
        const joints = new Map<JointName, JointBinding>();
        const allNodes: pc.GraphNode[] = [];
        const collectNodes = (node: pc.GraphNode) => {
            allNodes.push(node);
            for (const child of node.children) {
                collectNodes(child);
            }
        };
        collectNodes(modelEntity);

        for (const jointName of JOINT_NAMES) {
            const exact = allNodes.find((n) => n.name === jointName);
            const fallback =
                exact ??
                allNodes.find(
                    (n) =>
                        n.name.toLowerCase() === jointName.toLowerCase() ||
                        n.name.startsWith(`${jointName}.`)
                );
            if (fallback) {
                joints.set(jointName, {
                    node: fallback,
                    restPos: fallback.getLocalPosition().clone(),
                    restRot: fallback.getLocalRotation().clone(),
                });
            }
        }
        return joints;
    }

    private setupGlbAnimations(
        modelEntity: pc.Entity,
        bundle: LoadedModelBundle
    ): {
        animComponent: pc.AnimComponent | null;
        animClipMap: Map<'idle' | 'walk' | 'run' | 'jump', string>;
        activeAnimState: string | null;
    } {
        const animClipMap = new Map<'idle' | 'walk' | 'run' | 'jump', string>();
        const resource = bundle.containerAsset?.resource as
            | pc.ContainerResource
            | undefined;
        const animAssets = resource?.animations;
        if (!animAssets || animAssets.length === 0) {
            return { animComponent: null, animClipMap, activeAnimState: null };
        }

        const anim = modelEntity.addComponent('anim', {
            activate: true,
        }) as pc.AnimComponent;

        for (const asset of animAssets) {
            const track = asset.resource as pc.AnimTrack | undefined;
            if (!track) continue;
            const lower = (asset.name || track.name || '').toLowerCase();
            if (lower.includes('idle')) {
                anim.assignAnimation('idle', track, undefined, 1.0, true);
                animClipMap.set('idle', 'idle');
            } else if (lower.includes('walk')) {
                anim.assignAnimation('walk', track, undefined, 1.0, true);
                animClipMap.set('walk', 'walk');
            } else if (lower.includes('run')) {
                anim.assignAnimation('run', track, undefined, 1.0, true);
                animClipMap.set('run', 'run');
            } else if (lower.includes('jump') || lower.includes('fall')) {
                anim.assignAnimation('jump', track, undefined, 1.0, false);
                animClipMap.set('jump', 'jump');
            }
        }

        if (animClipMap.size === 0) {
            modelEntity.removeComponent('anim');
            return { animComponent: null, animClipMap, activeAnimState: null };
        }

        const initialClip =
            animClipMap.get('idle') ?? Array.from(animClipMap.values())[0];
        anim.baseLayer?.transition(initialClip, 0);
        return {
            animComponent: anim,
            animClipMap,
            activeAnimState: initialClip,
        };
    }

    private applyJointPositionOffset(
        actor: RemotePlayerActor,
        name: JointName,
        dx: number,
        dy: number,
        dz: number
    ): void {
        const joint = actor.joints.get(name);
        if (!joint) return;
        this.tmpVec.set(
            joint.restPos.x + dx,
            joint.restPos.y + dy,
            joint.restPos.z + dz
        );
        joint.node.setLocalPosition(this.tmpVec);
    }

    private applyJointRotationOffset(
        actor: RemotePlayerActor,
        name: JointName,
        pitchDeg: number,
        yawDeg: number,
        rollDeg: number
    ): void {
        const joint = actor.joints.get(name);
        if (!joint) return;
        this.tmpQuat.setFromEulerAngles(pitchDeg, yawDeg, rollDeg);
        this.tmpRotQuat.mul2(joint.restRot, this.tmpQuat);
        joint.node.setLocalRotation(this.tmpRotQuat);
    }

    private buildNameplate(
        actor: RemotePlayerActor,
        camera: pc.CameraComponent | null,
        camPos: pc.Vec3 | null,
        camForward: pc.Vec3 | null,
        farClip: number,
        canvasWidth: number,
        canvasHeight: number
    ): RemoteNameplateInfo {
        const palette = SLOT_PALETTE[actor.slotIndex] ?? SLOT_PALETTE[0];
        this.tmpHeadWorld.set(
            actor.displayPos.x,
            actor.displayPos.y + NAMEPLATE_HEAD_OFFSET_Y,
            actor.displayPos.z
        );

        let distanceMeters = 0;
        let screenX = 0;
        let screenY = 0;
        let visible = false;

        if (camera && camPos && camForward && canvasWidth > 0 && canvasHeight > 0) {
            this.tmpToHead.sub2(this.tmpHeadWorld, camPos);
            const rawDist = this.tmpToHead.length();
            distanceMeters = Math.round(rawDist * 10) / 10;

            const forwardDot = this.tmpToHead.dot(camForward);
            camera.worldToScreen(
                this.tmpHeadWorld,
                this.tmpScreen,
                canvasWidth,
                canvasHeight
            );

            const inFront = forwardDot > 0.25 && this.tmpScreen.z > 0;
            const inBounds =
                this.tmpScreen.x >= 0 &&
                this.tmpScreen.x <= canvasWidth &&
                this.tmpScreen.y >= 0 &&
                this.tmpScreen.y <= canvasHeight;

            if (
                inFront &&
                inBounds &&
                rawDist <= farClip &&
                Number.isFinite(this.tmpScreen.x) &&
                Number.isFinite(this.tmpScreen.y)
            ) {
                screenX = Math.round(this.tmpScreen.x * 10) / 10;
                screenY = Math.round(this.tmpScreen.y * 10) / 10;
                visible = true;
            }
        }

        return {
            playerId: actor.playerId,
            displayName: actor.displayName,
            slotIndex: actor.slotIndex,
            colorHex: palette.hex,
            state: actor.state,
            combatState: actor.combatState,
            hp: Math.round(actor.hp),
            maxHp: Math.round(actor.maxHp),
            connected: actor.connected,
            screenX,
            screenY,
            visible,
            distanceMeters,
        };
    }
}
