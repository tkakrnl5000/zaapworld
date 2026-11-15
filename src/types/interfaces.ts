import * as pc from 'playcanvas';

export type QualityTier = 'low' | 'medium' | 'high';

export type QualityMode = 'auto' | QualityTier;

export interface QualitySettings {
    tier: QualityTier;
    mode: QualityMode;
    pixelRatio: number;
    shadowsEnabled: boolean;
    shadowResolution: number;
    shadowDistance: number;
    drawDistance: number;
    lodBias: number;
    grassInstanceCount: number;
    bloomSimulate: boolean;
}

export interface PerformanceMetrics {
    fps: number;
    frameTimeMs: number;
    minFps1Pct: number;
    qualityTier: QualityTier;
    qualityMode: QualityMode;
    visibleInstances: number;
    culledObjects: number;
    memoryMb: number | null;
}

export interface RaycastHit {
    hit: boolean;
    point: pc.Vec3;
    normal: pc.Vec3;
    distance: number;
    colliderTag?: string;
}

export interface ColliderVolume {
    id: string;
    type: 'cylinder' | 'sphere' | 'box';
    position: pc.Vec3;
    radius: number;
    height?: number;
    halfExtents?: pc.Vec3;
    tag: 'tree' | 'rock' | 'ruin' | 'crystal' | 'prop' | 'resource' | 'structure';
    blocksCamera: boolean;
    collected?: boolean;
}

export interface ICollisionWorld {
    getTerrainHeight(x: number, z: number): number;
    getTerrainNormal(x: number, z: number, out?: pc.Vec3): pc.Vec3;
    getWaterLevel(): number;
    registerCollider(collider: ColliderVolume): void;
    removeCollider(id: string): void;
    resolveSphereMovement(
        currentPos: pc.Vec3,
        desiredPos: pc.Vec3,
        radius: number,
        stepHeight?: number
    ): {
        position: pc.Vec3;
        grounded: boolean;
        hitObstacle: boolean;
        groundNormal: pc.Vec3;
    };
    raycastCamera(
        origin: pc.Vec3,
        target: pc.Vec3,
        paddingRadius?: number
    ): RaycastHit;
    findNearestInteractable(
        pos: pc.Vec3,
        maxRadius: number
    ): ColliderVolume | null;
}

export type ModelAssetKey =
    | 'player_explorer'
    | 'tree_canopy'
    | 'tree_pine'
    | 'rock_cluster'
    | 'ancient_ruin'
    | 'vital_crystal'
    | 'bush_flower'
    | 'monster_moss_hopper'
    | 'monster_aether_wisp'
    | 'monster_shale_golem'
    | 'build_workbench'
    | 'build_chest'
    | 'build_bed';

export interface LoadedModelBundle {
    key: ModelAssetKey;
    containerAsset: pc.Asset | null;
    instantiate(name?: string): pc.Entity;
}

export interface IAssetLoader {
    loadAll(
        app: pc.Application,
        onProgress?: (loaded: number, total: number, label: string) => void
    ): Promise<Record<ModelAssetKey, LoadedModelBundle>>;
    getBundle(key: ModelAssetKey): LoadedModelBundle;
}

export interface InputState {
    moveX: number;
    moveZ: number;
    moveMagnitude: number;
    lookDeltaX: number;
    lookDeltaY: number;
    zoomDelta: number;
    sprintHeld: boolean;
    jumpPressed: boolean;
    interactPressed: boolean;
    isTouchActive: boolean;
    meleePressed?: boolean;
    rangedPressed?: boolean;
    dodgePressed?: boolean;
    capturePressed?: boolean;
    summonPressed?: boolean;
    selectCompanionIndex?: number | null;
    eatPressed?: boolean;
    buildModePressed?: boolean;
    craftPanelPressed?: boolean;
    basePanelPressed?: boolean;
    buildRotatePressed?: boolean;
    buildPlacePressed?: boolean;
    buildDemolishPressed?: boolean;
}

export interface PlayerTelemetry {
    position: pc.Vec3;
    velocity: pc.Vec3;
    speed: number;
    yawDeg: number;
    state: 'idle' | 'walk' | 'run' | 'jump' | 'fall' | 'attack' | 'dodge' | 'hit' | 'throw' | 'gather' | 'build';
    grounded: boolean;
    inWater: boolean;
    stamina: number;
    crystalsCollected: number;
    totalCrystals: number;
    nearbyHint: string | null;
    hp?: number;
    maxHp?: number;
    dodging?: boolean;
    attackComboStep?: number;
    hunger?: number;
    maxHunger?: number;
    equippedTool?: string;
}
