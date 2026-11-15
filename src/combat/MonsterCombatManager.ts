import * as pc from 'playcanvas';
import {
    CAPTURE_RESOLVE_MS,
    ISLAND_MAX_RADIUS,
    MAX_CAPTURE_SPHERES,
    MONSTER_RESPAWN_MS,
    PLAYER_MAX_HP,
    STARTING_CAPTURE_SPHERES,
    computeCaptureChance,
    type CapturedMonsterRecord,
    type CombatActionKind,
    type CompanionAIState,
    type CompanionSyncState,
    type CoopSessionStatus,
    type MonsterAIState,
    type MonsterSpeciesId,
    type MonsterSyncState,
    type S2CCombatEventMessage,
} from '../shared/NetworkProtocol';
import type { SoundManager } from '../audio/SoundManager';
import type { MultiplayerClient } from '../network/MultiplayerClient';
import type { RemotePlayerManager } from '../network/RemotePlayerManager';
import type { PlayerController } from '../player/PlayerController';
import type {
    IAssetLoader,
    ICollisionWorld,
    InputState,
    LoadedModelBundle,
    ModelAssetKey,
} from '../types/interfaces';

export interface CombatPlayerStatsSnapshot {
    hp: number;
    maxHp: number;
    captureSpheres: number;
    lootCount: number;
    dodging: boolean;
    attackComboStep: number;
    muted: boolean;
}

export interface LockedTargetSnapshot {
    id: string;
    species: MonsterSpeciesId;
    name: string;
    level: number;
    hp: number;
    maxHp: number;
    aiState: MonsterAIState;
    distanceMeters: number;
    captureChancePct: number;
    capturingByMe: boolean;
    lockedByOther: boolean;
}

export interface FloatingMonsterPlate {
    id: string;
    species: MonsterSpeciesId;
    name: string;
    level: number;
    hp: number;
    maxHp: number;
    aiState: MonsterAIState;
    screenX: number;
    screenY: number;
    x: number;
    y: number;
    visible: boolean;
    distanceMeters: number;
    isCompanion: boolean;
    captureProgress: number;
}

export type CombatPopupKind =
    | 'damage'
    | 'heavy'
    | 'player_hit'
    | 'dodge'
    | 'capture_success'
    | 'capture_fail'
    | 'loot'
    | 'info';

export interface FloatingCombatPopup {
    id: string;
    text: string;
    kind: CombatPopupKind;
    screenX: number;
    screenY: number;
    x: number;
    y: number;
    visible: boolean;
    ageRatio: number;
}

export interface CompanionRosterSnapshot {
    roster: CapturedMonsterRecord[];
    activeUid: string | null;
    selectedIndex: number;
    activeState: CompanionAIState | null;
    activeHp: number;
    activeMaxHp: number;
}

export interface FloatingPlatesResult {
    plates: FloatingMonsterPlate[];
    popups: FloatingCombatPopup[];
}

export interface CombatHudSnapshot {
    playerStats: CombatPlayerStatsSnapshot;
    lockedTarget: LockedTargetSnapshot | null;
    monsterPlates: FloatingMonsterPlate[];
    combatPopups: FloatingCombatPopup[];
    companions: CompanionRosterSnapshot;
}

export interface MonsterCombatManagerOptions {
    app: pc.Application;
    worldRoot: pc.Entity;
    collisionWorld: ICollisionWorld;
    assetLoader: IAssetLoader;
    playerController: PlayerController;
    soundManager: SoundManager;
    remotePlayerManager?: RemotePlayerManager | null;
    multiplayerClient?: MultiplayerClient | null;
}

interface SpeciesConfig {
    species: MonsterSpeciesId;
    assetKey: ModelAssetKey;
    displayName: string;
    maxHp: number;
    moveSpeed: number;
    chaseSpeed: number;
    aggroRadius: number;
    leashRadius: number;
    attackRange: number;
    attackCooldown: number;
    attackWindup: number;
    attackDamage: number;
    attackPowerCompanion: number;
    bodyRadius: number;
    plateHeight: number;
    baseHoverY: number;
    bobAmp: number;
    bobFreq: number;
    isRanged: boolean;
    hasAoeTelegraph: boolean;
    telegraphRadius: number;
    primaryColor: [number, number, number];
    accentColor: [number, number, number];
}

const SPECIES_CONFIGS: Record<MonsterSpeciesId, SpeciesConfig> = {
    moss_hopper: {
        species: 'moss_hopper',
        assetKey: 'monster_moss_hopper',
        displayName: '이끼 홉퍼',
        maxHp: 110,
        moveSpeed: 5.4,
        chaseSpeed: 6.8,
        aggroRadius: 15.5,
        leashRadius: 28,
        attackRange: 2.6,
        attackCooldown: 1.35,
        attackWindup: 0.36,
        attackDamage: 12,
        attackPowerCompanion: 16,
        bodyRadius: 0.56,
        plateHeight: 1.45,
        baseHoverY: 0,
        bobAmp: 0.04,
        bobFreq: 3.1,
        isRanged: false,
        hasAoeTelegraph: false,
        telegraphRadius: 2.2,
        primaryColor: [0.34, 0.78, 0.44],
        accentColor: [0.85, 0.92, 0.42],
    },
    aether_wisp: {
        species: 'aether_wisp',
        assetKey: 'monster_aether_wisp',
        displayName: '에테르 위습',
        maxHp: 85,
        moveSpeed: 4.8,
        chaseSpeed: 6.0,
        aggroRadius: 17.5,
        leashRadius: 30,
        attackRange: 8.2,
        attackCooldown: 1.75,
        attackWindup: 0.42,
        attackDamage: 14,
        attackPowerCompanion: 18,
        bodyRadius: 0.54,
        plateHeight: 1.65,
        baseHoverY: 0.14,
        bobAmp: 0.16,
        bobFreq: 2.6,
        isRanged: true,
        hasAoeTelegraph: false,
        telegraphRadius: 1.8,
        primaryColor: [0.38, 0.86, 0.98],
        accentColor: [0.76, 0.52, 1.0],
    },
    shale_golem: {
        species: 'shale_golem',
        assetKey: 'monster_shale_golem',
        displayName: '셰일 골렘',
        maxHp: 180,
        moveSpeed: 3.1,
        chaseSpeed: 4.3,
        aggroRadius: 14.5,
        leashRadius: 26,
        attackRange: 3.3,
        attackCooldown: 2.15,
        attackWindup: 0.64,
        attackDamage: 22,
        attackPowerCompanion: 24,
        bodyRadius: 0.92,
        plateHeight: 2.25,
        baseHoverY: 0,
        bobAmp: 0.02,
        bobFreq: 1.9,
        isRanged: false,
        hasAoeTelegraph: true,
        telegraphRadius: 3.6,
        primaryColor: [0.76, 0.48, 0.34],
        accentColor: [0.96, 0.58, 0.24],
    },
};

interface WildSpawnDef {
    id: string;
    species: MonsterSpeciesId;
    level: number;
    x: number;
    z: number;
}

const SOLO_WILD_SPAWNS: WildSpawnDef[] = [
    { id: 'wild-moss-1', species: 'moss_hopper', level: 2, x: -20, z: -24 },
    { id: 'wild-moss-2', species: 'moss_hopper', level: 3, x: 24, z: -30 },
    { id: 'wild-wisp-1', species: 'aether_wisp', level: 3, x: -34, z: 22 },
    { id: 'wild-wisp-2', species: 'aether_wisp', level: 4, x: 32, z: 24 },
    { id: 'wild-golem-1', species: 'shale_golem', level: 5, x: 40, z: -8 },
    { id: 'wild-golem-2', species: 'shale_golem', level: 5, x: -42, z: -10 },
];

type MonsterClipKey = 'Idle' | 'Walk' | 'Run' | 'Attack' | 'Hit' | 'Die';

interface ClonedMatEntry {
    material: pc.StandardMaterial;
    baseEmissive: pc.Color;
}

interface MonsterActor {
    id: string;
    species: MonsterSpeciesId;
    name: string;
    level: number;
    hp: number;
    maxHp: number;
    aiState: MonsterAIState;
    targetPlayerId: string | null;
    targetCompanionId: string | null;
    captureLockByPlayerId: string | null;
    respawnRemainingMs: number;
    attackCharge: number;

    rootEntity: pc.Entity;
    visualPivot: pc.Entity;
    modelEntity: pc.Entity;
    shadowEntity: pc.Entity;
    animComponent: pc.AnimComponent | null;
    clipNames: Map<MonsterClipKey, string>;
    activeClip: MonsterClipKey | null;
    clonedMaterials: ClonedMatEntry[];

    homeX: number;
    homeZ: number;
    pos: pc.Vec3;
    targetPos: pc.Vec3;
    velX: number;
    velZ: number;
    yawDeg: number;
    targetYawDeg: number;

    waypointX: number;
    waypointZ: number;
    stateTimer: number;
    attackCooldownTimer: number;
    windupDuration: number;
    windupElapsed: number;
    attackDealtInCycle: boolean;
    hitFlashTimer: number;
    cryCooldownTimer: number;
    captureScale: number;
    captureProgress: number;
    distantAccumDt: number;
    animPhase: number;
    lastServerHp: number;
    lastServerState: MonsterAIState;
    telegraphSlotIdx: number;
}

interface CompanionActor {
    uid: string;
    ownerPlayerId: string;
    species: MonsterSpeciesId;
    nickname: string;
    level: number;
    hp: number;
    maxHp: number;
    attackPower: number;
    aiState: CompanionAIState;
    targetMonsterId: string | null;

    rootEntity: pc.Entity;
    visualPivot: pc.Entity;
    modelEntity: pc.Entity;
    shadowEntity: pc.Entity;
    animComponent: pc.AnimComponent | null;
    clipNames: Map<MonsterClipKey, string>;
    activeClip: MonsterClipKey | null;
    clonedMaterials: ClonedMatEntry[];

    pos: pc.Vec3;
    targetPos: pc.Vec3;
    yawDeg: number;
    targetYawDeg: number;
    attackCooldownTimer: number;
    animPhase: number;
    hitFlashTimer: number;
    active: boolean;
}

interface PooledProjectile {
    active: boolean;
    kind: 'player_arcane' | 'monster_wisp' | 'companion_bolt';
    cosmeticOnly: boolean;
    ownerId: string;
    damage: number;
    age: number;
    maxAge: number;
    pos: pc.Vec3;
    vel: pc.Vec3;
    rootEntity: pc.Entity;
    coreEntity: pc.Entity;
    haloEntity: pc.Entity;
    coreRender: pc.RenderComponent;
    haloRender: pc.RenderComponent;
}

interface PooledSpark {
    active: boolean;
    age: number;
    maxAge: number;
    startScale: number;
    pos: pc.Vec3;
    vel: pc.Vec3;
    entity: pc.Entity;
    render: pc.RenderComponent;
}

interface PooledDodgeRing {
    active: boolean;
    age: number;
    maxAge: number;
    pos: pc.Vec3;
    entity: pc.Entity;
    material: pc.StandardMaterial;
}

interface PooledTelegraphRing {
    active: boolean;
    ownerKey: string;
    radius: number;
    charge: number;
    autoTimer: number;
    autoDuration: number;
    pos: pc.Vec3;
    rootEntity: pc.Entity;
    outerEntity: pc.Entity;
    fillEntity: pc.Entity;
    outerMat: pc.StandardMaterial;
    fillMat: pc.StandardMaterial;
}

interface PooledCaptureSphere {
    active: boolean;
    cosmeticOnly: boolean;
    targetMonsterId: string;
    ownerId: string;
    phase: 'flight' | 'shake';
    flightAge: number;
    flightDuration: number;
    shakeAge: number;
    shakeDuration: number;
    nextTickIndex: number;
    startPos: pc.Vec3;
    endPos: pc.Vec3;
    pos: pc.Vec3;
    rootEntity: pc.Entity;
    visualEntity: pc.Entity;
}

interface PopupEntry {
    id: string;
    text: string;
    kind: CombatPopupKind;
    worldX: number;
    worldY: number;
    worldZ: number;
    age: number;
    maxAge: number;
}

const PROJECTILE_POOL_SIZE = 16;
const SPARK_POOL_SIZE = 64;
const DODGE_RING_POOL_SIZE = 6;
const TELEGRAPH_POOL_SIZE = 6;
const CAPTURE_SPHERE_POOL_SIZE = 6;
const FULL_TICK_RANGE = 45;
const LOCK_ON_RANGE = 22;
const MELEE_RANGE = 3.25;
const CAPTURE_THROW_RANGE = 16.5;
const MELEE_COOLDOWN = 0.28;
const RANGED_COOLDOWN = 0.55;
const CAPTURE_COOLDOWN = 0.7;
const DODGE_RING_COOLDOWN = 0.35;

function clamp(v: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, v));
}

function normalizeAngleDeg(deg: number): number {
    let a = ((deg % 360) + 540) % 360 - 180;
    if (a < -180) a += 360;
    return a;
}

function lerpAngleDeg(current: number, target: number, alpha: number): number {
    const diff = normalizeAngleDeg(target - current);
    return normalizeAngleDeg(current + diff * alpha);
}

function yawFromDeltaXZ(dx: number, dz: number): number {
    return Math.atan2(-dx, -dz) * pc.math.RAD_TO_DEG;
}

export class MonsterCombatManager {
    private readonly app: pc.Application;
    private readonly worldRoot: pc.Entity;
    private readonly combatRoot: pc.Entity;
    private readonly collisionWorld: ICollisionWorld;
    private readonly assetLoader: IAssetLoader;
    private readonly playerController: PlayerController;
    private readonly soundManager: SoundManager;
    private readonly remotePlayerManager: RemotePlayerManager | null;
    private readonly multiplayerClient: MultiplayerClient | null;

    // Shared retained meshes (all created once with incRefCount() and pooled via .enabled)
    private readonly sharedMeshes: pc.Mesh[] = [];
    private readonly projectileCoreMesh: pc.Mesh;
    private readonly projectileHaloMesh: pc.Mesh;
    private readonly sparkMesh: pc.Mesh;
    private readonly dodgeRingMesh: pc.Mesh;
    private readonly telegraphRingMesh: pc.Mesh;
    private readonly telegraphFillMesh: pc.Mesh;
    private readonly captureDomeMesh: pc.Mesh;
    private readonly captureBeltMesh: pc.Mesh;
    private readonly lockRingMesh: pc.Mesh;
    private readonly shadowBlobMesh: pc.Mesh;

    // Cached materials for pools
    private readonly projectileMaterials: Record<
        PooledProjectile['kind'],
        { core: pc.StandardMaterial; halo: pc.StandardMaterial }
    >;
    private readonly sparkMaterials: Record<
        'melee' | 'arcane' | 'hit' | 'capture',
        pc.StandardMaterial
    >;
    private readonly shadowMaterial: pc.StandardMaterial;
    private readonly lockRingMaterial: pc.StandardMaterial;

    // Pools
    private readonly projectilePool: PooledProjectile[] = [];
    private readonly sparkPool: PooledSpark[] = [];
    private readonly dodgeRingPool: PooledDodgeRing[] = [];
    private readonly telegraphPool: PooledTelegraphRing[] = [];
    private readonly captureSpherePool: PooledCaptureSphere[] = [];
    private readonly lockRingEntity: pc.Entity;

    // Monster & Companion Actors
    private readonly soloMonsters: MonsterActor[] = [];
    private readonly coopMonsters = new Map<string, MonsterActor>();
    private readonly companionPool = new Map<MonsterSpeciesId, CompanionActor>();
    private activeCompanionSpecies: MonsterSpeciesId | null = null;
    private activeCoopCompanions = new Map<string, CompanionActor>();

    // State
    private isOnlineCoop = false;
    private playerRespawnLockTimer = 0;
    private meleeCooldownTimer = 0;
    private rangedCooldownTimer = 0;
    private captureCooldownTimer = 0;
    private dodgeCueCooldownTimer = 0;
    private captureSpheres = STARTING_CAPTURE_SPHERES;
    private lootCount = 0;
    private soloMeleeBonus = 0;
    private soloRangedBonus = 0;
    private workerAssignedUids = new Set<string>();
    private localCapturedRoster: CapturedMonsterRecord[] = [];
    private selectedCompanionIndex = 0;
    private localActiveCompanionUid: string | null = null;
    private lastCoopLockedTargetId: string | null = null;
    private popupSeq = 0;
    private readonly popups: PopupEntry[] = [];
    private unsubscribeCombatEvent: (() => void) | null = null;

    // Temp math objects
    private readonly tmpVec = new pc.Vec3();
    private readonly tmpVec2 = new pc.Vec3();
    private readonly tmpForward = new pc.Vec3();
    private readonly tmpScreen = new pc.Vec3();
    private readonly tmpOutPos = new pc.Vec3();

    constructor(options: MonsterCombatManagerOptions) {
        this.app = options.app;
        this.worldRoot = options.worldRoot;
        this.collisionWorld = options.collisionWorld;
        this.assetLoader = options.assetLoader;
        this.playerController = options.playerController;
        this.playerController.setCombatManagedExternally(true);
        this.soundManager = options.soundManager;
        this.remotePlayerManager = options.remotePlayerManager ?? null;
        this.multiplayerClient = options.multiplayerClient ?? null;

        this.combatRoot = new pc.Entity('MonsterCombatRoot');
        this.worldRoot.addChild(this.combatRoot);

        const device = this.app.graphicsDevice;
        this.projectileCoreMesh = this.retainMesh(
            pc.Mesh.fromGeometry(device, new pc.SphereGeometry({ radius: 0.22, latitudeBands: 10, longitudeBands: 12 }))
        );
        this.projectileHaloMesh = this.retainMesh(this.createFlatRingMesh(device, 0.28, 0.42, 16));
        this.sparkMesh = this.retainMesh(
            pc.Mesh.fromGeometry(device, new pc.BoxGeometry({ halfExtents: new pc.Vec3(0.08, 0.08, 0.08) }))
        );
        this.dodgeRingMesh = this.retainMesh(this.createFlatRingMesh(device, 0.72, 1.0, 24));
        this.telegraphRingMesh = this.retainMesh(this.createFlatRingMesh(device, 0.84, 1.0, 28));
        this.telegraphFillMesh = this.retainMesh(
            pc.Mesh.fromGeometry(device, new pc.CylinderGeometry({ radius: 1.0, height: 0.02, capSegments: 24 }))
        );
        this.captureDomeMesh = this.retainMesh(
            pc.Mesh.fromGeometry(device, new pc.SphereGeometry({ radius: 0.24, latitudeBands: 10, longitudeBands: 14 }))
        );
        this.captureBeltMesh = this.retainMesh(
            pc.Mesh.fromGeometry(device, new pc.CylinderGeometry({ radius: 0.255, height: 0.06, capSegments: 16 }))
        );
        this.lockRingMesh = this.retainMesh(this.createFlatRingMesh(device, 0.78, 1.0, 24));
        this.shadowBlobMesh = this.retainMesh(
            pc.Mesh.fromGeometry(device, new pc.CylinderGeometry({ radius: 0.68, height: 0.015, capSegments: 16 }))
        );

        this.projectileMaterials = {
            player_arcane: {
                core: this.createEmissiveMat([0.42, 0.95, 1.0], [0.25, 0.82, 1.0]),
                halo: this.createEmissiveMat([0.95, 0.86, 0.42], [0.8, 0.65, 0.2], 0.72),
            },
            monster_wisp: {
                core: this.createEmissiveMat([0.85, 0.48, 1.0], [0.75, 0.25, 1.0]),
                halo: this.createEmissiveMat([0.48, 0.85, 1.0], [0.35, 0.65, 0.95], 0.7),
            },
            companion_bolt: {
                core: this.createEmissiveMat([0.4, 0.96, 0.68], [0.25, 0.9, 0.52]),
                halo: this.createEmissiveMat([0.86, 1.0, 0.56], [0.6, 0.85, 0.3], 0.7),
            },
        };

        this.sparkMaterials = {
            melee: this.createEmissiveMat([1.0, 0.82, 0.34], [1.0, 0.62, 0.14]),
            arcane: this.createEmissiveMat([0.44, 0.94, 1.0], [0.26, 0.8, 1.0]),
            hit: this.createEmissiveMat([1.0, 0.36, 0.28], [0.95, 0.2, 0.16]),
            capture: this.createEmissiveMat([0.4, 0.96, 0.62], [0.24, 0.88, 0.45]),
        };

        this.shadowMaterial = new pc.StandardMaterial();
        this.shadowMaterial.diffuse.set(0.05, 0.08, 0.06);
        this.shadowMaterial.emissive.set(0, 0, 0);
        this.shadowMaterial.opacity = 0.38;
        this.shadowMaterial.blendType = pc.BLEND_NORMAL;
        this.shadowMaterial.depthWrite = false;
        this.shadowMaterial.update();

        this.lockRingMaterial = this.createEmissiveMat(
            [1.0, 0.84, 0.32],
            [0.95, 0.72, 0.2],
            0.84
        );
        this.lockRingMaterial.depthWrite = false;
        this.lockRingMaterial.update();

        this.lockRingEntity = new pc.Entity('CombatLockOnRing');
        this.lockRingEntity.addComponent('render', {
            meshInstances: [new pc.MeshInstance(this.lockRingMesh, this.lockRingMaterial)],
            castShadows: false,
            receiveShadows: false,
        });
        this.lockRingEntity.enabled = false;
        this.combatRoot.addChild(this.lockRingEntity);

        this.initPools();
        this.spawnSoloWildMonsters();
        this.prebuildSoloCompanionPool();

        if (this.multiplayerClient) {
            this.unsubscribeCombatEvent = this.multiplayerClient.onCombatEvent((event) => {
                this.handleCombatEvent(event);
            });
        }
    }

    public getLocalPlayerStats(): CombatPlayerStatsSnapshot {
        return {
            hp: Math.round(this.playerController.getHp()),
            maxHp: Math.round(this.playerController.getMaxHp()),
            captureSpheres: this.captureSpheres,
            lootCount: this.lootCount,
            dodging: this.playerController.isDodging(),
            attackComboStep: this.playerController.getAttackComboStep(),
            muted: this.soundManager.isMuted(),
        };
    }

    /** Phase 4: Apply Solo tool bonuses to melee & arcane bolt damage. */
    public setToolBonuses(meleeBonus: number, rangedBonus: number): void {
        this.soloMeleeBonus = Number.isFinite(meleeBonus) ? Math.max(0, meleeBonus) : 0;
        this.soloRangedBonus = Number.isFinite(rangedBonus) ? Math.max(0, rangedBonus) : 0;
    }

    /** Phase 4: Adjust local capture sphere inventory (Solo crafting). */
    public addCaptureSpheres(delta: number): number {
        if (!Number.isFinite(delta) || delta === 0) return this.captureSpheres;
        this.captureSpheres = clamp(Math.round(this.captureSpheres + delta), 0, MAX_CAPTURE_SPHERES);
        return this.captureSpheres;
    }

    /** Phase 4: Read current capture sphere count. */
    public getCaptureSpheres(): number {
        return this.captureSpheres;
    }

    /** Phase 4: Sync assigned base worker UIDs so they cannot be summoned while working at base. */
    public setWorkerAssignedUids(uids: ReadonlySet<string>): void {
        this.workerAssignedUids = new Set(uids);
        if (!this.isOnlineCoop && this.localActiveCompanionUid && this.workerAssignedUids.has(this.localActiveCompanionUid)) {
            this.recallSoloCompanion();
            this.soundManager.playSummon();
            this.spawnPlayerPopup('거점 작업 배치로 동료가 회수되었습니다', 'info');
        }
    }

    /** Phase 4: Recall active Solo companion if its UID is assigned as a base worker. */
    public recallIfActive(uid: string): boolean {
        if (!uid) return false;
        this.workerAssignedUids.add(uid);
        if (this.isOnlineCoop) {
            return this.getActiveCompanionUid() === uid;
        }
        if (this.localActiveCompanionUid === uid) {
            this.recallSoloCompanion();
            this.soundManager.playSummon();
            this.spawnPlayerPopup('거점 작업 배치로 동료가 회수되었습니다', 'info');
            return true;
        }
        return false;
    }

    /** Phase 4: Distance in meters from player to nearest targetable wild monster (or Infinity). */
    public getNearestWildMonsterDistance(): number {
        const pPos = this.playerController.getPosition();
        const list = this.getActiveWildMonsters();
        let best = Infinity;
        for (const m of list) {
            if (m.aiState === 'dead' || m.aiState === 'captured' || m.hp <= 0) continue;
            const dist = Math.hypot(m.pos.x - pPos.x, m.pos.z - pPos.z);
            if (dist < best) best = dist;
        }
        return best;
    }

    public getCapturedRoster(): CapturedMonsterRecord[] {
        if (this.isOnlineCoop && this.multiplayerClient) {
            return [...(this.multiplayerClient.getStatus().capturedRoster ?? [])];
        }
        return this.localCapturedRoster.map((r) => ({ ...r }));
    }

    public getActiveCompanionUid(): string | null {
        if (this.isOnlineCoop && this.multiplayerClient) {
            const status = this.multiplayerClient.getStatus();
            const localPlayer = status.players.find((p) => p.playerId === status.localPlayerId);
            if (localPlayer?.activeCompanionId) return localPlayer.activeCompanionId;
            const myComp = status.companions?.find((c) => c.ownerPlayerId === status.localPlayerId);
            return myComp?.uid ?? null;
        }
        return this.localActiveCompanionUid;
    }

    public getCompanionSnapshot(): CompanionRosterSnapshot {
        const roster = this.getCapturedRoster();
        if (roster.length > 0 && this.selectedCompanionIndex >= roster.length) {
            this.selectedCompanionIndex = roster.length - 1;
        }
        const activeUid = this.getActiveCompanionUid();
        let activeState: CompanionAIState | null = null;
        let activeHp = 0;
        let activeMaxHp = 0;

        if (activeUid) {
            if (this.isOnlineCoop && this.multiplayerClient) {
                const companions = this.multiplayerClient.getStatus().companions ?? [];
                const comp = companions.find((c) => c.uid === activeUid);
                if (comp) {
                    activeState = comp.aiState;
                    activeHp = Math.round(comp.hp);
                    activeMaxHp = Math.round(comp.maxHp);
                }
            } else if (this.activeCompanionSpecies) {
                const actor = this.companionPool.get(this.activeCompanionSpecies);
                if (actor && actor.active) {
                    activeState = actor.aiState;
                    activeHp = Math.round(actor.hp);
                    activeMaxHp = Math.round(actor.maxHp);
                }
            }
        }

        return {
            roster,
            activeUid,
            selectedIndex: clamp(this.selectedCompanionIndex, 0, Math.max(0, roster.length - 1)),
            activeState,
            activeHp,
            activeMaxHp,
        };
    }

    public selectCompanion(indexOrUid: number | string): boolean {
        const roster = this.getCapturedRoster();
        if (roster.length === 0) return false;
        let idx = -1;
        if (typeof indexOrUid === 'number') {
            idx = clamp(Math.floor(indexOrUid), 0, roster.length - 1);
        } else {
            idx = roster.findIndex((r) => r.uid === indexOrUid);
        }
        if (idx < 0) return false;
        this.selectedCompanionIndex = idx;
        return true;
    }

    public toggleSummonCompanion(uid?: string | null): boolean {
        const roster = this.getCapturedRoster();
        if (roster.length === 0) {
            this.spawnPlayerPopup('포획한 몬스터가 없습니다', 'info');
            return false;
        }

        const chosenIndex = uid
            ? Math.max(0, roster.findIndex((r) => r.uid === uid))
            : clamp(this.selectedCompanionIndex, 0, roster.length - 1);
        const record = roster[chosenIndex];
        if (!record) return false;

        this.selectedCompanionIndex = chosenIndex;
        const currentActiveUid = this.getActiveCompanionUid();

        const assignedInCoop =
            this.isOnlineCoop &&
            this.multiplayerClient?.getBaseWorkers().some((w) => w.uid === record.uid);
        if (currentActiveUid !== record.uid && (this.workerAssignedUids.has(record.uid) || assignedInCoop)) {
            this.spawnPlayerPopup(`${record.nickname}은(는) 거점 작업 중입니다 (먼저 배치 해제)`, 'info');
            return false;
        }

        if (this.isOnlineCoop && this.multiplayerClient) {
            const action: CombatActionKind =
                currentActiveUid === record.uid ? 'recall_companion' : 'summon_companion';
            return this.multiplayerClient.sendCombatAction({
                action,
                companionUid: record.uid,
            });
        }

        if (currentActiveUid === record.uid) {
            this.recallSoloCompanion();
            this.soundManager.playSummon();
            this.spawnPlayerPopup(`${record.nickname} 회수`, 'info');
            return true;
        }

        this.summonSoloCompanion(record);
        this.soundManager.playSummon();
        this.spawnPlayerPopup(`${record.nickname} 소환!`, 'capture_success');
        return true;
    }

    public getLockedTargetInfo(): LockedTargetSnapshot | null {
        const pPos = this.playerController.getPosition();
        const aimDir = this.playerController.getAimDirectionXZ(this.tmpVec);
        const list = this.getActiveWildMonsters();
        const localPlayerId = this.multiplayerClient?.getStatus().localPlayerId ?? 'local';

        let best: MonsterActor | null = null;
        let bestDist = Infinity;
        let bestScore = Infinity;

        for (const m of list) {
            if (m.aiState === 'dead' || m.aiState === 'captured' || m.hp <= 0) continue;
            const dx = m.pos.x - pPos.x;
            const dz = m.pos.z - pPos.z;
            const dist = Math.hypot(dx, dz);
            if (dist > LOCK_ON_RANGE) continue;

            const inv = dist > 0.001 ? 1 / dist : 1;
            const dot = dx * inv * aimDir.x + dz * inv * aimDir.z;
            const score = dist - dot * 6.5;
            if (score < bestScore) {
                bestScore = score;
                bestDist = dist;
                best = m;
            }
        }

        if (!best) return null;

        const chancePct = Math.round(
            computeCaptureChance(best.species, best.hp, best.maxHp) * 100
        );
        return {
            id: best.id,
            species: best.species,
            name: best.name,
            level: best.level,
            hp: Math.round(best.hp),
            maxHp: Math.round(best.maxHp),
            aiState: best.aiState,
            distanceMeters: Number(bestDist.toFixed(1)),
            captureChancePct: chancePct,
            capturingByMe:
                best.aiState === 'capturing' &&
                (!this.isOnlineCoop || best.captureLockByPlayerId === localPlayerId),
            lockedByOther:
                best.aiState === 'capturing' &&
                this.isOnlineCoop &&
                best.captureLockByPlayerId !== null &&
                best.captureLockByPlayerId !== localPlayerId,
        };
    }

    public getFloatingPlates(
        cameraEntity: pc.Entity,
        viewportWidth?: number,
        viewportHeight?: number
    ): FloatingPlatesResult {
        const cameraComp = cameraEntity.camera;
        const pPos = this.playerController.getPosition();
        const plates: FloatingMonsterPlate[] = [];
        const popups: FloatingCombatPopup[] = [];

        if (!cameraComp) {
            return { plates, popups };
        }

        const canvas = this.app.graphicsDevice.canvas as HTMLCanvasElement | undefined;
        const cw = Math.max(1, viewportWidth ?? canvas?.clientWidth ?? window.innerWidth ?? 1280);
        const ch = Math.max(1, viewportHeight ?? canvas?.clientHeight ?? window.innerHeight ?? 720);
        const camPos = cameraEntity.getPosition();
        const camForward = this.tmpForward.copy(cameraEntity.forward);

        const projectWorld = (wx: number, wy: number, wz: number) => {
            this.tmpVec2.set(wx, wy, wz);
            this.tmpVec.sub2(this.tmpVec2, camPos);
            const ahead = this.tmpVec.dot(camForward) > 0.1;
            cameraComp.worldToScreen(this.tmpVec2, this.tmpScreen);
            const sx = this.tmpScreen.x;
            const sy = this.tmpScreen.y;
            const visible =
                ahead &&
                this.tmpScreen.z > 0 &&
                sx >= -60 &&
                sx <= cw + 60 &&
                sy >= -60 &&
                sy <= ch + 60;
            return {
                screenX: clamp(sx, -80, cw + 80),
                screenY: clamp(sy, -80, ch + 80),
                visible,
            };
        };

        for (const m of this.getActiveWildMonsters()) {
            if (m.aiState === 'dead' || m.aiState === 'captured' || m.hp <= 0) continue;
            const dist = Math.hypot(m.pos.x - pPos.x, m.pos.z - pPos.z);
            if (dist > 52) continue;

            const cfg = SPECIES_CONFIGS[m.species];
            const proj = projectWorld(m.pos.x, m.pos.y + cfg.plateHeight, m.pos.z);
            plates.push({
                id: m.id,
                species: m.species,
                name: m.name,
                level: m.level,
                hp: Math.round(m.hp),
                maxHp: Math.round(m.maxHp),
                aiState: m.aiState,
                screenX: proj.screenX,
                screenY: proj.screenY,
                x: proj.screenX,
                y: proj.screenY,
                visible: proj.visible,
                distanceMeters: Number(dist.toFixed(1)),
                isCompanion: false,
                captureProgress: m.captureProgress,
            });
        }

        // Active companion plate(s)
        for (const comp of this.getActiveCompanionActors()) {
            if (!comp.active) continue;
            const dist = Math.hypot(comp.pos.x - pPos.x, comp.pos.z - pPos.z);
            const cfg = SPECIES_CONFIGS[comp.species];
            const proj = projectWorld(comp.pos.x, comp.pos.y + cfg.plateHeight * 0.9, comp.pos.z);
            plates.push({
                id: comp.uid,
                species: comp.species,
                name: comp.nickname,
                level: comp.level,
                hp: Math.round(comp.hp),
                maxHp: Math.round(comp.maxHp),
                aiState: 'patrol',
                screenX: proj.screenX,
                screenY: proj.screenY,
                x: proj.screenX,
                y: proj.screenY,
                visible: proj.visible,
                distanceMeters: Number(dist.toFixed(1)),
                isCompanion: true,
                captureProgress: 0,
            });
        }

        for (const entry of this.popups) {
            const ageRatio = clamp(entry.age / entry.maxAge, 0, 1);
            const floatY = entry.worldY + ageRatio * 1.15;
            const proj = projectWorld(entry.worldX, floatY, entry.worldZ);
            popups.push({
                id: entry.id,
                text: entry.text,
                kind: entry.kind,
                screenX: proj.screenX,
                screenY: proj.screenY,
                x: proj.screenX,
                y: proj.screenY,
                visible: proj.visible,
                ageRatio,
            });
        }

        return { plates, popups };
    }

    public getHudCombatState(
        cameraEntity: pc.Entity,
        viewportWidth?: number,
        viewportHeight?: number
    ): CombatHudSnapshot {
        const floating = this.getFloatingPlates(cameraEntity, viewportWidth, viewportHeight);
        return {
            playerStats: this.getLocalPlayerStats(),
            lockedTarget: this.getLockedTargetInfo(),
            monsterPlates: floating.plates,
            combatPopups: floating.popups,
            companions: this.getCompanionSnapshot(),
        };
    }

    public update(dt: number, input: InputState, isCameraDragging = false): void {
        const clampedDt = Math.min(Math.max(dt, 0), 0.05);
        const coopStatus = this.multiplayerClient?.getStatus() ?? null;
        const onlineNow = Boolean(
            coopStatus && coopStatus.state === 'connected' && coopStatus.roomCode
        );

        if (onlineNow !== this.isOnlineCoop) {
            this.handleModeSwitch(onlineNow);
        }

        this.playerController.setCombatManagedExternally(true);

        this.meleeCooldownTimer = Math.max(0, this.meleeCooldownTimer - clampedDt);
        this.rangedCooldownTimer = Math.max(0, this.rangedCooldownTimer - clampedDt);
        this.captureCooldownTimer = Math.max(0, this.captureCooldownTimer - clampedDt);
        this.dodgeCueCooldownTimer = Math.max(0, this.dodgeCueCooldownTimer - clampedDt);
        this.playerRespawnLockTimer = Math.max(0, this.playerRespawnLockTimer - clampedDt);

        if (onlineNow && coopStatus) {
            this.syncAuthoritativeCoopStatus(coopStatus);
            this.handlePlayerCombatInput(input, isCameraDragging, true);
            this.updateCoopMonsterActors(clampedDt);
            this.updateCoopCompanionActors(clampedDt);
        } else {
            this.handlePlayerCombatInput(input, isCameraDragging, false);
            this.updateSoloWildMonsters(clampedDt);
            this.updateSoloCompanion(clampedDt);
        }

        this.updatePools(clampedDt);
        this.updateLockOnRing(clampedDt);
        this.updatePopups(clampedDt);
    }

    public handleCombatEvent(event: S2CCombatEventMessage): void {
        const localId = this.multiplayerClient?.getStatus().localPlayerId ?? 'local';
        const isLocalActor = event.actorId === localId;
        const isLocalTarget = event.targetId === localId;

        if (!isLocalActor && this.remotePlayerManager) {
            this.remotePlayerManager.triggerRemoteCombatCue(event.actorId, event.event);
        }

        switch (event.event) {
            case 'melee_hit': {
                const heavy = (event.damage ?? 0) >= 28;
                this.spawnSparkBurst(event.x, event.y + 0.7, event.z, 'melee', heavy ? 9 : 6);
                this.soundManager.playHitImpact(heavy);
                if (typeof event.damage === 'number' && event.damage > 0) {
                    this.spawnPopup(
                        `-${Math.round(event.damage)}`,
                        heavy ? 'heavy' : 'damage',
                        event.x,
                        event.y + 1.35,
                        event.z
                    );
                }
                if (event.targetId) {
                    const targetMonster = this.coopMonsters.get(event.targetId);
                    if (targetMonster) {
                        targetMonster.hitFlashTimer = 0.22;
                        this.playMonsterClip(targetMonster, 'Hit', true);
                    }
                }
                break;
            }
            case 'ranged_cast': {
                this.soundManager.playRangedCast();
                if (!isLocalActor) {
                    this.spawnCosmeticBolt(
                        event.x,
                        event.y + 1.05,
                        event.z,
                        event.targetId ?? null,
                        'player_arcane'
                    );
                }
                break;
            }
            case 'ranged_hit': {
                this.spawnSparkBurst(event.x, event.y + 0.7, event.z, 'arcane', 7);
                this.soundManager.playHitImpact(false);
                if (typeof event.damage === 'number' && event.damage > 0) {
                    this.spawnPopup(
                        `-${Math.round(event.damage)}`,
                        'damage',
                        event.x,
                        event.y + 1.3,
                        event.z
                    );
                }
                break;
            }
            case 'monster_attack_telegraph': {
                const monster = this.coopMonsters.get(event.actorId);
                if (monster) {
                    this.soundManager.playMonsterCry(monster.species);
                    const cfg = SPECIES_CONFIGS[monster.species];
                    if (cfg.hasAoeTelegraph) {
                        this.activateTelegraphRing(
                            `coop:${monster.id}`,
                            event.x,
                            event.z,
                            cfg.telegraphRadius,
                            0.65
                        );
                    }
                }
                break;
            }
            case 'monster_attack_hit': {
                this.spawnSparkBurst(event.x, event.y + 0.4, event.z, 'hit', 8);
                this.soundManager.playHitImpact(true);
                break;
            }
            case 'player_hit': {
                this.spawnSparkBurst(event.x, event.y + 0.9, event.z, 'hit', 6);
                this.soundManager.playHitImpact(true);
                if (isLocalTarget || isLocalActor) {
                    const dmg = Math.round(event.damage ?? 12);
                    const pPos = this.playerController.getPosition();
                    const kx = pPos.x - event.x;
                    const kz = pPos.z - event.z;
                    this.playerController.triggerHitReaction(kx, kz, 4.5);
                    if (typeof event.remainingHp === 'number') {
                        this.playerController.setAuthoritativeHp(event.remainingHp);
                    }
                    this.spawnPopup(`-${dmg}`, 'player_hit', pPos.x, pPos.y + 1.75, pPos.z);
                }
                break;
            }
            case 'player_dodge': {
                this.spawnDodgeRing(event.x, event.y, event.z);
                if (isLocalActor || isLocalTarget) {
                    this.soundManager.playDodge();
                    this.spawnPopup('회피!', 'dodge', event.x, event.y + 1.5, event.z);
                }
                break;
            }
            case 'player_respawn': {
                this.spawnSparkBurst(event.x, event.y + 0.9, event.z, 'capture', 8);
                if (isLocalActor || isLocalTarget) {
                    this.playerController.respawnAtCampfire(event.x, event.z, 2.0);
                    this.spawnPopup('캠프파이어 부활', 'info', event.x, event.y + 1.8, event.z);
                }
                break;
            }
            case 'monster_dead': {
                this.spawnSparkBurst(event.x, event.y + 0.7, event.z, 'melee', 10);
                this.soundManager.playHitImpact(true);
                this.spawnPopup('처치!', 'loot', event.x, event.y + 1.4, event.z);
                break;
            }
            case 'capture_throw': {
                this.soundManager.playCaptureThrow();
                this.launchCaptureSphereVisual(
                    event.actorId,
                    event.targetId ?? '',
                    event.x,
                    event.y + 1.0,
                    event.z,
                    true
                );
                break;
            }
            case 'capture_result': {
                if (event.captureSuccess) {
                    this.soundManager.playCaptureSuccess();
                    this.spawnSparkBurst(event.x, event.y + 0.8, event.z, 'capture', 12);
                    this.spawnPopup('포획 성공!', 'capture_success', event.x, event.y + 1.6, event.z);
                } else {
                    this.soundManager.playCaptureFail();
                    this.spawnSparkBurst(event.x, event.y + 0.8, event.z, 'hit', 8);
                    this.spawnPopup('탈출!', 'capture_fail', event.x, event.y + 1.6, event.z);
                }
                break;
            }
            case 'companion_summon': {
                this.soundManager.playSummon();
                this.spawnSparkBurst(event.x, event.y + 0.6, event.z, 'capture', 9);
                break;
            }
            case 'companion_recall': {
                this.soundManager.playSummon();
                this.spawnSparkBurst(event.x, event.y + 0.6, event.z, 'arcane', 6);
                break;
            }
            case 'companion_attack': {
                this.spawnSparkBurst(event.x, event.y + 0.7, event.z, 'capture', 6);
                this.soundManager.playHitImpact(false);
                if (typeof event.damage === 'number' && event.damage > 0) {
                    this.spawnPopup(
                        `-${Math.round(event.damage)}`,
                        'damage',
                        event.x,
                        event.y + 1.3,
                        event.z
                    );
                }
                break;
            }
            case 'loot_drop': {
                this.spawnPopup(
                    event.lootItem ? `${event.lootItem} +1` : '전리품 +1',
                    'loot',
                    event.x,
                    event.y + 1.25,
                    event.z
                );
                break;
            }
        }
    }

    public triggerDebugAction(
        action:
            | 'melee'
            | 'ranged'
            | 'dodge'
            | 'capture'
            | 'summon'
            | 'weaken_nearest'
            | 'damage_player'
            | 'heal_player'
            | 'force_capture_nearest'
            | 'add_capture_spheres'
            | 'respawn_all'
            | 'telegraph_nearest',
        value?: number
    ): Record<string, unknown> {
        const pPos = this.playerController.getPosition();

        switch (action) {
            case 'melee':
                this.executeLocalMelee(false, this.isOnlineCoop);
                return { ok: true, combo: this.playerController.getAttackComboStep() };
            case 'ranged':
                this.executeLocalRanged(false, this.isOnlineCoop);
                return { ok: true };
            case 'dodge':
                return { ok: this.executeLocalDodge(this.isOnlineCoop) };
            case 'capture':
                return { ok: this.executeLocalCaptureThrow(false, this.isOnlineCoop) };
            case 'summon':
                return { ok: this.toggleSummonCompanion() };
            case 'damage_player': {
                const amt = typeof value === 'number' ? value : 15;
                const applied = this.playerController.applyDamage(amt, 0, 1, 3.5);
                return { ok: applied, hp: this.playerController.getHp() };
            }
            case 'heal_player':
                this.playerController.setAuthoritativeHp(this.playerController.getMaxHp());
                return { ok: true, hp: this.playerController.getHp() };
            case 'add_capture_spheres':
                this.captureSpheres = MAX_CAPTURE_SPHERES;
                return { ok: true, captureSpheres: this.captureSpheres };
            case 'respawn_all':
                for (const m of this.soloMonsters) {
                    this.respawnSoloMonster(m);
                }
                return { ok: true, aliveCount: this.soloMonsters.length };
            case 'weaken_nearest': {
                const target = this.findNearestWildMonster(pPos.x, pPos.z, 35);
                if (!target) return { ok: false };
                target.hp = Math.max(5, Math.round(target.maxHp * 0.15));
                return { ok: true, id: target.id, hp: target.hp, maxHp: target.maxHp };
            }
            case 'force_capture_nearest': {
                const target = this.findNearestWildMonster(pPos.x, pPos.z, 35);
                if (!target) {
                    const fallbackRecord: CapturedMonsterRecord = {
                        uid: `solo-debug-${Date.now()}`,
                        species: 'moss_hopper',
                        nickname: '이끼 홉퍼',
                        level: 2,
                        hp: 110,
                        maxHp: 110,
                        attackPower: 16,
                    };
                    this.localCapturedRoster = [...this.localCapturedRoster, fallbackRecord];
                    return { ok: true, rosterCount: this.localCapturedRoster.length };
                }
                this.completeSoloCapture(target, true);
                return { ok: true, rosterCount: this.localCapturedRoster.length };
            }
            case 'telegraph_nearest': {
                const target = this.findNearestWildMonster(pPos.x, pPos.z, 35);
                if (!target) return { ok: false };
                const cfg = SPECIES_CONFIGS[target.species];
                this.activateTelegraphRing(
                    `debug:${target.id}`,
                    target.pos.x,
                    target.pos.z,
                    Math.max(cfg.telegraphRadius, 3.2),
                    0.9
                );
                return { ok: true, id: target.id };
            }
        }
    }

    public dispose(): void {
        this.playerController.setCombatManagedExternally(false);
        if (this.unsubscribeCombatEvent) {
            this.unsubscribeCombatEvent();
            this.unsubscribeCombatEvent = null;
        }
        this.popups.length = 0;
        for (const m of this.sharedMeshes) {
            m.decRefCount();
        }
        this.combatRoot.destroy();
    }

    // =========================================================================
    // Input & Local Combat Actions
    // =========================================================================

    private handlePlayerCombatInput(
        input: InputState,
        isCameraDragging: boolean,
        online: boolean
    ): void {
        if (typeof input.selectCompanionIndex === 'number') {
            this.selectCompanion(input.selectCompanionIndex);
        }

        if (input.summonPressed) {
            this.toggleSummonCompanion();
        }

        if (input.dodgePressed) {
            this.executeLocalDodge(online);
        }

        if (input.meleePressed) {
            this.executeLocalMelee(isCameraDragging, online);
        }

        if (input.rangedPressed) {
            this.executeLocalRanged(isCameraDragging, online);
        }

        if (input.capturePressed) {
            this.executeLocalCaptureThrow(isCameraDragging, online);
        }
    }

    private computeAimYawForAttack(isCameraDragging: boolean, maxRange: number): number | null {
        const locked = this.getLockedTargetInfo();
        if (!locked || locked.distanceMeters > maxRange) return null;
        const m = this.findActiveMonsterById(locked.id);
        if (!m) return null;
        return this.playerController.applyAutoAimAssist(m.pos.x, m.pos.z, isCameraDragging);
    }

    private executeLocalDodge(online: boolean): boolean {
        const pPos = this.playerController.getPosition();
        const triggered = this.playerController.triggerDodge();
        if (!triggered) return false;

        if (this.dodgeCueCooldownTimer <= 0) {
            this.dodgeCueCooldownTimer = DODGE_RING_COOLDOWN;
            this.spawnDodgeRing(pPos.x, pPos.y, pPos.z);
            this.soundManager.playDodge();
        }

        if (online && this.multiplayerClient) {
            const aim = this.playerController.getAimDirectionXZ(this.tmpVec);
            this.multiplayerClient.sendCombatAction({
                action: 'dodge_roll',
                aimYaw: this.playerController.getYawDeg(),
                originX: pPos.x,
                originY: pPos.y,
                originZ: pPos.z,
                dirX: aim.x,
                dirZ: aim.z,
            });
        }
        return true;
    }

    private executeLocalMelee(isCameraDragging: boolean, online: boolean): number {
        if (this.meleeCooldownTimer > 0) return 0;
        const aimYaw = this.computeAimYawForAttack(isCameraDragging, 10);
        const comboStep = this.playerController.triggerMeleeAttack(aimYaw);
        if (comboStep === 0) return 0;

        this.meleeCooldownTimer = MELEE_COOLDOWN;
        this.soundManager.playMeleeSwing(comboStep);

        const pPos = this.playerController.getPosition();
        const aimDir = this.playerController.getAimDirectionXZ(this.tmpVec);

        if (online && this.multiplayerClient) {
            const locked = this.getLockedTargetInfo();
            this.multiplayerClient.sendCombatAction({
                action: 'melee_attack',
                targetMonsterId: locked?.id ?? null,
                aimYaw: this.playerController.getYawDeg(),
                originX: pPos.x,
                originY: pPos.y,
                originZ: pPos.z,
                dirX: aimDir.x,
                dirZ: aimDir.z,
            });
            return comboStep;
        }

        // Solo melee cleave check
        const baseDamage = (comboStep === 3 ? 36 : comboStep === 2 ? 26 : 22) + this.soloMeleeBonus;
        let hitCount = 0;
        for (const m of this.soloMonsters) {
            if (
                m.aiState === 'dead' ||
                m.aiState === 'captured' ||
                m.aiState === 'capturing' ||
                m.hp <= 0
            ) {
                continue;
            }
            const cfg = SPECIES_CONFIGS[m.species];
            const dx = m.pos.x - pPos.x;
            const dz = m.pos.z - pPos.z;
            const dist = Math.hypot(dx, dz);
            if (dist > MELEE_RANGE + cfg.bodyRadius) continue;

            const inv = dist > 0.001 ? 1 / dist : 1;
            const dot = dx * inv * aimDir.x + dz * inv * aimDir.z;
            if (dist > 1.35 && dot < 0.1) continue;

            this.damageSoloMonster(
                m,
                baseDamage,
                'local',
                dx * inv,
                dz * inv,
                comboStep === 3
            );
            hitCount += 1;
            if (hitCount >= 3) break;
        }

        if (hitCount > 0) {
            this.soundManager.playHitImpact(comboStep === 3);
        }
        return comboStep;
    }

    private executeLocalRanged(isCameraDragging: boolean, online: boolean): boolean {
        if (this.rangedCooldownTimer > 0) return false;
        const aimYaw = this.computeAimYawForAttack(isCameraDragging, LOCK_ON_RANGE);
        if (!this.playerController.triggerRangedCast(aimYaw)) return false;

        this.rangedCooldownTimer = RANGED_COOLDOWN;
        this.soundManager.playRangedCast();

        const pPos = this.playerController.getPosition();
        const aimDir = this.playerController.getAimDirectionXZ(this.tmpVec);
        const startX = pPos.x + aimDir.x * 0.65;
        const startY = pPos.y + 1.08;
        const startZ = pPos.z + aimDir.z * 0.65;

        if (online && this.multiplayerClient) {
            const locked = this.getLockedTargetInfo();
            this.spawnProjectile(
                'player_arcane',
                true,
                'local',
                0,
                startX,
                startY,
                startZ,
                aimDir.x,
                0,
                aimDir.z,
                22
            );
            this.multiplayerClient.sendCombatAction({
                action: 'ranged_attack',
                targetMonsterId: locked?.id ?? null,
                aimYaw: this.playerController.getYawDeg(),
                originX: startX,
                originY: startY,
                originZ: startZ,
                dirX: aimDir.x,
                dirZ: aimDir.z,
            });
            return true;
        }

        this.spawnProjectile(
            'player_arcane',
            false,
            'local',
            18 + this.soloRangedBonus,
            startX,
            startY,
            startZ,
            aimDir.x,
            0,
            aimDir.z,
            22
        );
        return true;
    }

    private executeLocalCaptureThrow(isCameraDragging: boolean, online: boolean): boolean {
        if (this.captureCooldownTimer > 0) return false;
        if (this.captureSpheres <= 0) {
            this.spawnPlayerPopup('포획 스피어가 부족합니다', 'info');
            this.soundManager.playCaptureFail();
            return false;
        }

        const locked = this.getLockedTargetInfo();
        if (!locked || locked.distanceMeters > CAPTURE_THROW_RANGE) {
            this.spawnPlayerPopup('사거리 내 몬스터가 없습니다', 'info');
            return false;
        }

        const targetMonster = this.findActiveMonsterById(locked.id);
        if (
            !targetMonster ||
            targetMonster.aiState === 'capturing' ||
            targetMonster.aiState === 'dead' ||
            targetMonster.aiState === 'captured'
        ) {
            return false;
        }

        const aimYaw = this.computeAimYawForAttack(isCameraDragging, CAPTURE_THROW_RANGE);
        if (!this.playerController.triggerCaptureThrow(aimYaw)) return false;

        this.captureCooldownTimer = CAPTURE_COOLDOWN;
        this.soundManager.playCaptureThrow();

        const pPos = this.playerController.getPosition();

        if (online && this.multiplayerClient) {
            return this.multiplayerClient.sendCombatAction({
                action: 'throw_capture',
                targetMonsterId: targetMonster.id,
                aimYaw: this.playerController.getYawDeg(),
                originX: pPos.x,
                originY: pPos.y + 1.15,
                originZ: pPos.z,
            });
        }

        this.captureSpheres = Math.max(0, this.captureSpheres - 1);
        targetMonster.aiState = 'capturing';
        targetMonster.captureLockByPlayerId = 'local';
        targetMonster.captureProgress = 0;
        targetMonster.stateTimer = CAPTURE_RESOLVE_MS / 1000;
        targetMonster.attackCharge = 0;
        this.launchCaptureSphereVisual(
            'local',
            targetMonster.id,
            pPos.x,
            pPos.y + 1.15,
            pPos.z,
            false
        );
        return true;
    }

    // =========================================================================
    // Solo Wild Monsters & Companion AI
    // =========================================================================

    private spawnSoloWildMonsters(): void {
        for (const def of SOLO_WILD_SPAWNS) {
            const groundY = this.collisionWorld.getTerrainHeight(def.x, def.z);
            const actor = this.createMonsterActor(def.id, def.species, def.level, def.x, groundY, def.z);
            this.soloMonsters.push(actor);
        }
    }

    private respawnSoloMonster(m: MonsterActor): void {
        const cfg = SPECIES_CONFIGS[m.species];
        const y = this.collisionWorld.getTerrainHeight(m.homeX, m.homeZ);
        m.hp = cfg.maxHp;
        m.maxHp = cfg.maxHp;
        m.aiState = 'patrol';
        m.targetPlayerId = null;
        m.targetCompanionId = null;
        m.captureLockByPlayerId = null;
        m.respawnRemainingMs = 0;
        m.attackCharge = 0;
        m.pos.set(m.homeX, y, m.homeZ);
        m.targetPos.copy(m.pos);
        m.velX = 0;
        m.velZ = 0;
        m.captureScale = 1;
        m.captureProgress = 0;
        m.stateTimer = 1.8;
        m.attackCooldownTimer = 0.5;
        m.windupElapsed = 0;
        m.hitFlashTimer = 0;
        this.pickPatrolWaypoint(m);
        m.rootEntity.enabled = true;
        m.shadowEntity.enabled = true;
        m.visualPivot.setLocalScale(1, 1, 1);
        m.rootEntity.setPosition(m.pos.x, m.pos.y + cfg.baseHoverY, m.pos.z);
        this.resetActorMaterials(m.clonedMaterials);
        this.playMonsterClip(m, 'Idle', false);
    }

    private updateSoloWildMonsters(dt: number): void {
        const pPos = this.playerController.getPosition();

        for (const m of this.soloMonsters) {
            const cfg = SPECIES_CONFIGS[m.species];

            if (m.aiState === 'dead' || m.aiState === 'captured') {
                m.respawnRemainingMs = Math.max(0, m.respawnRemainingMs - dt * 1000);
                if (m.aiState === 'dead' && m.stateTimer > 0) {
                    m.stateTimer = Math.max(0, m.stateTimer - dt);
                    if (m.stateTimer <= 0) {
                        m.rootEntity.enabled = false;
                    }
                }
                if (m.respawnRemainingMs <= 0) {
                    this.respawnSoloMonster(m);
                }
                continue;
            }

            if (m.cryCooldownTimer > 0) m.cryCooldownTimer = Math.max(0, m.cryCooldownTimer - dt);
            if (m.attackCooldownTimer > 0) m.attackCooldownTimer = Math.max(0, m.attackCooldownTimer - dt);
            if (m.hitFlashTimer > 0) {
                m.hitFlashTimer = Math.max(0, m.hitFlashTimer - dt);
                this.updateActorHitTint(m.clonedMaterials, m.hitFlashTimer);
            }

            const distToPlayer = Math.hypot(m.pos.x - pPos.x, m.pos.z - pPos.z);
            let stepDt = dt;
            if (distToPlayer > FULL_TICK_RANGE) {
                m.distantAccumDt += dt;
                if (m.distantAccumDt < 0.1) continue;
                stepDt = m.distantAccumDt;
                m.distantAccumDt = 0;
            } else {
                m.distantAccumDt = 0;
            }

            this.stepSoloMonsterAI(m, cfg, pPos, distToPlayer, stepDt);
            this.updateMonsterPresentation(m, cfg, stepDt, distToPlayer <= FULL_TICK_RANGE + 10);
        }
    }

    private stepSoloMonsterAI(
        m: MonsterActor,
        cfg: SpeciesConfig,
        pPos: pc.Vec3,
        distToPlayer: number,
        dt: number
    ): void {
        // Choose closest aggro target: companion or player
        const activeComp = this.getActiveSoloCompanion();
        let targetX = pPos.x;
        let targetZ = pPos.z;
        let targetDist = distToPlayer;
        let targetIsCompanion = false;

        if (activeComp && activeComp.hp > 0) {
            const compDist = Math.hypot(m.pos.x - activeComp.pos.x, m.pos.z - activeComp.pos.z);
            if (m.targetCompanionId === activeComp.uid || compDist < distToPlayer * 0.85) {
                targetX = activeComp.pos.x;
                targetZ = activeComp.pos.z;
                targetDist = compDist;
                targetIsCompanion = true;
            }
        }

        const distFromHome = Math.hypot(m.pos.x - m.homeX, m.pos.z - m.homeZ);

        switch (m.aiState) {
            case 'capturing': {
                m.velX = 0;
                m.velZ = 0;
                m.captureScale = Math.max(0.14, m.captureScale - dt * 2.8);
                m.captureProgress = clamp(
                    1 - m.stateTimer / (CAPTURE_RESOLVE_MS / 1000),
                    0,
                    1
                );
                m.stateTimer = Math.max(0, m.stateTimer - dt);
                if (m.stateTimer <= 0) {
                    const chance = computeCaptureChance(m.species, m.hp, m.maxHp);
                    this.completeSoloCapture(m, Math.random() < chance);
                }
                return;
            }
            case 'hit': {
                m.stateTimer -= dt;
                this.moveMonsterToward(m, cfg, m.pos.x + m.velX, m.pos.z + m.velZ, 1, dt, true);
                m.velX *= Math.exp(-9 * dt);
                m.velZ *= Math.exp(-9 * dt);
                if (m.stateTimer <= 0) {
                    const lowHpRatio = m.hp / m.maxHp;
                    if (
                        m.species !== 'shale_golem' &&
                        lowHpRatio <= 0.22 &&
                        Math.random() < 0.45
                    ) {
                        m.aiState = 'flee';
                        m.stateTimer = 2.6;
                    } else {
                        m.aiState = 'chase';
                    }
                }
                break;
            }
            case 'flee': {
                m.stateTimer -= dt;
                const awayX = m.pos.x - targetX;
                const awayZ = m.pos.z - targetZ;
                const awayLen = Math.hypot(awayX, awayZ) || 1;
                const goalX = m.pos.x + (awayX / awayLen) * 5;
                const goalZ = m.pos.z + (awayZ / awayLen) * 5;
                this.moveMonsterToward(m, cfg, goalX, goalZ, cfg.chaseSpeed, dt, false);
                if (m.stateTimer <= 0 || distFromHome > cfg.leashRadius) {
                    m.aiState = 'return';
                }
                break;
            }
            case 'rest': {
                m.velX = 0;
                m.velZ = 0;
                m.stateTimer -= dt;
                if (targetDist <= cfg.aggroRadius * 1.25) {
                    m.aiState = 'observe';
                    m.stateTimer = 0.85;
                } else if (m.stateTimer <= 0) {
                    this.pickPatrolWaypoint(m);
                    m.aiState = 'patrol';
                    m.stateTimer = 4.5;
                }
                break;
            }
            case 'observe': {
                m.velX = 0;
                m.velZ = 0;
                m.targetYawDeg = yawFromDeltaXZ(targetX - m.pos.x, targetZ - m.pos.z);
                m.stateTimer -= dt;
                if (targetDist <= cfg.aggroRadius * 0.92) {
                    this.enterAlertState(m);
                } else if (targetDist > cfg.aggroRadius * 1.45) {
                    m.aiState = 'patrol';
                    m.stateTimer = 3.5;
                } else if (m.stateTimer <= 0) {
                    this.enterAlertState(m);
                }
                break;
            }
            case 'patrol': {
                if (targetDist <= cfg.aggroRadius) {
                    this.enterAlertState(m);
                    break;
                }
                const wpDx = m.waypointX - m.pos.x;
                const wpDz = m.waypointZ - m.pos.z;
                m.stateTimer -= dt;
                if (Math.hypot(wpDx, wpDz) < 1.1 || m.stateTimer <= 0) {
                    m.aiState = 'rest';
                    m.stateTimer = 1.8 + Math.random() * 1.4;
                } else {
                    this.moveMonsterToward(
                        m,
                        cfg,
                        m.waypointX,
                        m.waypointZ,
                        cfg.moveSpeed * 0.55,
                        dt,
                        false
                    );
                }
                break;
            }
            case 'alert': {
                m.velX = 0;
                m.velZ = 0;
                m.targetYawDeg = yawFromDeltaXZ(targetX - m.pos.x, targetZ - m.pos.z);
                m.stateTimer -= dt;
                if (m.stateTimer <= 0) {
                    m.aiState = 'chase';
                }
                break;
            }
            case 'chase': {
                if (distFromHome > cfg.leashRadius || targetDist > cfg.leashRadius * 1.15) {
                    m.aiState = 'return';
                    m.targetPlayerId = null;
                    m.targetCompanionId = null;
                    break;
                }
                if (targetDist <= cfg.attackRange && m.attackCooldownTimer <= 0) {
                    m.aiState = 'attack';
                    m.windupElapsed = 0;
                    m.windupDuration = cfg.attackWindup;
                    m.attackDealtInCycle = false;
                    m.attackCharge = 0;
                    m.targetYawDeg = yawFromDeltaXZ(targetX - m.pos.x, targetZ - m.pos.z);
                    this.playMonsterClip(m, 'Attack', true);
                    if (cfg.hasAoeTelegraph) {
                        this.activateTelegraphRing(
                            `solo:${m.id}`,
                            m.pos.x,
                            m.pos.z,
                            cfg.telegraphRadius,
                            cfg.attackWindup
                        );
                    }
                    break;
                }
                if (targetDist > cfg.attackRange * 0.88) {
                    this.moveMonsterToward(m, cfg, targetX, targetZ, cfg.chaseSpeed, dt, false);
                } else {
                    m.velX = 0;
                    m.velZ = 0;
                    m.targetYawDeg = yawFromDeltaXZ(targetX - m.pos.x, targetZ - m.pos.z);
                }
                break;
            }
            case 'attack': {
                m.velX = 0;
                m.velZ = 0;
                m.targetYawDeg = yawFromDeltaXZ(targetX - m.pos.x, targetZ - m.pos.z);
                m.windupElapsed += dt;
                m.attackCharge = clamp(m.windupElapsed / Math.max(0.05, m.windupDuration), 0, 1);

                if (!m.attackDealtInCycle && m.windupElapsed >= m.windupDuration) {
                    m.attackDealtInCycle = true;
                    this.resolveSoloMonsterAttack(
                        m,
                        cfg,
                        targetX,
                        targetZ,
                        targetIsCompanion ? activeComp : null
                    );
                }

                if (m.windupElapsed >= m.windupDuration + 0.24) {
                    m.attackCharge = 0;
                    m.attackCooldownTimer = cfg.attackCooldown;
                    m.aiState = targetDist <= cfg.leashRadius ? 'chase' : 'return';
                }
                break;
            }
            case 'return': {
                const homeDx = m.homeX - m.pos.x;
                const homeDz = m.homeZ - m.pos.z;
                const homeDist = Math.hypot(homeDx, homeDz);
                m.hp = Math.min(m.maxHp, m.hp + dt * 6);
                if (homeDist < 1.5) {
                    m.hp = m.maxHp;
                    m.aiState = 'rest';
                    m.stateTimer = 2.0;
                } else {
                    this.moveMonsterToward(
                        m,
                        cfg,
                        m.homeX,
                        m.homeZ,
                        cfg.chaseSpeed * 1.15,
                        dt,
                        false
                    );
                }
                break;
            }
        }
    }

    private enterAlertState(m: MonsterActor): void {
        m.aiState = 'alert';
        m.stateTimer = 0.42;
        if (m.cryCooldownTimer <= 0) {
            this.soundManager.playMonsterCry(m.species);
            m.cryCooldownTimer = 4.5;
        }
    }

    private resolveSoloMonsterAttack(
        m: MonsterActor,
        cfg: SpeciesConfig,
        targetX: number,
        targetZ: number,
        targetComp: CompanionActor | null
    ): void {
        if (cfg.isRanged) {
            const dx = targetX - m.pos.x;
            const dz = targetZ - m.pos.z;
            const len = Math.hypot(dx, dz) || 1;
            this.spawnProjectile(
                'monster_wisp',
                false,
                m.id,
                cfg.attackDamage,
                m.pos.x + (dx / len) * 0.6,
                m.pos.y + 0.95,
                m.pos.z + (dz / len) * 0.6,
                dx / len,
                0,
                dz / len,
                14.5
            );
            this.soundManager.playRangedCast();
            return;
        }

        const hitRadius = cfg.hasAoeTelegraph ? cfg.telegraphRadius : cfg.attackRange + 0.7;
        if (cfg.hasAoeTelegraph) {
            this.spawnSparkBurst(m.pos.x, m.pos.y + 0.35, m.pos.z, 'melee', 10);
            this.soundManager.playHitImpact(true);
        }

        // Check player hit
        const pPos = this.playerController.getPosition();
        const pdx = pPos.x - m.pos.x;
        const pdz = pPos.z - m.pos.z;
        const pDist = Math.hypot(pdx, pdz);
        if (pDist <= hitRadius) {
            this.applySoloMonsterDamageToPlayer(m.pos.x, m.pos.z, cfg.attackDamage);
        }

        // Check companion hit if present
        if (targetComp && targetComp.active && targetComp.hp > 0) {
            const cDist = Math.hypot(targetComp.pos.x - m.pos.x, targetComp.pos.z - m.pos.z);
            if (cDist <= hitRadius) {
                targetComp.hp = Math.max(0, targetComp.hp - cfg.attackDamage * 0.65);
                targetComp.hitFlashTimer = 0.22;
                this.spawnSparkBurst(targetComp.pos.x, targetComp.pos.y + 0.7, targetComp.pos.z, 'hit', 5);
                if (targetComp.hp <= 0) {
                    this.recallSoloCompanion();
                    this.spawnPlayerPopup(`${targetComp.nickname} 귀환!`, 'info');
                }
            }
        }
    }

    private applySoloMonsterDamageToPlayer(sourceX: number, sourceZ: number, damage: number): void {
        if (this.playerRespawnLockTimer > 0) return;
        const pPos = this.playerController.getPosition();
        if (this.playerController.isInvulnerable()) {
            this.spawnPopup('회피!', 'dodge', pPos.x, pPos.y + 1.65, pPos.z);
            this.soundManager.playDodge();
            return;
        }

        const kx = pPos.x - sourceX;
        const kz = pPos.z - sourceZ;
        const applied = this.playerController.applyDamage(damage, kx, kz, 5.2);
        if (!applied) return;

        this.soundManager.playHitImpact(true);
        this.spawnSparkBurst(pPos.x, pPos.y + 0.9, pPos.z, 'hit', 6);
        this.spawnPopup(`-${Math.round(damage)}`, 'player_hit', pPos.x, pPos.y + 1.75, pPos.z);

        if (this.playerController.getHp() <= 0) {
            this.playerRespawnLockTimer = 0.6;
            this.playerController.respawnAtCampfire(0, 0, 2.0);
            this.spawnPopup('캠프파이어 부활', 'info', 0, this.collisionWorld.getTerrainHeight(0, 0) + 1.8, 0);
        }
    }

    private damageSoloMonster(
        m: MonsterActor,
        damage: number,
        attackerId: string,
        dirX: number,
        dirZ: number,
        heavy: boolean
    ): void {
        if (m.aiState === 'dead' || m.aiState === 'captured' || m.hp <= 0) return;
        m.hp = Math.max(0, m.hp - damage);
        m.hitFlashTimer = 0.22;

        if (attackerId.startsWith('comp:')) {
            m.targetCompanionId = attackerId.slice(5);
        } else {
            m.targetPlayerId = attackerId;
        }

        this.spawnSparkBurst(m.pos.x, m.pos.y + 0.8, m.pos.z, 'melee', heavy ? 9 : 6);
        this.spawnPopup(
            `-${Math.round(damage)}`,
            heavy ? 'heavy' : 'damage',
            m.pos.x,
            m.pos.y + SPECIES_CONFIGS[m.species].plateHeight,
            m.pos.z
        );

        if (m.hp <= 0) {
            m.aiState = 'dead';
            m.attackCharge = 0;
            m.stateTimer = 1.25;
            m.respawnRemainingMs = MONSTER_RESPAWN_MS;
            m.shadowEntity.enabled = false;
            this.playMonsterClip(m, 'Die', true);
            this.lootCount += 1;
            this.captureSpheres = Math.min(MAX_CAPTURE_SPHERES, this.captureSpheres + 1);
            this.spawnPopup('전리품 +1 / 스피어 +1', 'loot', m.pos.x, m.pos.y + 1.5, m.pos.z);
            return;
        }

        m.velX = dirX * (heavy ? 5.6 : 3.4);
        m.velZ = dirZ * (heavy ? 5.6 : 3.4);
        if (m.aiState !== 'capturing' && m.aiState !== 'attack') {
            m.aiState = 'hit';
            m.stateTimer = 0.28;
            this.playMonsterClip(m, 'Hit', true);
        }
    }

    private completeSoloCapture(m: MonsterActor, success: boolean): void {
        const cfg = SPECIES_CONFIGS[m.species];
        m.captureLockByPlayerId = null;
        m.captureProgress = 0;

        if (success) {
            m.aiState = 'captured';
            m.respawnRemainingMs = MONSTER_RESPAWN_MS;
            m.rootEntity.enabled = false;
            m.shadowEntity.enabled = false;
            this.lootCount += 1;

            const record: CapturedMonsterRecord = {
                uid: `comp-${m.species}-${Date.now().toString(36)}-${Math.floor(Math.random() * 999)}`,
                species: m.species,
                nickname: cfg.displayName,
                level: m.level,
                hp: cfg.maxHp,
                maxHp: cfg.maxHp,
                attackPower: cfg.attackPowerCompanion,
            };
            this.localCapturedRoster = [...this.localCapturedRoster, record];
            if (this.localCapturedRoster.length === 1) {
                this.selectedCompanionIndex = 0;
            }

            this.soundManager.playCaptureSuccess();
            this.spawnSparkBurst(m.pos.x, m.pos.y + 0.85, m.pos.z, 'capture', 12);
            this.spawnPopup('포획 성공!', 'capture_success', m.pos.x, m.pos.y + 1.65, m.pos.z);
        } else {
            m.captureScale = 1;
            m.visualPivot.setLocalScale(1, 1, 1);
            m.aiState = 'alert';
            m.stateTimer = 0.5;
            this.soundManager.playCaptureFail();
            this.spawnSparkBurst(m.pos.x, m.pos.y + 0.8, m.pos.z, 'hit', 8);
            this.spawnPopup('탈출!', 'capture_fail', m.pos.x, m.pos.y + 1.65, m.pos.z);
        }
    }

    private moveMonsterToward(
        m: MonsterActor,
        cfg: SpeciesConfig,
        goalX: number,
        goalZ: number,
        speed: number,
        dt: number,
        rawVelocityMode: boolean
    ): void {
        let stepX = 0;
        let stepZ = 0;
        if (rawVelocityMode) {
            stepX = (goalX - m.pos.x) * dt;
            stepZ = (goalZ - m.pos.z) * dt;
        } else {
            const dx = goalX - m.pos.x;
            const dz = goalZ - m.pos.z;
            const dist = Math.hypot(dx, dz);
            if (dist < 0.05) {
                m.velX = 0;
                m.velZ = 0;
                return;
            }
            const inv = 1 / dist;
            m.velX = dx * inv * speed;
            m.velZ = dz * inv * speed;
            stepX = m.velX * dt;
            stepZ = m.velZ * dt;
            m.targetYawDeg = yawFromDeltaXZ(m.velX, m.velZ);
        }

        const waterLevel = this.collisionWorld.getWaterLevel();
        const candidateX = m.pos.x + stepX;
        const candidateZ = m.pos.z + stepZ;
        const radiusFromOrigin = Math.hypot(candidateX, candidateZ);
        let desiredDeltaX = stepX;
        let desiredDeltaZ = stepZ;
        if (radiusFromOrigin > ISLAND_MAX_RADIUS - 4) {
            const pullBack = (ISLAND_MAX_RADIUS - 4) / Math.max(0.01, radiusFromOrigin);
            desiredDeltaX = candidateX * pullBack - m.pos.x;
            desiredDeltaZ = candidateZ * pullBack - m.pos.z;
        }

        this.tmpVec.set(m.pos.x + desiredDeltaX, m.pos.y, m.pos.z + desiredDeltaZ);
        const resolved = this.collisionWorld.resolveSphereMovement(
            m.pos,
            this.tmpVec,
            cfg.bodyRadius
        );

        const nextY = this.collisionWorld.getTerrainHeight(
            resolved.position.x,
            resolved.position.z
        );
        if (nextY >= waterLevel + 0.3) {
            m.pos.set(resolved.position.x, nextY, resolved.position.z);
        } else if (!rawVelocityMode) {
            this.pickPatrolWaypoint(m);
        }
    }

    private pickPatrolWaypoint(m: MonsterActor): void {
        const angle = Math.random() * Math.PI * 2;
        const dist = 3.5 + Math.random() * 6.5;
        let wx = m.homeX + Math.cos(angle) * dist;
        let wz = m.homeZ + Math.sin(angle) * dist;
        const waterLevel = this.collisionWorld.getWaterLevel();
        if (this.collisionWorld.getTerrainHeight(wx, wz) < waterLevel + 0.35) {
            wx = m.homeX;
            wz = m.homeZ;
        }
        m.waypointX = wx;
        m.waypointZ = wz;
    }

    private prebuildSoloCompanionPool(): void {
        for (const species of ['moss_hopper', 'aether_wisp', 'shale_golem'] as MonsterSpeciesId[]) {
            const cfg = SPECIES_CONFIGS[species];
            const actor = this.createCompanionActor(
                `solo-pool-${species}`,
                'local',
                species,
                cfg.displayName,
                1,
                cfg.maxHp,
                cfg.attackPowerCompanion
            );
            actor.active = false;
            actor.rootEntity.enabled = false;
            this.companionPool.set(species, actor);
        }
    }

    private summonSoloCompanion(record: CapturedMonsterRecord): void {
        this.recallSoloCompanion();
        const actor = this.companionPool.get(record.species);
        if (!actor) return;

        const pPos = this.playerController.getPosition();
        const pYawRad = this.playerController.getYawDeg() * pc.math.DEG_TO_RAD;
        const sideX = Math.cos(pYawRad) * 1.9;
        const sideZ = -Math.sin(pYawRad) * 1.9;
        const spawnX = pPos.x + sideX;
        const spawnZ = pPos.z + sideZ;
        const spawnY = this.collisionWorld.getTerrainHeight(spawnX, spawnZ);

        actor.uid = record.uid;
        actor.nickname = record.nickname;
        actor.level = record.level;
        actor.hp = record.maxHp;
        actor.maxHp = record.maxHp;
        actor.attackPower = record.attackPower;
        actor.aiState = 'follow';
        actor.targetMonsterId = null;
        actor.attackCooldownTimer = 0.4;
        actor.pos.set(spawnX, spawnY, spawnZ);
        actor.targetPos.copy(actor.pos);
        actor.yawDeg = this.playerController.getYawDeg();
        actor.targetYawDeg = actor.yawDeg;
        actor.active = true;
        actor.rootEntity.enabled = true;
        actor.rootEntity.setPosition(spawnX, spawnY + SPECIES_CONFIGS[record.species].baseHoverY, spawnZ);
        actor.rootEntity.setLocalEulerAngles(0, actor.yawDeg, 0);

        this.activeCompanionSpecies = record.species;
        this.localActiveCompanionUid = record.uid;
        this.spawnSparkBurst(spawnX, spawnY + 0.7, spawnZ, 'capture', 10);
    }

    private recallSoloCompanion(): void {
        if (this.activeCompanionSpecies) {
            const actor = this.companionPool.get(this.activeCompanionSpecies);
            if (actor) {
                actor.active = false;
                actor.rootEntity.enabled = false;
                this.spawnSparkBurst(actor.pos.x, actor.pos.y + 0.6, actor.pos.z, 'arcane', 6);
            }
        }
        this.activeCompanionSpecies = null;
        this.localActiveCompanionUid = null;
    }

    private getActiveSoloCompanion(): CompanionActor | null {
        if (!this.activeCompanionSpecies) return null;
        const actor = this.companionPool.get(this.activeCompanionSpecies);
        return actor && actor.active ? actor : null;
    }

    private updateSoloCompanion(dt: number): void {
        const comp = this.getActiveSoloCompanion();
        if (!comp) return;

        const cfg = SPECIES_CONFIGS[comp.species];
        const pPos = this.playerController.getPosition();
        comp.attackCooldownTimer = Math.max(0, comp.attackCooldownTimer - dt);
        if (comp.hitFlashTimer > 0) {
            comp.hitFlashTimer = Math.max(0, comp.hitFlashTimer - dt);
            this.updateActorHitTint(comp.clonedMaterials, comp.hitFlashTimer);
        }

        // Pick nearby threat within 15m of player
        const threat = this.findNearestWildMonster(pPos.x, pPos.z, 15.5);
        let speed = 0;

        if (threat && threat.hp > 0) {
            comp.targetMonsterId = threat.id;
            const dx = threat.pos.x - comp.pos.x;
            const dz = threat.pos.z - comp.pos.z;
            const dist = Math.hypot(dx, dz);
            comp.targetYawDeg = yawFromDeltaXZ(dx, dz);

            const engageDist = cfg.isRanged ? 6.5 : 2.35;
            if (dist <= engageDist) {
                comp.aiState = 'assist_attack';
                if (comp.attackCooldownTimer <= 0) {
                    comp.attackCooldownTimer = 1.45;
                    this.playCompanionClip(comp, 'Attack', true);
                    if (cfg.isRanged) {
                        const inv = dist > 0.001 ? 1 / dist : 1;
                        this.spawnProjectile(
                            'companion_bolt',
                            false,
                            `comp:${comp.uid}`,
                            comp.attackPower,
                            comp.pos.x + dx * inv * 0.5,
                            comp.pos.y + 0.9,
                            comp.pos.z + dz * inv * 0.5,
                            dx * inv,
                            0,
                            dz * inv,
                            18
                        );
                        this.soundManager.playRangedCast();
                    } else {
                        const inv = dist > 0.001 ? 1 / dist : 1;
                        this.damageSoloMonster(
                            threat,
                            comp.attackPower,
                            `comp:${comp.uid}`,
                            dx * inv,
                            dz * inv,
                            false
                        );
                        this.soundManager.playHitImpact(false);
                    }
                }
            } else {
                comp.aiState = 'assist_chase';
                speed = cfg.chaseSpeed * 1.15;
                this.moveCompanionToward(comp, cfg, threat.pos.x, threat.pos.z, speed, dt);
            }
        } else {
            comp.targetMonsterId = null;
            comp.aiState = 'follow';
            const yawRad = this.playerController.getYawDeg() * pc.math.DEG_TO_RAD;
            const followX = pPos.x + Math.cos(yawRad) * 1.85 + Math.sin(yawRad) * 1.6;
            const followZ = pPos.z - Math.sin(yawRad) * 1.85 + Math.cos(yawRad) * 1.6;
            const dx = followX - comp.pos.x;
            const dz = followZ - comp.pos.z;
            const dist = Math.hypot(dx, dz);

            if (dist > 22) {
                comp.pos.set(followX, this.collisionWorld.getTerrainHeight(followX, followZ), followZ);
            } else if (dist > 1.1) {
                speed = dist > 6 ? cfg.chaseSpeed * 1.25 : cfg.moveSpeed * 1.05;
                comp.targetYawDeg = yawFromDeltaXZ(dx, dz);
                this.moveCompanionToward(comp, cfg, followX, followZ, speed, dt);
            } else {
                comp.targetYawDeg = this.playerController.getYawDeg();
            }
        }

        comp.yawDeg = lerpAngleDeg(comp.yawDeg, comp.targetYawDeg, 1 - Math.exp(-10 * dt));
        comp.animPhase += dt * (speed > 0.4 ? cfg.bobFreq * 2.1 : cfg.bobFreq);
        const bob = Math.sin(comp.animPhase) * cfg.bobAmp;
        comp.rootEntity.setPosition(comp.pos.x, comp.pos.y + cfg.baseHoverY + bob, comp.pos.z);
        comp.rootEntity.setLocalEulerAngles(0, comp.yawDeg, 0);
        comp.visualPivot.setLocalScale(0.84, 0.84, 0.84);
        this.playCompanionClip(comp, speed > 4.2 ? 'Run' : speed > 0.35 ? 'Walk' : 'Idle', false);
    }

    private moveCompanionToward(
        comp: CompanionActor,
        cfg: SpeciesConfig,
        goalX: number,
        goalZ: number,
        speed: number,
        dt: number
    ): void {
        const dx = goalX - comp.pos.x;
        const dz = goalZ - comp.pos.z;
        const dist = Math.hypot(dx, dz);
        if (dist < 0.05) return;
        const inv = 1 / dist;
        this.tmpVec.set(
            comp.pos.x + dx * inv * speed * dt,
            comp.pos.y,
            comp.pos.z + dz * inv * speed * dt
        );
        const resolved = this.collisionWorld.resolveSphereMovement(
            comp.pos,
            this.tmpVec,
            cfg.bodyRadius * 0.8
        );
        const ny = this.collisionWorld.getTerrainHeight(
            resolved.position.x,
            resolved.position.z
        );
        comp.pos.set(resolved.position.x, ny, resolved.position.z);
    }

    // =========================================================================
    // Co-op Mode Interpolation & Sync
    // =========================================================================

    private handleModeSwitch(online: boolean): void {
        this.isOnlineCoop = online;
        for (const m of this.soloMonsters) {
            m.rootEntity.enabled = !online && m.aiState !== 'captured' && m.aiState !== 'dead';
        }
        if (online) {
            this.recallSoloCompanion();
        }
        for (const m of this.coopMonsters.values()) {
            m.rootEntity.enabled = online && m.aiState !== 'captured' && m.aiState !== 'dead';
        }
        for (const c of this.activeCoopCompanions.values()) {
            c.rootEntity.enabled = online && c.active;
        }
    }

    private syncAuthoritativeCoopStatus(status: CoopSessionStatus): void {
        const localPlayer = status.players.find((p) => p.playerId === status.localPlayerId);
        if (localPlayer) {
            if (typeof localPlayer.hp === 'number') {
                this.playerController.setAuthoritativeHp(
                    localPlayer.hp,
                    localPlayer.maxHp ?? PLAYER_MAX_HP
                );
            }
            if (typeof localPlayer.captureSpheres === 'number') {
                this.captureSpheres = localPlayer.captureSpheres;
            }
            if (typeof localPlayer.lootCount === 'number') {
                this.lootCount = localPlayer.lootCount;
            }
        }

        const seenMonsterIds = new Set<string>();
        const monsters = status.monsters ?? [];
        for (const sync of monsters) {
            seenMonsterIds.add(sync.id);
            let actor = this.coopMonsters.get(sync.id);
            if (!actor) {
                actor = this.createMonsterActor(
                    sync.id,
                    sync.species,
                    sync.level,
                    sync.x,
                    sync.y,
                    sync.z
                );
                this.coopMonsters.set(sync.id, actor);
            }

            const prevState = actor.lastServerState;
            const tookDmg = sync.hp < actor.lastServerHp - 0.5;
            actor.lastServerHp = sync.hp;
            actor.lastServerState = sync.aiState;

            actor.name = sync.name || SPECIES_CONFIGS[sync.species].displayName;
            actor.level = sync.level;
            actor.hp = sync.hp;
            actor.maxHp = sync.maxHp;
            actor.aiState = sync.aiState;
            actor.targetPlayerId = sync.targetPlayerId;
            actor.targetCompanionId = sync.targetCompanionId;
            actor.captureLockByPlayerId = sync.captureLockByPlayerId;
            actor.respawnRemainingMs = sync.respawnRemainingMs;
            actor.attackCharge = sync.attackCharge;
            actor.velX = sync.vx;
            actor.velZ = sync.vz;
            actor.targetPos.set(sync.x, sync.y, sync.z);
            actor.targetYawDeg = sync.yaw;

            const cfg = SPECIES_CONFIGS[actor.species];
            if (tookDmg) {
                actor.hitFlashTimer = 0.22;
                this.playMonsterClip(actor, 'Hit', true);
            } else if (sync.aiState !== prevState) {
                if (sync.aiState === 'attack') {
                    this.playMonsterClip(actor, 'Attack', true);
                } else if (sync.aiState === 'dead') {
                    this.playMonsterClip(actor, 'Die', true);
                } else if (sync.aiState === 'alert' && actor.cryCooldownTimer <= 0) {
                    this.soundManager.playMonsterCry(actor.species);
                    actor.cryCooldownTimer = 4.5;
                }
            }

            if (sync.aiState === 'attack' && sync.attackCharge > 0.02 && cfg.hasAoeTelegraph) {
                this.activateTelegraphRing(
                    `coop:${sync.id}`,
                    sync.x,
                    sync.z,
                    cfg.telegraphRadius,
                    0.65,
                    sync.attackCharge
                );
            }

            if (sync.aiState === 'capturing') {
                actor.captureProgress = clamp(actor.captureProgress + 0.08, 0.1, 0.95);
            } else {
                actor.captureProgress = 0;
                actor.captureScale = 1;
            }
        }

        for (const [id, actor] of this.coopMonsters) {
            if (!seenMonsterIds.has(id)) {
                actor.rootEntity.enabled = false;
            }
        }

        const seenCompIds = new Set<string>();
        const companions = status.companions ?? [];
        for (const cSync of companions) {
            seenCompIds.add(cSync.uid);
            let comp = this.activeCoopCompanions.get(cSync.uid);
            if (!comp) {
                comp = this.createCompanionActor(
                    cSync.uid,
                    cSync.ownerPlayerId,
                    cSync.species,
                    cSync.nickname,
                    cSync.level,
                    cSync.maxHp,
                    SPECIES_CONFIGS[cSync.species].attackPowerCompanion
                );
                comp.pos.set(cSync.x, cSync.y, cSync.z);
                this.activeCoopCompanions.set(cSync.uid, comp);
            }
            comp.active = true;
            comp.rootEntity.enabled = true;
            comp.nickname = cSync.nickname;
            comp.level = cSync.level;
            comp.hp = cSync.hp;
            comp.maxHp = cSync.maxHp;
            comp.aiState = cSync.aiState;
            comp.targetMonsterId = cSync.targetMonsterId;
            comp.targetPos.set(cSync.x, cSync.y, cSync.z);
            comp.targetYawDeg = cSync.yaw;
        }

        for (const [uid, comp] of this.activeCoopCompanions) {
            if (!seenCompIds.has(uid)) {
                comp.active = false;
                comp.rootEntity.enabled = false;
            }
        }
    }

    private updateCoopMonsterActors(dt: number): void {
        const pPos = this.playerController.getPosition();
        const alpha = 1 - Math.exp(-12 * dt);

        for (const m of this.coopMonsters.values()) {
            const hidden = m.aiState === 'captured' || (m.aiState === 'dead' && m.respawnRemainingMs < MONSTER_RESPAWN_MS - 1300);
            m.rootEntity.enabled = !hidden;
            if (hidden) continue;

            if (m.cryCooldownTimer > 0) m.cryCooldownTimer = Math.max(0, m.cryCooldownTimer - dt);
            if (m.hitFlashTimer > 0) {
                m.hitFlashTimer = Math.max(0, m.hitFlashTimer - dt);
                this.updateActorHitTint(m.clonedMaterials, m.hitFlashTimer);
            }

            m.pos.lerp(m.pos, m.targetPos, alpha);
            if (m.aiState === 'capturing') {
                m.captureScale = Math.max(0.14, m.captureScale - dt * 3.0);
            } else {
                m.captureScale = Math.min(1, m.captureScale + dt * 4.5);
            }

            const distToPlayer = Math.hypot(m.pos.x - pPos.x, m.pos.z - pPos.z);
            this.updateMonsterPresentation(
                m,
                SPECIES_CONFIGS[m.species],
                dt,
                distToPlayer <= FULL_TICK_RANGE + 10
            );
        }
    }

    private updateCoopCompanionActors(dt: number): void {
        const alpha = 1 - Math.exp(-12 * dt);
        for (const comp of this.activeCoopCompanions.values()) {
            if (!comp.active) continue;
            const cfg = SPECIES_CONFIGS[comp.species];
            const prevX = comp.pos.x;
            const prevZ = comp.pos.z;
            comp.pos.lerp(comp.pos, comp.targetPos, alpha);
            comp.yawDeg = lerpAngleDeg(comp.yawDeg, comp.targetYawDeg, 1 - Math.exp(-11 * dt));
            const speed = dt > 0.001 ? Math.hypot(comp.pos.x - prevX, comp.pos.z - prevZ) / dt : 0;
            comp.animPhase += dt * (speed > 0.4 ? cfg.bobFreq * 2.0 : cfg.bobFreq);
            const bob = Math.sin(comp.animPhase) * cfg.bobAmp;
            comp.rootEntity.setPosition(comp.pos.x, comp.pos.y + cfg.baseHoverY + bob, comp.pos.z);
            comp.rootEntity.setLocalEulerAngles(0, comp.yawDeg, 0);
            comp.visualPivot.setLocalScale(0.84, 0.84, 0.84);

            if (comp.aiState === 'assist_attack') {
                this.playCompanionClip(comp, 'Attack', false);
            } else {
                this.playCompanionClip(
                    comp,
                    speed > 4.2 ? 'Run' : speed > 0.35 ? 'Walk' : 'Idle',
                    false
                );
            }
        }
    }

    // =========================================================================
    // Visual Presentation & Animation
    // =========================================================================

    private updateMonsterPresentation(
        m: MonsterActor,
        cfg: SpeciesConfig,
        dt: number,
        highDetail: boolean
    ): void {
        m.yawDeg = lerpAngleDeg(m.yawDeg, m.targetYawDeg, 1 - Math.exp(-10 * dt));
        const speed = Math.hypot(m.velX, m.velZ);
        m.animPhase += dt * (speed > 0.5 ? cfg.bobFreq * 2.1 : cfg.bobFreq);
        const bob = highDetail && m.aiState !== 'dead' ? Math.sin(m.animPhase) * cfg.bobAmp : 0;

        m.rootEntity.setPosition(m.pos.x, m.pos.y + cfg.baseHoverY + bob, m.pos.z);
        m.rootEntity.setLocalEulerAngles(0, m.yawDeg, 0);

        // Squash/charge + capture shrink scale
        let sx = m.captureScale;
        let sy = m.captureScale;
        let sz = m.captureScale;
        if (m.aiState === 'attack' && m.attackCharge > 0) {
            const stretch = 1 + m.attackCharge * 0.14;
            sx *= stretch;
            sy *= 1 - m.attackCharge * 0.1;
            sz *= stretch;
        }
        m.visualPivot.setLocalScale(sx, sy, sz);
        m.shadowEntity.enabled = m.aiState !== 'dead' && m.aiState !== 'captured' && m.captureScale > 0.45;

        if (!highDetail && m.aiState !== 'attack' && m.aiState !== 'dead') {
            this.playMonsterClip(m, speed > 0.4 ? 'Walk' : 'Idle', false);
            return;
        }

        if (m.aiState === 'dead') {
            this.playMonsterClip(m, 'Die', false);
        } else if (m.aiState === 'hit') {
            this.playMonsterClip(m, 'Hit', false);
        } else if (m.aiState === 'attack') {
            this.playMonsterClip(m, 'Attack', false);
        } else if (speed > cfg.moveSpeed * 0.85 || m.aiState === 'chase' || m.aiState === 'flee') {
            this.playMonsterClip(m, speed > 0.4 ? 'Run' : 'Idle', false);
        } else if (speed > 0.35) {
            this.playMonsterClip(m, 'Walk', false);
        } else {
            this.playMonsterClip(m, 'Idle', false);
        }
    }

    private playMonsterClip(actor: MonsterActor, key: MonsterClipKey, forceRestart: boolean): void {
        if (!actor.animComponent || !actor.animComponent.baseLayer) return;
        const clip = actor.clipNames.get(key) ?? actor.clipNames.get('Idle');
        if (!clip) return;
        if (actor.activeClip === key && !forceRestart) return;
        actor.activeClip = key;
        if (forceRestart) {
            actor.animComponent.baseLayer.play(clip);
        } else {
            actor.animComponent.baseLayer.transition(clip, 0.14);
        }
    }

    private playCompanionClip(actor: CompanionActor, key: MonsterClipKey, forceRestart: boolean): void {
        if (!actor.animComponent || !actor.animComponent.baseLayer) return;
        const clip = actor.clipNames.get(key) ?? actor.clipNames.get('Idle');
        if (!clip) return;
        if (actor.activeClip === key && !forceRestart) return;
        actor.activeClip = key;
        if (forceRestart) {
            actor.animComponent.baseLayer.play(clip);
        } else {
            actor.animComponent.baseLayer.transition(clip, 0.14);
        }
    }

    // =========================================================================
    // Pools Update (Projectiles, Sparks, Dodge Rings, Telegraphs, Capture Orbs)
    // =========================================================================

    private initPools(): void {
        for (let i = 0; i < PROJECTILE_POOL_SIZE; i += 1) {
            const rootEntity = new pc.Entity(`ProjPool_${i}`);
            const coreEntity = new pc.Entity(`ProjCore_${i}`);
            coreEntity.addComponent('render', {
                meshInstances: [
                    new pc.MeshInstance(
                        this.projectileCoreMesh,
                        this.projectileMaterials.player_arcane.core
                    ),
                ],
                castShadows: false,
                receiveShadows: false,
            });
            const haloEntity = new pc.Entity(`ProjHalo_${i}`);
            haloEntity.addComponent('render', {
                meshInstances: [
                    new pc.MeshInstance(
                        this.projectileHaloMesh,
                        this.projectileMaterials.player_arcane.halo
                    ),
                ],
                castShadows: false,
                receiveShadows: false,
            });
            rootEntity.addChild(coreEntity);
            rootEntity.addChild(haloEntity);
            rootEntity.enabled = false;
            this.combatRoot.addChild(rootEntity);

            this.projectilePool.push({
                active: false,
                kind: 'player_arcane',
                cosmeticOnly: false,
                ownerId: '',
                damage: 18,
                age: 0,
                maxAge: 1.2,
                pos: new pc.Vec3(),
                vel: new pc.Vec3(),
                rootEntity,
                coreEntity,
                haloEntity,
                coreRender: coreEntity.render as pc.RenderComponent,
                haloRender: haloEntity.render as pc.RenderComponent,
            });
        }

        for (let i = 0; i < SPARK_POOL_SIZE; i += 1) {
            const entity = new pc.Entity(`SparkPool_${i}`);
            entity.addComponent('render', {
                meshInstances: [new pc.MeshInstance(this.sparkMesh, this.sparkMaterials.melee)],
                castShadows: false,
                receiveShadows: false,
            });
            entity.enabled = false;
            this.combatRoot.addChild(entity);

            this.sparkPool.push({
                active: false,
                age: 0,
                maxAge: 0.45,
                startScale: 1,
                pos: new pc.Vec3(),
                vel: new pc.Vec3(),
                entity,
                render: entity.render as pc.RenderComponent,
            });
        }

        for (let i = 0; i < DODGE_RING_POOL_SIZE; i += 1) {
            const material = this.createEmissiveMat([0.45, 0.94, 1.0], [0.35, 0.85, 1.0], 0.82);
            material.depthWrite = false;
            material.update();
            const entity = new pc.Entity(`DodgeRing_${i}`);
            entity.addComponent('render', {
                meshInstances: [new pc.MeshInstance(this.dodgeRingMesh, material)],
                castShadows: false,
                receiveShadows: false,
            });
            entity.enabled = false;
            this.combatRoot.addChild(entity);

            this.dodgeRingPool.push({
                active: false,
                age: 0,
                maxAge: 0.42,
                pos: new pc.Vec3(),
                entity,
                material,
            });
        }

        for (let i = 0; i < TELEGRAPH_POOL_SIZE; i += 1) {
            const outerMat = this.createEmissiveMat([1.0, 0.44, 0.22], [1.0, 0.28, 0.12], 0.9);
            outerMat.depthWrite = false;
            outerMat.update();
            const fillMat = this.createEmissiveMat([1.0, 0.34, 0.18], [0.95, 0.22, 0.1], 0.26);
            fillMat.depthWrite = false;
            fillMat.update();

            const rootEntity = new pc.Entity(`Telegraph_${i}`);
            const outerEntity = new pc.Entity(`TelegraphOuter_${i}`);
            outerEntity.addComponent('render', {
                meshInstances: [new pc.MeshInstance(this.telegraphRingMesh, outerMat)],
                castShadows: false,
                receiveShadows: false,
            });
            const fillEntity = new pc.Entity(`TelegraphFill_${i}`);
            fillEntity.addComponent('render', {
                meshInstances: [new pc.MeshInstance(this.telegraphFillMesh, fillMat)],
                castShadows: false,
                receiveShadows: false,
            });
            rootEntity.addChild(outerEntity);
            rootEntity.addChild(fillEntity);
            rootEntity.enabled = false;
            this.combatRoot.addChild(rootEntity);

            this.telegraphPool.push({
                active: false,
                ownerKey: '',
                radius: 3.4,
                charge: 0,
                autoTimer: 0,
                autoDuration: 0.65,
                pos: new pc.Vec3(),
                rootEntity,
                outerEntity,
                fillEntity,
                outerMat,
                fillMat,
            });
        }

        const topMat = this.createEmissiveMat([0.28, 0.88, 0.96], [0.16, 0.62, 0.82]);
        const beltMat = this.createEmissiveMat([1.0, 0.92, 0.45], [0.9, 0.78, 0.25]);
        for (let i = 0; i < CAPTURE_SPHERE_POOL_SIZE; i += 1) {
            const rootEntity = new pc.Entity(`CaptureSphere_${i}`);
            const visualEntity = new pc.Entity(`CaptureSphereVis_${i}`);
            const dome = new pc.Entity(`CaptureDome_${i}`);
            dome.addComponent('render', {
                meshInstances: [new pc.MeshInstance(this.captureDomeMesh, topMat)],
                castShadows: true,
                receiveShadows: false,
            });
            const belt = new pc.Entity(`CaptureBelt_${i}`);
            belt.addComponent('render', {
                meshInstances: [new pc.MeshInstance(this.captureBeltMesh, beltMat)],
                castShadows: false,
                receiveShadows: false,
            });
            visualEntity.addChild(dome);
            visualEntity.addChild(belt);
            rootEntity.addChild(visualEntity);
            rootEntity.enabled = false;
            this.combatRoot.addChild(rootEntity);

            this.captureSpherePool.push({
                active: false,
                cosmeticOnly: false,
                targetMonsterId: '',
                ownerId: '',
                phase: 'flight',
                flightAge: 0,
                flightDuration: 0.34,
                shakeAge: 0,
                shakeDuration: 0.8,
                nextTickIndex: 0,
                startPos: new pc.Vec3(),
                endPos: new pc.Vec3(),
                pos: new pc.Vec3(),
                rootEntity,
                visualEntity,
            });
        }
    }

    private updatePools(dt: number): void {
        this.updateProjectilePool(dt);
        this.updateSparkPool(dt);
        this.updateDodgeRingPool(dt);
        this.updateTelegraphPool(dt);
        this.updateCaptureSpherePool(dt);
    }

    private spawnProjectile(
        kind: PooledProjectile['kind'],
        cosmeticOnly: boolean,
        ownerId: string,
        damage: number,
        x: number,
        y: number,
        z: number,
        dirX: number,
        dirY: number,
        dirZ: number,
        speed: number
    ): void {
        const slot = this.projectilePool.find((p) => !p.active) ?? this.projectilePool[0];
        if (!slot) return;

        slot.active = true;
        slot.kind = kind;
        slot.cosmeticOnly = cosmeticOnly;
        slot.ownerId = ownerId;
        slot.damage = damage;
        slot.age = 0;
        slot.maxAge = kind === 'monster_wisp' ? 1.45 : 1.05;
        slot.pos.set(x, y, z);
        slot.vel.set(dirX * speed, dirY * speed, dirZ * speed);

        const mats = this.projectileMaterials[kind];
        if (slot.coreRender.meshInstances[0]) slot.coreRender.meshInstances[0].material = mats.core;
        if (slot.haloRender.meshInstances[0]) slot.haloRender.meshInstances[0].material = mats.halo;
        slot.rootEntity.setPosition(x, y, z);
        slot.rootEntity.enabled = true;
    }

    private spawnCosmeticBolt(
        x: number,
        y: number,
        z: number,
        targetMonsterId: string | null,
        kind: PooledProjectile['kind']
    ): void {
        let dirX = 0;
        let dirZ = -1;
        if (targetMonsterId) {
            const m = this.findActiveMonsterById(targetMonsterId);
            if (m) {
                const dx = m.pos.x - x;
                const dz = m.pos.z - z;
                const len = Math.hypot(dx, dz) || 1;
                dirX = dx / len;
                dirZ = dz / len;
            }
        }
        this.spawnProjectile(kind, true, 'coop', 0, x, y, z, dirX, 0, dirZ, 22);
    }

    private updateProjectilePool(dt: number): void {
        const pPos = this.playerController.getPosition();

        for (const p of this.projectilePool) {
            if (!p.active) continue;
            p.age += dt;
            if (p.age >= p.maxAge) {
                p.active = false;
                p.rootEntity.enabled = false;
                continue;
            }

            p.pos.x += p.vel.x * dt;
            p.pos.y += p.vel.y * dt;
            p.pos.z += p.vel.z * dt;
            p.rootEntity.setPosition(p.pos.x, p.pos.y, p.pos.z);
            p.haloEntity.rotate(0, dt * 380, dt * 210);

            const groundY = this.collisionWorld.getTerrainHeight(p.pos.x, p.pos.z);
            if (p.pos.y < groundY + 0.1) {
                this.spawnSparkBurst(
                    p.pos.x,
                    groundY + 0.2,
                    p.pos.z,
                    p.kind === 'player_arcane' ? 'arcane' : 'capture',
                    4
                );
                p.active = false;
                p.rootEntity.enabled = false;
                continue;
            }

            if (p.cosmeticOnly) continue;

            if (p.kind === 'player_arcane' || p.kind === 'companion_bolt') {
                for (const m of this.soloMonsters) {
                    if (
                        m.aiState === 'dead' ||
                        m.aiState === 'captured' ||
                        m.aiState === 'capturing' ||
                        m.hp <= 0
                    ) {
                        continue;
                    }
                    const cfg = SPECIES_CONFIGS[m.species];
                    const dx = m.pos.x - p.pos.x;
                    const dz = m.pos.z - p.pos.z;
                    if (dx * dx + dz * dz <= (cfg.bodyRadius + 0.45) * (cfg.bodyRadius + 0.45)) {
                        const inv = 1 / Math.max(0.01, Math.hypot(p.vel.x, p.vel.z));
                        this.damageSoloMonster(
                            m,
                            p.damage,
                            p.ownerId,
                            p.vel.x * inv,
                            p.vel.z * inv,
                            false
                        );
                        this.soundManager.playHitImpact(false);
                        this.spawnSparkBurst(p.pos.x, p.pos.y, p.pos.z, 'arcane', 6);
                        p.active = false;
                        p.rootEntity.enabled = false;
                        break;
                    }
                }
            } else if (p.kind === 'monster_wisp') {
                const pdx = pPos.x - p.pos.x;
                const pdz = pPos.z - p.pos.z;
                if (pdx * pdx + pdz * pdz <= 0.72 * 0.72 && Math.abs(p.pos.y - (pPos.y + 0.9)) < 1.1) {
                    this.applySoloMonsterDamageToPlayer(
                        p.pos.x - p.vel.x * 0.1,
                        p.pos.z - p.vel.z * 0.1,
                        p.damage
                    );
                    this.spawnSparkBurst(p.pos.x, p.pos.y, p.pos.z, 'hit', 6);
                    p.active = false;
                    p.rootEntity.enabled = false;
                }
            }
        }
    }

    private spawnSparkBurst(
        x: number,
        y: number,
        z: number,
        palette: keyof MonsterCombatManager['sparkMaterials'],
        count: number
    ): void {
        const mat = this.sparkMaterials[palette];
        let spawned = 0;
        for (const s of this.sparkPool) {
            if (s.active) continue;
            const angle = Math.random() * Math.PI * 2;
            const spd = 2.6 + Math.random() * 4.2;
            s.active = true;
            s.age = 0;
            s.maxAge = 0.26 + Math.random() * 0.22;
            s.startScale = 0.8 + Math.random() * 0.65;
            s.pos.set(x, y, z);
            s.vel.set(Math.cos(angle) * spd, 2.2 + Math.random() * 3.0, Math.sin(angle) * spd);
            if (s.render.meshInstances[0]) s.render.meshInstances[0].material = mat;
            s.entity.setPosition(x, y, z);
            s.entity.setLocalScale(s.startScale, s.startScale, s.startScale);
            s.entity.enabled = true;
            spawned += 1;
            if (spawned >= count) break;
        }
    }

    private updateSparkPool(dt: number): void {
        for (const s of this.sparkPool) {
            if (!s.active) continue;
            s.age += dt;
            if (s.age >= s.maxAge) {
                s.active = false;
                s.entity.enabled = false;
                continue;
            }
            s.vel.y -= 9.5 * dt;
            s.pos.x += s.vel.x * dt;
            s.pos.y += s.vel.y * dt;
            s.pos.z += s.vel.z * dt;
            const scale = s.startScale * (1 - s.age / s.maxAge);
            s.entity.setPosition(s.pos.x, s.pos.y, s.pos.z);
            s.entity.setLocalScale(scale, scale, scale);
            s.entity.rotate(dt * 340, dt * 260, 0);
        }
    }

    private spawnDodgeRing(x: number, y: number, z: number): void {
        const slot = this.dodgeRingPool.find((r) => !r.active) ?? this.dodgeRingPool[0];
        if (!slot) return;
        const groundY = this.collisionWorld.getTerrainHeight(x, z);
        slot.active = true;
        slot.age = 0;
        slot.pos.set(x, Math.max(y, groundY) + 0.08, z);
        slot.entity.setPosition(slot.pos.x, slot.pos.y, slot.pos.z);
        slot.entity.setLocalScale(0.7, 1, 0.7);
        slot.material.opacity = 0.85;
        slot.material.update();
        slot.entity.enabled = true;
    }

    private updateDodgeRingPool(dt: number): void {
        for (const r of this.dodgeRingPool) {
            if (!r.active) continue;
            r.age += dt;
            if (r.age >= r.maxAge) {
                r.active = false;
                r.entity.enabled = false;
                continue;
            }
            const t = r.age / r.maxAge;
            const scale = 0.7 + t * 1.65;
            r.entity.setLocalScale(scale, 1, scale);
            r.material.opacity = 0.82 * (1 - t);
            r.material.update();
        }
    }

    private activateTelegraphRing(
        ownerKey: string,
        x: number,
        z: number,
        radius: number,
        duration: number,
        explicitCharge?: number
    ): void {
        let slot = this.telegraphPool.find((t) => t.active && t.ownerKey === ownerKey);
        if (!slot) {
            slot = this.telegraphPool.find((t) => !t.active) ?? this.telegraphPool[0];
        }
        if (!slot) return;

        const y = this.collisionWorld.getTerrainHeight(x, z) + 0.08;
        slot.active = true;
        slot.ownerKey = ownerKey;
        slot.radius = radius;
        slot.autoDuration = Math.max(0.2, duration);
        if (typeof explicitCharge === 'number') {
            slot.charge = clamp(explicitCharge, 0.05, 1);
            slot.autoTimer = slot.charge * slot.autoDuration;
        } else if (slot.ownerKey !== ownerKey || slot.autoTimer >= slot.autoDuration) {
            slot.autoTimer = 0;
            slot.charge = 0.05;
        }
        slot.pos.set(x, y, z);
        slot.rootEntity.setPosition(x, y, z);
        slot.outerEntity.setLocalScale(radius, 1, radius);
        slot.rootEntity.enabled = true;
    }

    private updateTelegraphPool(dt: number): void {
        for (const t of this.telegraphPool) {
            if (!t.active) continue;
            t.autoTimer += dt;
            t.charge = clamp(t.autoTimer / t.autoDuration, 0.05, 1);
            if (t.autoTimer >= t.autoDuration + 0.08) {
                t.active = false;
                t.ownerKey = '';
                t.rootEntity.enabled = false;
                continue;
            }
            const fillScale = t.radius * t.charge;
            t.fillEntity.setLocalScale(fillScale, 1, fillScale);
            t.fillMat.opacity = 0.18 + t.charge * 0.28;
            t.fillMat.update();
        }
    }

    private launchCaptureSphereVisual(
        ownerId: string,
        targetMonsterId: string,
        startX: number,
        startY: number,
        startZ: number,
        cosmeticOnly: boolean
    ): void {
        const slot = this.captureSpherePool.find((c) => !c.active) ?? this.captureSpherePool[0];
        if (!slot) return;
        const target = this.findActiveMonsterById(targetMonsterId);
        const endX = target ? target.pos.x : startX;
        const endY = target ? target.pos.y + 0.72 : startY;
        const endZ = target ? target.pos.z : startZ - 4;

        slot.active = true;
        slot.cosmeticOnly = cosmeticOnly;
        slot.ownerId = ownerId;
        slot.targetMonsterId = targetMonsterId;
        slot.phase = 'flight';
        slot.flightAge = 0;
        slot.flightDuration = 0.34;
        slot.shakeAge = 0;
        slot.shakeDuration = Math.max(0.45, CAPTURE_RESOLVE_MS / 1000 - 0.34);
        slot.nextTickIndex = 0;
        slot.startPos.set(startX, startY, startZ);
        slot.endPos.set(endX, endY, endZ);
        slot.pos.copy(slot.startPos);
        slot.rootEntity.setPosition(startX, startY, startZ);
        slot.visualEntity.setLocalEulerAngles(0, 0, 0);
        slot.rootEntity.enabled = true;
    }

    private updateCaptureSpherePool(dt: number): void {
        for (const c of this.captureSpherePool) {
            if (!c.active) continue;
            if (c.phase === 'flight') {
                c.flightAge += dt;
                const t = clamp(c.flightAge / c.flightDuration, 0, 1);
                const arc = Math.sin(t * Math.PI) * 1.45;
                c.pos.lerp(c.startPos, c.endPos, t);
                c.pos.y += arc;
                c.rootEntity.setPosition(c.pos.x, c.pos.y, c.pos.z);
                c.visualEntity.rotate(dt * 420, dt * 320, 0);
                if (t >= 1) {
                    c.phase = 'shake';
                    c.shakeAge = 0;
                    this.spawnSparkBurst(c.pos.x, c.pos.y, c.pos.z, 'arcane', 6);
                }
            } else {
                c.shakeAge += dt;
                const progress = clamp(c.shakeAge / c.shakeDuration, 0, 1);
                const tickStep = Math.floor(progress * 3);
                if (tickStep > c.nextTickIndex && tickStep <= 3) {
                    c.nextTickIndex = tickStep;
                    this.soundManager.playCaptureTick();
                }
                const wobble = Math.sin(progress * Math.PI * 6) * 28 * (1 - progress * 0.25);
                c.rootEntity.setPosition(c.endPos.x, c.endPos.y + Math.abs(wobble) * 0.004, c.endPos.z);
                c.visualEntity.setLocalEulerAngles(0, 0, wobble);

                if (c.shakeAge >= c.shakeDuration) {
                    c.active = false;
                    c.rootEntity.enabled = false;
                }
            }
        }
    }

    private updateLockOnRing(dt: number): void {
        const locked = this.getLockedTargetInfo();
        if (!locked) {
            this.lockRingEntity.enabled = false;
            this.lastCoopLockedTargetId = null;
            return;
        }
        const m = this.findActiveMonsterById(locked.id);
        if (!m) {
            this.lockRingEntity.enabled = false;
            return;
        }
        if (this.lastCoopLockedTargetId !== locked.id) {
            this.lastCoopLockedTargetId = locked.id;
        }
        const cfg = SPECIES_CONFIGS[m.species];
        const ringScale = cfg.bodyRadius * 1.55 + Math.sin(performance.now() * 0.006) * 0.08;
        const groundY = this.collisionWorld.getTerrainHeight(m.pos.x, m.pos.z) + 0.07;

        this.lockRingEntity.enabled = true;
        this.lockRingEntity.setPosition(m.pos.x, groundY, m.pos.z);
        this.lockRingEntity.setLocalScale(ringScale, 1, ringScale);
        this.lockRingEntity.rotate(0, dt * 75, 0);

        if (locked.aiState === 'attack') {
            this.lockRingMaterial.emissive.set(1.0, 0.34, 0.24);
        } else if (locked.captureChancePct >= 55) {
            this.lockRingMaterial.emissive.set(0.32, 0.96, 0.56);
        } else {
            this.lockRingMaterial.emissive.set(0.98, 0.82, 0.28);
        }
        this.lockRingMaterial.update();
    }

    // =========================================================================
    // Popups & Helpers
    // =========================================================================

    private spawnPlayerPopup(text: string, kind: CombatPopupKind): void {
        const pPos = this.playerController.getPosition();
        this.spawnPopup(text, kind, pPos.x, pPos.y + 1.8, pPos.z);
    }

    private spawnPopup(
        text: string,
        kind: CombatPopupKind,
        worldX: number,
        worldY: number,
        worldZ: number
    ): void {
        this.popupSeq += 1;
        this.popups.push({
            id: `pop-${this.popupSeq}`,
            text,
            kind,
            worldX: worldX + (Math.random() - 0.5) * 0.35,
            worldY,
            worldZ: worldZ + (Math.random() - 0.5) * 0.35,
            age: 0,
            maxAge: kind === 'capture_success' ? 1.4 : 0.95,
        });
        if (this.popups.length > 24) {
            this.popups.shift();
        }
    }

    private updatePopups(dt: number): void {
        for (let i = this.popups.length - 1; i >= 0; i -= 1) {
            const p = this.popups[i];
            p.age += dt;
            if (p.age >= p.maxAge) {
                this.popups.splice(i, 1);
            }
        }
    }

    private getActiveWildMonsters(): MonsterActor[] {
        return this.isOnlineCoop ? Array.from(this.coopMonsters.values()) : this.soloMonsters;
    }

    private getActiveCompanionActors(): CompanionActor[] {
        if (this.isOnlineCoop) {
            return Array.from(this.activeCoopCompanions.values());
        }
        const comp = this.getActiveSoloCompanion();
        return comp ? [comp] : [];
    }

    private findActiveMonsterById(id: string): MonsterActor | null {
        if (this.isOnlineCoop) {
            return this.coopMonsters.get(id) ?? null;
        }
        return this.soloMonsters.find((m) => m.id === id) ?? null;
    }

    private findNearestWildMonster(x: number, z: number, maxRadius: number): MonsterActor | null {
        let best: MonsterActor | null = null;
        let bestDist = maxRadius;
        for (const m of this.getActiveWildMonsters()) {
            if (m.aiState === 'dead' || m.aiState === 'captured' || m.hp <= 0) continue;
            const d = Math.hypot(m.pos.x - x, m.pos.z - z);
            if (d < bestDist) {
                bestDist = d;
                best = m;
            }
        }
        return best;
    }

    // =========================================================================
    // Entity / Animation / Mesh Builders
    // =========================================================================

    private createMonsterActor(
        id: string,
        species: MonsterSpeciesId,
        level: number,
        x: number,
        y: number,
        z: number
    ): MonsterActor {
        const cfg = SPECIES_CONFIGS[species];
        const rootEntity = new pc.Entity(`Monster_${id}`);
        const visualPivot = new pc.Entity(`MonsterPivot_${id}`);
        const bundle = this.assetLoader.getBundle(cfg.assetKey);
        const modelEntity =
            bundle.key === cfg.assetKey
                ? bundle.instantiate(`MonsterModel_${id}`)
                : this.createFallbackMonsterEntity(species, `MonsterFallback_${id}`);
        modelEntity.setLocalEulerAngles(0, 180, 0);

        const shadowEntity = new pc.Entity(`MonsterShadow_${id}`);
        shadowEntity.addComponent('render', {
            meshInstances: [new pc.MeshInstance(this.shadowBlobMesh, this.shadowMaterial)],
            castShadows: false,
            receiveShadows: false,
        });
        shadowEntity.setLocalScale(cfg.bodyRadius * 1.4, 1, cfg.bodyRadius * 1.4);
        shadowEntity.setLocalPosition(0, 0.04 - cfg.baseHoverY, 0);

        visualPivot.addChild(modelEntity);
        rootEntity.addChild(visualPivot);
        rootEntity.addChild(shadowEntity);
        rootEntity.setPosition(x, y + cfg.baseHoverY, z);
        this.combatRoot.addChild(rootEntity);

        const { animComponent, clipNames } = this.setupEntityGlbAnimations(modelEntity, bundle);
        const clonedMaterials = this.cloneEntityMaterials(modelEntity);

        const actor: MonsterActor = {
            id,
            species,
            name: cfg.displayName,
            level,
            hp: cfg.maxHp,
            maxHp: cfg.maxHp,
            aiState: 'patrol',
            targetPlayerId: null,
            targetCompanionId: null,
            captureLockByPlayerId: null,
            respawnRemainingMs: 0,
            attackCharge: 0,
            rootEntity,
            visualPivot,
            modelEntity,
            shadowEntity,
            animComponent,
            clipNames,
            activeClip: null,
            clonedMaterials,
            homeX: x,
            homeZ: z,
            pos: new pc.Vec3(x, y, z),
            targetPos: new pc.Vec3(x, y, z),
            velX: 0,
            velZ: 0,
            yawDeg: Math.random() * 360 - 180,
            targetYawDeg: 0,
            waypointX: x,
            waypointZ: z,
            stateTimer: 1.5,
            attackCooldownTimer: 0.4,
            windupDuration: cfg.attackWindup,
            windupElapsed: 0,
            attackDealtInCycle: false,
            hitFlashTimer: 0,
            cryCooldownTimer: 0,
            captureScale: 1,
            captureProgress: 0,
            distantAccumDt: 0,
            animPhase: Math.random() * Math.PI * 2,
            lastServerHp: cfg.maxHp,
            lastServerState: 'patrol',
            telegraphSlotIdx: -1,
        };
        actor.targetYawDeg = actor.yawDeg;
        this.pickPatrolWaypoint(actor);
        this.playMonsterClip(actor, 'Idle', false);
        return actor;
    }

    private createCompanionActor(
        uid: string,
        ownerPlayerId: string,
        species: MonsterSpeciesId,
        nickname: string,
        level: number,
        maxHp: number,
        attackPower: number
    ): CompanionActor {
        const cfg = SPECIES_CONFIGS[species];
        const rootEntity = new pc.Entity(`Companion_${uid}`);
        const visualPivot = new pc.Entity(`CompanionPivot_${uid}`);
        const bundle = this.assetLoader.getBundle(cfg.assetKey);
        const modelEntity =
            bundle.key === cfg.assetKey
                ? bundle.instantiate(`CompanionModel_${uid}`)
                : this.createFallbackMonsterEntity(species, `CompanionFallback_${uid}`);
        modelEntity.setLocalEulerAngles(0, 180, 0);

        const shadowEntity = new pc.Entity(`CompanionShadow_${uid}`);
        shadowEntity.addComponent('render', {
            meshInstances: [new pc.MeshInstance(this.shadowBlobMesh, this.shadowMaterial)],
            castShadows: false,
            receiveShadows: false,
        });
        shadowEntity.setLocalScale(cfg.bodyRadius * 1.15, 1, cfg.bodyRadius * 1.15);
        shadowEntity.setLocalPosition(0, 0.04 - cfg.baseHoverY, 0);

        visualPivot.addChild(modelEntity);
        visualPivot.setLocalScale(0.84, 0.84, 0.84);
        rootEntity.addChild(visualPivot);
        rootEntity.addChild(shadowEntity);
        this.combatRoot.addChild(rootEntity);

        const { animComponent, clipNames } = this.setupEntityGlbAnimations(modelEntity, bundle);
        const clonedMaterials = this.cloneEntityMaterials(modelEntity);

        return {
            uid,
            ownerPlayerId,
            species,
            nickname,
            level,
            hp: maxHp,
            maxHp,
            attackPower,
            aiState: 'follow',
            targetMonsterId: null,
            rootEntity,
            visualPivot,
            modelEntity,
            shadowEntity,
            animComponent,
            clipNames,
            activeClip: null,
            clonedMaterials,
            pos: new pc.Vec3(),
            targetPos: new pc.Vec3(),
            yawDeg: 0,
            targetYawDeg: 0,
            attackCooldownTimer: 0.4,
            animPhase: 0,
            hitFlashTimer: 0,
            active: false,
        };
    }

    private setupEntityGlbAnimations(
        modelEntity: pc.Entity,
        bundle: LoadedModelBundle
    ): { animComponent: pc.AnimComponent | null; clipNames: Map<MonsterClipKey, string> } {
        const clipNames = new Map<MonsterClipKey, string>();
        const resource = bundle.containerAsset?.resource as pc.ContainerResource | undefined;
        const animAssets = resource?.animations;
        if (!animAssets || animAssets.length === 0) {
            return { animComponent: null, clipNames };
        }

        const anim = modelEntity.addComponent('anim', {
            activate: true,
        }) as pc.AnimComponent;

        for (const asset of animAssets) {
            const track = asset.resource as pc.AnimTrack | undefined;
            if (!track) continue;
            const lower = (asset.name || track.name || '').toLowerCase();
            if (lower.includes('idle')) {
                anim.assignAnimation('Idle', track, undefined, 1.0, true);
                clipNames.set('Idle', 'Idle');
            } else if (lower.includes('walk')) {
                anim.assignAnimation('Walk', track, undefined, 1.0, true);
                clipNames.set('Walk', 'Walk');
            } else if (lower.includes('run')) {
                anim.assignAnimation('Run', track, undefined, 1.0, true);
                clipNames.set('Run', 'Run');
            } else if (lower.includes('attack')) {
                anim.assignAnimation('Attack', track, undefined, 1.0, false);
                clipNames.set('Attack', 'Attack');
            } else if (lower.includes('hit')) {
                anim.assignAnimation('Hit', track, undefined, 1.0, false);
                clipNames.set('Hit', 'Hit');
            } else if (lower.includes('die')) {
                anim.assignAnimation('Die', track, undefined, 1.0, false);
                clipNames.set('Die', 'Die');
            }
        }

        if (clipNames.size === 0) {
            modelEntity.removeComponent('anim');
            return { animComponent: null, clipNames };
        }
        return { animComponent: anim, clipNames };
    }

    private createFallbackMonsterEntity(species: MonsterSpeciesId, name: string): pc.Entity {
        const cfg = SPECIES_CONFIGS[species];
        const root = new pc.Entity(name);
        const device = this.app.graphicsDevice;
        const bodyMesh = this.retainMesh(
            pc.Mesh.fromGeometry(
                device,
                new pc.SphereGeometry({ radius: cfg.bodyRadius * 0.72, latitudeBands: 10, longitudeBands: 12 })
            )
        );
        const mat = this.createEmissiveMat(cfg.primaryColor, [
            cfg.accentColor[0] * 0.25,
            cfg.accentColor[1] * 0.25,
            cfg.accentColor[2] * 0.25,
        ]);
        const body = new pc.Entity(`${name}_Body`);
        body.setLocalPosition(0, cfg.bodyRadius * 0.85, 0);
        body.addComponent('render', {
            meshInstances: [new pc.MeshInstance(bodyMesh, mat)],
            castShadows: true,
            receiveShadows: true,
        });
        root.addChild(body);
        return root;
    }

    private cloneEntityMaterials(root: pc.Entity): ClonedMatEntry[] {
        const result: ClonedMatEntry[] = [];
        const walk = (node: pc.GraphNode) => {
            if (node instanceof pc.Entity && node.render) {
                for (const mi of node.render.meshInstances) {
                    if (mi.material instanceof pc.StandardMaterial) {
                        const cloned = mi.material.clone();
                        mi.material = cloned;
                        result.push({
                            material: cloned,
                            baseEmissive: cloned.emissive.clone(),
                        });
                    }
                }
            }
            for (const child of node.children) {
                walk(child);
            }
        };
        walk(root);
        return result;
    }

    private updateActorHitTint(entries: ClonedMatEntry[], flashTimer: number): void {
        const active = flashTimer > 0;
        for (const e of entries) {
            if (active) {
                e.material.emissive.set(0.95, 0.3, 0.22);
            } else {
                e.material.emissive.copy(e.baseEmissive);
            }
            e.material.update();
        }
    }

    private resetActorMaterials(entries: ClonedMatEntry[]): void {
        for (const e of entries) {
            e.material.emissive.copy(e.baseEmissive);
            e.material.update();
        }
    }

    private retainMesh(mesh: pc.Mesh): pc.Mesh {
        mesh.incRefCount();
        this.sharedMeshes.push(mesh);
        return mesh;
    }

    private createEmissiveMat(
        diffuse: [number, number, number],
        emissive: [number, number, number],
        opacity = 1
    ): pc.StandardMaterial {
        const mat = new pc.StandardMaterial();
        mat.diffuse.set(diffuse[0], diffuse[1], diffuse[2]);
        mat.emissive.set(emissive[0], emissive[1], emissive[2]);
        if (opacity < 1) {
            mat.opacity = opacity;
            mat.blendType = pc.BLEND_NORMAL;
        }
        mat.update();
        return mat;
    }

    private createFlatRingMesh(
        device: pc.GraphicsDevice,
        innerR: number,
        outerR: number,
        segments: number
    ): pc.Mesh {
        const positions: number[] = [];
        const normals: number[] = [];
        const indices: number[] = [];

        for (let i = 0; i <= segments; i += 1) {
            const theta = (i / segments) * Math.PI * 2;
            const c = Math.cos(theta);
            const s = Math.sin(theta);
            positions.push(c * innerR, 0, s * innerR);
            normals.push(0, 1, 0);
            positions.push(c * outerR, 0, s * outerR);
            normals.push(0, 1, 0);
        }

        for (let i = 0; i < segments; i += 1) {
            const a = i * 2;
            const b = a + 1;
            const c = a + 2;
            const d = a + 3;
            indices.push(a, c, b, b, c, d);
        }

        const mesh = new pc.Mesh(device);
        mesh.setPositions(positions);
        mesh.setNormals(normals);
        mesh.setIndices(indices);
        mesh.update(pc.PRIMITIVE_TRIANGLES);
        return mesh;
    }
}
