import * as pc from 'playcanvas';
import { MultiplayerClient } from '../network/MultiplayerClient';
import {
    BUILD_GRID_SIZE_METERS,
    type CapturedMonsterRecord,
    type CompanionSyncState,
    CoopSessionManagerStub,
    type CoopSessionStatus,
    MAX_PARTY_PLAYERS,
    MODULAR_STRUCTURE_RECIPES,
    MODULAR_STRUCTURE_RECIPE_LIST,
    type ModularStructureRecipeDef,
    type MonsterSpeciesId,
    type MonsterSyncState,
    type PlacedStructureSyncState,
    type SharedResourceInventory,
    computeCaptureChance,
} from '../shared/NetworkProtocol';
import type { ICollisionWorld } from '../types/interfaces';

export { CoopSessionManagerStub, MultiplayerClient };

export type MonsterElement = 'aether' | 'flora' | 'terra' | 'aqua';

export interface MonsterSpeciesDef {
    speciesId: MonsterSpeciesId | string;
    name: string;
    element: MonsterElement;
    rarity: 'common' | 'uncommon' | 'rare';
    baseHp: number;
    moveSpeed: number;
    captureDifficulty: number;
    preferredBiomes: ('meadow' | 'shore' | 'ruins' | 'highlands')[];
    description: string;
    baseLevel?: number;
    attackRange?: number;
    attackDamage?: number;
    combatStyle?: 'melee' | 'ranged' | 'aoe_bruiser';
}

export interface WildMonsterInstance {
    instanceId: string;
    speciesId: string;
    position: { x: number; y: number; z: number };
    hpRatio: number;
    captured: boolean;
    aiState?: MonsterSyncState['aiState'];
    hp?: number;
    maxHp?: number;
}

export const DEFAULT_WILD_SPAWN_POINTS: ReadonlyArray<{
    id: string;
    x: number;
    z: number;
    speciesId: MonsterSpeciesId;
    level: number;
}> = [
    { id: 'wild-moss_hopper-1', x: -16, z: -18, speciesId: 'moss_hopper', level: 3 },
    { id: 'wild-moss_hopper-2', x: 16, z: 14, speciesId: 'moss_hopper', level: 4 },
    { id: 'wild-aether_wisp-1', x: 10, z: -44, speciesId: 'aether_wisp', level: 5 },
    { id: 'wild-aether_wisp-2', x: -38, z: -22, speciesId: 'aether_wisp', level: 6 },
    { id: 'wild-shale_golem-1', x: 42, z: -26, speciesId: 'shale_golem', level: 7 },
    { id: 'wild-shale_golem-2', x: -46, z: 36, speciesId: 'shale_golem', level: 8 },
];

const STARTER_MONSTER_SPECIES: MonsterSpeciesDef[] = [
    {
        speciesId: 'aether_wisp',
        name: 'Aether Wisp',
        element: 'aether',
        rarity: 'uncommon',
        baseHp: 85,
        moveSpeed: 4.8,
        captureDifficulty: 0.35,
        preferredBiomes: ['ruins', 'meadow'],
        description: 'Luminous sanctuary spirit drawn to Vital Crystals and ancient stonework.',
        baseLevel: 5,
        attackRange: 13.0,
        attackDamage: 14,
        combatStyle: 'ranged',
    },
    {
        speciesId: 'moss_hopper',
        name: 'Moss Hopper',
        element: 'flora',
        rarity: 'common',
        baseHp: 110,
        moveSpeed: 5.4,
        captureDifficulty: 0.22,
        preferredBiomes: ['meadow', 'shore'],
        description: 'Nimble emerald meadow creature that bounds across sunlit grass slopes.',
        baseLevel: 3,
        attackRange: 2.3,
        attackDamage: 12,
        combatStyle: 'melee',
    },
    {
        speciesId: 'shale_golem',
        name: 'Shale Golem',
        element: 'terra',
        rarity: 'rare',
        baseHp: 180,
        moveSpeed: 3.1,
        captureDifficulty: 0.58,
        preferredBiomes: ['highlands', 'ruins'],
        description: 'Runic boulder guardian that sleeps along elevated mountain ridges.',
        baseLevel: 7,
        attackRange: 3.4,
        attackDamage: 24,
        combatStyle: 'aoe_bruiser',
    },
];

export class WildMonsterSpawnerStub {
    private readonly speciesRegistry = new Map<string, MonsterSpeciesDef>();
    private readonly activeSpawns: WildMonsterInstance[] = [];
    private readonly capturedSpeciesIds: string[] = [];
    private syncedMonsters: MonsterSyncState[] = [];
    private syncedCompanions: CompanionSyncState[] = [];
    private capturedRoster: CapturedMonsterRecord[] = [];

    constructor() {
        for (const species of STARTER_MONSTER_SPECIES) {
            this.registerSpecies(species);
        }
    }

    public registerSpecies(def: MonsterSpeciesDef): void {
        this.speciesRegistry.set(def.speciesId, { ...def });
    }

    public getRegisteredSpecies(): MonsterSpeciesDef[] {
        return Array.from(this.speciesRegistry.values());
    }

    public getSpecies(speciesId: string): MonsterSpeciesDef | undefined {
        return this.speciesRegistry.get(speciesId);
    }

    public planWildSpawns(
        collisionWorld?: Pick<ICollisionWorld, 'getTerrainHeight'>,
        seedPoints: ReadonlyArray<{ x: number; z: number; speciesId: string; id?: string }> = DEFAULT_WILD_SPAWN_POINTS
    ): WildMonsterInstance[] {
        this.activeSpawns.length = 0;
        seedPoints.forEach((spot, index) => {
            const def = this.speciesRegistry.get(spot.speciesId);
            if (!def) {
                return;
            }
            const y = collisionWorld ? collisionWorld.getTerrainHeight(spot.x, spot.z) : 0;
            this.activeSpawns.push({
                instanceId: spot.id ?? `wild-${spot.speciesId}-${index + 1}`,
                speciesId: spot.speciesId,
                position: { x: spot.x, y, z: spot.z },
                hpRatio: 1.0,
                captured: false,
                aiState: 'patrol',
                hp: def.baseHp,
                maxHp: def.baseHp,
            });
        });
        return this.getActiveSpawns();
    }

    public syncFromNetwork(
        monsters: ReadonlyArray<MonsterSyncState>,
        companions: ReadonlyArray<CompanionSyncState> = [],
        capturedRoster?: ReadonlyArray<CapturedMonsterRecord>
    ): void {
        this.syncedMonsters = monsters.map((m) => ({ ...m }));
        this.syncedCompanions = companions.map((c) => ({ ...c }));
        if (capturedRoster) {
            this.capturedRoster = capturedRoster.map((r) => ({ ...r }));
            this.capturedSpeciesIds.length = 0;
            for (const rec of capturedRoster) {
                this.capturedSpeciesIds.push(rec.species);
            }
        }
        if (monsters.length > 0) {
            this.activeSpawns.length = 0;
            for (const m of monsters) {
                this.activeSpawns.push({
                    instanceId: m.id,
                    speciesId: m.species,
                    position: { x: m.x, y: m.y, z: m.z },
                    hpRatio: m.maxHp > 0 ? Math.max(0, Math.min(1, m.hp / m.maxHp)) : 0,
                    captured: m.aiState === 'captured',
                    aiState: m.aiState,
                    hp: m.hp,
                    maxHp: m.maxHp,
                });
            }
        }
    }

    public syncLocalCombatState(
        monsters: ReadonlyArray<MonsterSyncState>,
        companions: ReadonlyArray<CompanionSyncState>,
        capturedRoster: ReadonlyArray<CapturedMonsterRecord>
    ): void {
        this.syncFromNetwork(monsters, companions, capturedRoster);
    }

    public getSyncedMonsters(): MonsterSyncState[] {
        return this.syncedMonsters;
    }

    public getCompanions(): CompanionSyncState[] {
        return this.syncedCompanions;
    }

    public getCapturedRoster(): CapturedMonsterRecord[] {
        return this.capturedRoster;
    }

    public attemptCapture(instanceId: string, orbBonus = 0): {
        success: boolean;
        chance: number;
        speciesId: string | null;
    } {
        const target = this.activeSpawns.find((entry) => entry.instanceId === instanceId);
        if (!target || target.captured) {
            return { success: false, chance: 0, speciesId: null };
        }
        const def = this.speciesRegistry.get(target.speciesId);
        const maxHp = target.maxHp ?? def?.baseHp ?? 100;
        const hp = target.hp ?? Math.round(maxHp * target.hpRatio);
        const species = target.speciesId as MonsterSpeciesId;
        const baseChance = computeCaptureChance(species, hp, maxHp);
        const chance = Math.min(0.95, Math.max(0.1, baseChance + orbBonus));
        const success = chance >= 0.5;
        if (success) {
            target.captured = true;
            this.capturedSpeciesIds.push(target.speciesId);
        }
        return { success, chance: Number(chance.toFixed(2)), speciesId: target.speciesId };
    }

    public getActiveSpawns(): WildMonsterInstance[] {
        return this.activeSpawns.map((item) => ({
            ...item,
            position: { ...item.position },
        }));
    }

    public getCapturedCount(): number {
        return Math.max(this.capturedSpeciesIds.length, this.capturedRoster.length);
    }

    public getActiveCompanionCount(): number {
        return this.syncedCompanions.length;
    }
}

export type BuildableCategory = 'utility' | 'defense' | 'sanctuary';

export interface BuildableRecipe {
    recipeId: string;
    name: string;
    nameKo?: string;
    category: BuildableCategory;
    layer?: 0 | 1 | 2;
    footprintCells: { x: number; z: number };
    heightMeters: number;
    elevationOffsetY?: number;
    crystalCost: number;
    cost?: Partial<SharedResourceInventory>;
    maxSlopeDeg: number;
    blocksMovement?: boolean;
    blocksCamera?: boolean;
    description: string;
}

export interface PlacedStructureRecord {
    structureId: string;
    recipeId: string;
    gridX: number;
    gridZ: number;
    layer?: 0 | 1 | 2;
    worldPos: { x: number; y: number; z: number };
    rotationYawDeg: number;
    ownerId: string;
    ownerName?: string;
}

const STARTER_BUILDABLES: BuildableRecipe[] = [
    {
        recipeId: 'camp_beacon',
        name: 'Sanctuary Beacon',
        category: 'utility',
        footprintCells: { x: 1, z: 1 },
        heightMeters: 2.6,
        crystalCost: 2,
        maxSlopeDeg: 22,
        description: 'Fast-travel anchor and party rally point for up to 3 explorers.',
    },
    {
        recipeId: 'timber_palisade',
        name: 'Timber Palisade',
        category: 'defense',
        footprintCells: { x: 2, z: 1 },
        heightMeters: 2.4,
        crystalCost: 1,
        maxSlopeDeg: 28,
        description: 'Snap-aligned wooden barrier wall for base perimeter crafting.',
    },
    {
        recipeId: 'aether_pylon',
        name: 'Aether Storage Pylon',
        category: 'sanctuary',
        footprintCells: { x: 1, z: 1 },
        heightMeters: 3.2,
        crystalCost: 3,
        maxSlopeDeg: 18,
        description: 'Harmonizes captured monsters and powers nearby base stations.',
    },
];

export class BuildPlacementSystemStub {
    public readonly gridSizeMeters = BUILD_GRID_SIZE_METERS;
    private readonly recipes = new Map<string, BuildableRecipe>();
    private readonly placedStructures = new Map<string, PlacedStructureRecord>();

    constructor() {
        for (const recipe of STARTER_BUILDABLES) {
            this.registerRecipe({ ...recipe, layer: 1 });
        }
        for (const mod of MODULAR_STRUCTURE_RECIPE_LIST) {
            const category: BuildableCategory =
                mod.recipeId === 'wood_wall'
                    ? 'defense'
                    : mod.recipeId === 'workbench' ||
                        mod.recipeId === 'storage_chest' ||
                        mod.recipeId === 'straw_bed'
                      ? 'utility'
                      : 'sanctuary';
            this.registerRecipe({
                recipeId: mod.recipeId,
                name: mod.name,
                nameKo: mod.nameKo,
                category,
                layer: mod.layer,
                footprintCells: {
                    x: Math.max(1, Math.round(mod.footprintMeters.x / this.gridSizeMeters)),
                    z: Math.max(1, Math.round(mod.footprintMeters.z / this.gridSizeMeters)),
                },
                heightMeters: mod.heightMeters,
                elevationOffsetY: mod.elevationOffsetY,
                crystalCost: mod.cost.aether_shard ?? 0,
                cost: { ...mod.cost },
                maxSlopeDeg: mod.maxSlopeDeg,
                blocksMovement: mod.blocksMovement,
                blocksCamera: mod.blocksCamera,
                description: mod.description,
            });
        }
    }

    public registerRecipe(recipe: BuildableRecipe): void {
        this.recipes.set(recipe.recipeId, {
            ...recipe,
            footprintCells: { ...recipe.footprintCells },
            cost: recipe.cost ? { ...recipe.cost } : undefined,
        });
    }

    public getRecipes(): BuildableRecipe[] {
        return Array.from(this.recipes.values());
    }

    public getModularRecipes(): ReadonlyArray<ModularStructureRecipeDef> {
        return MODULAR_STRUCTURE_RECIPE_LIST;
    }

    public getModularRecipe(recipeId: string): ModularStructureRecipeDef | undefined {
        return (MODULAR_STRUCTURE_RECIPES as Record<string, ModularStructureRecipeDef | undefined>)[
            recipeId
        ];
    }

    public snapToGrid(worldX: number, worldZ: number): {
        gridX: number;
        gridZ: number;
        snappedX: number;
        snappedZ: number;
    } {
        const gridX = Math.round(worldX / this.gridSizeMeters);
        const gridZ = Math.round(worldZ / this.gridSizeMeters);
        return {
            gridX,
            gridZ,
            snappedX: gridX * this.gridSizeMeters,
            snappedZ: gridZ * this.gridSizeMeters,
        };
    }

    public canPlaceAt(
        recipeId: string,
        worldX: number,
        worldZ: number,
        collisionWorld?: Pick<ICollisionWorld, 'getTerrainHeight' | 'getTerrainNormal' | 'getWaterLevel'>,
        layerOverride?: 0 | 1 | 2
    ): { valid: boolean; reason: string | null; snappedY: number } {
        const recipe = this.recipes.get(recipeId);
        if (!recipe) {
            return { valid: false, reason: 'Unknown recipe', snappedY: 0 };
        }
        const snapped = this.snapToGrid(worldX, worldZ);
        const layer = layerOverride ?? recipe.layer ?? 1;
        const cellKey = `${snapped.gridX}:${snapped.gridZ}:${layer}`;
        if (this.placedStructures.has(cellKey)) {
            return { valid: false, reason: 'Grid cell occupied', snappedY: 0 };
        }
        if (!collisionWorld) {
            const foundation = this.placedStructures.get(`${snapped.gridX}:${snapped.gridZ}:0`);
            const baseOffset =
                layer === 1 && foundation
                    ? foundation.worldPos.y + (recipe.elevationOffsetY ?? 0.35)
                    : layer === 2
                      ? (foundation ? foundation.worldPos.y : 0) + (recipe.elevationOffsetY ?? 2.95)
                      : 0;
            return { valid: true, reason: null, snappedY: baseOffset };
        }
        const groundY = collisionWorld.getTerrainHeight(snapped.snappedX, snapped.snappedZ);
        if (groundY < collisionWorld.getWaterLevel() + 0.15) {
            return { valid: false, reason: 'Cannot build underwater', snappedY: groundY };
        }
        const normal = collisionWorld.getTerrainNormal(snapped.snappedX, snapped.snappedZ, new pc.Vec3());
        const slopeDeg = (Math.acos(Math.min(1, Math.max(-1, normal.y))) * 180) / Math.PI;
        if (slopeDeg > recipe.maxSlopeDeg) {
            return { valid: false, reason: 'Terrain too steep', snappedY: groundY };
        }
        const foundation = this.placedStructures.get(`${snapped.gridX}:${snapped.gridZ}:0`);
        let snappedY = groundY;
        if (layer === 1 && foundation) {
            snappedY = foundation.worldPos.y + (recipe.elevationOffsetY ?? 0.35);
        } else if (layer === 2) {
            snappedY = (foundation ? foundation.worldPos.y : groundY) + (recipe.elevationOffsetY ?? 2.95);
        }
        return { valid: true, reason: null, snappedY };
    }

    public placeStructure(
        recipeId: string,
        worldX: number,
        worldZ: number,
        rotationYawDeg = 0,
        ownerId = 'local-explorer-1',
        collisionWorld?: Pick<ICollisionWorld, 'getTerrainHeight' | 'getTerrainNormal' | 'getWaterLevel'>,
        layerOverride?: 0 | 1 | 2
    ): PlacedStructureRecord | null {
        const recipe = this.recipes.get(recipeId);
        if (!recipe) {
            return null;
        }
        const layer = layerOverride ?? recipe.layer ?? 1;
        const check = this.canPlaceAt(recipeId, worldX, worldZ, collisionWorld, layer);
        if (!check.valid) {
            return null;
        }
        const snapped = this.snapToGrid(worldX, worldZ);
        const cellKey = `${snapped.gridX}:${snapped.gridZ}:${layer}`;
        const record: PlacedStructureRecord = {
            structureId: `struct-${snapped.gridX}_${snapped.gridZ}_${layer}-${Date.now()}`,
            recipeId,
            gridX: snapped.gridX,
            gridZ: snapped.gridZ,
            layer,
            worldPos: {
                x: snapped.snappedX,
                y: check.snappedY,
                z: snapped.snappedZ,
            },
            rotationYawDeg,
            ownerId,
        };
        this.placedStructures.set(cellKey, record);
        return record;
    }

    public removeStructure(structureIdOrCellKey: string): boolean {
        if (this.placedStructures.delete(structureIdOrCellKey)) {
            return true;
        }
        for (const [key, rec] of this.placedStructures.entries()) {
            if (rec.structureId === structureIdOrCellKey) {
                this.placedStructures.delete(key);
                return true;
            }
        }
        return false;
    }

    public syncFromNetwork(structures: ReadonlyArray<PlacedStructureSyncState>): void {
        this.placedStructures.clear();
        for (const s of structures) {
            const cellKey = `${s.gridX}:${s.gridZ}:${s.layer}`;
            this.placedStructures.set(cellKey, {
                structureId: s.id,
                recipeId: s.recipeId,
                gridX: s.gridX,
                gridZ: s.gridZ,
                layer: s.layer,
                worldPos: { x: s.x, y: s.y, z: s.z },
                rotationYawDeg: s.rotationYawDeg,
                ownerId: s.ownerPlayerId,
                ownerName: s.ownerName,
            });
        }
    }

    public getPlacedStructures(): PlacedStructureRecord[] {
        return Array.from(this.placedStructures.values());
    }
}

export interface ExpansionSummary {
    coop: {
        ready: boolean;
        maxPartyPlayers: number;
        status: CoopSessionStatus;
    };
    monsters: {
        ready: boolean;
        speciesCount: number;
        species: MonsterSpeciesDef[];
        activeSpawns: number;
        capturedCount: number;
        companionsActive: number;
        rosterCount: number;
    };
    building: {
        ready: boolean;
        gridSizeMeters: number;
        recipeCount: number;
        recipes: BuildableRecipe[];
        placedCount: number;
    };
}

export class ExpansionHooks {
    public readonly coop: MultiplayerClient;
    public readonly monsters: WildMonsterSpawnerStub;
    public readonly building: BuildPlacementSystemStub;

    constructor(localPlayerId = 'local-explorer-1') {
        this.coop = new MultiplayerClient(localPlayerId);
        this.monsters = new WildMonsterSpawnerStub();
        this.building = new BuildPlacementSystemStub();

        this.coop.onSnapshot((status) => {
            if (status.state === 'connected') {
                this.monsters.syncFromNetwork(
                    status.monsters ?? [],
                    status.companions ?? [],
                    status.capturedRoster
                );
                if (status.structures) {
                    this.building.syncFromNetwork(status.structures);
                }
            }
        });
    }

    public getStatus(): ExpansionSummary {
        const coopStatus = this.coop.getStatus();
        return {
            coop: {
                ready: true,
                maxPartyPlayers: MAX_PARTY_PLAYERS,
                status: coopStatus,
            },
            monsters: {
                ready: true,
                speciesCount: this.monsters.getRegisteredSpecies().length,
                species: this.monsters.getRegisteredSpecies(),
                activeSpawns: this.monsters.getActiveSpawns().length,
                capturedCount: this.monsters.getCapturedCount(),
                companionsActive: (coopStatus.companions?.length ?? 0) || this.monsters.getActiveCompanionCount(),
                rosterCount: (coopStatus.capturedRoster?.length ?? 0) || this.monsters.getCapturedRoster().length,
            },
            building: {
                ready: true,
                gridSizeMeters: this.building.gridSizeMeters,
                recipeCount: this.building.getRecipes().length,
                recipes: this.building.getRecipes(),
                placedCount: this.building.getPlacedStructures().length,
            },
        };
    }
}
