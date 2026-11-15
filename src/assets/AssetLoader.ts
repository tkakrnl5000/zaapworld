import * as pc from 'playcanvas';
import type {
    IAssetLoader,
    LoadedModelBundle,
    ModelAssetKey,
} from '../types/interfaces';

interface ModelSpec {
    key: ModelAssetKey;
    url: string;
    label: string;
    castShadows: boolean;
    receiveShadows: boolean;
}

export const MODEL_SPECS: readonly ModelSpec[] = [
    {
        key: 'player_explorer',
        url: '/models/player_explorer.glb',
        label: 'Explorer Character',
        castShadows: true,
        receiveShadows: true,
    },
    {
        key: 'tree_canopy',
        url: '/models/tree_canopy.glb',
        label: 'Broadleaf Canopy Tree',
        castShadows: true,
        receiveShadows: true,
    },
    {
        key: 'tree_pine',
        url: '/models/tree_pine.glb',
        label: 'Highland Pine Tree',
        castShadows: true,
        receiveShadows: true,
    },
    {
        key: 'rock_cluster',
        url: '/models/rock_cluster.glb',
        label: 'Mossy Boulder Cluster',
        castShadows: true,
        receiveShadows: true,
    },
    {
        key: 'ancient_ruin',
        url: '/models/ancient_ruin.glb',
        label: 'Ancient Ruin Sanctuary',
        castShadows: true,
        receiveShadows: true,
    },
    {
        key: 'vital_crystal',
        url: '/models/vital_crystal.glb',
        label: 'Vital Aether Crystal',
        castShadows: false,
        receiveShadows: true,
    },
    {
        key: 'bush_flower',
        url: '/models/bush_flower.glb',
        label: 'Flowering Meadow Shrub',
        castShadows: false,
        receiveShadows: true,
    },
    {
        key: 'monster_moss_hopper',
        url: '/models/monster_moss_hopper.glb',
        label: 'Moss Hopper',
        castShadows: true,
        receiveShadows: true,
    },
    {
        key: 'monster_aether_wisp',
        url: '/models/monster_aether_wisp.glb',
        label: 'Aether Wisp',
        castShadows: true,
        receiveShadows: true,
    },
    {
        key: 'monster_shale_golem',
        url: '/models/monster_shale_golem.glb',
        label: 'Shale Golem',
        castShadows: true,
        receiveShadows: true,
    },
    {
        key: 'build_workbench',
        url: '/models/build_workbench.glb',
        label: 'Crafting Workbench',
        castShadows: true,
        receiveShadows: true,
    },
    {
        key: 'build_chest',
        url: '/models/build_chest.glb',
        label: 'Storage Chest',
        castShadows: true,
        receiveShadows: true,
    },
    {
        key: 'build_bed',
        url: '/models/build_bed.glb',
        label: 'Frontier Straw Bed',
        castShadows: true,
        receiveShadows: true,
    },
] as const;

type PrimitiveType = 'box' | 'capsule' | 'cone' | 'cylinder' | 'sphere';

export class AssetLoader implements IAssetLoader {
    private readonly bundles = new Map<ModelAssetKey, LoadedModelBundle>();
    private readonly fallbackMaterials = new Map<string, pc.StandardMaterial>();

    public async loadAll(
        app: pc.Application,
        onProgress?: (loaded: number, total: number, label: string) => void
    ): Promise<Record<ModelAssetKey, LoadedModelBundle>> {
        const total = MODEL_SPECS.length;
        let loaded = 0;

        onProgress?.(0, total, 'Preparing 3D assets...');

        const loadPromises = MODEL_SPECS.map(async (spec) => {
            const containerAsset = await this.loadGlbContainer(app, spec.url);
            const bundle = this.createBundle(spec, containerAsset);
            this.bundles.set(spec.key, bundle);
            loaded += 1;
            onProgress?.(loaded, total, spec.label);
        });

        await Promise.all(loadPromises);

        return this.buildRecord();
    }

    public getBundle(key: ModelAssetKey): LoadedModelBundle {
        const existing = this.bundles.get(key);
        if (existing) {
            return existing;
        }
        const spec = MODEL_SPECS.find((s) => s.key === key) ?? MODEL_SPECS[0];
        const fallbackBundle = this.createBundle(spec, null);
        this.bundles.set(key, fallbackBundle);
        return fallbackBundle;
    }

    private buildRecord(): Record<ModelAssetKey, LoadedModelBundle> {
        const record = {} as Record<ModelAssetKey, LoadedModelBundle>;
        for (const spec of MODEL_SPECS) {
            record[spec.key] = this.getBundle(spec.key);
        }
        return record;
    }

    private loadGlbContainer(
        app: pc.Application,
        url: string
    ): Promise<pc.Asset | null> {
        return new Promise((resolve) => {
            try {
                app.assets.loadFromUrl(url, 'container', (err, asset) => {
                    if (err || !asset || !asset.resource) {
                        console.warn(
                            `[AssetLoader] Failed to load "${url}", using procedural fallback.`,
                            err ?? 'missing resource'
                        );
                        resolve(null);
                        return;
                    }
                    resolve(asset);
                });
            } catch (error) {
                console.warn(
                    `[AssetLoader] Exception loading "${url}", using procedural fallback.`,
                    error
                );
                resolve(null);
            }
        });
    }

    private createBundle(
        spec: ModelSpec,
        containerAsset: pc.Asset | null
    ): LoadedModelBundle {
        return {
            key: spec.key,
            containerAsset,
            instantiate: (name?: string): pc.Entity => {
                const instanceName = name ?? spec.key;
                const resource = containerAsset?.resource as
                    | pc.ContainerResource
                    | undefined;

                if (resource && typeof resource.instantiateRenderEntity === 'function') {
                    try {
                        const entity = resource.instantiateRenderEntity({
                            castShadows: spec.castShadows,
                            receiveShadows: spec.receiveShadows,
                        });
                        entity.name = instanceName;
                        return entity;
                    } catch (error) {
                        console.warn(
                            `[AssetLoader] instantiateRenderEntity failed for "${spec.key}", falling back.`,
                            error
                        );
                    }
                }

                return this.createProceduralFallback(
                    spec.key,
                    instanceName,
                    spec.castShadows,
                    spec.receiveShadows
                );
            },
        };
    }

    private getMaterial(
        key: string,
        diffuse: [number, number, number],
        options?: {
            gloss?: number;
            metalness?: number;
            emissive?: [number, number, number];
            emissiveIntensity?: number;
        }
    ): pc.StandardMaterial {
        const cached = this.fallbackMaterials.get(key);
        if (cached) {
            return cached;
        }
        const mat = new pc.StandardMaterial();
        mat.diffuse = new pc.Color(diffuse[0], diffuse[1], diffuse[2]);
        mat.gloss = options?.gloss ?? 0.35;
        mat.metalness = options?.metalness ?? 0.0;
        mat.useMetalness = true;
        if (options?.emissive) {
            mat.emissive = new pc.Color(
                options.emissive[0],
                options.emissive[1],
                options.emissive[2]
            );
            mat.emissiveIntensity = options.emissiveIntensity ?? 1.8;
        }
        mat.update();
        this.fallbackMaterials.set(key, mat);
        return mat;
    }

    private addPart(
        parent: pc.Entity,
        name: string,
        type: PrimitiveType,
        localPos: [number, number, number],
        localScale: [number, number, number],
        material: pc.StandardMaterial,
        castShadows: boolean,
        receiveShadows: boolean,
        localEuler?: [number, number, number]
    ): pc.Entity {
        const part = new pc.Entity(name);
        part.setLocalPosition(localPos[0], localPos[1], localPos[2]);
        if (localEuler) {
            part.setLocalEulerAngles(localEuler[0], localEuler[1], localEuler[2]);
        }
        const visual = new pc.Entity(`${name}_Visual`);
        visual.setLocalScale(localScale[0], localScale[1], localScale[2]);
        visual.addComponent('render', {
            type,
            material,
            castShadows,
            receiveShadows,
        });
        part.addChild(visual);
        parent.addChild(part);
        return part;
    }

    private addOffsetMesh(
        pivot: pc.Entity,
        meshName: string,
        type: PrimitiveType,
        offsetPos: [number, number, number],
        scale: [number, number, number],
        material: pc.StandardMaterial,
        castShadows: boolean,
        receiveShadows: boolean,
        localEuler?: [number, number, number]
    ): void {
        const mesh = new pc.Entity(meshName);
        mesh.setLocalPosition(offsetPos[0], offsetPos[1], offsetPos[2]);
        if (localEuler) {
            mesh.setLocalEulerAngles(localEuler[0], localEuler[1], localEuler[2]);
        }
        mesh.setLocalScale(scale[0], scale[1], scale[2]);
        mesh.addComponent('render', {
            type,
            material,
            castShadows,
            receiveShadows,
        });
        pivot.addChild(mesh);
    }

    private createProceduralFallback(
        key: ModelAssetKey,
        name: string,
        castShadows: boolean,
        receiveShadows: boolean
    ): pc.Entity {
        const entity = new pc.Entity(name);

        switch (key) {
            case 'player_explorer':
                this.buildFallbackPlayer(entity, castShadows, receiveShadows);
                break;
            case 'tree_canopy':
                this.buildFallbackCanopyTree(entity, castShadows, receiveShadows);
                break;
            case 'tree_pine':
                this.buildFallbackPineTree(entity, castShadows, receiveShadows);
                break;
            case 'rock_cluster':
                this.buildFallbackRockCluster(entity, castShadows, receiveShadows);
                break;
            case 'ancient_ruin':
                this.buildFallbackAncientRuin(entity, castShadows, receiveShadows);
                break;
            case 'vital_crystal':
                this.buildFallbackVitalCrystal(entity, castShadows, receiveShadows);
                break;
            case 'bush_flower':
                this.buildFallbackBushFlower(entity, castShadows, receiveShadows);
                break;
            case 'monster_moss_hopper':
                this.buildFallbackMossHopper(entity, castShadows, receiveShadows);
                break;
            case 'monster_aether_wisp':
                this.buildFallbackAetherWisp(entity, castShadows, receiveShadows);
                break;
            case 'monster_shale_golem':
                this.buildFallbackShaleGolem(entity, castShadows, receiveShadows);
                break;
            case 'build_workbench':
                this.buildFallbackWorkbench(entity, castShadows, receiveShadows);
                break;
            case 'build_chest':
                this.buildFallbackChest(entity, castShadows, receiveShadows);
                break;
            case 'build_bed':
                this.buildFallbackBed(entity, castShadows, receiveShadows);
                break;
        }

        return entity;
    }

    private buildFallbackPlayer(
        container: pc.Entity,
        castShadows: boolean,
        receiveShadows: boolean
    ): void {
        const tunic = this.getMaterial('fb_tunic', [0.14, 0.48, 0.92]);
        const teal = this.getMaterial('fb_teal', [0.08, 0.72, 0.7]);
        const leather = this.getMaterial('fb_leather', [0.42, 0.22, 0.11]);
        const gold = this.getMaterial('fb_gold', [0.96, 0.75, 0.18], {
            gloss: 0.75,
            metalness: 0.85,
        });
        const skin = this.getMaterial('fb_skin', [0.96, 0.75, 0.62]);
        const hair = this.getMaterial('fb_hair', [0.14, 0.21, 0.42]);
        const capeMat = this.getMaterial('fb_cape', [0.92, 0.26, 0.24]);
        const aether = this.getMaterial('fb_aether', [0.16, 0.96, 1.0], {
            gloss: 0.9,
            emissive: [0.15, 0.94, 1.0],
            emissiveIntensity: 2.8,
        });

        const root = new pc.Entity('Root');
        container.addChild(root);

        const hips = new pc.Entity('Hips');
        hips.setLocalPosition(0, 0.9, 0);
        root.addChild(hips);
        this.addOffsetMesh(hips, 'Hips_Geo', 'box', [0, 0, 0], [0.3, 0.16, 0.22], tunic, castShadows, receiveShadows);
        this.addOffsetMesh(hips, 'Belt_Geo', 'box', [0, 0.04, 0], [0.32, 0.06, 0.24], leather, castShadows, receiveShadows);

        const torso = new pc.Entity('Torso');
        torso.setLocalPosition(0, 0.07, 0);
        hips.addChild(torso);
        this.addOffsetMesh(torso, 'Torso_Geo', 'box', [0, 0.21, 0], [0.36, 0.42, 0.24], tunic, castShadows, receiveShadows);
        this.addOffsetMesh(torso, 'Bib_Geo', 'box', [0, 0.29, 0.12], [0.22, 0.16, 0.04], teal, castShadows, receiveShadows);

        const head = new pc.Entity('Head');
        head.setLocalPosition(0, 0.45, 0);
        torso.addChild(head);
        this.addOffsetMesh(head, 'Head_Geo', 'sphere', [0, 0.14, 0], [0.25, 0.26, 0.24], skin, castShadows, receiveShadows);
        this.addOffsetMesh(head, 'Hair_Geo', 'sphere', [0, 0.19, -0.02], [0.28, 0.22, 0.26], hair, castShadows, receiveShadows);

        const backpack = new pc.Entity('Backpack');
        backpack.setLocalPosition(0, 0.23, -0.15);
        torso.addChild(backpack);
        this.addOffsetMesh(backpack, 'Pack_Geo', 'box', [0, 0, -0.04], [0.24, 0.26, 0.14], leather, castShadows, receiveShadows);
        this.addOffsetMesh(backpack, 'Core_Geo', 'sphere', [0, 0, -0.12], [0.11, 0.11, 0.06], aether, false, receiveShadows);

        const cape = new pc.Entity('Cape');
        cape.setLocalPosition(0, 0.37, -0.08);
        torso.addChild(cape);
        this.addOffsetMesh(cape, 'Cape_Geo', 'box', [0, -0.25, -0.16], [0.36, 0.48, 0.03], capeMat, castShadows, receiveShadows);
        this.addOffsetMesh(cape, 'CapeTrim_Geo', 'box', [0, -0.49, -0.16], [0.36, 0.06, 0.03], gold, castShadows, receiveShadows);

        for (const [label, sx] of [
            ['L', 1],
            ['R', -1],
        ] as const) {
            const arm = new pc.Entity(`Arm_${label}`);
            arm.setLocalPosition(sx * 0.215, 0.355, 0);
            torso.addChild(arm);
            this.addOffsetMesh(arm, `Arm_${label}_Geo`, 'cylinder', [sx * 0.015, -0.125, 0], [0.1, 0.25, 0.1], tunic, castShadows, receiveShadows);

            const forearm = new pc.Entity(`ForeArm_${label}`);
            forearm.setLocalPosition(sx * 0.032, -0.255, 0);
            arm.addChild(forearm);
            this.addOffsetMesh(forearm, `ForeArm_${label}_Geo`, 'cylinder', [0, -0.11, 0], [0.085, 0.22, 0.085], leather, castShadows, receiveShadows);

            const leg = new pc.Entity(`Leg_${label}`);
            leg.setLocalPosition(sx * 0.105, -0.04, 0);
            hips.addChild(leg);
            this.addOffsetMesh(leg, `Leg_${label}_Geo`, 'cylinder', [0, -0.21, 0], [0.13, 0.42, 0.13], tunic, castShadows, receiveShadows);

            const shin = new pc.Entity(`Shin_${label}`);
            shin.setLocalPosition(0, -0.42, 0);
            leg.addChild(shin);
            this.addOffsetMesh(shin, `Shin_${label}_Geo`, 'cylinder', [0, -0.19, 0], [0.11, 0.38, 0.11], leather, castShadows, receiveShadows);
            this.addOffsetMesh(shin, `Boot_${label}_Geo`, 'box', [0, -0.40, 0.04], [0.11, 0.08, 0.20], leather, castShadows, receiveShadows);
        }
    }

    private buildFallbackCanopyTree(
        root: pc.Entity,
        castShadows: boolean,
        receiveShadows: boolean
    ): void {
        const bark = this.getMaterial('fb_bark', [0.38, 0.22, 0.13]);
        const leaf1 = this.getMaterial('fb_leaf_deep', [0.09, 0.48, 0.2]);
        const leaf2 = this.getMaterial('fb_leaf_sun', [0.28, 0.75, 0.26]);

        this.addPart(root, 'Trunk', 'cylinder', [0, 2.1, 0], [0.52, 4.2, 0.52], bark, castShadows, receiveShadows);
        this.addPart(root, 'CrownTop', 'sphere', [0, 5.2, 0], [3.3, 2.4, 3.2], leaf2, castShadows, receiveShadows);
        this.addPart(root, 'CrownLeft', 'sphere', [1.1, 4.4, 0.5], [2.4, 2.0, 2.3], leaf1, castShadows, receiveShadows);
        this.addPart(root, 'CrownRight', 'sphere', [-1.1, 4.5, -0.4], [2.4, 2.0, 2.3], leaf1, castShadows, receiveShadows);
    }

    private buildFallbackPineTree(
        root: pc.Entity,
        castShadows: boolean,
        receiveShadows: boolean
    ): void {
        const cedar = this.getMaterial('fb_cedar', [0.44, 0.22, 0.11]);
        const pine = this.getMaterial('fb_pine', [0.1, 0.5, 0.26]);
        const pineTop = this.getMaterial('fb_pine_top', [0.2, 0.68, 0.3]);

        this.addPart(root, 'Trunk', 'cylinder', [0, 2.2, 0], [0.42, 4.4, 0.42], cedar, castShadows, receiveShadows);
        this.addPart(root, 'Tier1', 'cone', [0, 2.5, 0], [3.4, 2.0, 3.4], pine, castShadows, receiveShadows);
        this.addPart(root, 'Tier2', 'cone', [0, 4.1, 0], [2.6, 1.9, 2.6], pine, castShadows, receiveShadows);
        this.addPart(root, 'Tier3', 'cone', [0, 5.7, 0], [1.7, 2.0, 1.7], pineTop, castShadows, receiveShadows);
    }

    private buildFallbackRockCluster(
        root: pc.Entity,
        castShadows: boolean,
        receiveShadows: boolean
    ): void {
        const slate = this.getMaterial('fb_slate', [0.3, 0.39, 0.49]);
        const moss = this.getMaterial('fb_moss', [0.2, 0.72, 0.24]);

        this.addPart(root, 'BoulderMain', 'sphere', [-0.15, 0.65, 0], [1.7, 1.4, 1.5], slate, castShadows, receiveShadows);
        this.addPart(root, 'BoulderSide', 'sphere', [0.8, 0.45, 0.1], [1.3, 1.0, 1.2], slate, castShadows, receiveShadows);
        this.addPart(root, 'MossCap', 'sphere', [-0.15, 1.32, 0], [1.1, 0.36, 0.95], moss, castShadows, receiveShadows);
    }

    private buildFallbackAncientRuin(
        root: pc.Entity,
        castShadows: boolean,
        receiveShadows: boolean
    ): void {
        const stone = this.getMaterial('fb_ruin_stone', [0.46, 0.5, 0.56]);
        const rune = this.getMaterial('fb_rune', [0.18, 0.96, 1.0], {
            gloss: 0.9,
            emissive: [0.14, 0.92, 1.0],
            emissiveIntensity: 2.8,
        });

        this.addPart(root, 'Dais', 'box', [0, 0.2, 0], [4.5, 0.4, 2.2], stone, castShadows, receiveShadows);
        this.addPart(root, 'PillarL', 'box', [-1.4, 2.2, 0], [0.7, 3.6, 0.7], stone, castShadows, receiveShadows);
        this.addPart(root, 'PillarR', 'box', [1.4, 2.2, 0], [0.7, 3.6, 0.7], stone, castShadows, receiveShadows);
        this.addPart(root, 'Lintel', 'box', [0, 4.25, 0], [4.3, 0.55, 0.9], stone, castShadows, receiveShadows);
        this.addPart(root, 'RuneCore', 'cone', [0, 5.0, 0], [0.45, 0.9, 0.45], rune, false, receiveShadows);
    }

    private buildFallbackVitalCrystal(
        root: pc.Entity,
        castShadows: boolean,
        receiveShadows: boolean
    ): void {
        const stone = this.getMaterial('fb_pedestal', [0.34, 0.4, 0.48]);
        const crystal = this.getMaterial('fb_vital_crystal', [0.2, 0.96, 0.95], {
            gloss: 0.92,
            emissive: [0.16, 0.92, 0.98],
            emissiveIntensity: 3.0,
        });

        this.addPart(root, 'Pedestal', 'cylinder', [0, 0.11, 0], [0.95, 0.22, 0.95], stone, castShadows, receiveShadows);
        this.addPart(root, 'MainShard', 'cone', [0, 0.88, 0], [0.36, 1.4, 0.36], crystal, castShadows, receiveShadows);
        this.addPart(root, 'SideShardL', 'cone', [0.22, 0.58, 0.1], [0.24, 0.85, 0.24], crystal, castShadows, receiveShadows, [0, 0, -18]);
        this.addPart(root, 'SideShardR', 'cone', [-0.2, 0.54, -0.1], [0.22, 0.78, 0.22], crystal, castShadows, receiveShadows, [0, 0, 18]);
    }

    private buildFallbackBushFlower(
        root: pc.Entity,
        castShadows: boolean,
        receiveShadows: boolean
    ): void {
        const leaf = this.getMaterial('fb_bush_leaf', [0.18, 0.68, 0.26]);
        const coral = this.getMaterial('fb_coral', [0.98, 0.34, 0.32]);
        const gold = this.getMaterial('fb_flower_gold', [1.0, 0.84, 0.16]);

        this.addPart(root, 'BushMain', 'sphere', [0, 0.35, 0], [0.9, 0.7, 0.85], leaf, castShadows, receiveShadows);
        this.addPart(root, 'Blossom1', 'sphere', [0.2, 0.62, 0.2], [0.16, 0.12, 0.16], coral, false, receiveShadows);
        this.addPart(root, 'Blossom2', 'sphere', [-0.24, 0.55, -0.15], [0.16, 0.12, 0.16], gold, false, receiveShadows);
    }

    private buildFallbackMossHopper(
        container: pc.Entity,
        castShadows: boolean,
        receiveShadows: boolean
    ): void {
        const emerald = this.getMaterial('fb_mh_emerald', [0.14, 0.66, 0.28]);
        const forest = this.getMaterial('fb_mh_forest', [0.07, 0.42, 0.19]);
        const lime = this.getMaterial('fb_mh_lime', [0.44, 0.88, 0.28]);
        const cream = this.getMaterial('fb_mh_cream', [0.96, 0.91, 0.74]);
        const amberEye = this.getMaterial('fb_mh_eye', [1.0, 0.56, 0.05], {
            gloss: 0.85,
            emissive: [1.0, 0.46, 0.04],
            emissiveIntensity: 1.8,
        });

        const root = new pc.Entity('MossHopper_Root');
        container.addChild(root);

        const body = new pc.Entity('Body');
        body.setLocalPosition(0, 0.30, 0);
        root.addChild(body);
        this.addOffsetMesh(body, 'Body_Geo', 'sphere', [0, 0, 0], [0.39, 0.37, 0.44], emerald, castShadows, receiveShadows);
        this.addOffsetMesh(body, 'Belly_Geo', 'sphere', [0, -0.01, 0.11], [0.29, 0.28, 0.24], cream, castShadows, receiveShadows);

        const head = new pc.Entity('Head');
        head.setLocalPosition(0, 0.195, 0.075);
        body.addChild(head);
        this.addOffsetMesh(head, 'Head_Geo', 'sphere', [0, 0.03, 0], [0.41, 0.34, 0.37], emerald, castShadows, receiveShadows);
        this.addOffsetMesh(head, 'Muzzle_Geo', 'sphere', [0, -0.025, 0.11], [0.28, 0.17, 0.19], cream, castShadows, receiveShadows);
        this.addOffsetMesh(head, 'Eye_L_Geo', 'sphere', [0.088, 0.052, 0.155], [0.06, 0.07, 0.04], amberEye, false, receiveShadows);
        this.addOffsetMesh(head, 'Eye_R_Geo', 'sphere', [-0.088, 0.052, 0.155], [0.06, 0.07, 0.04], amberEye, false, receiveShadows);

        for (const [label, sx] of [['L', 1], ['R', -1]] as const) {
            const ear = new pc.Entity(`Ear_${label}`);
            ear.setLocalPosition(sx * 0.10, 0.14, -0.015);
            head.addChild(ear);
            this.addOffsetMesh(ear, `Ear_${label}_Geo`, 'cone', [sx * 0.05, 0.12, -0.02], [0.13, 0.26, 0.05], lime, castShadows, receiveShadows, [0, 0, sx * -20]);

            const arm = new pc.Entity(`Arm_${label}`);
            arm.setLocalPosition(sx * 0.158, 0.025, 0.10);
            body.addChild(arm);
            this.addOffsetMesh(arm, `Arm_${label}_Geo`, 'capsule', [sx * 0.02, -0.05, 0.05], [0.08, 0.12, 0.08], emerald, castShadows, receiveShadows);
            this.addOffsetMesh(arm, `Paw_${label}_Geo`, 'sphere', [sx * 0.03, -0.10, 0.10], [0.08, 0.07, 0.08], cream, castShadows, receiveShadows);

            const leg = new pc.Entity(`Leg_${label}`);
            leg.setLocalPosition(sx * 0.155, -0.085, -0.035);
            body.addChild(leg);
            this.addOffsetMesh(leg, `Thigh_${label}_Geo`, 'sphere', [sx * 0.025, -0.035, -0.015], [0.17, 0.18, 0.23], forest, castShadows, receiveShadows);

            const foot = new pc.Entity(`Foot_${label}`);
            foot.setLocalPosition(sx * 0.018, -0.075, -0.055);
            leg.addChild(foot);
            this.addOffsetMesh(foot, `Foot_${label}_Geo`, 'sphere', [sx * 0.008, -0.115, 0.065], [0.14, 0.09, 0.28], emerald, castShadows, receiveShadows);
        }

        const tail = new pc.Entity('Tail');
        tail.setLocalPosition(0, -0.015, -0.195);
        body.addChild(tail);
        this.addOffsetMesh(tail, 'TailLeaf_Geo', 'cone', [0, 0.06, -0.09], [0.14, 0.22, 0.05], lime, castShadows, receiveShadows, [-55, 0, 0]);
        this.addOffsetMesh(tail, 'TailBud_Geo', 'sphere', [0, 0.04, -0.05], [0.08, 0.08, 0.08], amberEye, false, receiveShadows);
    }

    private buildFallbackAetherWisp(
        container: pc.Entity,
        castShadows: boolean,
        receiveShadows: boolean
    ): void {
        const sky = this.getMaterial('fb_aw_sky', [0.20, 0.82, 0.98]);
        const pearl = this.getMaterial('fb_aw_pearl', [0.78, 0.95, 1.0]);
        const lavender = this.getMaterial('fb_aw_lavender', [0.52, 0.36, 0.94]);
        const gold = this.getMaterial('fb_aw_gold', [0.96, 0.78, 0.24], {
            gloss: 0.78,
            metalness: 0.8,
        });
        const cyanGlow = this.getMaterial('fb_aw_cyan_glow', [0.14, 0.94, 1.0], {
            gloss: 0.9,
            emissive: [0.12, 0.90, 1.0],
            emissiveIntensity: 2.2,
        });
        const goldGlow = this.getMaterial('fb_aw_gold_glow', [1.0, 0.68, 0.10], {
            gloss: 0.85,
            emissive: [1.0, 0.56, 0.06],
            emissiveIntensity: 1.9,
        });

        const root = new pc.Entity('AetherWisp_Root');
        container.addChild(root);

        const body = new pc.Entity('Body');
        body.setLocalPosition(0, 0.60, 0);
        root.addChild(body);
        this.addOffsetMesh(body, 'Body_Geo', 'capsule', [0, 0, 0], [0.31, 0.38, 0.28], sky, castShadows, receiveShadows);
        this.addOffsetMesh(body, 'Skirt_Geo', 'cone', [0, -0.09, 0], [0.32, 0.24, 0.28], lavender, castShadows, receiveShadows, [180, 0, 0]);
        this.addOffsetMesh(body, 'CoreGem_Geo', 'sphere', [0, 0.06, 0.145], [0.09, 0.11, 0.05], cyanGlow, false, receiveShadows);

        const head = new pc.Entity('Head');
        head.setLocalPosition(0, 0.21, 0.01);
        body.addChild(head);
        this.addOffsetMesh(head, 'Head_Geo', 'sphere', [0, 0.02, 0], [0.34, 0.31, 0.32], pearl, castShadows, receiveShadows);
        this.addOffsetMesh(head, 'Cowl_Geo', 'sphere', [0, 0.05, -0.03], [0.36, 0.29, 0.33], lavender, castShadows, receiveShadows);
        this.addOffsetMesh(head, 'Eye_L_Geo', 'sphere', [0.065, 0.016, 0.155], [0.055, 0.065, 0.035], goldGlow, false, receiveShadows);
        this.addOffsetMesh(head, 'Eye_R_Geo', 'sphere', [-0.065, 0.016, 0.155], [0.055, 0.065, 0.035], goldGlow, false, receiveShadows);

        const halo = new pc.Entity('Halo');
        halo.setLocalPosition(0, 0.24, -0.02);
        head.addChild(halo);
        this.addOffsetMesh(halo, 'HaloRing_Geo', 'cylinder', [0, 0, 0], [0.29, 0.03, 0.29], gold, castShadows, receiveShadows, [-14, 0, 0]);
        this.addOffsetMesh(halo, 'HaloShard_Geo', 'cone', [0, 0.08, 0], [0.05, 0.16, 0.05], cyanGlow, false, receiveShadows);

        for (const [label, sx] of [['L', 1], ['R', -1]] as const) {
            const fin = new pc.Entity(`EarFin_${label}`);
            fin.setLocalPosition(sx * 0.195, 0.045, -0.01);
            head.addChild(fin);
            this.addOffsetMesh(fin, `EarFin_${label}_Geo`, 'cone', [sx * 0.10, 0.09, -0.05], [0.08, 0.24, 0.03], cyanGlow, false, receiveShadows, [0, 0, sx * -48]);

            const arm = new pc.Entity(`Arm_${label}`);
            arm.setLocalPosition(sx * 0.20, 0.075, 0.03);
            body.addChild(arm);
            this.addOffsetMesh(arm, `Arm_${label}_Geo`, 'capsule', [sx * 0.02, -0.06, 0.08], [0.07, 0.14, 0.07], sky, castShadows, receiveShadows);
        }

        const ring = new pc.Entity('RunicRing');
        ring.setLocalPosition(0, 0.01, -0.01);
        body.addChild(ring);
        this.addOffsetMesh(ring, 'RunicRing_Geo', 'cylinder', [0, 0, 0], [0.78, 0.025, 0.78], gold, false, receiveShadows, [15, 0, -10]);
        this.addOffsetMesh(ring, 'RingNodeF_Geo', 'sphere', [0, 0, 0.39], [0.06, 0.09, 0.06], cyanGlow, false, receiveShadows);
        this.addOffsetMesh(ring, 'RingNodeB_Geo', 'sphere', [0, 0, -0.39], [0.06, 0.09, 0.06], goldGlow, false, receiveShadows);

        const tail = new pc.Entity('Tail');
        tail.setLocalPosition(0, -0.13, -0.04);
        body.addChild(tail);
        this.addOffsetMesh(tail, 'Tail_Geo', 'cone', [0, -0.06, -0.08], [0.16, 0.24, 0.16], lavender, castShadows, receiveShadows, [-125, 0, 0]);
        const tailTip = new pc.Entity('TailTip');
        tailTip.setLocalPosition(0, -0.12, -0.15);
        tail.addChild(tailTip);
        this.addOffsetMesh(tailTip, 'TailTip_Geo', 'cone', [0, -0.06, -0.10], [0.09, 0.22, 0.09], cyanGlow, false, receiveShadows, [-115, 0, 0]);
    }

    private buildFallbackShaleGolem(
        container: pc.Entity,
        castShadows: boolean,
        receiveShadows: boolean
    ): void {
        const basalt = this.getMaterial('fb_sg_basalt', [0.20, 0.22, 0.27]);
        const terracotta = this.getMaterial('fb_sg_terracotta', [0.78, 0.36, 0.20]);
        const moss = this.getMaterial('fb_sg_moss', [0.18, 0.66, 0.24]);
        const amberRune = this.getMaterial('fb_sg_amber', [1.0, 0.46, 0.04], {
            gloss: 0.85,
            emissive: [1.0, 0.42, 0.02],
            emissiveIntensity: 2.0,
        });

        const root = new pc.Entity('ShaleGolem_Root');
        container.addChild(root);

        const pelvis = new pc.Entity('Pelvis');
        pelvis.setLocalPosition(0, 0.54, 0);
        root.addChild(pelvis);
        this.addOffsetMesh(pelvis, 'Pelvis_Geo', 'box', [0, 0, 0], [0.58, 0.26, 0.42], basalt, castShadows, receiveShadows);
        this.addOffsetMesh(pelvis, 'Apron_Geo', 'box', [0, -0.02, 0.17], [0.30, 0.24, 0.12], terracotta, castShadows, receiveShadows);

        const torso = new pc.Entity('Torso');
        torso.setLocalPosition(0, 0.16, 0);
        pelvis.addChild(torso);
        this.addOffsetMesh(torso, 'TorsoCore_Geo', 'box', [0, 0.22, 0], [0.66, 0.42, 0.46], basalt, castShadows, receiveShadows);
        this.addOffsetMesh(torso, 'Chest_Geo', 'box', [0, 0.44, 0.02], [0.86, 0.34, 0.52], terracotta, castShadows, receiveShadows);
        this.addOffsetMesh(torso, 'ChestRune_Geo', 'box', [0, 0.44, 0.28], [0.16, 0.14, 0.06], amberRune, false, receiveShadows, [0, 0, 45]);
        this.addOffsetMesh(torso, 'BackMoss_Geo', 'sphere', [0, 0.48, -0.25], [0.52, 0.46, 0.30], moss, castShadows, receiveShadows);

        const head = new pc.Entity('Head');
        head.setLocalPosition(0, 0.53, 0.14);
        torso.addChild(head);
        this.addOffsetMesh(head, 'Head_Geo', 'box', [0, 0.14, 0], [0.36, 0.30, 0.34], basalt, castShadows, receiveShadows);
        this.addOffsetMesh(head, 'Eye_L_Geo', 'box', [0.075, 0.14, 0.175], [0.066, 0.042, 0.03], amberRune, false, receiveShadows);
        this.addOffsetMesh(head, 'Eye_R_Geo', 'box', [-0.075, 0.14, 0.175], [0.066, 0.042, 0.03], amberRune, false, receiveShadows);
        this.addOffsetMesh(head, 'HeadMoss_Geo', 'sphere', [0, 0.32, 0], [0.42, 0.18, 0.38], moss, castShadows, receiveShadows);

        for (const [label, sx] of [['L', 1], ['R', -1]] as const) {
            const arm = new pc.Entity(`Arm_${label}`);
            arm.setLocalPosition(sx * 0.50, 0.46, 0);
            torso.addChild(arm);
            this.addOffsetMesh(arm, `Pauldron_${label}_Geo`, 'box', [sx * 0.06, 0.04, 0], [0.42, 0.30, 0.42], basalt, castShadows, receiveShadows);
            this.addOffsetMesh(arm, `PauldronTop_${label}_Geo`, 'box', [sx * 0.10, 0.10, 0], [0.37, 0.17, 0.37], terracotta, castShadows, receiveShadows);
            this.addOffsetMesh(arm, `PauldronRune_${label}_Geo`, 'box', [sx * 0.11, 0.03, 0.01], [0.38, 0.04, 0.39], amberRune, false, receiveShadows);
            this.addOffsetMesh(arm, `UpperArm_${label}_Geo`, 'box', [sx * 0.08, -0.19, 0], [0.24, 0.28, 0.24], basalt, castShadows, receiveShadows);

            const forearm = new pc.Entity(`ForeArm_${label}`);
            forearm.setLocalPosition(sx * 0.09, -0.34, 0.03);
            arm.addChild(forearm);
            this.addOffsetMesh(forearm, `WristRune_${label}_Geo`, 'box', [0, -0.06, 0.02], [0.29, 0.04, 0.30], amberRune, false, receiveShadows);
            this.addOffsetMesh(forearm, `Fist_${label}_Geo`, 'box', [0, -0.26, 0.04], [0.31, 0.28, 0.33], terracotta, castShadows, receiveShadows);

            const leg = new pc.Entity(`Leg_${label}`);
            leg.setLocalPosition(sx * 0.23, -0.04, 0);
            pelvis.addChild(leg);
            this.addOffsetMesh(leg, `Leg_${label}_Geo`, 'box', [0, -0.22, 0], [0.25, 0.36, 0.26], basalt, castShadows, receiveShadows);
            this.addOffsetMesh(leg, `Foot_${label}_Geo`, 'box', [0, -0.44, 0.05], [0.31, 0.12, 0.40], terracotta, castShadows, receiveShadows);
        }
    }

    private buildFallbackWorkbench(
        root: pc.Entity,
        castShadows: boolean,
        receiveShadows: boolean
    ): void {
        const cedar = this.getMaterial('fb_bw_cedar', [0.48, 0.27, 0.14]);
        const honey = this.getMaterial('fb_bw_honey', [0.66, 0.42, 0.21]);
        const walnut = this.getMaterial('fb_bw_walnut', [0.28, 0.15, 0.08]);
        const iron = this.getMaterial('fb_bw_iron', [0.20, 0.23, 0.28], { gloss: 0.62, metalness: 0.82 });
        const brass = this.getMaterial('fb_bw_brass', [0.90, 0.68, 0.22], { gloss: 0.74, metalness: 0.86 });
        const parchment = this.getMaterial('fb_bw_paper', [0.94, 0.89, 0.74]);
        const teal = this.getMaterial('fb_bw_teal', [0.12, 0.64, 0.68]);
        const aether = this.getMaterial('fb_bw_aether', [0.18, 0.95, 1.0], {
            gloss: 0.9,
            emissive: [0.14, 0.90, 1.0],
            emissiveIntensity: 2.8,
        });

        for (const sx of [-1, 1] as const) {
            for (const sz of [-1, 1] as const) {
                this.addPart(root, `Leg_${sx}_${sz}`, 'box', [sx * 0.68, 0.37, sz * 0.39], [0.095, 0.72, 0.095], walnut, castShadows, receiveShadows, [sz * -7, 0, sx * 7]);
                this.addPart(root, `Shoe_${sx}_${sz}`, 'box', [sx * 0.73, 0.032, sz * 0.43], [0.12, 0.064, 0.12], iron, castShadows, receiveShadows);
            }
            this.addPart(root, `SideBrace_${sx}`, 'box', [sx * 0.695, 0.24, 0], [0.065, 0.075, 0.80], cedar, castShadows, receiveShadows);
            this.addPart(root, `Cleat_${sx}`, 'box', [sx * 0.755, 0.752, 0], [0.086, 0.068, 0.91], walnut, castShadows, receiveShadows);
        }

        this.addPart(root, 'LowerShelf', 'box', [0, 0.285, 0], [1.22, 0.036, 0.58], honey, castShadows, receiveShadows);
        this.addPart(root, 'Crate', 'box', [0.36, 0.39, -0.02], [0.34, 0.18, 0.28], cedar, castShadows, receiveShadows);
        this.addPart(root, 'Worktop', 'box', [0, 0.752, 0], [1.44, 0.064, 0.89], honey, castShadows, receiveShadows);
        this.addPart(root, 'Drawer', 'box', [-0.10, 0.66, 0.365], [0.46, 0.095, 0.045], honey, castShadows, receiveShadows);
        this.addPart(root, 'DrawerPull', 'box', [-0.10, 0.66, 0.395], [0.11, 0.026, 0.026], brass, castShadows, receiveShadows);

        this.addPart(root, 'ViseJaw', 'box', [0.48, 0.72, 0.475], [0.26, 0.11, 0.048], iron, castShadows, receiveShadows);
        this.addPart(root, 'ViseHandle', 'cylinder', [0.48, 0.72, 0.52], [0.022, 0.14, 0.022], brass, castShadows, receiveShadows);
        this.addPart(root, 'AnvilBase', 'box', [0.48, 0.82, -0.06], [0.22, 0.06, 0.16], walnut, castShadows, receiveShadows);
        this.addPart(root, 'AnvilBody', 'box', [0.46, 0.91, -0.06], [0.24, 0.08, 0.11], iron, castShadows, receiveShadows);

        this.addPart(root, 'LanternPost', 'box', [-0.64, 0.91, -0.34], [0.062, 0.265, 0.062], walnut, castShadows, receiveShadows);
        this.addPart(root, 'LanternArm', 'box', [-0.54, 1.02, -0.29], [0.22, 0.048, 0.048], iron, castShadows, receiveShadows, [0, -25, 0]);
        this.addPart(root, 'LanternGem', 'cone', [-0.45, 0.89, -0.24], [0.072, 0.095, 0.072], aether, false, receiveShadows);
        this.addPart(root, 'LanternCap', 'cone', [-0.45, 0.95, -0.24], [0.14, 0.04, 0.14], iron, castShadows, receiveShadows);

        this.addPart(root, 'ToolRackRail', 'box', [0.14, 0.93, -0.39], [0.94, 0.055, 0.045], cedar, castShadows, receiveShadows);
        this.addPart(root, 'Blueprint', 'box', [-0.34, 0.792, 0.14], [0.42, 0.014, 0.30], parchment, castShadows, receiveShadows, [0, -7, 0]);
        this.addPart(root, 'BlueprintGrid', 'box', [-0.34, 0.800, 0.14], [0.30, 0.006, 0.18], teal, false, receiveShadows, [0, -7, 0]);
    }

    private buildFallbackChest(
        root: pc.Entity,
        castShadows: boolean,
        receiveShadows: boolean
    ): void {
        const cedar = this.getMaterial('fb_bc_cedar', [0.48, 0.26, 0.13]);
        const honey = this.getMaterial('fb_bc_honey', [0.64, 0.39, 0.19]);
        const walnut = this.getMaterial('fb_bc_walnut', [0.27, 0.14, 0.08]);
        const iron = this.getMaterial('fb_bc_iron', [0.18, 0.21, 0.26], { gloss: 0.64, metalness: 0.84 });
        const brass = this.getMaterial('fb_bc_brass', [0.92, 0.70, 0.22], { gloss: 0.76, metalness: 0.88 });
        const aether = this.getMaterial('fb_bc_aether', [0.18, 0.96, 1.0], {
            gloss: 0.92,
            emissive: [0.14, 0.92, 1.0],
            emissiveIntensity: 3.0,
        });

        for (const sx of [-1, 1] as const) {
            for (const sz of [-1, 1] as const) {
                this.addPart(root, `Foot_${sx}_${sz}`, 'box', [sx * 0.44, 0.04, sz * 0.28], [0.13, 0.08, 0.12], iron, castShadows, receiveShadows);
                this.addPart(root, `CornerStrap_${sx}_${sz}`, 'box', [sx * 0.475, 0.30, sz * 0.315], [0.082, 0.46, 0.082], iron, castShadows, receiveShadows);
            }
            this.addPart(root, `HandlePlate_${sx}`, 'box', [sx * 0.512, 0.36, 0], [0.024, 0.075, 0.17], brass, castShadows, receiveShadows);
            this.addPart(root, `HandleBar_${sx}`, 'box', [sx * 0.538, 0.26, 0], [0.024, 0.024, 0.16], iron, castShadows, receiveShadows);
        }

        this.addPart(root, 'ChestCore', 'box', [0, 0.295, 0], [0.98, 0.44, 0.66], cedar, castShadows, receiveShadows);
        this.addPart(root, 'ChestRim', 'box', [0, 0.515, 0], [1.03, 0.048, 0.70], iron, castShadows, receiveShadows);
        this.addPart(root, 'ChestLid', 'cylinder', [0, 0.54, 0], [0.65, 0.98, 0.61], honey, castShadows, receiveShadows, [0, 0, 90]);
        for (const sx of [-0.495, -0.28, 0.28, 0.495] as const) {
            this.addPart(root, `LidBand_${sx}`, 'cylinder', [sx, 0.54, 0], [0.71, 0.068, 0.67], iron, castShadows, receiveShadows, [0, 0, 90]);
        }
        this.addPart(root, 'LidEndL', 'cylinder', [-0.48, 0.54, 0], [0.64, 0.04, 0.60], walnut, castShadows, receiveShadows, [0, 0, 90]);
        this.addPart(root, 'LidEndR', 'cylinder', [0.48, 0.54, 0], [0.64, 0.04, 0.60], walnut, castShadows, receiveShadows, [0, 0, 90]);

        this.addPart(root, 'LockShield', 'box', [0, 0.505, 0.354], [0.19, 0.17, 0.028], brass, castShadows, receiveShadows);
        this.addPart(root, 'LockBezel', 'box', [0, 0.492, 0.368], [0.115, 0.12, 0.020], iron, castShadows, receiveShadows);
        this.addPart(root, 'LockAetherGem', 'box', [0, 0.505, 0.376], [0.068, 0.068, 0.020], aether, false, receiveShadows, [0, 0, 45]);
    }

    private buildFallbackBed(
        root: pc.Entity,
        castShadows: boolean,
        receiveShadows: boolean
    ): void {
        const cedar = this.getMaterial('fb_bb_cedar', [0.48, 0.26, 0.13]);
        const honey = this.getMaterial('fb_bb_honey', [0.64, 0.40, 0.20]);
        const brass = this.getMaterial('fb_bb_brass', [0.90, 0.68, 0.22], { gloss: 0.74, metalness: 0.84 });
        const straw = this.getMaterial('fb_bb_straw', [0.86, 0.68, 0.24]);
        const teal = this.getMaterial('fb_bb_teal', [0.10, 0.62, 0.64]);
        const coral = this.getMaterial('fb_bb_coral', [0.92, 0.34, 0.28]);
        const linen = this.getMaterial('fb_bb_linen', [0.96, 0.91, 0.78]);

        for (const sx of [-1, 1] as const) {
            this.addPart(root, `HeadPost_${sx}`, 'box', [sx * 0.545, 0.33, -0.99], [0.095, 0.66, 0.095], cedar, castShadows, receiveShadows);
            this.addPart(root, `HeadCollar_${sx}`, 'box', [sx * 0.545, 0.65, -0.99], [0.106, 0.032, 0.106], brass, castShadows, receiveShadows);
            this.addPart(root, `HeadFinial_${sx}`, 'sphere', [sx * 0.545, 0.695, -0.99], [0.09, 0.07, 0.09], honey, castShadows, receiveShadows);
            this.addPart(root, `FootPost_${sx}`, 'box', [sx * 0.545, 0.24, 0.99], [0.095, 0.48, 0.095], cedar, castShadows, receiveShadows);
            this.addPart(root, `FootFinial_${sx}`, 'sphere', [sx * 0.545, 0.505, 0.99], [0.088, 0.068, 0.088], honey, castShadows, receiveShadows);
            this.addPart(root, `SideRail_${sx}`, 'box', [sx * 0.545, 0.21, 0], [0.055, 0.115, 1.92], cedar, castShadows, receiveShadows);
        }

        this.addPart(root, 'Headboard', 'box', [0, 0.45, -0.99], [1.04, 0.38, 0.052], honey, castShadows, receiveShadows);
        this.addPart(root, 'Footboard', 'box', [0, 0.32, 0.99], [1.04, 0.24, 0.050], honey, castShadows, receiveShadows);
        this.addPart(root, 'StrawMattress', 'box', [0, 0.325, 0], [1.01, 0.165, 1.88], straw, castShadows, receiveShadows);

        this.addPart(root, 'BlanketTop', 'box', [0, 0.398, 0.34], [1.06, 0.095, 1.18], teal, castShadows, receiveShadows);
        this.addPart(root, 'BlanketCuff', 'box', [0, 0.425, -0.21], [1.07, 0.068, 0.18], coral, castShadows, receiveShadows);
        this.addPart(root, 'BlanketStripe', 'box', [0, 0.415, 0.76], [1.07, 0.072, 0.11], coral, castShadows, receiveShadows);

        this.addPart(root, 'Bolster', 'cylinder', [0, 0.445, -0.80], [0.14, 0.76, 0.14], coral, castShadows, receiveShadows, [0, 0, 90]);
        this.addPart(root, 'Pillow', 'sphere', [0, 0.445, -0.62], [0.78, 0.18, 0.42], linen, castShadows, receiveShadows, [12, 0, 0]);
    }
}
