import * as pc from 'playcanvas';
import {
    BUILD_GRID_SIZE_METERS,
    CRAFT_RECIPES,
    ISLAND_MAX_RADIUS,
    MAX_BASE_WORKERS,
    MODULAR_STRUCTURE_RECIPES,
    PLAYER_MAX_HUNGER,
    RESOURCE_RESPAWN_MS,
    SEEDED_RESOURCE_NODES,
    SPECIES_WORK_SUITABILITY,
    TOOL_COMBAT_BONUSES,
    createDefaultSharedResources,
    type BaseWorkerAIState,
    type BaseWorkerSyncState,
    type CapturedMonsterRecord,
    type CraftRecipeId,
    type ModularStructureRecipeDef,
    type ModularStructureRecipeId,
    type PlacedStructureSyncState,
    type ResourceKind,
    type ResourceNodeKind,
    type ResourceNodeSyncState,
    type S2CSurvivalEventMessage,
    type SharedResourceInventory,
    type ToolId,
    type WorkSuitabilityKind,
} from '../shared/NetworkProtocol';
import type { SoundManager } from '../audio/SoundManager';
import type { MonsterCombatManager } from '../combat/MonsterCombatManager';
import type { MultiplayerClient } from '../network/MultiplayerClient';
import type { PlayerController } from '../player/PlayerController';
import type {
    IAssetLoader,
    ICollisionWorld,
    InputState,
    LoadedModelBundle,
    ModelAssetKey,
} from '../types/interfaces';

export interface SurvivalPlateInfo {
    id: string;
    label: string;
    kind: 'resource' | 'structure' | 'worker';
    hp?: number;
    maxHp?: number;
    energy?: number;
    maxEnergy?: number;
    stateTag?: string;
    screenX: number;
    screenY: number;
    visible: boolean;
    distanceMeters: number;
}

export interface SurvivalHudSnapshot {
    hunger: number;
    maxHunger: number;
    equippedTool: ToolId;
    unlockedTools: ToolId[];
    sharedResources: SharedResourceInventory;
    hasWorkbenchNearOrInBase: boolean;
    hasBedNear: boolean;
    nearestResourceLabel: string | null;
    nearestStructureLabel: string | null;
    nearestStructureId: string | null;
    buildMode: boolean;
    selectedBuildRecipe: ModularStructureRecipeId;
    buildRotationDeg: number;
    buildPreviewValid: boolean;
    buildPreviewReason: string | null;
    placedStructures: PlacedStructureSyncState[];
    baseWorkers: BaseWorkerSyncState[];
    capturedRoster: CapturedMonsterRecord[];
    activeCompanionUid: string | null;
    persistenceMode: string;
    plates: SurvivalPlateInfo[];
}

export interface SurvivalBuildingManagerOptions {
    app: pc.Application;
    worldRoot: pc.Entity;
    collisionWorld: ICollisionWorld;
    assetLoader: IAssetLoader;
    playerController: PlayerController;
    soundManager: SoundManager;
    monsterCombatManager: MonsterCombatManager;
    multiplayerClient?: MultiplayerClient | null;
    onToast?: (msg: string, kind: 'info' | 'success' | 'warning' | 'error') => void;
}

interface SoloResourceNode {
    id: string;
    kind: ResourceNodeKind;
    label: string;
    x: number;
    y: number;
    z: number;
    hp: number;
    maxHp: number;
    depleted: boolean;
    respawnAtMs: number;
}

interface ResourceNodeActor {
    id: string;
    kind: ResourceNodeKind;
    label: string;
    x: number;
    y: number;
    z: number;
    entity: pc.Entity;
    visualPivot: pc.Entity;
    colliderId: string;
    colliderActive: boolean;
    colliderRadius: number;
    colliderHeight: number;
    blocksCamera: boolean;
    hitShakeTimer: number;
    respawnScale: number;
    wasDepleted: boolean;
    plateHeight: number;
    state: ResourceNodeSyncState;
}

interface StructureActor {
    id: string;
    recipeId: ModularStructureRecipeId;
    entity: pc.Entity;
    colliderId: string | null;
    state: PlacedStructureSyncState;
    hasFoundation: boolean;
}

interface SoloWorkerInternal {
    uid: string;
    species: CapturedMonsterRecord['species'];
    nickname: string;
    level: number;
    suitability: WorkSuitabilityKind;
    aiState: BaseWorkerAIState;
    energy: number;
    maxEnergy: number;
    x: number;
    y: number;
    z: number;
    yawDeg: number;
    targetId: string | null;
    targetX: number;
    targetZ: number;
    carryingKind: ResourceKind | null;
    carryingAmount: number;
    workTimer: number;
    pendingAction: 'gather' | 'craft_cooked_berry' | 'refine_aether' | null;
}

interface WorkerVisualActor {
    uid: string;
    species: CapturedMonsterRecord['species'];
    entity: pc.Entity;
    modelPivot: pc.Entity;
    carryOrb: pc.Entity;
    carryOrbMi: pc.MeshInstance | null;
    x: number;
    y: number;
    z: number;
    yawDeg: number;
    phase: number;
}

interface SparkParticle {
    entity: pc.Entity;
    mi: pc.MeshInstance;
    active: boolean;
    age: number;
    lifetime: number;
    vx: number;
    vy: number;
    vz: number;
    baseScale: number;
}

interface SoloPersistencePayload {
    version: 1;
    hunger: number;
    equippedTool: ToolId;
    unlockedTools: ToolId[];
    sharedResources: SharedResourceInventory;
    placedStructures: PlacedStructureSyncState[];
    resourceNodes: Array<{
        id: string;
        hp: number;
        depleted: boolean;
        respawnRemainingMs: number;
    }>;
    baseWorkers: SoloWorkerInternal[];
}

const SOLO_STORAGE_KEY = 'zaapworld_solo_phase4_v1';
const HUNGER_DECAY_PER_SEC = 0.35;
const STARVATION_TICK_SEC = 2.5;
const STARVATION_HP_STEP = 2;
const INTERACT_HARVEST_RANGE = 4.2;
const MELEE_HARVEST_RANGE = 3.8;
const CRYSTAL_PRIORITY_RANGE = 2.5;
const BUILD_PREVIEW_DISTANCE = 3.2;
const BED_REST_RANGE = 6.5;
const WORKBENCH_NEAR_RANGE = 10.5;
const DEMOLISH_RANGE = 6.0;
const SPARK_POOL_SIZE = 36;

const RESOURCE_NODE_LABELS: Record<ResourceNodeKind, string> = {
    wood: '목재 나무',
    stone: '바위 광맥',
    ore: '에테르 광석',
    berry: '베리 덤불',
};

const RESOURCE_KIND_LABELS: Record<ResourceKind, string> = {
    wood: '목재',
    stone: '석재',
    ore: '광석',
    berry: '베리',
    aether_shard: '에테르 조각',
    cooked_berry: '구운 베리',
};

const WORKER_STATE_LABELS: Record<BaseWorkerAIState, string> = {
    idle: '대기 중',
    work_gather: '채집 작업',
    work_craft: '제작 작업',
    transport: '운반 중',
    return: '복귀 중',
    rest: '휴식 중',
};

function getStructureRecipe(recipeId: string): ModularStructureRecipeDef | null {
    if (recipeId in MODULAR_STRUCTURE_RECIPES) {
        return MODULAR_STRUCTURE_RECIPES[recipeId as ModularStructureRecipeId];
    }
    return null;
}

function clamp(v: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, v));
}

function lerp(a: number, b: number, t: number): number {
    return a + (b - a) * t;
}

function normalizeAngleDeg(deg: number): number {
    let a = deg % 360;
    if (a > 180) a -= 360;
    if (a < -180) a += 360;
    return a;
}

function lerpAngleDeg(current: number, target: number, t: number): number {
    const diff = normalizeAngleDeg(target - current);
    return normalizeAngleDeg(current + diff * t);
}

function getToolDisplayName(toolId: ToolId): string {
    switch (toolId) {
        case 'wood_axe':
            return '목재 도끼';
        case 'stone_pickaxe':
            return '돌 곡괭이';
        case 'aether_blade':
            return '에테르 검';
        default:
            return '맨손';
    }
}

export class SurvivalBuildingManager {
    private readonly app: pc.Application;
    private readonly worldRoot: pc.Entity;
    private readonly collisionWorld: ICollisionWorld;
    private readonly assetLoader: IAssetLoader;
    private readonly playerController: PlayerController;
    private readonly soundManager: SoundManager;
    private readonly monsterCombatManager: MonsterCombatManager;
    private readonly multiplayerClient: MultiplayerClient | null;
    private readonly onToast?: (
        msg: string,
        kind: 'info' | 'success' | 'warning' | 'error'
    ) => void;

    private readonly survivalRoot = new pc.Entity('SurvivalRoot');
    private readonly nodesRoot = new pc.Entity('ResourceNodesRoot');
    private readonly structuresRoot = new pc.Entity('StructuresRoot');
    private readonly workersRoot = new pc.Entity('BaseWorkersRoot');
    private readonly vfxRoot = new pc.Entity('SurvivalVfxRoot');
    private readonly ghostRoot = new pc.Entity('BuildPreviewGhost');

    // Memory-safe shared GPU resources
    private readonly retainedMeshes: pc.Mesh[] = [];
    private readonly sharedMaterials: pc.StandardMaterial[] = [];

    private boxMesh!: pc.Mesh;
    private cylMesh!: pc.Mesh;
    private coneMesh!: pc.Mesh;
    private sphereMesh!: pc.Mesh;
    private rockMesh!: pc.Mesh;
    private crystalMesh!: pc.Mesh;
    private discMesh!: pc.Mesh;

    private birchTrunkMat!: pc.StandardMaterial;
    private barkBandMat!: pc.StandardMaterial;
    private timberTrunkMat!: pc.StandardMaterial;
    private leafDarkMat!: pc.StandardMaterial;
    private leafBrightMat!: pc.StandardMaterial;
    private stoneLightMat!: pc.StandardMaterial;
    private stoneDarkMat!: pc.StandardMaterial;
    private oreBasaltMat!: pc.StandardMaterial;
    private oreCyanMat!: pc.StandardMaterial;
    private oreAmberMat!: pc.StandardMaterial;
    private berryLeafMat!: pc.StandardMaterial;
    private berryCrimsonMat!: pc.StandardMaterial;

    private woodPlankMat!: pc.StandardMaterial;
    private woodBeamMat!: pc.StandardMaterial;
    private woodRoofMat!: pc.StandardMaterial;
    private bronzeAccentMat!: pc.StandardMaterial;

    private ghostValidMat!: pc.StandardMaterial;
    private ghostInvalidMat!: pc.StandardMaterial;
    private shadowMat!: pc.StandardMaterial;
    private carryMaterials!: Record<ResourceKind, pc.StandardMaterial>;
    private sparkMaterials!: Record<ResourceNodeKind | 'build', pc.StandardMaterial>;

    // World actor maps & pools
    private readonly nodeActors = new Map<string, ResourceNodeActor>();
    private readonly structureActors = new Map<string, StructureActor>();
    private readonly workerActors = new Map<string, WorkerVisualActor>();
    private readonly sparkPool: SparkParticle[] = [];
    private sparkCursor = 0;

    // Ghost preview state
    private readonly ghostPartsByRecipe = new Map<ModularStructureRecipeId, pc.Entity>();
    private readonly ghostMeshInstances = new Map<ModularStructureRecipeId, pc.MeshInstance[]>();
    private buildMode = false;
    private selectedBuildRecipe: ModularStructureRecipeId = 'wood_foundation';
    private buildRotationDeg = 0;
    private buildPreviewValid = false;
    private buildPreviewReason: string | null = null;
    private previewGridX = 0;
    private previewGridZ = 0;
    private previewPlaceY = 0;

    // Solo simulation state
    private soloHunger = PLAYER_MAX_HUNGER;
    private soloEquippedTool: ToolId = 'hands';
    private soloUnlockedTools: ToolId[] = ['hands'];
    private soloSharedResources: SharedResourceInventory = createDefaultSharedResources();
    private soloNodes = new Map<string, SoloResourceNode>();
    private soloStructures: PlacedStructureSyncState[] = [];
    private soloWorkers: SoloWorkerInternal[] = [];
    private starvationTimer = 0;
    private gatherCooldownTimer = 0;
    private soloDirty = false;
    private saveDebounceHandle: number | null = null;

    // Online sync tracking
    private wasOnline = false;
    private unsubscribeSurvivalEvent: (() => void) | null = null;
    private lastSyncedTool: ToolId | null = null;
    private readonly boundBeforeUnload: () => void;

    // Scratch vectors
    private readonly tmpVec = new pc.Vec3();
    private readonly tmpVec2 = new pc.Vec3();
    private readonly tmpNormal = new pc.Vec3();
    private readonly tmpForward = new pc.Vec3();
    private readonly tmpScreen = new pc.Vec3();

    constructor(options: SurvivalBuildingManagerOptions) {
        this.app = options.app;
        this.worldRoot = options.worldRoot;
        this.collisionWorld = options.collisionWorld;
        this.assetLoader = options.assetLoader;
        this.playerController = options.playerController;
        this.soundManager = options.soundManager;
        this.monsterCombatManager = options.monsterCombatManager;
        this.multiplayerClient = options.multiplayerClient ?? null;
        this.onToast = options.onToast;

        this.worldRoot.addChild(this.survivalRoot);
        this.survivalRoot.addChild(this.nodesRoot);
        this.survivalRoot.addChild(this.structuresRoot);
        this.survivalRoot.addChild(this.workersRoot);
        this.survivalRoot.addChild(this.vfxRoot);
        this.survivalRoot.addChild(this.ghostRoot);
        this.ghostRoot.enabled = false;

        this.createSharedAssets();
        this.initSparkPool();
        this.initGhostPreviews();
        this.initSoloStateFromSeedOrStorage();
        this.spawnInitialResourceNodeActors();

        // Apply initial loaded tool bonuses & worker exclusions in Solo
        this.syncSoloCombatIntegration();
        this.rebuildSoloStructureActors();

        if (this.multiplayerClient) {
            this.unsubscribeSurvivalEvent = this.multiplayerClient.onSurvivalEvent((evt) => {
                this.handleOnlineSurvivalEvent(evt);
            });
        }

        this.boundBeforeUnload = () => {
            this.flushSoloPersistenceNow();
        };
        if (typeof window !== 'undefined') {
            window.addEventListener('beforeunload', this.boundBeforeUnload);
        }
    }

    // -------------------------------------------------------------------------
    // Shared Meshes, Materials & Pools (PlayCanvas Memory Safe)
    // -------------------------------------------------------------------------

    private retainMesh(mesh: pc.Mesh): pc.Mesh {
        mesh.incRefCount();
        this.retainedMeshes.push(mesh);
        return mesh;
    }

    private makeMaterial(
        name: string,
        diffuse: [number, number, number],
        opts?: {
            emissive?: [number, number, number];
            emissiveIntensity?: number;
            gloss?: number;
            metalness?: number;
            opacity?: number;
            doubleSided?: boolean;
        }
    ): pc.StandardMaterial {
        const mat = new pc.StandardMaterial();
        mat.name = name;
        mat.diffuse = new pc.Color(diffuse[0], diffuse[1], diffuse[2]);
        mat.useMetalness = true;
        mat.metalness = opts?.metalness ?? 0.06;
        mat.gloss = opts?.gloss ?? 0.32;
        if (opts?.emissive) {
            mat.emissive = new pc.Color(opts.emissive[0], opts.emissive[1], opts.emissive[2]);
            mat.emissiveIntensity = opts.emissiveIntensity ?? 1.0;
        }
        if (opts?.opacity !== undefined && opts.opacity < 1) {
            mat.opacity = opts.opacity;
            mat.blendType = pc.BLEND_NORMAL;
            mat.depthWrite = false;
        }
        if (opts?.doubleSided) {
            mat.cull = pc.CULLFACE_NONE;
        }
        mat.update();
        this.sharedMaterials.push(mat);
        return mat;
    }

    private createSharedAssets(): void {
        const device = this.app.graphicsDevice;
        this.boxMesh = this.retainMesh(pc.Mesh.fromGeometry(device, new pc.BoxGeometry()));
        this.cylMesh = this.retainMesh(
            pc.Mesh.fromGeometry(
                device,
                new pc.CylinderGeometry({ radius: 0.5, height: 1, capSegments: 10 })
            )
        );
        this.coneMesh = this.retainMesh(
            pc.Mesh.fromGeometry(
                device,
                new pc.ConeGeometry({ baseRadius: 0.5, peakRadius: 0, height: 1, capSegments: 10 })
            )
        );
        this.sphereMesh = this.retainMesh(
            pc.Mesh.fromGeometry(
                device,
                new pc.SphereGeometry({ radius: 0.5, latitudeBands: 8, longitudeBands: 12 })
            )
        );
        this.rockMesh = this.retainMesh(
            pc.Mesh.fromGeometry(
                device,
                new pc.SphereGeometry({ radius: 0.5, latitudeBands: 4, longitudeBands: 6 })
            )
        );
        this.crystalMesh = this.retainMesh(
            pc.Mesh.fromGeometry(
                device,
                new pc.ConeGeometry({ baseRadius: 0.34, peakRadius: 0, height: 1, capSegments: 5 })
            )
        );
        this.discMesh = this.retainMesh(
            pc.Mesh.fromGeometry(
                device,
                new pc.CylinderGeometry({ radius: 0.5, height: 0.04, capSegments: 14 })
            )
        );

        this.birchTrunkMat = this.makeMaterial('surv_birch_trunk', [0.85, 0.83, 0.77], { gloss: 0.25 });
        this.barkBandMat = this.makeMaterial('surv_bark_band', [0.24, 0.21, 0.19], { gloss: 0.2 });
        this.timberTrunkMat = this.makeMaterial('surv_timber_trunk', [0.42, 0.27, 0.17], { gloss: 0.22 });
        this.leafDarkMat = this.makeMaterial('surv_leaf_dark', [0.18, 0.46, 0.22], { gloss: 0.26 });
        this.leafBrightMat = this.makeMaterial('surv_leaf_bright', [0.32, 0.62, 0.27], { gloss: 0.3 });
        this.stoneLightMat = this.makeMaterial('surv_stone_light', [0.55, 0.57, 0.59], { gloss: 0.24 });
        this.stoneDarkMat = this.makeMaterial('surv_stone_dark', [0.36, 0.39, 0.43], { gloss: 0.26 });
        this.oreBasaltMat = this.makeMaterial('surv_ore_basalt', [0.18, 0.2, 0.24], { gloss: 0.3 });
        this.oreCyanMat = this.makeMaterial('surv_ore_cyan', [0.16, 0.9, 0.96], {
            emissive: [0.14, 0.74, 0.85],
            emissiveIntensity: 1.4,
            gloss: 0.82,
        });
        this.oreAmberMat = this.makeMaterial('surv_ore_amber', [0.96, 0.66, 0.18], {
            emissive: [0.82, 0.45, 0.1],
            emissiveIntensity: 1.25,
            gloss: 0.78,
        });
        this.berryLeafMat = this.makeMaterial('surv_berry_leaf', [0.21, 0.51, 0.23], { gloss: 0.3 });
        this.berryCrimsonMat = this.makeMaterial('surv_berry_crimson', [0.88, 0.14, 0.2], {
            emissive: [0.22, 0.02, 0.04],
            emissiveIntensity: 0.9,
            gloss: 0.75,
        });

        this.woodPlankMat = this.makeMaterial('surv_wood_plank', [0.59, 0.41, 0.24], { gloss: 0.28 });
        this.woodBeamMat = this.makeMaterial('surv_wood_beam', [0.37, 0.24, 0.14], { gloss: 0.24 });
        this.woodRoofMat = this.makeMaterial('surv_wood_roof', [0.47, 0.29, 0.18], { gloss: 0.25 });
        this.bronzeAccentMat = this.makeMaterial('surv_bronze', [0.74, 0.58, 0.29], {
            metalness: 0.72,
            gloss: 0.68,
        });

        this.ghostValidMat = this.makeMaterial('surv_ghost_valid', [0.22, 0.94, 0.54], {
            emissive: [0.1, 0.56, 0.28],
            emissiveIntensity: 1.15,
            opacity: 0.46,
            doubleSided: true,
        });
        this.ghostInvalidMat = this.makeMaterial('surv_ghost_invalid', [0.96, 0.24, 0.24], {
            emissive: [0.64, 0.1, 0.1],
            emissiveIntensity: 1.15,
            opacity: 0.48,
            doubleSided: true,
        });
        this.shadowMat = this.makeMaterial('surv_shadow', [0.04, 0.06, 0.09], {
            opacity: 0.34,
            gloss: 0.1,
        });

        this.carryMaterials = {
            wood: this.makeMaterial('surv_carry_wood', [0.58, 0.39, 0.21], {
                emissive: [0.16, 0.09, 0.03],
            }),
            stone: this.makeMaterial('surv_carry_stone', [0.62, 0.64, 0.68], {
                emissive: [0.14, 0.14, 0.18],
            }),
            ore: this.makeMaterial('surv_carry_ore', [0.24, 0.88, 0.96], {
                emissive: [0.14, 0.66, 0.78],
                emissiveIntensity: 1.2,
            }),
            berry: this.makeMaterial('surv_carry_berry', [0.9, 0.18, 0.26], {
                emissive: [0.35, 0.05, 0.08],
            }),
            aether_shard: this.makeMaterial('surv_carry_aether', [0.54, 0.48, 0.98], {
                emissive: [0.35, 0.3, 0.85],
                emissiveIntensity: 1.3,
            }),
            cooked_berry: this.makeMaterial('surv_carry_cooked', [0.98, 0.58, 0.2], {
                emissive: [0.5, 0.22, 0.06],
                emissiveIntensity: 1.15,
            }),
        };

        this.sparkMaterials = {
            wood: this.makeMaterial('surv_spark_wood', [0.76, 0.56, 0.3], {
                emissive: [0.35, 0.22, 0.08],
                emissiveIntensity: 1.1,
            }),
            stone: this.makeMaterial('surv_spark_stone', [0.76, 0.79, 0.82], {
                emissive: [0.32, 0.34, 0.38],
                emissiveIntensity: 1.1,
            }),
            ore: this.makeMaterial('surv_spark_ore', [0.3, 0.94, 1.0], {
                emissive: [0.24, 0.8, 0.95],
                emissiveIntensity: 1.5,
            }),
            berry: this.makeMaterial('surv_spark_berry', [0.95, 0.22, 0.3], {
                emissive: [0.55, 0.12, 0.14],
                emissiveIntensity: 1.2,
            }),
            build: this.makeMaterial('surv_spark_build', [0.38, 0.92, 0.64], {
                emissive: [0.2, 0.7, 0.4],
                emissiveIntensity: 1.3,
            }),
        };
    }

    private attachMeshPart(
        parent: pc.Entity,
        name: string,
        mesh: pc.Mesh,
        material: pc.StandardMaterial,
        pos: [number, number, number],
        scale: [number, number, number],
        rotEuler: [number, number, number] = [0, 0, 0],
        castShadows = true,
        receiveShadows = true
    ): { entity: pc.Entity; mi: pc.MeshInstance } {
        const part = new pc.Entity(name);
        const mi = new pc.MeshInstance(mesh, material);
        part.addComponent('render', {
            meshInstances: [mi],
            castShadows,
            receiveShadows,
        });
        part.setLocalPosition(pos[0], pos[1], pos[2]);
        part.setLocalScale(scale[0], scale[1], scale[2]);
        if (rotEuler[0] !== 0 || rotEuler[1] !== 0 || rotEuler[2] !== 0) {
            part.setLocalEulerAngles(rotEuler[0], rotEuler[1], rotEuler[2]);
        }
        parent.addChild(part);
        return { entity: part, mi };
    }

    private initSparkPool(): void {
        for (let i = 0; i < SPARK_POOL_SIZE; i++) {
            const { entity, mi } = this.attachMeshPart(
                this.vfxRoot,
                `SurvivalSpark_${i}`,
                this.boxMesh,
                this.sparkMaterials.wood,
                [0, -50, 0],
                [0.12, 0.12, 0.12],
                [0, 0, 0],
                false,
                false
            );
            entity.enabled = false;
            this.sparkPool.push({
                entity,
                mi,
                active: false,
                age: 0,
                lifetime: 0.4,
                vx: 0,
                vy: 0,
                vz: 0,
                baseScale: 0.12,
            });
        }
    }

    private spawnSparkBurst(
        x: number,
        y: number,
        z: number,
        kind: ResourceNodeKind | 'build',
        count = 6
    ): void {
        const mat = this.sparkMaterials[kind];
        for (let i = 0; i < count; i++) {
            const p = this.sparkPool[this.sparkCursor % this.sparkPool.length];
            this.sparkCursor = (this.sparkCursor + 1) % this.sparkPool.length;
            const angle = ((i + Math.random() * 0.7) / count) * Math.PI * 2;
            const horizSpeed = 1.6 + Math.random() * 2.4;
            p.mi.material = mat;
            p.active = true;
            p.age = 0;
            p.lifetime = 0.28 + Math.random() * 0.18;
            p.vx = Math.cos(angle) * horizSpeed;
            p.vy = 2.6 + Math.random() * 2.4;
            p.vz = Math.sin(angle) * horizSpeed;
            p.baseScale = kind === 'ore' ? 0.14 : 0.11;
            p.entity.setLocalPosition(x, y, z);
            p.entity.setLocalScale(p.baseScale, p.baseScale, p.baseScale);
            p.entity.enabled = true;
        }
    }

    private updateSparks(dt: number): void {
        for (const p of this.sparkPool) {
            if (!p.active) continue;
            p.age += dt;
            if (p.age >= p.lifetime) {
                p.active = false;
                p.entity.enabled = false;
                continue;
            }
            p.vy -= 9.5 * dt;
            const pos = p.entity.getLocalPosition();
            p.entity.setLocalPosition(pos.x + p.vx * dt, pos.y + p.vy * dt, pos.z + p.vz * dt);
            const fade = clamp(1 - p.age / p.lifetime, 0.05, 1);
            const s = p.baseScale * fade;
            p.entity.setLocalScale(s, s, s);
            p.entity.rotate(260 * dt, 190 * dt, 0);
        }
    }

    // -------------------------------------------------------------------------
    // 24 Harvestable Resource Nodes
    // -------------------------------------------------------------------------

    private initSoloStateFromSeedOrStorage(): void {
        for (const def of SEEDED_RESOURCE_NODES) {
            const y = this.collisionWorld.getTerrainHeight(def.x, def.z);
            this.soloNodes.set(def.id, {
                id: def.id,
                kind: def.kind,
                label: RESOURCE_NODE_LABELS[def.kind],
                x: def.x,
                y,
                z: def.z,
                hp: def.maxHp,
                maxHp: def.maxHp,
                depleted: false,
                respawnAtMs: 0,
            });
        }

        if (typeof localStorage === 'undefined') return;
        try {
            const raw = localStorage.getItem(SOLO_STORAGE_KEY);
            if (!raw) return;
            const parsed = JSON.parse(raw) as Partial<SoloPersistencePayload>;
            if (!parsed || parsed.version !== 1) return;

            if (typeof parsed.hunger === 'number' && Number.isFinite(parsed.hunger)) {
                this.soloHunger = clamp(parsed.hunger, 0, PLAYER_MAX_HUNGER);
            }
            if (Array.isArray(parsed.unlockedTools)) {
                const validTools = parsed.unlockedTools.filter(
                    (t): t is ToolId =>
                        t === 'hands' ||
                        t === 'wood_axe' ||
                        t === 'stone_pickaxe' ||
                        t === 'aether_blade'
                );
                if (!validTools.includes('hands')) validTools.unshift('hands');
                this.soloUnlockedTools = Array.from(new Set(validTools));
            }
            if (
                parsed.equippedTool &&
                this.soloUnlockedTools.includes(parsed.equippedTool)
            ) {
                this.soloEquippedTool = parsed.equippedTool;
            }
            if (parsed.sharedResources && typeof parsed.sharedResources === 'object') {
                const base = createDefaultSharedResources();
                for (const k of Object.keys(base) as ResourceKind[]) {
                    const v = Number(parsed.sharedResources[k]);
                    base[k] = Number.isFinite(v) ? Math.max(0, Math.floor(v)) : base[k];
                }
                this.soloSharedResources = base;
            }
            if (Array.isArray(parsed.placedStructures)) {
                this.soloStructures = parsed.placedStructures
                    .filter((s) => s && typeof s.id === 'string' && s.recipeId in MODULAR_STRUCTURE_RECIPES)
                    .map((s) => ({ ...s }));
            }
            if (Array.isArray(parsed.resourceNodes)) {
                const nowMs = Date.now();
                for (const saved of parsed.resourceNodes) {
                    const node = this.soloNodes.get(saved.id);
                    if (!node) continue;
                    node.depleted = Boolean(saved.depleted);
                    if (node.depleted) {
                        const rem = clamp(Number(saved.respawnRemainingMs) || RESOURCE_RESPAWN_MS, 500, RESOURCE_RESPAWN_MS);
                        node.hp = 0;
                        node.respawnAtMs = nowMs + rem;
                    } else {
                        node.hp = clamp(Number(saved.hp) || node.maxHp, 1, node.maxHp);
                        node.respawnAtMs = 0;
                    }
                }
            }
            if (Array.isArray(parsed.baseWorkers)) {
                const rosterIds = new Set(
                    this.monsterCombatManager.getCapturedRoster().map((r) => r.uid)
                );
                // Keep saved workers whose uid still matches roster (or preserve gracefully if combat manager starts empty)
                this.soloWorkers = parsed.baseWorkers
                    .slice(0, MAX_BASE_WORKERS)
                    .filter((w) => w && typeof w.uid === 'string' && (rosterIds.size === 0 || rosterIds.has(w.uid)))
                    .map((w) => ({
                        ...w,
                        y: this.collisionWorld.getTerrainHeight(w.x, w.z),
                    }));
            }
        } catch {
            // Ignore malformed persisted data
        }
    }

    private spawnInitialResourceNodeActors(): void {
        for (const def of SEEDED_RESOURCE_NODES) {
            const solo = this.soloNodes.get(def.id);
            const y = solo ? solo.y : this.collisionWorld.getTerrainHeight(def.x, def.z);
            const entity = new pc.Entity(`ResourceNode_${def.id}`);
            entity.setPosition(def.x, y, def.z);
            const visualPivot = new pc.Entity('VisualPivot');
            entity.addChild(visualPivot);
            this.nodesRoot.addChild(entity);

            const numSeed = Number(def.id.replace(/\D/g, '')) || 1;
            const yaw = (numSeed * 53) % 360;
            visualPivot.setLocalEulerAngles(0, yaw, 0);

            let colliderRadius = 0.75;
            let colliderHeight = 1.4;
            let blocksCamera = true;
            let plateHeight = 2.0;

            if (def.kind === 'wood') {
                const isBirch = numSeed % 2 === 1;
                const trunkMat = isBirch ? this.birchTrunkMat : this.timberTrunkMat;
                const leafMat = isBirch ? this.leafBrightMat : this.leafDarkMat;
                this.attachMeshPart(visualPivot, 'Trunk', this.cylMesh, trunkMat, [0, 1.08, 0], [0.34, 2.2, 0.34]);
                if (isBirch) {
                    this.attachMeshPart(visualPivot, 'BandA', this.cylMesh, this.barkBandMat, [0, 0.58, 0], [0.355, 0.12, 0.355]);
                    this.attachMeshPart(visualPivot, 'BandB', this.cylMesh, this.barkBandMat, [0, 1.38, 0], [0.355, 0.12, 0.355]);
                }
                this.attachMeshPart(visualPivot, 'CrownLower', this.coneMesh, this.leafDarkMat, [0, 2.28, 0], [1.75, 1.35, 1.75]);
                this.attachMeshPart(visualPivot, 'CrownMid', this.coneMesh, leafMat, [0, 2.96, 0], [1.38, 1.15, 1.38]);
                this.attachMeshPart(visualPivot, 'CrownTop', this.sphereMesh, leafMat, [0.1, 3.45, -0.06], [0.88, 0.78, 0.88]);
                colliderRadius = 0.56;
                colliderHeight = 3.5;
                blocksCamera = true;
                plateHeight = 3.95;
            } else if (def.kind === 'stone') {
                this.attachMeshPart(visualPivot, 'BoulderMain', this.rockMesh, this.stoneLightMat, [0, 0.46, 0], [1.55, 1.05, 1.38], [8, 14, -5]);
                this.attachMeshPart(visualPivot, 'BoulderSubA', this.rockMesh, this.stoneDarkMat, [-0.56, 0.3, 0.38], [0.9, 0.65, 0.82], [-12, 24, 15]);
                this.attachMeshPart(visualPivot, 'BoulderSubB', this.rockMesh, this.stoneDarkMat, [0.52, 0.25, -0.35], [0.76, 0.54, 0.74], [10, -20, -14]);
                colliderRadius = 0.92;
                colliderHeight = 1.25;
                blocksCamera = true;
                plateHeight = 1.6;
            } else if (def.kind === 'ore') {
                this.attachMeshPart(visualPivot, 'BasaltCore', this.rockMesh, this.oreBasaltMat, [0, 0.44, 0], [1.46, 0.98, 1.36], [6, 10, -6]);
                this.attachMeshPart(visualPivot, 'BasaltSub', this.rockMesh, this.stoneDarkMat, [-0.5, 0.28, -0.32], [0.85, 0.6, 0.8], [-8, 35, 10]);
                this.attachMeshPart(visualPivot, 'CrystalA', this.crystalMesh, this.oreCyanMat, [0.22, 0.88, 0.16], [0.42, 0.9, 0.42], [18, 22, -24]);
                this.attachMeshPart(visualPivot, 'CrystalB', this.crystalMesh, this.oreAmberMat, [-0.26, 0.76, 0.2], [0.36, 0.78, 0.36], [-22, -16, 28]);
                this.attachMeshPart(visualPivot, 'CrystalC', this.crystalMesh, this.oreCyanMat, [0.02, 0.96, -0.24], [0.34, 0.84, 0.34], [-25, 40, -12]);
                colliderRadius = 0.88;
                colliderHeight = 1.25;
                blocksCamera = true;
                plateHeight = 1.85;
            } else {
                // Berry bush
                this.attachMeshPart(visualPivot, 'BushCenter', this.sphereMesh, this.berryLeafMat, [0, 0.38, 0], [1.08, 0.78, 1.08]);
                this.attachMeshPart(visualPivot, 'BushLeft', this.sphereMesh, this.leafBrightMat, [-0.36, 0.28, 0.18], [0.76, 0.6, 0.76]);
                this.attachMeshPart(visualPivot, 'BushRight', this.sphereMesh, this.leafDarkMat, [0.34, 0.3, -0.18], [0.78, 0.62, 0.78]);
                const berryOffsets: [number, number, number][] = [
                    [0.24, 0.62, 0.28],
                    [-0.22, 0.56, 0.3],
                    [0.36, 0.46, -0.18],
                    [-0.38, 0.42, 0.04],
                    [0.05, 0.72, -0.12],
                    [-0.08, 0.52, -0.36],
                ];
                for (let bi = 0; bi < berryOffsets.length; bi++) {
                    this.attachMeshPart(
                        visualPivot,
                        `Berry_${bi}`,
                        this.sphereMesh,
                        this.berryCrimsonMat,
                        berryOffsets[bi],
                        [0.14, 0.14, 0.14],
                        [0, 0, 0],
                        false,
                        false
                    );
                }
                colliderRadius = 0.64;
                colliderHeight = 0.88;
                blocksCamera = false;
                plateHeight = 1.25;
            }

            const colliderId = `resource_${def.id}`;
            const label = RESOURCE_NODE_LABELS[def.kind];
            const initialState: ResourceNodeSyncState = {
                id: def.id,
                kind: def.kind,
                name: label,
                x: def.x,
                y,
                z: def.z,
                hp: solo ? solo.hp : def.maxHp,
                maxHp: def.maxHp,
                depleted: solo ? solo.depleted : false,
                respawnRemainingMs: solo && solo.depleted ? Math.max(0, solo.respawnAtMs - Date.now()) : 0,
            };

            const actor: ResourceNodeActor = {
                id: def.id,
                kind: def.kind,
                label,
                x: def.x,
                y,
                z: def.z,
                entity,
                visualPivot,
                colliderId,
                colliderActive: false,
                colliderRadius,
                colliderHeight,
                blocksCamera,
                hitShakeTimer: 0,
                respawnScale: initialState.depleted ? 0.05 : 1,
                wasDepleted: initialState.depleted,
                plateHeight,
                state: initialState,
            };

            this.syncNodeActorColliderAndVisibility(actor, initialState.depleted);
            this.nodeActors.set(def.id, actor);
        }
    }

    private syncNodeActorColliderAndVisibility(actor: ResourceNodeActor, depleted: boolean): void {
        actor.entity.enabled = !depleted;
        if (!depleted && !actor.colliderActive) {
            this.collisionWorld.registerCollider({
                id: actor.colliderId,
                type: 'cylinder',
                tag: 'resource',
                position: new pc.Vec3(actor.x, actor.y + actor.colliderHeight * 0.5, actor.z),
                radius: actor.colliderRadius,
                height: actor.colliderHeight,
                blocksCamera: actor.blocksCamera,
            });
            actor.colliderActive = true;
        } else if (depleted && actor.colliderActive) {
            this.collisionWorld.removeCollider(actor.colliderId);
            actor.colliderActive = false;
        }
    }

    // -------------------------------------------------------------------------
    // Modular Structure Visuals & Ghost Preview
    // -------------------------------------------------------------------------

    private buildProceduralStructureParts(
        parent: pc.Entity,
        recipeId: ModularStructureRecipeId,
        hasFoundation: boolean,
        ghostMat: pc.StandardMaterial | null,
        collectMIs?: pc.MeshInstance[]
    ): void {
        const add = (
            name: string,
            mesh: pc.Mesh,
            mat: pc.StandardMaterial,
            pos: [number, number, number],
            scale: [number, number, number],
            rot: [number, number, number] = [0, 0, 0]
        ) => {
            const { mi } = this.attachMeshPart(
                parent,
                name,
                mesh,
                ghostMat ?? mat,
                pos,
                scale,
                rot,
                ghostMat === null,
                ghostMat === null
            );
            if (collectMIs) collectMIs.push(mi);
        };

        if (recipeId === 'wood_foundation') {
            add('DeckMain', this.boxMesh, this.woodPlankMat, [0, 0.175, 0], [2.0, 0.35, 2.0]);
            add('TrimN', this.boxMesh, this.woodBeamMat, [0, 0.24, -0.94], [2.02, 0.24, 0.12]);
            add('TrimS', this.boxMesh, this.woodBeamMat, [0, 0.24, 0.94], [2.02, 0.24, 0.12]);
            add('TrimW', this.boxMesh, this.woodBeamMat, [-0.94, 0.24, 0], [0.12, 0.24, 1.88]);
            add('TrimE', this.boxMesh, this.woodBeamMat, [0.94, 0.24, 0], [0.12, 0.24, 1.88]);
            return;
        }

        if (recipeId === 'wood_wall') {
            add('WallPanel', this.boxMesh, this.woodPlankMat, [0, 1.3, 0], [2.0, 2.6, 0.22]);
            add('PostL', this.boxMesh, this.woodBeamMat, [-0.92, 1.3, 0], [0.18, 2.62, 0.26]);
            add('PostR', this.boxMesh, this.woodBeamMat, [0.92, 1.3, 0], [0.18, 2.62, 0.26]);
            add('MidBeam', this.boxMesh, this.woodBeamMat, [0, 1.32, 0], [1.96, 0.14, 0.25]);
            add('TopBeam', this.boxMesh, this.woodBeamMat, [0, 2.52, 0], [2.04, 0.16, 0.28]);
            if (!hasFoundation) {
                add('FootingL', this.boxMesh, this.woodBeamMat, [-0.85, -0.175, 0], [0.24, 0.35, 0.32]);
                add('FootingR', this.boxMesh, this.woodBeamMat, [0.85, -0.175, 0], [0.24, 0.35, 0.32]);
            }
            return;
        }

        if (recipeId === 'wood_door') {
            add('LeftWall', this.boxMesh, this.woodPlankMat, [-0.71, 1.3, 0], [0.58, 2.6, 0.22]);
            add('RightWall', this.boxMesh, this.woodPlankMat, [0.71, 1.3, 0], [0.58, 2.6, 0.22]);
            add('Lintel', this.boxMesh, this.woodBeamMat, [0, 2.34, 0], [2.0, 0.52, 0.26]);
            add('DoorLeaf', this.boxMesh, this.woodBeamMat, [-0.36, 1.04, 0.12], [0.76, 2.02, 0.08], [0, 18, 0]);
            add('DoorKnob', this.sphereMesh, this.bronzeAccentMat, [-0.05, 1.04, 0.24], [0.09, 0.09, 0.09]);
            if (!hasFoundation) {
                add('FootingL', this.boxMesh, this.woodBeamMat, [-0.75, -0.175, 0], [0.3, 0.35, 0.3]);
                add('FootingR', this.boxMesh, this.woodBeamMat, [0.75, -0.175, 0], [0.3, 0.35, 0.3]);
            }
            return;
        }

        if (recipeId === 'wood_roof') {
            add('RoofSlab', this.boxMesh, this.woodRoofMat, [0, 0.1, 0], [2.16, 0.2, 2.16]);
            add('RidgeBeam', this.boxMesh, this.woodBeamMat, [0, 0.23, 0], [2.2, 0.12, 0.26]);
            add('RafterL', this.boxMesh, this.woodBeamMat, [-0.88, -0.02, 0], [0.16, 0.12, 2.16]);
            add('RafterR', this.boxMesh, this.woodBeamMat, [0.88, -0.02, 0], [0.16, 0.12, 2.16]);
            return;
        }

        // Station ghost proxies (actual placed stations also use GLB bundles)
        if (recipeId === 'workbench') {
            add('BenchTop', this.boxMesh, this.woodPlankMat, [0, 0.85, 0], [1.58, 0.14, 0.98]);
            add('BenchLegs', this.boxMesh, this.woodBeamMat, [0, 0.42, 0], [1.4, 0.78, 0.82]);
            return;
        }

        if (recipeId === 'storage_chest') {
            add('ChestBody', this.boxMesh, this.woodPlankMat, [0, 0.42, 0], [1.1, 0.82, 0.76]);
            add('ChestTrim', this.boxMesh, this.bronzeAccentMat, [0, 0.56, 0.39], [0.2, 0.18, 0.06]);
            return;
        }

        // straw_bed
        add('BedFrame', this.boxMesh, this.woodBeamMat, [0, 0.26, 0], [1.2, 0.52, 2.08]);
        add('Pillow', this.boxMesh, this.woodPlankMat, [0, 0.58, -0.74], [0.88, 0.16, 0.42]);
    }

    private initGhostPreviews(): void {
        const recipeIds = Object.keys(MODULAR_STRUCTURE_RECIPES) as ModularStructureRecipeId[];
        for (const recipeId of recipeIds) {
            const container = new pc.Entity(`Ghost_${recipeId}`);
            const mis: pc.MeshInstance[] = [];
            this.buildProceduralStructureParts(
                container,
                recipeId,
                true,
                this.ghostValidMat,
                mis
            );
            container.enabled = recipeId === this.selectedBuildRecipe;
            this.ghostRoot.addChild(container);
            this.ghostPartsByRecipe.set(recipeId, container);
            this.ghostMeshInstances.set(recipeId, mis);
        }
    }

    private createStructureActor(
        state: PlacedStructureSyncState,
        allStructures: PlacedStructureSyncState[]
    ): StructureActor {
        const recipeId: ModularStructureRecipeId = getStructureRecipe(state.recipeId)
            ? (state.recipeId as ModularStructureRecipeId)
            : 'wood_foundation';
        const recipe = MODULAR_STRUCTURE_RECIPES[recipeId];
        const hasFoundation =
            state.layer > 0 &&
            allStructures.some(
                (other) =>
                    other.gridX === state.gridX &&
                    other.gridZ === state.gridZ &&
                    other.layer === 0
            );

        const entity = new pc.Entity(`Structure_${state.id}`);
        const groundY = this.collisionWorld.getTerrainHeight(state.x, state.z);
        const isStation =
            recipeId === 'workbench' ||
            recipeId === 'storage_chest' ||
            recipeId === 'straw_bed';
        const visualY = isStation && !hasFoundation ? groundY : state.y;

        entity.setPosition(state.x, visualY, state.z);
        entity.setLocalEulerAngles(0, state.rotationYawDeg, 0);
        this.structuresRoot.addChild(entity);

        if (isStation) {
            const bundleKey: ModelAssetKey =
                recipeId === 'workbench'
                    ? 'build_workbench'
                    : recipeId === 'storage_chest'
                      ? 'build_chest'
                      : 'build_bed';
            const bundle = this.safeGetBundle(bundleKey);
            if (bundle) {
                const inst = bundle.instantiate(`struct_${state.id}`);
                entity.addChild(inst);
            } else {
                this.buildProceduralStructureParts(entity, recipeId, hasFoundation, null);
            }
        } else {
            this.buildProceduralStructureParts(entity, recipeId, hasFoundation, null);
        }

        let colliderId: string | null = null;
        if (recipe.blocksMovement) {
            colliderId = `struct_${state.id}`;
            const quarterTurns = Math.round(((state.rotationYawDeg % 180) + 180) % 180 / 90);
            const swapXZ = quarterTurns === 1;
            let rawHalfX = 1.0;
            let rawHalfZ = 0.16;
            let height = 2.6;
            if (recipeId === 'workbench') {
                rawHalfX = 0.82;
                rawHalfZ = 0.52;
                height = 1.05;
            } else if (recipeId === 'storage_chest') {
                rawHalfX = 0.56;
                rawHalfZ = 0.4;
                height = 0.88;
            } else if (recipeId === 'straw_bed') {
                rawHalfX = 0.62;
                rawHalfZ = 1.06;
                height = 0.72;
            }
            const halfX = swapXZ ? rawHalfZ : rawHalfX;
            const halfZ = swapXZ ? rawHalfX : rawHalfZ;

            this.collisionWorld.registerCollider({
                id: colliderId,
                type: 'box',
                tag: 'structure',
                position: new pc.Vec3(state.x, visualY + height * 0.5, state.z),
                radius: Math.max(halfX, halfZ),
                halfExtents: new pc.Vec3(halfX, height * 0.5, halfZ),
                blocksCamera: recipe.blocksCamera,
            });
        }

        return {
            id: state.id,
            recipeId,
            entity,
            colliderId,
            state: { ...state },
            hasFoundation,
        };
    }

    private destroyStructureActor(actor: StructureActor): void {
        if (actor.colliderId) {
            this.collisionWorld.removeCollider(actor.colliderId);
            actor.colliderId = null;
        }
        actor.entity.destroy();
    }

    private syncStructureActors(desiredList: PlacedStructureSyncState[]): void {
        const desiredIds = new Set(desiredList.map((s) => s.id));
        for (const [id, actor] of this.structureActors.entries()) {
            const next = desiredList.find((s) => s.id === id);
            const nextHasFoundation =
                !!next &&
                next.layer > 0 &&
                desiredList.some(
                    (o) => o.gridX === next.gridX && o.gridZ === next.gridZ && o.layer === 0
                );
            if (!desiredIds.has(id) || (next && nextHasFoundation !== actor.hasFoundation)) {
                this.destroyStructureActor(actor);
                this.structureActors.delete(id);
            }
        }

        for (const s of desiredList) {
            if (!this.structureActors.has(s.id)) {
                const actor = this.createStructureActor(s, desiredList);
                this.structureActors.set(s.id, actor);
            }
        }
    }

    private rebuildSoloStructureActors(): void {
        this.syncStructureActors(this.soloStructures);
    }

    private safeGetBundle(key: ModelAssetKey): LoadedModelBundle | null {
        try {
            return this.assetLoader.getBundle(key);
        } catch {
            return null;
        }
    }

    // -------------------------------------------------------------------------
    // Base Worker Visuals
    // -------------------------------------------------------------------------

    private createWorkerVisualActor(state: BaseWorkerSyncState): WorkerVisualActor {
        const entity = new pc.Entity(`BaseWorker_${state.uid}`);
        const groundY = this.collisionWorld.getTerrainHeight(state.x, state.z);
        entity.setPosition(state.x, groundY, state.z);
        this.workersRoot.addChild(entity);

        this.attachMeshPart(
            entity,
            'Shadow',
            this.discMesh,
            this.shadowMat,
            [0, 0.03, 0],
            [0.95, 1, 0.95],
            [0, 0, 0],
            false,
            false
        );

        const modelPivot = new pc.Entity('WorkerModelPivot');
        entity.addChild(modelPivot);
        const bundleKey = `monster_${state.species}` as ModelAssetKey;
        const bundle = this.safeGetBundle(bundleKey);
        if (bundle) {
            const inst = bundle.instantiate(`worker_${state.uid}`);
            modelPivot.addChild(inst);
        } else {
            this.attachMeshPart(
                modelPivot,
                'ProxyBody',
                this.sphereMesh,
                this.carryMaterials.aether_shard,
                [0, 0.55, 0],
                [0.7, 0.7, 0.7]
            );
        }

        const { entity: carryOrb, mi: carryOrbMi } = this.attachMeshPart(
            entity,
            'CarryOrb',
            this.sphereMesh,
            this.carryMaterials.wood,
            [0, 1.35, 0],
            [0.34, 0.34, 0.34],
            [0, 0, 0],
            false,
            false
        );
        carryOrb.enabled = false;

        const facing = typeof state.yaw === 'number' ? state.yaw : 0;

        return {
            uid: state.uid,
            species: state.species,
            entity,
            modelPivot,
            carryOrb,
            carryOrbMi,
            x: state.x,
            y: groundY,
            z: state.z,
            yawDeg: facing,
            phase: Math.random() * Math.PI * 2,
        };
    }

    private syncAndAnimateWorkerActors(workers: BaseWorkerSyncState[], dt: number): void {
        const activeIds = new Set(workers.map((w) => w.uid));
        for (const [uid, actor] of this.workerActors.entries()) {
            if (!activeIds.has(uid)) {
                actor.entity.destroy();
                this.workerActors.delete(uid);
            }
        }

        const online = this.isOnlineMode();
        const followT = online ? clamp(dt * 10, 0.05, 0.65) : 1;

        for (const w of workers) {
            let actor = this.workerActors.get(w.uid);
            if (!actor) {
                actor = this.createWorkerVisualActor(w);
                this.workerActors.set(w.uid, actor);
            }

            const prevX = actor.x;
            const prevZ = actor.z;
            actor.x = lerp(actor.x, w.x, followT);
            actor.z = lerp(actor.z, w.z, followT);
            actor.y = this.collisionWorld.getTerrainHeight(actor.x, actor.z);

            const moveDx = actor.x - prevX;
            const moveDz = actor.z - prevZ;
            const targetYaw =
                typeof w.yaw === 'number'
                    ? w.yaw
                    : Math.hypot(moveDx, moveDz) > 0.002
                      ? Math.atan2(-moveDx, -moveDz) * pc.math.RAD_TO_DEG
                      : actor.yawDeg;
            actor.yawDeg = lerpAngleDeg(actor.yawDeg, targetYaw, followT);

            const moving =
                w.aiState === 'work_gather' ||
                w.aiState === 'work_craft' ||
                w.aiState === 'transport' ||
                w.aiState === 'return';
            actor.phase += dt * (moving ? 9.5 : 3.2);

            let bobY = 0;
            let squashX = 1;
            let squashY = 1;
            if (w.aiState === 'work_gather' || w.aiState === 'work_craft') {
                const pulse = Math.abs(Math.sin(actor.phase));
                bobY = pulse * 0.12;
                squashY = 1 - pulse * 0.07;
                squashX = 1 + pulse * 0.05;
            } else if (w.aiState === 'rest') {
                bobY = -0.05;
                squashY = 0.88;
                squashX = 1.08;
            } else if (moving) {
                bobY = Math.abs(Math.sin(actor.phase)) * 0.1;
            } else {
                bobY = Math.sin(actor.phase) * 0.03;
            }

            actor.entity.setPosition(actor.x, actor.y, actor.z);
            actor.modelPivot.setLocalPosition(0, bobY, 0);
            actor.modelPivot.setLocalEulerAngles(0, actor.yawDeg, 0);
            actor.modelPivot.setLocalScale(squashX, squashY, squashX);

            if (w.aiState === 'transport' && w.carryingKind) {
                actor.carryOrb.enabled = true;
                if (actor.carryOrbMi) {
                    actor.carryOrbMi.material = this.carryMaterials[w.carryingKind];
                }
                const orbBob = 1.38 + Math.sin(actor.phase * 0.8) * 0.08;
                actor.carryOrb.setLocalPosition(0, orbBob, 0);
                actor.carryOrb.rotate(0, 90 * dt, 0);
            } else {
                actor.carryOrb.enabled = false;
            }
        }
    }

    // -------------------------------------------------------------------------
    // Main Frame Update (Dual Mode: Online Co-op & Offline Solo)
    // -------------------------------------------------------------------------

    public update(dt: number, input: InputState, forwardXZ: pc.Vec3): void {
        const clampedDt = clamp(dt, 0, 0.1);
        this.gatherCooldownTimer = Math.max(0, this.gatherCooldownTimer - clampedDt);

        const online = this.isOnlineMode();
        if (online !== this.wasOnline) {
            this.handleModeTransition(online);
        }

        if (online) {
            this.updateOnlineSync(clampedDt);
        } else {
            this.updateSoloSimulation(clampedDt);
        }

        this.handlePlayerSurvivalInputs(input);
        this.updateBuildPreview(forwardXZ);
        this.updateNodeAnimations(clampedDt);
        this.updateSparks(clampedDt);
        this.syncPlayerTelemetry();
    }

    private isOnlineMode(): boolean {
        if (!this.multiplayerClient) return false;
        const st = this.multiplayerClient.getStatus();
        return st.state === 'connected' && Boolean(st.roomCode);
    }

    private handleModeTransition(online: boolean): void {
        this.wasOnline = online;
        this.lastSyncedTool = null;
        if (online) {
            this.flushSoloPersistenceNow();
        } else {
            // Restore Solo world visuals cleanly when disconnecting
            for (const actor of this.nodeActors.values()) {
                const solo = this.soloNodes.get(actor.id);
                if (!solo) continue;
                actor.state = {
                    id: solo.id,
                    kind: solo.kind,
                    name: solo.label,
                    x: solo.x,
                    y: solo.y,
                    z: solo.z,
                    hp: solo.hp,
                    maxHp: solo.maxHp,
                    depleted: solo.depleted,
                    respawnRemainingMs: solo.depleted
                        ? Math.max(0, solo.respawnAtMs - Date.now())
                        : 0,
                };
                this.syncNodeActorColliderAndVisibility(actor, solo.depleted);
            }
            this.rebuildSoloStructureActors();
            this.syncSoloCombatIntegration();
        }
    }

    private syncPlayerTelemetry(): void {
        if (this.isOnlineMode() && this.multiplayerClient) {
            const lp = this.getLocalCoopPlayerState();
            const hunger = lp?.hunger ?? PLAYER_MAX_HUNGER;
            const maxHunger = lp?.maxHunger ?? PLAYER_MAX_HUNGER;
            const tool = (lp?.equippedTool ?? 'hands') as ToolId;
            this.playerController.setHungerTelemetry(hunger, maxHunger, tool);
            return;
        }
        this.playerController.setHungerTelemetry(
            Math.round(this.soloHunger),
            PLAYER_MAX_HUNGER,
            this.soloEquippedTool
        );
    }

    private getLocalCoopPlayerState() {
        if (!this.multiplayerClient) return null;
        const st = this.multiplayerClient.getStatus();
        return st.players.find((p) => p.playerId === st.localPlayerId) ?? null;
    }

    private updateOnlineSync(dt: number): void {
        if (!this.multiplayerClient) return;

        // Sync resource nodes from authoritative snapshot
        const nodes = this.multiplayerClient.getResourceNodes();
        for (const nodeState of nodes) {
            const actor = this.nodeActors.get(nodeState.id);
            if (!actor) continue;
            if (nodeState.hp < actor.state.hp && !nodeState.depleted) {
                actor.hitShakeTimer = 0.24;
            }
            if (actor.wasDepleted && !nodeState.depleted) {
                actor.respawnScale = 0.05;
            }
            actor.wasDepleted = nodeState.depleted;
            actor.state = { ...nodeState };
            this.syncNodeActorColliderAndVisibility(actor, nodeState.depleted);
        }

        // Sync placed structures
        this.syncStructureActors(this.multiplayerClient.getPlacedStructures());

        // Sync base workers & notify MonsterCombatManager of assigned worker UIDs
        const workers = this.multiplayerClient.getBaseWorkers();
        this.syncAndAnimateWorkerActors(workers, dt);
        this.monsterCombatManager.setWorkerAssignedUids(
            new Set(workers.map((w) => w.uid))
        );

        const lp = this.getLocalCoopPlayerState();
        if (lp?.equippedTool && lp.equippedTool !== this.lastSyncedTool) {
            this.lastSyncedTool = lp.equippedTool;
        }
    }

    private updateSoloSimulation(dt: number): void {
        const nowMs = Date.now();

        // 1. Resource node respawn & actor sync
        for (const solo of this.soloNodes.values()) {
            if (solo.depleted && solo.respawnAtMs > 0 && nowMs >= solo.respawnAtMs) {
                solo.depleted = false;
                solo.hp = solo.maxHp;
                solo.respawnAtMs = 0;
                this.markSoloDirty();
            }
            const actor = this.nodeActors.get(solo.id);
            if (!actor) continue;
            if (actor.wasDepleted && !solo.depleted) {
                actor.respawnScale = 0.05;
            }
            actor.wasDepleted = solo.depleted;
            actor.state = {
                id: solo.id,
                kind: solo.kind,
                name: solo.label,
                x: solo.x,
                y: solo.y,
                z: solo.z,
                hp: solo.hp,
                maxHp: solo.maxHp,
                depleted: solo.depleted,
                respawnRemainingMs: solo.depleted
                    ? Math.max(0, solo.respawnAtMs - nowMs)
                    : 0,
            };
            this.syncNodeActorColliderAndVisibility(actor, solo.depleted);
        }

        // 2. Hunger decay & starvation floor (5 HP)
        const prevRounded = Math.round(this.soloHunger);
        this.soloHunger = Math.max(0, this.soloHunger - HUNGER_DECAY_PER_SEC * dt);
        if (Math.round(this.soloHunger) !== prevRounded && Math.round(this.soloHunger) % 5 === 0) {
            this.markSoloDirty();
        }
        if (this.soloHunger <= 0) {
            this.starvationTimer += dt;
            if (this.starvationTimer >= STARVATION_TICK_SEC) {
                this.starvationTimer -= STARVATION_TICK_SEC;
                if (this.playerController.getHp() > 5) {
                    const drain = Math.min(
                        STARVATION_HP_STEP,
                        this.playerController.getHp() - 5
                    );
                    if (drain > 0) {
                        this.playerController.applyExternalHpDelta(-drain);
                    }
                }
            }
        } else {
            this.starvationTimer = 0;
        }

        // 3. Base worker AI simulation & visual actors
        this.updateSoloWorkers(dt);
        this.syncAndAnimateWorkerActors(this.getSoloWorkerSnapshots(), dt);

        if (this.soloDirty && this.saveDebounceHandle === null) {
            this.scheduleSoloSave();
        }
    }

    private updateNodeAnimations(dt: number): void {
        for (const actor of this.nodeActors.values()) {
            if (actor.state.depleted) continue;
            if (actor.respawnScale < 1) {
                actor.respawnScale = Math.min(1, actor.respawnScale + dt * 2.4);
            }
            let tiltX = 0;
            let tiltZ = 0;
            let pulse = 1;
            if (actor.hitShakeTimer > 0) {
                actor.hitShakeTimer = Math.max(0, actor.hitShakeTimer - dt);
                const t = actor.hitShakeTimer / 0.26;
                const wobble = Math.sin(t * Math.PI * 4) * t;
                tiltX = wobble * (actor.kind === 'wood' ? 5.5 : 3.2);
                tiltZ = wobble * 4.2;
                pulse = 1 + t * 0.06;
            }
            const s = actor.respawnScale * pulse;
            const numSeed = Number(actor.id.replace(/\D/g, '')) || 1;
            const baseYaw = (numSeed * 53) % 360;
            actor.visualPivot.setLocalScale(s, s, s);
            actor.visualPivot.setLocalEulerAngles(tiltX, baseYaw, tiltZ);
        }
    }

    // -------------------------------------------------------------------------
    // Player Input Handling: Gather, Eat, Build Mode
    // -------------------------------------------------------------------------

    private handlePlayerSurvivalInputs(input: InputState): void {
        if (input.eatPressed) {
            this.eatFood();
        }

        if (input.buildModePressed) {
            this.setBuildMode(!this.buildMode);
        }

        if (this.buildMode) {
            if (input.buildRotatePressed) {
                this.rotateBuildPreview();
            }
            if (input.buildPlacePressed) {
                this.confirmBuildPlace();
            }
            if (input.buildDemolishPressed) {
                this.demolishNearestOrTargetedStructure();
            }
        } else if (input.buildDemolishPressed) {
            this.demolishNearestOrTargetedStructure();
        }

        // Harvesting via Interact or Melee
        const pPos = this.playerController.getPosition();
        if (input.interactPressed && this.gatherCooldownTimer <= 0) {
            const nearestNode = this.findNearestActiveNode(pPos, INTERACT_HARVEST_RANGE);
            const crystalDist = this.getNearestUncollectedCrystalDist(pPos);

            if (nearestNode && !(crystalDist < CRYSTAL_PRIORITY_RANGE && crystalDist <= nearestNode.dist)) {
                this.executeHarvestOnNode(nearestNode.actor, true);
                return;
            }

            if (!nearestNode && crystalDist >= CRYSTAL_PRIORITY_RANGE) {
                // Convenient interact fallback: rest at nearby bed if standing beside one
                const bed = this.findNearestStructureByRecipe(pPos, 'straw_bed', BED_REST_RANGE);
                if (bed) {
                    this.restAtNearestBed();
                }
            }
            return;
        }

        if (input.meleePressed && this.gatherCooldownTimer <= 0) {
            const nearestNode = this.findNearestActiveNode(pPos, MELEE_HARVEST_RANGE);
            if (nearestNode) {
                const monsterDist = this.monsterCombatManager.getNearestWildMonsterDistance();
                if (monsterDist > MELEE_HARVEST_RANGE || nearestNode.dist < monsterDist) {
                    this.executeHarvestOnNode(nearestNode.actor, false);
                }
            }
        }
    }

    private getNearestUncollectedCrystalDist(pos: pc.Vec3): number {
        const crystal = this.collisionWorld.findNearestInteractable(pos, CRYSTAL_PRIORITY_RANGE);
        if (!crystal) return Infinity;
        return Math.hypot(crystal.position.x - pos.x, crystal.position.z - pos.z);
    }

    private findNearestActiveNode(
        pos: pc.Vec3,
        maxDist: number
    ): { actor: ResourceNodeActor; dist: number } | null {
        let bestActor: ResourceNodeActor | null = null;
        let bestDist = Infinity;
        for (const actor of this.nodeActors.values()) {
            if (actor.state.depleted) continue;
            const d = Math.hypot(actor.x - pos.x, actor.z - pos.z);
            if (d <= maxDist && d < bestDist) {
                bestDist = d;
                bestActor = actor;
            }
        }
        return bestActor ? { actor: bestActor, dist: bestDist } : null;
    }

    private executeHarvestOnNode(actor: ResourceNodeActor, playGatherAnim: boolean): void {
        this.gatherCooldownTimer = 0.28;
        const pPos = this.playerController.getPosition();
        const dx = actor.x - pPos.x;
        const dz = actor.z - pPos.z;
        const aimYaw = Math.atan2(-dx, -dz) * pc.math.RAD_TO_DEG;

        if (playGatherAnim) {
            this.playerController.triggerGatherSwing(0.34, aimYaw);
        }

        if (this.isOnlineMode() && this.multiplayerClient) {
            this.soundManager.playGatherHit(actor.kind);
            this.spawnSparkBurst(actor.x, actor.y + 0.9, actor.z, actor.kind, 6);
            actor.hitShakeTimer = 0.26;
            this.multiplayerClient.sendSurvivalAction({
                action: 'harvest_node',
                nodeId: actor.id,
            });
            return;
        }

        const solo = this.soloNodes.get(actor.id);
        if (!solo || solo.depleted) return;

        const dmg = this.computeSoloHarvestDamage(solo.kind);
        solo.hp = Math.max(0, solo.hp - dmg);
        actor.hitShakeTimer = 0.26;

        this.soundManager.playGatherHit(solo.kind);
        this.spawnSparkBurst(actor.x, actor.y + 0.95, actor.z, solo.kind, 6);

        const depletedNow = solo.hp <= 0;
        const gained = this.grantSoloHarvestYield(solo.kind, depletedNow);

        if (depletedNow) {
            solo.depleted = true;
            solo.respawnAtMs = Date.now() + RESOURCE_RESPAWN_MS;
            this.soundManager.playGatherComplete();
            this.spawnSparkBurst(actor.x, actor.y + 1.15, actor.z, solo.kind, 10);
            this.notify(`${solo.label} 채집 완료 (${gained})`, 'success');
        }

        this.markSoloDirty();
    }

    private computeSoloHarvestDamage(kind: ResourceNodeKind): number {
        switch (this.soloEquippedTool) {
            case 'wood_axe':
                return kind === 'wood' ? 50 : 35;
            case 'stone_pickaxe':
                return kind === 'stone' || kind === 'ore' ? 50 : 35;
            case 'aether_blade':
                return 50;
            default:
                return 25;
        }
    }

    private grantSoloHarvestYield(kind: ResourceNodeKind, depletedNow: boolean): string {
        const bonusDeplete = depletedNow ? 2 : 0;
        const tool = this.soloEquippedTool;

        if (kind === 'wood') {
            const matched = tool === 'wood_axe' || tool === 'aether_blade' ? 2 : 1;
            const amt = matched + bonusDeplete;
            this.soloSharedResources.wood += amt;
            return `목재 +${amt}`;
        }
        if (kind === 'stone') {
            const matched = tool === 'stone_pickaxe' || tool === 'aether_blade' ? 2 : 1;
            const amt = matched + bonusDeplete;
            this.soloSharedResources.stone += amt;
            return `석재 +${amt}`;
        }
        if (kind === 'ore') {
            const matched = tool === 'stone_pickaxe' || tool === 'aether_blade';
            const oreAmt = (matched ? 2 : 1) + (depletedNow ? 1 : 0);
            const stoneAmt = 1;
            const shardAmt = depletedNow || matched ? 1 : 0;
            this.soloSharedResources.ore += oreAmt;
            this.soloSharedResources.stone += stoneAmt;
            if (shardAmt > 0) {
                this.soloSharedResources.aether_shard += shardAmt;
            }
            return shardAmt > 0 ? `광석 +${oreAmt}, 에테르 +${shardAmt}` : `광석 +${oreAmt}`;
        }
        const berryAmt = 1 + (depletedNow ? 2 : 0);
        this.soloSharedResources.berry += berryAmt;
        return `베리 +${berryAmt}`;
    }

    // -------------------------------------------------------------------------
    // Build Mode & Ghost Preview
    // -------------------------------------------------------------------------

    private updateBuildPreview(forwardXZ: pc.Vec3): void {
        if (!this.buildMode) {
            this.ghostRoot.enabled = false;
            return;
        }

        const pPos = this.playerController.getPosition();
        const fx = Number.isFinite(forwardXZ.x) ? forwardXZ.x : 0;
        const fz = Number.isFinite(forwardXZ.z) ? forwardXZ.z : -1;
        const fLen = Math.hypot(fx, fz);
        const dirX = fLen > 1e-4 ? fx / fLen : 0;
        const dirZ = fLen > 1e-4 ? fz / fLen : -1;

        const targetX = pPos.x + dirX * BUILD_PREVIEW_DISTANCE;
        const targetZ = pPos.z + dirZ * BUILD_PREVIEW_DISTANCE;

        const gridX = Math.round(targetX / BUILD_GRID_SIZE_METERS);
        const gridZ = Math.round(targetZ / BUILD_GRID_SIZE_METERS);
        const sx = gridX * BUILD_GRID_SIZE_METERS;
        const sz = gridZ * BUILD_GRID_SIZE_METERS;

        this.previewGridX = gridX;
        this.previewGridZ = gridZ;

        const recipe = MODULAR_STRUCTURE_RECIPES[this.selectedBuildRecipe];
        const structures = this.getActiveStructures();
        const foundation = structures.find(
            (s) => s.gridX === gridX && s.gridZ === gridZ && s.layer === 0
        );
        const occupied = structures.some(
            (s) => s.gridX === gridX && s.gridZ === gridZ && s.layer === recipe.layer
        );
        const groundY = this.collisionWorld.getTerrainHeight(sx, sz);
        this.collisionWorld.getTerrainNormal(sx, sz, this.tmpNormal);
        const slopeDeg = Math.acos(clamp(this.tmpNormal.y, -1, 1)) * pc.math.RAD_TO_DEG;

        const baseSurfaceY = foundation ? foundation.y : groundY;
        const placeY = Number((baseSurfaceY + recipe.elevationOffsetY).toFixed(3));
        this.previewPlaceY = placeY;

        const isStation =
            this.selectedBuildRecipe === 'workbench' ||
            this.selectedBuildRecipe === 'storage_chest' ||
            this.selectedBuildRecipe === 'straw_bed';
        const displayY = isStation && !foundation ? groundY : placeY;

        let valid = true;
        let reason: string | null = null;
        if (Math.hypot(sx, sz) > ISLAND_MAX_RADIUS - 2) {
            valid = false;
            reason = '섬 외곽 경계 밖입니다';
        } else if (groundY < -0.15) {
            valid = false;
            reason = '물 위에는 설치할 수 없습니다';
        } else if (occupied) {
            valid = false;
            reason = '이미 구조물이 설치되어 있습니다';
        } else if (!foundation && slopeDeg > recipe.maxSlopeDeg) {
            valid = false;
            reason = '경사가 너무 급합니다';
        } else if (!this.hasEnoughResources(this.getActiveSharedResources(), recipe.cost)) {
            valid = false;
            reason = '재료가 부족합니다';
        }

        this.buildPreviewValid = valid;
        this.buildPreviewReason = reason;

        this.ghostRoot.enabled = true;
        this.ghostRoot.setPosition(sx, displayY, sz);
        this.ghostRoot.setLocalEulerAngles(0, this.buildRotationDeg, 0);

        for (const [id, ent] of this.ghostPartsByRecipe.entries()) {
            ent.enabled = id === this.selectedBuildRecipe;
        }
        const mis = this.ghostMeshInstances.get(this.selectedBuildRecipe);
        if (mis) {
            const mat = valid ? this.ghostValidMat : this.ghostInvalidMat;
            for (const mi of mis) {
                mi.material = mat;
            }
        }
    }

    public setBuildMode(enabled: boolean, recipeId?: ModularStructureRecipeId): void {
        this.buildMode = enabled;
        if (recipeId && recipeId in MODULAR_STRUCTURE_RECIPES) {
            this.selectedBuildRecipe = recipeId;
        }
        this.ghostRoot.enabled = enabled;
        if (enabled) {
            this.notify(
                `건축 모드 ON (${MODULAR_STRUCTURE_RECIPES[this.selectedBuildRecipe].nameKo})`,
                'info'
            );
        } else {
            this.notify('건축 모드 OFF', 'info');
        }
    }

    public selectBuildRecipe(recipeId: ModularStructureRecipeId): void {
        if (!(recipeId in MODULAR_STRUCTURE_RECIPES)) return;
        this.selectedBuildRecipe = recipeId;
        if (!this.buildMode) {
            this.setBuildMode(true, recipeId);
        }
    }

    public rotateBuildPreview(): number {
        this.buildRotationDeg = (this.buildRotationDeg + 90) % 360;
        return this.buildRotationDeg;
    }

    public confirmBuildPlace(): boolean {
        if (!this.buildMode) {
            this.setBuildMode(true);
        }
        this.updateBuildPreview(this.playerController.getAimDirectionXZ(this.tmpForward));

        if (!this.buildPreviewValid) {
            this.notify(this.buildPreviewReason || '여기에 설치할 수 없습니다', 'warning');
            return false;
        }

        const recipe = MODULAR_STRUCTURE_RECIPES[this.selectedBuildRecipe];
        const sx = Number((this.previewGridX * BUILD_GRID_SIZE_METERS).toFixed(3));
        const sz = Number((this.previewGridZ * BUILD_GRID_SIZE_METERS).toFixed(3));

        this.playerController.triggerBuildPose(0.32);

        if (this.isOnlineMode() && this.multiplayerClient) {
            const sent = this.multiplayerClient.sendSurvivalAction({
                action: 'place_structure',
                structureRecipeId: this.selectedBuildRecipe,
                gridX: this.previewGridX,
                gridZ: this.previewGridZ,
                x: sx,
                y: this.previewPlaceY,
                z: sz,
                rotationYawDeg: this.buildRotationDeg,
            });
            if (sent) {
                this.soundManager.playBuildPlace();
                this.spawnSparkBurst(sx, this.previewPlaceY + 0.5, sz, 'build', 7);
            }
            return sent;
        }

        if (!this.hasEnoughResources(this.soloSharedResources, recipe.cost)) {
            this.notify('건축에 필요한 자원이 부족합니다', 'warning');
            return false;
        }
        this.deductResources(this.soloSharedResources, recipe.cost);

        const id = `solo_struct_${this.previewGridX}_${this.previewGridZ}_${recipe.layer}_${Math.random()
            .toString(36)
            .slice(2, 7)}`;
        const placed: PlacedStructureSyncState = {
            id,
            recipeId: this.selectedBuildRecipe,
            gridX: this.previewGridX,
            gridZ: this.previewGridZ,
            layer: recipe.layer,
            x: sx,
            y: this.previewPlaceY,
            z: sz,
            rotationYawDeg: this.buildRotationDeg,
            ownerPlayerId: 'local',
            ownerName: '모험가',
            createdAtMs: Date.now(),
        };
        this.soloStructures.push(placed);
        this.rebuildSoloStructureActors();
        this.soundManager.playBuildPlace();
        this.spawnSparkBurst(sx, this.previewPlaceY + 0.5, sz, 'build', 8);
        this.notify(`${recipe.nameKo} 설치 완료!`, 'success');
        this.markSoloDirty();
        return true;
    }

    public demolishNearestOrTargetedStructure(): boolean {
        const pPos = this.playerController.getPosition();
        const target = this.findNearestStructure(pPos, DEMOLISH_RANGE);
        if (!target) {
            this.notify('철거할 구조물이 근처(6m 이내)에 없습니다', 'info');
            return false;
        }

        this.playerController.triggerBuildPose(0.28);

        if (this.isOnlineMode() && this.multiplayerClient) {
            const sent = this.multiplayerClient.sendSurvivalAction({
                action: 'demolish_structure',
                structureId: target.id,
            });
            if (sent) {
                this.soundManager.playBuildDemolish();
                this.spawnSparkBurst(target.x, target.y + 0.5, target.z, 'wood', 8);
            }
            return sent;
        }

        const idx = this.soloStructures.findIndex((s) => s.id === target.id);
        if (idx < 0) return false;
        const [removed] = this.soloStructures.splice(idx, 1);
        const recipe = getStructureRecipe(removed.recipeId);
        if (recipe) {
            for (const [k, v] of Object.entries(recipe.cost)) {
                if (typeof v === 'number' && v > 0) {
                    const refund = Math.max(1, Math.floor(v * 0.5));
                    this.soloSharedResources[k as ResourceKind] += refund;
                }
            }
        }
        this.rebuildSoloStructureActors();
        this.soundManager.playBuildDemolish();
        this.spawnSparkBurst(removed.x, removed.y + 0.5, removed.z, 'wood', 8);
        this.notify(`${recipe?.nameKo ?? '구조물'} 철거 (자원 일부 회수)`, 'info');
        this.markSoloDirty();
        return true;
    }

    // -------------------------------------------------------------------------
    // Crafting, Tool Equip, Food & Bed Rest
    // -------------------------------------------------------------------------

    public craftItem(recipeId: CraftRecipeId): boolean {
        const recipe = CRAFT_RECIPES[recipeId];
        if (!recipe) {
            this.notify('알 수 없는 제작 레시피입니다', 'error');
            return false;
        }

        if (this.isOnlineMode() && this.multiplayerClient) {
            if (recipe.requiresWorkbench && !this.hasWorkbenchNearOrInBase()) {
                this.notify('작업대 근처(또는 거점)에서 제작할 수 있습니다', 'warning');
                return false;
            }
            const sent = this.multiplayerClient.sendSurvivalAction({
                action: 'craft_item',
                craftRecipeId: recipeId,
            });
            return sent;
        }

        if (recipe.requiresWorkbench && !this.hasWorkbenchNearOrInBase()) {
            this.notify('작업대가 필요합니다 (먼저 작업대를 설치하세요)', 'warning');
            return false;
        }

        if (recipe.unlocksTool && this.soloUnlockedTools.includes(recipe.unlocksTool)) {
            this.equipTool(recipe.unlocksTool);
            this.notify(`${recipe.nameKo}은(는) 이미 보유 중이라 장착했습니다`, 'info');
            return true;
        }

        if (!this.hasEnoughResources(this.soloSharedResources, recipe.cost)) {
            this.notify('제작 재료가 부족합니다', 'warning');
            return false;
        }

        this.deductResources(this.soloSharedResources, recipe.cost);

        if (recipe.unlocksTool) {
            this.soloUnlockedTools.push(recipe.unlocksTool);
            this.soloEquippedTool = recipe.unlocksTool;
            this.syncSoloCombatIntegration();
        } else {
            switch (recipeId) {
                case 'wood_axe':
                case 'stone_pickaxe':
                case 'aether_blade':
                    break;
                case 'capture_sphere_pack':
                    this.monsterCombatManager.addCaptureSpheres(recipe.yieldAmount);
                    break;
                case 'cooked_berry_batch':
                    this.soloSharedResources.cooked_berry += recipe.yieldAmount;
                    break;
            }
        }

        this.soundManager.playCraftSuccess();
        this.notify(`${recipe.nameKo} 제작 완료!`, 'success');
        this.markSoloDirty();
        return true;
    }

    public equipTool(toolId: ToolId): boolean {
        if (this.isOnlineMode() && this.multiplayerClient) {
            const lp = this.getLocalCoopPlayerState();
            if (lp?.unlockedTools && !lp.unlockedTools.includes(toolId)) {
                this.notify('아직 제작하지 않은 도구입니다', 'warning');
                return false;
            }
            return this.multiplayerClient.sendSurvivalAction({
                action: 'equip_tool',
                toolId,
            });
        }

        if (!this.soloUnlockedTools.includes(toolId)) {
            this.notify('아직 제작하지 않은 도구입니다', 'warning');
            return false;
        }
        this.soloEquippedTool = toolId;
        this.syncSoloCombatIntegration();
        this.soundManager.playCraftSuccess();
        this.notify(`${getToolDisplayName(toolId)} 장착`, 'info');
        this.markSoloDirty();
        return true;
    }

    public eatFood(preferredKind?: 'cooked_berry' | 'berry'): boolean {
        if (this.isOnlineMode() && this.multiplayerClient) {
            return this.multiplayerClient.sendSurvivalAction({
                action: 'eat_food',
                foodKind: preferredKind,
            });
        }

        let chosen: 'cooked_berry' | 'berry' | null = null;
        if (preferredKind && this.soloSharedResources[preferredKind] >= 1) {
            chosen = preferredKind;
        } else if (this.soloSharedResources.cooked_berry >= 1) {
            chosen = 'cooked_berry';
        } else if (this.soloSharedResources.berry >= 1) {
            chosen = 'berry';
        }

        if (!chosen) {
            this.notify('먹을 수 있는 식량이 없습니다', 'warning');
            return false;
        }

        this.soloSharedResources[chosen] -= 1;
        const hungerGain = chosen === 'cooked_berry' ? 35 : 14;
        const hpGain = chosen === 'cooked_berry' ? 20 : 6;
        this.soloHunger = clamp(this.soloHunger + hungerGain, 0, PLAYER_MAX_HUNGER);
        this.playerController.applyExternalHpDelta(hpGain);
        this.soundManager.playEatFood();
        this.notify(
            `${RESOURCE_KIND_LABELS[chosen]} 섭취 (포만감 +${hungerGain}, HP +${hpGain})`,
            'success'
        );
        this.markSoloDirty();
        return true;
    }

    public restAtNearestBed(): boolean {
        const pPos = this.playerController.getPosition();
        const bed = this.findNearestStructureByRecipe(pPos, 'straw_bed', BED_REST_RANGE);
        if (!bed) {
            this.notify('가까운 짚 침대(6.5m 이내)에서 휴식할 수 있습니다', 'warning');
            return false;
        }

        if (this.isOnlineMode() && this.multiplayerClient) {
            return this.multiplayerClient.sendSurvivalAction({
                action: 'rest_bed',
                structureId: bed.id,
            });
        }

        const healDelta = Math.max(0, this.playerController.getMaxHp() - this.playerController.getHp());
        if (healDelta > 0) {
            this.playerController.applyExternalHpDelta(healDelta);
        }
        this.soloHunger = clamp(this.soloHunger + 15, 0, PLAYER_MAX_HUNGER);
        this.soundManager.playGatherComplete();
        this.spawnSparkBurst(bed.x, bed.y + 0.7, bed.z, 'build', 8);
        this.notify('침대에서 휴식하여 체력을 회복했습니다!', 'success');
        this.markSoloDirty();
        return true;
    }

    // -------------------------------------------------------------------------
    // Base Worker Assignment & Solo AI Simulation
    // -------------------------------------------------------------------------

    public assignBaseWorker(companionUid: string): boolean {
        const roster = this.monsterCombatManager.getCapturedRoster();
        const record = roster.find((r) => r.uid === companionUid);
        if (!record) {
            this.notify('포획 명단에서 몬스터를 찾을 수 없습니다', 'warning');
            return false;
        }

        if (this.isOnlineMode() && this.multiplayerClient) {
            const existing = this.multiplayerClient.getBaseWorkers();
            if (existing.some((w) => w.uid === companionUid)) {
                this.notify(`${record.nickname}은(는) 이미 거점 작업 중입니다`, 'info');
                return false;
            }
            if (existing.length >= MAX_BASE_WORKERS) {
                this.notify(`거점 작업 몬스터는 최대 ${MAX_BASE_WORKERS}마리입니다`, 'warning');
                return false;
            }
            return this.multiplayerClient.sendSurvivalAction({
                action: 'assign_base_worker',
                companionUid,
            });
        }

        if (this.soloWorkers.some((w) => w.uid === companionUid)) {
            this.notify(`${record.nickname}은(는) 이미 거점 작업 중입니다`, 'info');
            return false;
        }
        if (this.soloWorkers.length >= MAX_BASE_WORKERS) {
            this.notify(`거점 작업 몬스터는 최대 ${MAX_BASE_WORKERS}마리입니다`, 'warning');
            return false;
        }

        this.monsterCombatManager.recallIfActive(companionUid);
        const rally = this.getSoloBaseRallyPoint();
        const angle = this.soloWorkers.length * 2.1;
        const spawnX = rally.x + Math.cos(angle) * 1.8;
        const spawnZ = rally.z + Math.sin(angle) * 1.8;
        const spawnY = this.collisionWorld.getTerrainHeight(spawnX, spawnZ);

        const suitTable = SPECIES_WORK_SUITABILITY[record.species];
        const suitabilityKeys = Object.keys(suitTable) as WorkSuitabilityKind[];
        const primarySuitability: WorkSuitabilityKind = suitabilityKeys[0] ?? 'gather';

        this.soloWorkers.push({
            uid: record.uid,
            species: record.species,
            nickname: record.nickname,
            level: record.level,
            suitability: primarySuitability,
            aiState: 'idle',
            energy: 100,
            maxEnergy: 100,
            x: spawnX,
            y: spawnY,
            z: spawnZ,
            yawDeg: 0,
            targetId: null,
            targetX: spawnX,
            targetZ: spawnZ,
            carryingKind: null,
            carryingAmount: 0,
            workTimer: 0,
            pendingAction: null,
        });

        this.syncSoloCombatIntegration();
        this.soundManager.playSummon();
        this.notify(`${record.nickname} 거점 작업 배치!`, 'success');
        this.markSoloDirty();
        return true;
    }

    public unassignBaseWorker(companionUid: string): boolean {
        if (this.isOnlineMode() && this.multiplayerClient) {
            return this.multiplayerClient.sendSurvivalAction({
                action: 'unassign_base_worker',
                companionUid,
            });
        }

        const idx = this.soloWorkers.findIndex((w) => w.uid === companionUid);
        if (idx < 0) return false;
        const [removed] = this.soloWorkers.splice(idx, 1);
        this.syncSoloCombatIntegration();
        this.soundManager.playSummon();
        this.notify(`${removed.nickname} 거점 배치 해제`, 'info');
        this.markSoloDirty();
        return true;
    }

    private getSoloBaseRallyPoint(): { x: number; z: number } {
        const workbench = this.soloStructures.find((s) => s.recipeId === 'workbench');
        if (workbench) return { x: workbench.x, z: workbench.z };
        const chest = this.soloStructures.find((s) => s.recipeId === 'storage_chest');
        if (chest) return { x: chest.x, z: chest.z };
        if (this.soloStructures.length > 0) {
            return { x: this.soloStructures[0].x, z: this.soloStructures[0].z };
        }
        return { x: 0, z: 12 };
    }

    private updateSoloWorkers(dt: number): void {
        if (this.soloWorkers.length === 0) return;
        const rally = this.getSoloBaseRallyPoint();
        const bed = this.soloStructures.find((s) => s.recipeId === 'straw_bed') ?? null;
        const workbench = this.soloStructures.find((s) => s.recipeId === 'workbench') ?? null;
        const chest = this.soloStructures.find((s) => s.recipeId === 'storage_chest') ?? null;
        const dropoff = chest ?? workbench ?? rally;
        const restSpot = bed ? { x: bed.x, z: bed.z } : rally;
        const pPos = this.playerController.getPosition();

        for (const w of this.soloWorkers) {
            if (w.energy < 20 && w.aiState !== 'rest' && w.aiState !== 'transport') {
                w.aiState = 'rest';
                w.targetId = bed?.id ?? null;
                w.targetX = restSpot.x;
                w.targetZ = restSpot.z;
            }

            if (w.aiState === 'rest') {
                const dist = Math.hypot(restSpot.x - w.x, restSpot.z - w.z);
                if (dist > 1.4) {
                    this.stepWorkerToward(w, restSpot.x, restSpot.z, 4.1, dt);
                } else {
                    w.energy = clamp(w.energy + 16 * dt, 0, w.maxEnergy);
                    if (w.energy >= 90) {
                        w.aiState = 'idle';
                    }
                }
                continue;
            }

            if (w.aiState === 'idle') {
                this.assignWorkerNextJob(w, workbench);
                continue;
            }

            if (w.aiState === 'work_gather' || w.aiState === 'work_craft') {
                if (w.pendingAction === 'gather' && w.targetId) {
                    const node = this.soloNodes.get(w.targetId);
                    if (!node || node.depleted) {
                        w.aiState = 'idle';
                        continue;
                    }
                }
                const dist = Math.hypot(w.targetX - w.x, w.targetZ - w.z);
                if (dist > 1.75) {
                    this.stepWorkerToward(w, w.targetX, w.targetZ, 4.6, dt);
                    continue;
                }

                w.energy = clamp(w.energy - 5.2 * dt, 0, w.maxEnergy);
                w.workTimer -= dt;
                if (w.workTimer > 0) continue;

                // Complete work tick
                let producedKind: ResourceKind = 'wood';
                let producedAmt = 1;
                if (w.pendingAction === 'craft_cooked_berry' && this.soloSharedResources.berry >= 2 && this.soloSharedResources.wood >= 1) {
                    this.soloSharedResources.berry -= 2;
                    this.soloSharedResources.wood -= 1;
                    producedKind = 'cooked_berry';
                    producedAmt = 1;
                } else if (w.pendingAction === 'refine_aether' && this.soloSharedResources.ore >= 1) {
                    this.soloSharedResources.ore -= 1;
                    producedKind = 'aether_shard';
                    producedAmt = 2;
                } else if (w.targetId) {
                    const node = this.soloNodes.get(w.targetId);
                    if (node && !node.depleted) {
                        node.hp = Math.max(0, node.hp - 34);
                        if (node.hp <= 0) {
                            node.depleted = true;
                            node.respawnAtMs = Date.now() + RESOURCE_RESPAWN_MS;
                        }
                        if (node.kind === 'wood') {
                            producedKind = 'wood';
                            producedAmt = 2;
                        } else if (node.kind === 'stone') {
                            producedKind = 'stone';
                            producedAmt = 2;
                        } else if (node.kind === 'ore') {
                            producedKind = 'aether_shard';
                            producedAmt = 1;
                            this.soloSharedResources.ore += 1;
                        } else {
                            producedKind = 'berry';
                            producedAmt = 2;
                        }
                    } else {
                        producedKind =
                            w.species === 'moss_hopper'
                                ? 'wood'
                                : w.species === 'shale_golem'
                                  ? 'stone'
                                  : 'aether_shard';
                        producedAmt = 1;
                    }
                }

                w.carryingKind = producedKind;
                w.carryingAmount = producedAmt;
                w.energy = clamp(w.energy - 7, 0, w.maxEnergy);
                w.aiState = 'transport';
                w.targetX = dropoff.x;
                w.targetZ = dropoff.z;
                continue;
            }

            if (w.aiState === 'transport' || w.aiState === 'return') {
                const dist = Math.hypot(dropoff.x - w.x, dropoff.z - w.z);
                if (dist > 1.75) {
                    this.stepWorkerToward(w, dropoff.x, dropoff.z, 4.2, dt);
                } else {
                    if (w.carryingKind && w.carryingAmount > 0) {
                        this.soloSharedResources[w.carryingKind] += w.carryingAmount;
                        this.markSoloDirty();
                        if (Math.hypot(pPos.x - w.x, pPos.z - w.z) < 28) {
                            this.soundManager.playWorkerDeliver();
                            this.spawnSparkBurst(w.x, w.y + 1.0, w.z, 'build', 5);
                        }
                    }
                    w.carryingKind = null;
                    w.carryingAmount = 0;
                    w.aiState = w.energy < 20 ? 'rest' : 'idle';
                }
            }
        }
    }

    private assignWorkerNextJob(
        w: SoloWorkerInternal,
        workbench: PlacedStructureSyncState | null
    ): void {
        if (w.species === 'aether_wisp' && workbench) {
            if (this.soloSharedResources.berry >= 2 && this.soloSharedResources.wood >= 1) {
                w.pendingAction = 'craft_cooked_berry';
                w.targetId = workbench.id;
                w.targetX = workbench.x;
                w.targetZ = workbench.z;
                w.workTimer = 2.2;
                w.aiState = 'work_craft';
                return;
            }
            if (this.soloSharedResources.ore >= 1) {
                w.pendingAction = 'refine_aether';
                w.targetId = workbench.id;
                w.targetX = workbench.x;
                w.targetZ = workbench.z;
                w.workTimer = 2.2;
                w.aiState = 'work_craft';
                return;
            }
        }

        const preferredKinds: ResourceNodeKind[] =
            w.species === 'moss_hopper'
                ? ['wood', 'berry']
                : w.species === 'shale_golem'
                  ? ['stone', 'ore']
                  : ['ore', 'berry', 'wood'];

        let best: SoloResourceNode | null = null;
        let bestDist = Infinity;
        for (const kind of preferredKinds) {
            for (const n of this.soloNodes.values()) {
                if (n.depleted || n.kind !== kind) continue;
                const d = Math.hypot(n.x - w.x, n.z - w.z);
                if (d < bestDist) {
                    bestDist = d;
                    best = n;
                }
            }
            if (best) break;
        }

        if (!best) {
            for (const n of this.soloNodes.values()) {
                if (n.depleted) continue;
                const d = Math.hypot(n.x - w.x, n.z - w.z);
                if (d < bestDist) {
                    bestDist = d;
                    best = n;
                }
            }
        }

        if (best) {
            w.pendingAction = 'gather';
            w.targetId = best.id;
            w.targetX = best.x;
            w.targetZ = best.z;
            w.workTimer = 2.2;
            w.aiState = 'work_gather';
        }
    }

    private stepWorkerToward(
        w: SoloWorkerInternal,
        tx: number,
        tz: number,
        speed: number,
        dt: number
    ): void {
        const dx = tx - w.x;
        const dz = tz - w.z;
        const dist = Math.hypot(dx, dz);
        if (dist < 1e-4) return;
        const step = Math.min(dist, speed * dt);
        w.x += (dx / dist) * step;
        w.z += (dz / dist) * step;
        w.y = this.collisionWorld.getTerrainHeight(w.x, w.z);
        w.yawDeg = Math.atan2(-dx, -dz) * pc.math.RAD_TO_DEG;
    }

    private getSoloWorkerSnapshots(): BaseWorkerSyncState[] {
        return this.soloWorkers.map((w) => {
            const suitKeys = Object.keys(
                SPECIES_WORK_SUITABILITY[w.species]
            ) as WorkSuitabilityKind[];
            const activeWork: WorkSuitabilityKind | null =
                w.aiState === 'rest' || w.aiState === 'idle'
                    ? null
                    : w.aiState === 'work_craft'
                      ? (suitKeys.find((k) => String(k).includes('craft')) ?? w.suitability)
                      : w.suitability;
            const targetNodeId = w.pendingAction === 'gather' ? w.targetId : null;
            const targetStructureId =
                w.pendingAction && w.pendingAction !== 'gather' ? w.targetId : null;
            return {
                uid: w.uid,
                species: w.species,
                nickname: w.nickname,
                level: w.level,
                ownerPlayerId: 'local',
                aiState: w.aiState,
                energy: Math.round(w.energy),
                maxEnergy: w.maxEnergy,
                x: w.x,
                y: w.y,
                z: w.z,
                yaw: w.yawDeg,
                activeWork,
                targetNodeId,
                targetStructureId,
                carryingKind: w.carryingKind,
                carryingAmount: w.carryingAmount,
            };
        });
    }

    private syncSoloCombatIntegration(): void {
        if (this.isOnlineMode()) return;
        const bonus = TOOL_COMBAT_BONUSES[this.soloEquippedTool];
        this.monsterCombatManager.setToolBonuses(bonus.meleeBonus, bonus.rangedBonus);
        this.monsterCombatManager.setWorkerAssignedUids(
            new Set(this.soloWorkers.map((w) => w.uid))
        );
    }

    // -------------------------------------------------------------------------
    // Online Survival Event Handling
    // -------------------------------------------------------------------------

    private handleOnlineSurvivalEvent(evt: S2CSurvivalEventMessage): void {
        const localPlayerId = this.multiplayerClient?.getStatus().localPlayerId ?? '';
        const isMe = evt.actorId === localPlayerId;

        switch (evt.event) {
            case 'node_hit': {
                if (typeof evt.x === 'number' && typeof evt.z === 'number') {
                    const node = evt.targetId ? this.nodeActors.get(evt.targetId) : null;
                    if (node) {
                        node.hitShakeTimer = 0.25;
                        this.spawnSparkBurst(node.x, node.y + 0.9, node.z, node.kind, 6);
                        if (!isMe) {
                            this.soundManager.playGatherHit(node.kind);
                        }
                    }
                }
                break;
            }
            case 'node_depleted': {
                if (evt.targetId) {
                    const node = this.nodeActors.get(evt.targetId);
                    if (node) {
                        this.spawnSparkBurst(node.x, node.y + 1.1, node.z, node.kind, 10);
                    }
                }
                if (isMe) {
                    this.soundManager.playGatherComplete();
                    this.notify('자원 채집 완료!', 'success');
                }
                break;
            }
            case 'item_crafted': {
                if (isMe) {
                    this.soundManager.playCraftSuccess();
                    const label =
                        evt.recipeId && evt.recipeId in CRAFT_RECIPES
                            ? CRAFT_RECIPES[evt.recipeId as CraftRecipeId].nameKo
                            : '아이템';
                    this.notify(`${label} 제작 완료!`, 'success');
                }
                break;
            }
            case 'tool_equipped': {
                if (isMe && evt.toolId) {
                    this.soundManager.playCraftSuccess();
                    this.notify(`${getToolDisplayName(evt.toolId)} 장착`, 'info');
                }
                break;
            }
            case 'food_eaten': {
                if (isMe) {
                    this.soundManager.playEatFood();
                    this.notify('식량을 섭취했습니다', 'success');
                }
                break;
            }
            case 'structure_placed': {
                if (typeof evt.x === 'number' && typeof evt.z === 'number') {
                    this.spawnSparkBurst(evt.x, (evt.y ?? 0) + 0.5, evt.z, 'build', 8);
                }
                if (isMe) {
                    this.notify('구조물 설치 완료!', 'success');
                }
                break;
            }
            case 'structure_demolished': {
                if (typeof evt.x === 'number' && typeof evt.z === 'number') {
                    this.spawnSparkBurst(evt.x, (evt.y ?? 0) + 0.5, evt.z, 'wood', 8);
                }
                if (isMe) {
                    this.notify('구조물 철거 완료', 'info');
                }
                break;
            }
            case 'node_respawned': {
                if (evt.targetId) {
                    const node = this.nodeActors.get(evt.targetId);
                    if (node) {
                        node.respawnScale = 0.05;
                        this.spawnSparkBurst(node.x, node.y + 0.8, node.z, node.kind, 5);
                    }
                }
                break;
            }
            case 'bed_rested': {
                if (isMe) {
                    this.soundManager.playGatherComplete();
                    this.notify('휴식하여 체력을 회복했습니다!', 'success');
                }
                break;
            }
            case 'worker_assigned': {
                if (isMe) {
                    this.soundManager.playSummon();
                    this.notify('거점 작업 몬스터를 배치했습니다!', 'success');
                }
                break;
            }
            case 'worker_unassigned': {
                if (isMe) {
                    this.soundManager.playSummon();
                    this.notify('거점 작업 배치를 해제했습니다', 'info');
                }
                break;
            }
            case 'worker_delivered': {
                const pPos = this.playerController.getPosition();
                if (
                    typeof evt.x === 'number' &&
                    typeof evt.z === 'number' &&
                    Math.hypot(pPos.x - evt.x, pPos.z - evt.z) < 28
                ) {
                    this.soundManager.playWorkerDeliver();
                    this.spawnSparkBurst(evt.x, (evt.y ?? 0) + 1.0, evt.z, 'build', 5);
                }
                break;
            }
            case 'action_rejected': {
                if (isMe && evt.message) {
                    this.notify(evt.message, 'warning');
                }
                break;
            }
            default: {
                const _exhaustive: never = evt.event;
                void _exhaustive;
                break;
            }
        }
    }

    // -------------------------------------------------------------------------
    // HUD Snapshot & Floating Plates
    // -------------------------------------------------------------------------

    public getHudSurvivalState(
        cameraEntity: pc.Entity,
        viewportWidth: number,
        viewportHeight: number
    ): SurvivalHudSnapshot {
        const online = this.isOnlineMode();
        const lp = online ? this.getLocalCoopPlayerState() : null;
        const pPos = this.playerController.getPosition();

        const hunger = online ? Math.round(lp?.hunger ?? PLAYER_MAX_HUNGER) : Math.round(this.soloHunger);
        const maxHunger = online ? Math.round(lp?.maxHunger ?? PLAYER_MAX_HUNGER) : PLAYER_MAX_HUNGER;
        const equippedTool = (online ? lp?.equippedTool ?? 'hands' : this.soloEquippedTool) as ToolId;
        const unlockedTools = online
            ? ([...(lp?.unlockedTools ?? ['hands'])] as ToolId[])
            : [...this.soloUnlockedTools];

        const sharedResources = { ...this.getActiveSharedResources() };
        const structures = this.getActiveStructures();
        const workers = online && this.multiplayerClient
            ? [...this.multiplayerClient.getBaseWorkers()]
            : this.getSoloWorkerSnapshots();

        const nearestNode = this.findNearestActiveNode(pPos, INTERACT_HARVEST_RANGE);
        const nearestStruct = this.findNearestStructure(pPos, DEMOLISH_RANGE);
        const nearestBed = this.findNearestStructureByRecipe(pPos, 'straw_bed', BED_REST_RANGE);

        const plates = this.collectPlates(
            cameraEntity,
            viewportWidth,
            viewportHeight,
            pPos,
            structures,
            workers
        );

        return {
            hunger,
            maxHunger,
            equippedTool,
            unlockedTools,
            sharedResources,
            hasWorkbenchNearOrInBase: this.hasWorkbenchNearOrInBase(),
            hasBedNear: nearestBed !== null,
            nearestResourceLabel: nearestNode ? nearestNode.actor.label : null,
            nearestStructureLabel: nearestStruct
                ? (getStructureRecipe(nearestStruct.recipeId)?.nameKo ?? nearestStruct.recipeId)
                : null,
            nearestStructureId: nearestStruct?.id ?? null,
            buildMode: this.buildMode,
            selectedBuildRecipe: this.selectedBuildRecipe,
            buildRotationDeg: this.buildRotationDeg,
            buildPreviewValid: this.buildPreviewValid,
            buildPreviewReason: this.buildPreviewReason,
            placedStructures: structures.map((s) => ({ ...s })),
            baseWorkers: workers,
            capturedRoster: this.monsterCombatManager.getCapturedRoster(),
            activeCompanionUid: this.monsterCombatManager.getActiveCompanionUid(),
            persistenceMode:
                (online && this.multiplayerClient
                    ? this.multiplayerClient.getPersistenceMode()
                    : null) ?? 'localStorage',
            plates,
        };
    }

    private collectPlates(
        cameraEntity: pc.Entity,
        viewportWidth: number,
        viewportHeight: number,
        pPos: pc.Vec3,
        structures: PlacedStructureSyncState[],
        workers: BaseWorkerSyncState[]
    ): SurvivalPlateInfo[] {
        const camComp = cameraEntity.camera;
        if (!camComp) return [];

        const cw = Math.max(1, viewportWidth);
        const ch = Math.max(1, viewportHeight);
        const camPos = cameraEntity.getPosition();
        this.tmpForward.copy(cameraEntity.forward);

        const project = (wx: number, wy: number, wz: number) => {
            this.tmpVec2.set(wx, wy, wz);
            this.tmpVec.sub2(this.tmpVec2, camPos);
            const ahead = this.tmpVec.dot(this.tmpForward) > 0.1;
            if (!ahead) return { visible: false, sx: -999, sy: -999 };
            camComp.worldToScreen(this.tmpVec2, this.tmpScreen);
            const sx = this.tmpScreen.x;
            const sy = this.tmpScreen.y;
            const onScreen = sx >= -60 && sx <= cw + 60 && sy >= -60 && sy <= ch + 60;
            return { visible: onScreen, sx, sy };
        };

        const plates: SurvivalPlateInfo[] = [];

        for (const actor of this.nodeActors.values()) {
            if (actor.state.depleted) continue;
            const dist = Math.hypot(actor.x - pPos.x, actor.z - pPos.z);
            const damaged = actor.state.hp < actor.state.maxHp;
            if (dist > (damaged ? 24 : 14)) continue;
            const proj = project(actor.x, actor.y + actor.plateHeight, actor.z);
            if (!proj.visible) continue;
            plates.push({
                id: actor.id,
                label: actor.label,
                kind: 'resource',
                hp: Math.round(actor.state.hp),
                maxHp: Math.round(actor.state.maxHp),
                screenX: proj.sx,
                screenY: proj.sy,
                visible: true,
                distanceMeters: Number(dist.toFixed(1)),
            });
        }

        for (const s of structures) {
            const dist = Math.hypot(s.x - pPos.x, s.z - pPos.z);
            if (dist > 14) continue;
            if (
                s.recipeId !== 'workbench' &&
                s.recipeId !== 'storage_chest' &&
                s.recipeId !== 'straw_bed'
            ) {
                continue;
            }
            const recipe = getStructureRecipe(s.recipeId);
            const proj = project(s.x, s.y + 1.45, s.z);
            if (!proj.visible) continue;
            plates.push({
                id: s.id,
                label: recipe?.nameKo ?? s.recipeId,
                kind: 'structure',
                stateTag:
                    s.recipeId === 'workbench'
                        ? '제작대'
                        : s.recipeId === 'straw_bed'
                          ? '휴식 가능'
                          : '공유 보관함',
                screenX: proj.sx,
                screenY: proj.sy,
                visible: true,
                distanceMeters: Number(dist.toFixed(1)),
            });
        }

        for (const w of workers) {
            const dist = Math.hypot(w.x - pPos.x, w.z - pPos.z);
            if (dist > 36) continue;
            const actor = this.workerActors.get(w.uid);
            const wy = actor ? actor.y : this.collisionWorld.getTerrainHeight(w.x, w.z);
            const proj = project(w.x, wy + 1.85, w.z);
            if (!proj.visible) continue;
            plates.push({
                id: w.uid,
                label: w.nickname,
                kind: 'worker',
                energy: Math.round(w.energy),
                maxEnergy: Math.round(w.maxEnergy),
                stateTag: WORKER_STATE_LABELS[w.aiState],
                screenX: proj.sx,
                screenY: proj.sy,
                visible: true,
                distanceMeters: Number(dist.toFixed(1)),
            });
        }

        return plates;
    }

    // -------------------------------------------------------------------------
    // Shared Helpers & Queries
    // -------------------------------------------------------------------------

    private getActiveSharedResources(): SharedResourceInventory {
        if (this.isOnlineMode() && this.multiplayerClient) {
            return this.multiplayerClient.getSharedResources();
        }
        return this.soloSharedResources;
    }

    private getActiveStructures(): PlacedStructureSyncState[] {
        if (this.isOnlineMode() && this.multiplayerClient) {
            return this.multiplayerClient.getPlacedStructures();
        }
        return this.soloStructures;
    }

    private hasWorkbenchNearOrInBase(): boolean {
        const structures = this.getActiveStructures();
        const workbenches = structures.filter((s) => s.recipeId === 'workbench');
        if (workbenches.length === 0) return false;
        const pPos = this.playerController.getPosition();
        return (
            workbenches.some(
                (w) => Math.hypot(w.x - pPos.x, w.z - pPos.z) <= WORKBENCH_NEAR_RANGE
            ) || workbenches.length > 0
        );
    }

    private findNearestStructure(
        pos: pc.Vec3,
        maxDist: number
    ): PlacedStructureSyncState | null {
        const list = this.getActiveStructures();
        let best: PlacedStructureSyncState | null = null;
        let bestDist = Infinity;
        for (const s of list) {
            const d = Math.hypot(s.x - pos.x, s.z - pos.z);
            if (d <= maxDist && d < bestDist) {
                bestDist = d;
                best = s;
            }
        }
        return best;
    }

    private findNearestStructureByRecipe(
        pos: pc.Vec3,
        recipeId: ModularStructureRecipeId,
        maxDist: number
    ): PlacedStructureSyncState | null {
        const list = this.getActiveStructures();
        let best: PlacedStructureSyncState | null = null;
        let bestDist = Infinity;
        for (const s of list) {
            if (s.recipeId !== recipeId) continue;
            const d = Math.hypot(s.x - pos.x, s.z - pos.z);
            if (d <= maxDist && d < bestDist) {
                bestDist = d;
                best = s;
            }
        }
        return best;
    }

    private hasEnoughResources(
        inv: SharedResourceInventory,
        cost: Partial<Record<ResourceKind, number>>
    ): boolean {
        for (const [k, amount] of Object.entries(cost)) {
            if (!amount || amount <= 0) continue;
            if ((inv[k as ResourceKind] ?? 0) < amount) return false;
        }
        return true;
    }

    private deductResources(
        inv: SharedResourceInventory,
        cost: Partial<Record<ResourceKind, number>>
    ): void {
        for (const [k, amount] of Object.entries(cost)) {
            if (!amount || amount <= 0) continue;
            const key = k as ResourceKind;
            inv[key] = Math.max(0, (inv[key] ?? 0) - amount);
        }
    }

    private notify(
        msg: string,
        kind: 'info' | 'success' | 'warning' | 'error' = 'info'
    ): void {
        this.onToast?.(msg, kind);
    }

    // -------------------------------------------------------------------------
    // Debounced Solo Persistence
    // -------------------------------------------------------------------------

    private markSoloDirty(): void {
        this.soloDirty = true;
        this.scheduleSoloSave();
    }

    private scheduleSoloSave(): void {
        if (typeof window === 'undefined' || this.saveDebounceHandle !== null) return;
        this.saveDebounceHandle = window.setTimeout(() => {
            this.saveDebounceHandle = null;
            this.flushSoloPersistenceNow();
        }, 450);
    }

    private flushSoloPersistenceNow(): void {
        if (!this.soloDirty) return;
        this.soloDirty = false;
        if (this.saveDebounceHandle !== null && typeof window !== 'undefined') {
            window.clearTimeout(this.saveDebounceHandle);
            this.saveDebounceHandle = null;
        }
        if (typeof localStorage === 'undefined') return;
        try {
            const nowMs = Date.now();
            const payload: SoloPersistencePayload = {
                version: 1,
                hunger: Math.round(this.soloHunger),
                equippedTool: this.soloEquippedTool,
                unlockedTools: [...this.soloUnlockedTools],
                sharedResources: { ...this.soloSharedResources },
                placedStructures: this.soloStructures.map((s) => ({ ...s })),
                resourceNodes: Array.from(this.soloNodes.values()).map((n) => ({
                    id: n.id,
                    hp: n.hp,
                    depleted: n.depleted,
                    respawnRemainingMs: n.depleted ? Math.max(0, n.respawnAtMs - nowMs) : 0,
                })),
                baseWorkers: this.soloWorkers.map((w) => ({ ...w })),
            };
            localStorage.setItem(SOLO_STORAGE_KEY, JSON.stringify(payload));
        } catch {
            // Storage quota / privacy mode fallback
        }
    }

    // -------------------------------------------------------------------------
    // Debug / Test Hook & Cleanup
    // -------------------------------------------------------------------------

    public triggerDebugAction(action: string, arg?: string): Record<string, unknown> {
        const online = this.isOnlineMode();
        switch (action) {
            case 'grant_resources': {
                if (online) {
                    return { ok: false, reason: 'online_authoritative' };
                }
                const amt = Math.max(1, Number(arg) || 20);
                this.soloSharedResources.wood += amt;
                this.soloSharedResources.stone += amt;
                this.soloSharedResources.ore += Math.ceil(amt * 0.5);
                this.soloSharedResources.berry += amt;
                this.soloSharedResources.aether_shard += Math.ceil(amt * 0.4);
                this.soloSharedResources.cooked_berry += 5;
                this.markSoloDirty();
                return { ok: true, sharedResources: { ...this.soloSharedResources } };
            }
            case 'set_hunger':
            case 'fill_hunger':
            case 'drain_hunger': {
                if (online) {
                    return { ok: false, reason: 'online_authoritative' };
                }
                const val =
                    action === 'drain_hunger'
                        ? Number(arg ?? 0)
                        : Number(arg ?? PLAYER_MAX_HUNGER);
                this.soloHunger = clamp(Number.isFinite(val) ? val : PLAYER_MAX_HUNGER, 0, PLAYER_MAX_HUNGER);
                this.markSoloDirty();
                return { ok: true, hunger: this.soloHunger };
            }
            case 'toggle_build': {
                const next = !this.buildMode;
                this.setBuildMode(next);
                return { ok: true, buildMode: this.buildMode };
            }
            case 'respawn_nodes': {
                if (online) {
                    return { ok: false, reason: 'online_authoritative' };
                }
                for (const n of this.soloNodes.values()) {
                    n.depleted = false;
                    n.hp = n.maxHp;
                    n.respawnAtMs = 0;
                }
                this.markSoloDirty();
                return { ok: true, respawned: this.soloNodes.size };
            }
            case 'assign_first_worker': {
                const roster = this.monsterCombatManager.getCapturedRoster();
                const assigned = new Set(
                    (online && this.multiplayerClient
                        ? this.multiplayerClient.getBaseWorkers()
                        : this.soloWorkers
                    ).map((w) => w.uid)
                );
                const candidate = roster.find((r) => !assigned.has(r.uid));
                if (!candidate) return { ok: false, reason: 'no_available_monster' };
                const ok = this.assignBaseWorker(candidate.uid);
                return { ok, uid: candidate.uid };
            }
            case 'reset_solo': {
                if (typeof localStorage !== 'undefined') {
                    try {
                        localStorage.removeItem(SOLO_STORAGE_KEY);
                    } catch {
                        // ignore
                    }
                }
                this.soloHunger = PLAYER_MAX_HUNGER;
                this.soloEquippedTool = 'hands';
                this.soloUnlockedTools = ['hands'];
                this.soloSharedResources = createDefaultSharedResources();
                this.soloStructures = [];
                this.soloWorkers = [];
                for (const def of SEEDED_RESOURCE_NODES) {
                    const n = this.soloNodes.get(def.id);
                    if (n) {
                        n.hp = n.maxHp;
                        n.depleted = false;
                        n.respawnAtMs = 0;
                    }
                }
                this.rebuildSoloStructureActors();
                this.syncSoloCombatIntegration();
                return { ok: true };
            }
            default: {
                const nodes = Array.from(this.nodeActors.values());
                return {
                    ok: true,
                    online,
                    hunger: Math.round(this.soloHunger),
                    equippedTool: this.soloEquippedTool,
                    sharedResources: { ...this.getActiveSharedResources() },
                    placedStructuresCount: this.getActiveStructures().length,
                    baseWorkersCount: online && this.multiplayerClient
                        ? this.multiplayerClient.getBaseWorkers().length
                        : this.soloWorkers.length,
                    depletedNodesCount: nodes.filter((n) => n.state.depleted).length,
                };
            }
        }
    }

    public dispose(): void {
        this.flushSoloPersistenceNow();
        if (typeof window !== 'undefined') {
            window.removeEventListener('beforeunload', this.boundBeforeUnload);
        }
        if (this.saveDebounceHandle !== null && typeof window !== 'undefined') {
            window.clearTimeout(this.saveDebounceHandle);
            this.saveDebounceHandle = null;
        }
        if (this.unsubscribeSurvivalEvent) {
            this.unsubscribeSurvivalEvent();
            this.unsubscribeSurvivalEvent = null;
        }

        for (const actor of this.nodeActors.values()) {
            if (actor.colliderActive) {
                this.collisionWorld.removeCollider(actor.colliderId);
                actor.colliderActive = false;
            }
        }
        this.nodeActors.clear();

        for (const actor of this.structureActors.values()) {
            this.destroyStructureActor(actor);
        }
        this.structureActors.clear();

        for (const actor of this.workerActors.values()) {
            actor.entity.destroy();
        }
        this.workerActors.clear();

        this.survivalRoot.destroy();

        for (const mat of this.sharedMaterials) {
            mat.destroy();
        }
        this.sharedMaterials.length = 0;

        for (const mesh of this.retainedMeshes) {
            mesh.decRefCount();
        }
        this.retainedMeshes.length = 0;
    }
}
