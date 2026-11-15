import * as pc from 'playcanvas';
import {
    IAssetLoader,
    ModelAssetKey,
    QualitySettings,
} from '../types/interfaces';
import { CollisionWorld } from '../physics/CollisionWorld';
import { BuiltTerrainResult, TerrainBuilder } from './TerrainBuilder';

const MAX_GRASS_INSTANCES = 3500;
const MAX_CLOUD_PUFFS = 48;
const WORLD_SEED = 20261115;

interface CloudPuffRecord {
    baseX: number;
    baseY: number;
    baseZ: number;
    scaleX: number;
    scaleY: number;
    scaleZ: number;
    yawDeg: number;
    bobPhase: number;
    driftSpeed: number;
}

interface PropRecord {
    id: string;
    key: ModelAssetKey;
    entity: pc.Entity;
    x: number;
    z: number;
    isLandmark: boolean;
    meshCount: number;
}

interface CrystalNode {
    id: string;
    entity: pc.Entity;
    haloEntity: pc.Entity;
    x: number;
    baseY: number;
    z: number;
    phase: number;
    collected: boolean;
}

interface BurstParticle {
    entity: pc.Entity;
    vx: number;
    vy: number;
    vz: number;
    baseScale: number;
    isRing: boolean;
}

interface BurstEffect {
    active: boolean;
    elapsed: number;
    duration: number;
    particles: BurstParticle[];
}

interface CrystalPlacement {
    id: string;
    x: number;
    z: number;
}

const CRYSTAL_LOCATIONS: readonly CrystalPlacement[] = [
    { id: 'crystal_01', x: 7.5, z: 4.0 },
    { id: 'crystal_02', x: -6.8, z: -14.0 },
    { id: 'crystal_03', x: 0.0, z: -51.5 },
    { id: 'crystal_04', x: -9.5, z: -43.0 },
    { id: 'crystal_05', x: 16.5, z: 22.0 },
    { id: 'crystal_06', x: 41.0, z: 31.0 },
    { id: 'crystal_07', x: -42.5, z: -16.0 },
    { id: 'crystal_08', x: 44.5, z: -20.0 },
    { id: 'crystal_09', x: 6.5, z: 48.0 },
    { id: 'crystal_10', x: -40.0, z: 42.0 },
    { id: 'crystal_11', x: 48.0, z: 56.0 },
    { id: 'crystal_12', x: 22.0, z: -66.0 },
];

function createSeededRng(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function countRenderMeshes(root: pc.Entity): number {
    let count = 0;
    const visit = (node: pc.GraphNode): void => {
        if (node instanceof pc.Entity && node.render) {
            count += Math.max(1, node.render.meshInstances.length);
        }
        for (const child of node.children) {
            visit(child);
        }
    };
    visit(root);
    return Math.max(1, count);
}

/**
 * Manages lighting, atmospheric fog, procedural sky dome, terrain/water,
 * seeded landmark & nature population, collectible vital crystals,
 * hardware-instanced grass, and distance culling.
 */
export class EnvironmentManager {
    private readonly app: pc.Application;
    private readonly collisionWorld: CollisionWorld;
    private readonly assetLoader: IAssetLoader;

    private terrainResult: BuiltTerrainResult | null = null;
    private sunLight: pc.Entity | null = null;
    private fillLight: pc.Entity | null = null;
    private crystalPointLight: pc.Entity | null = null;
    private skyDome: pc.Entity | null = null;

    private grassEntity: pc.Entity | null = null;
    private grassMeshInstance: pc.MeshInstance | null = null;
    private totalGrassPlaced = 0;
    private activeGrassCount = 1500;

    private cloudEntity: pc.Entity | null = null;
    private cloudMesh: pc.Mesh | null = null;
    private cloudMeshInstance: pc.MeshInstance | null = null;
    private cloudInstancingVb: pc.VertexBuffer | null = null;
    private cloudMatrices: Float32Array | null = null;
    private readonly cloudPuffs: CloudPuffRecord[] = [];
    private activeCloudCount = MAX_CLOUD_PUFFS;
    private readonly tmpCloudPos = new pc.Vec3();
    private readonly tmpCloudRot = new pc.Quat();
    private readonly tmpCloudScale = new pc.Vec3();
    private readonly tmpCloudMat = new pc.Mat4();

    private readonly habitatMeshes: pc.Mesh[] = [];
    private readonly habitatEntities: pc.Entity[] = [];
    private habitatAccentCount = 0;

    private readonly props: PropRecord[] = [];
    private readonly crystals = new Map<string, CrystalNode>();
    private readonly burstPool: BurstEffect[] = [];

    private haloMaterial: pc.StandardMaterial | null = null;
    private burstShardMaterial: pc.StandardMaterial | null = null;
    private burstShardMesh: pc.Mesh | null = null;
    private burstRingMesh: pc.Mesh | null = null;

    private elapsedTime = 0;
    private initialized = false;
    private lastAppliedDrawDistance = -1;
    private lastShadowsEnabled: boolean | null = null;
    private lastShadowRes = -1;
    private lastShadowDist = -1;

    constructor(
        app: pc.Application,
        collisionWorld: CollisionWorld,
        assetLoader: IAssetLoader
    ) {
        this.app = app;
        this.collisionWorld = collisionWorld;
        this.assetLoader = assetLoader;
    }

    initialize(initialQuality: QualitySettings): void {
        if (this.initialized) return;
        this.initialized = true;

        this.setupLightingAndFog(initialQuality);
        this.skyDome = this.createSkyDome();
        this.terrainResult = new TerrainBuilder(this.app, this.collisionWorld).build();

        this.createSharedVfxResources();
        this.populateWorld();
        this.createInstancedGrass(initialQuality.grassInstanceCount);
        this.createDriftingSkyClouds(initialQuality);
        this.createHabitatClearingAccents();
        this.applyQualityToScene(initialQuality);
    }

    getDirectionalLight(): pc.Entity | null {
        return this.sunLight;
    }

    getTotalCrystals(): number {
        return this.crystals.size;
    }

    getCollectedCrystalCount(): number {
        let count = 0;
        for (const crystal of this.crystals.values()) {
            if (crystal.collected) count++;
        }
        return count;
    }

    /**
     * Returns the IDs of all collected vital crystals in deterministic order.
     */
    getCollectedCrystalIds(): string[] {
        const ids: string[] = [];
        for (const crystal of this.crystals.values()) {
            if (crystal.collected) {
                ids.push(crystal.id);
            }
        }
        return ids;
    }

    /**
     * Marks a vital crystal as collected, removes its collider, hides its node,
     * and spawns an expanding glowing particle burst.
     */
    collectCrystal(id: string): boolean {
        return this.markCrystalCollected(id, true);
    }

    /**
     * Applies authoritative/peer-synced collected crystal IDs to the scene.
     * Triggers collection VFX only for newly collected crystals when triggerBurstForNew is true.
     */
    syncCollectedCrystals(
        crystalIds: ReadonlyArray<string>,
        triggerBurstForNew = true
    ): number {
        for (const id of crystalIds) {
            this.markCrystalCollected(id, triggerBurstForNew);
        }
        return this.getCollectedCrystalCount();
    }

    private markCrystalCollected(id: string, triggerBurst: boolean): boolean {
        const crystal = this.crystals.get(id);
        if (!crystal || crystal.collected) {
            return false;
        }

        crystal.collected = true;
        this.collisionWorld.removeCollider(id);
        crystal.entity.enabled = false;
        crystal.haloEntity.enabled = false;

        if (triggerBurst) {
            this.spawnCollectionBurst(crystal.x, crystal.baseY + 0.75, crystal.z);
        }
        return true;
    }

    update(
        dt: number,
        playerPos: pc.Vec3,
        qualitySettings: QualitySettings
    ): { visibleInstances: number; culledObjects: number } {
        const safeDt = Math.min(Math.max(dt, 0.001), 0.1);
        this.elapsedTime += safeDt;

        // 1. Sync quality settings (fog, grass instance count, light shadows)
        this.applyQualityToScene(qualitySettings);

        // 2. Water wave & caustic shimmer update
        if (this.terrainResult) {
            this.terrainResult.updateWater(this.elapsedTime);
        }

        // 3. Directional sun shadow follow snapped to texels around playerPos
        if (this.sunLight) {
            const res = Math.max(256, qualitySettings.shadowResolution);
            const texelSize = (qualitySettings.shadowDistance * 2) / res;
            const snapX = Math.round(playerPos.x / texelSize) * texelSize;
            const snapZ = Math.round(playerPos.z / texelSize) * texelSize;
            this.sunLight.setPosition(snapX, 45, snapZ);
        }

        // 4. Sky dome tracks player horizontally & fits active camera far clip
        if (this.skyDome) {
            const activeCam = this.app.root.findComponent('camera') as pc.CameraComponent | null;
            const farClip = activeCam?.farClip ?? 180;
            const skyScale = Math.max(95, farClip * 0.88);
            this.skyDome.setPosition(playerPos.x, 0, playerPos.z);
            this.skyDome.setLocalScale(skyScale, skyScale, skyScale);
        }

        // 5. Animate vital crystals & track nearest active crystal for pooled point light
        let nearestCrystal: CrystalNode | null = null;
        let nearestDistSq = 18 * 18;
        for (const crystal of this.crystals.values()) {
            if (crystal.collected) continue;

            const bob = Math.sin(this.elapsedTime * 2.4 + crystal.phase) * 0.16;
            crystal.entity.setPosition(crystal.x, crystal.baseY + bob, crystal.z);
            crystal.entity.rotate(0, 78 * safeDt, 0);

            const haloPulse = 1.0 + 0.14 * Math.sin(this.elapsedTime * 3.2 + crystal.phase);
            crystal.haloEntity.setLocalScale(haloPulse, 1, haloPulse);
            crystal.haloEntity.rotate(0, -45 * safeDt, 0);

            const dx = crystal.x - playerPos.x;
            const dz = crystal.z - playerPos.z;
            const dSq = dx * dx + dz * dz;
            if (dSq < nearestDistSq) {
                nearestDistSq = dSq;
                nearestCrystal = crystal;
            }
        }

        if (this.crystalPointLight?.light) {
            if (nearestCrystal) {
                this.crystalPointLight.enabled = true;
                this.crystalPointLight.setPosition(
                    nearestCrystal.x,
                    nearestCrystal.baseY + 1.05,
                    nearestCrystal.z
                );
                const flicker = 1.7 + 0.35 * Math.sin(this.elapsedTime * 4.5);
                this.crystalPointLight.light.intensity = flicker;
            } else {
                this.crystalPointLight.enabled = false;
            }
        }

        // 6. Animate collection burst effects & drifting sky clouds
        this.updateBursts(safeDt);
        this.updateDriftingSkyClouds(safeDt);

        // 7. Distance culling across populated props & instance accounting
        const drawDist = qualitySettings.drawDistance;
        const propCullSq = drawDist * drawDist;
        const landmarkCullSq = (drawDist * 1.4) * (drawDist * 1.4);

        let visibleInstances = 2; // Terrain + Water
        let culledObjects = 0;

        for (const prop of this.props) {
            if (prop.key === 'vital_crystal') {
                const crystal = this.crystals.get(prop.id);
                if (crystal?.collected) {
                    continue;
                }
            }

            const dx = prop.x - playerPos.x;
            const dz = prop.z - playerPos.z;
            const distSq = dx * dx + dz * dz;
            const maxSq = prop.isLandmark ? landmarkCullSq : propCullSq;
            const visible = distSq <= maxSq;

            if (prop.entity.enabled !== visible) {
                prop.entity.enabled = visible;
            }
            if (prop.key === 'vital_crystal') {
                const crystal = this.crystals.get(prop.id);
                if (crystal && crystal.haloEntity.enabled !== visible) {
                    crystal.haloEntity.enabled = visible;
                }
            }

            if (visible) {
                visibleInstances += prop.meshCount;
            } else {
                culledObjects++;
            }
        }

        visibleInstances += this.activeGrassCount + this.activeCloudCount + this.habitatAccentCount;

        return { visibleInstances, culledObjects };
    }

    private setupLightingAndFog(quality: QualitySettings): void {
        // Warm vibrant sky/meadow ambient base so shadows stay bright turquoise-blue
        this.app.scene.ambientLight.set(0.38, 0.50, 0.58);

        // Linear atmospheric mist matching sky horizon
        this.app.scene.fog.type = pc.FOG_LINEAR;
        this.app.scene.fog.color.set(0.68, 0.87, 0.96);

        // Main sunlight directional light
        const sun = new pc.Entity('SunLight');
        sun.addComponent('light', {
            type: 'directional',
            color: new pc.Color(1.0, 0.96, 0.86),
            intensity: 1.55,
            castShadows: quality.shadowsEnabled,
            shadowResolution: quality.shadowResolution,
            shadowDistance: quality.shadowDistance,
            shadowType: pc.SHADOW_PCF3_32F,
            shadowBias: 0.28,
            normalOffsetBias: 0.04,
            shadowUpdateMode: pc.SHADOWUPDATE_REALTIME,
        });
        sun.setEulerAngles(48, -38, 0);
        sun.setPosition(0, 45, 12);
        this.app.root.addChild(sun);
        this.sunLight = sun;

        // Sky/ground hemisphere bounce fill (shadowless opposite upward angle)
        const fill = new pc.Entity('HemisphereBounceFill');
        fill.addComponent('light', {
            type: 'directional',
            color: new pc.Color(0.56, 0.80, 0.84),
            intensity: 0.44,
            castShadows: false,
        });
        fill.setEulerAngles(-35, 142, 0);
        this.app.root.addChild(fill);
        this.fillLight = fill;

        // Pooled point light for nearest uncollected vital crystal
        const crystalLight = new pc.Entity('NearestCrystalGlowLight');
        crystalLight.addComponent('light', {
            type: 'point',
            color: new pc.Color(0.22, 0.96, 1.0),
            intensity: 1.8,
            range: 9.0,
            castShadows: false,
        });
        crystalLight.enabled = false;
        this.app.root.addChild(crystalLight);
        this.crystalPointLight = crystalLight;
    }

    private applyQualityToScene(quality: QualitySettings): void {
        if (Math.abs(quality.drawDistance - this.lastAppliedDrawDistance) > 0.1) {
            this.lastAppliedDrawDistance = quality.drawDistance;
            this.app.scene.fog.start = quality.drawDistance * 0.45;
            this.app.scene.fog.end = quality.drawDistance * 1.18;
        }

        if (this.sunLight?.light) {
            if (
                this.lastShadowsEnabled !== quality.shadowsEnabled ||
                this.lastShadowRes !== quality.shadowResolution ||
                this.lastShadowDist !== quality.shadowDistance
            ) {
                this.lastShadowsEnabled = quality.shadowsEnabled;
                this.lastShadowRes = quality.shadowResolution;
                this.lastShadowDist = quality.shadowDistance;

                this.sunLight.light.castShadows = quality.shadowsEnabled;
                this.sunLight.light.shadowResolution = quality.shadowResolution;
                this.sunLight.light.shadowDistance = quality.shadowDistance;
            }
        }

        const grassLimit = this.totalGrassPlaced > 0 ? this.totalGrassPlaced : MAX_GRASS_INSTANCES;
        const clampedGrass = Math.min(grassLimit, Math.max(0, Math.round(quality.grassInstanceCount)));
        if (this.grassMeshInstance && this.grassEntity) {
            this.activeGrassCount = clampedGrass;
            this.grassMeshInstance.instancingCount = clampedGrass;
            this.grassEntity.enabled = clampedGrass > 0;
        }

        if (this.cloudMeshInstance && this.cloudEntity && this.cloudPuffs.length > 0) {
            const targetPuffs =
                quality.tier === 'low'
                    ? 24
                    : quality.tier === 'medium'
                      ? 36
                      : this.cloudPuffs.length;
            this.activeCloudCount = Math.min(this.cloudPuffs.length, targetPuffs);
            this.cloudMeshInstance.instancingCount = this.activeCloudCount;
            this.cloudEntity.enabled = this.activeCloudCount > 0;
        }
    }

    private createSkyDome(): pc.Entity {
        const device = this.app.graphicsDevice;
        const latBands = 20;
        const lonBands = 32;
        const positions: number[] = [];
        const normals: number[] = [];
        const uvs: number[] = [];
        const indices: number[] = [];

        for (let lat = 0; lat <= latBands; lat++) {
            const v = lat / latBands;
            const theta = v * Math.PI;
            const sinT = Math.sin(theta);
            const cosT = Math.cos(theta);

            for (let lon = 0; lon <= lonBands; lon++) {
                const u = lon / lonBands;
                const phi = u * Math.PI * 2;
                const x = sinT * Math.cos(phi);
                const y = cosT;
                const z = sinT * Math.sin(phi);

                positions.push(x, y, z);
                normals.push(-x, -y, -z);
                uvs.push(u, 1 - v);
            }
        }

        for (let lat = 0; lat < latBands; lat++) {
            for (let lon = 0; lon < lonBands; lon++) {
                const first = lat * (lonBands + 1) + lon;
                const second = first + lonBands + 1;
                // Inward-facing winding
                indices.push(first, first + 1, second);
                indices.push(second, first + 1, second + 1);
            }
        }

        const mesh = new pc.Mesh(device);
        mesh.setPositions(new Float32Array(positions));
        mesh.setNormals(new Float32Array(normals));
        mesh.setUvs(0, new Float32Array(uvs));
        mesh.setIndices(new Uint16Array(indices));
        mesh.update(pc.PRIMITIVE_TRIANGLES, true);

        const skyTex = this.createSkyGradientTexture(device);
        const material = new pc.StandardMaterial();
        material.name = 'StylizedSkyDomeMaterial';
        material.diffuse = new pc.Color(0, 0, 0);
        material.emissive = new pc.Color(1, 1, 1);
        material.emissiveMap = skyTex;
        material.useLighting = false;
        material.useFog = false;
        material.useSkybox = false;
        material.depthWrite = false;
        material.cull = pc.CULLFACE_NONE;
        material.update();

        const meshInstance = new pc.MeshInstance(mesh, material);
        meshInstance.cull = false;

        const skyEntity = new pc.Entity('SkyDome');
        skyEntity.addComponent('render', {
            meshInstances: [meshInstance],
            castShadows: false,
            receiveShadows: false,
            layers: [pc.LAYERID_SKYBOX],
        });
        skyEntity.setLocalScale(155, 155, 155);
        this.app.root.addChild(skyEntity);
        return skyEntity;
    }

    private createSkyGradientTexture(device: pc.GraphicsDevice): pc.Texture {
        const w = 512;
        const h = 256;
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (ctx) {
            const grad = ctx.createLinearGradient(0, 0, 0, h);
            grad.addColorStop(0.0, '#1e6fd9');   // Zenith rich cobalt-azure
            grad.addColorStop(0.28, '#46a8f5');  // Mid-upper cerulean
            grad.addColorStop(0.47, '#9ce2fa');  // Horizon sunlit cyan
            grad.addColorStop(0.52, '#e4f9fc');  // Horizon warm mist glow
            grad.addColorStop(0.65, '#9ed9e8');  // Below horizon reflection
            grad.addColorStop(1.0, '#4f9bb8');   // Nadir
            ctx.fillStyle = grad;
            ctx.fillRect(0, 0, w, h);

            // Warm stylized sun glow disc
            const sunX = w * 0.22;
            const sunY = h * 0.34;
            const sunGrad = ctx.createRadialGradient(sunX, sunY, 3, sunX, sunY, 54);
            sunGrad.addColorStop(0.0, 'rgba(255, 252, 224, 1.0)');
            sunGrad.addColorStop(0.22, 'rgba(255, 240, 178, 0.82)');
            sunGrad.addColorStop(0.55, 'rgba(255, 232, 165, 0.24)');
            sunGrad.addColorStop(1.0, 'rgba(255, 232, 165, 0.0)');
            ctx.fillStyle = sunGrad;
            ctx.beginPath();
            ctx.arc(sunX, sunY, 54, 0, Math.PI * 2);
            ctx.fill();

            // Soft stylized horizontal clouds near upper horizon
            const rng = createSeededRng(777);
            for (let i = 0; i < 18; i++) {
                const cx = rng() * w;
                const cy = h * (0.28 + rng() * 0.16);
                const rx = 24 + rng() * 44;
                const ry = 6 + rng() * 10;
                const cGrad = ctx.createRadialGradient(cx, cy, 2, cx, cy, rx);
                cGrad.addColorStop(0.0, 'rgba(255, 255, 255, 0.42)');
                cGrad.addColorStop(0.6, 'rgba(255, 255, 255, 0.16)');
                cGrad.addColorStop(1.0, 'rgba(255, 255, 255, 0.0)');
                ctx.fillStyle = cGrad;
                ctx.beginPath();
                ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
                ctx.fill();
            }
        }

        const tex = new pc.Texture(device, {
            name: 'SkyGradientTex',
            width: w,
            height: h,
            format: pc.PIXELFORMAT_RGBA8,
            srgb: true,
            mipmaps: false,
            minFilter: pc.FILTER_LINEAR,
            magFilter: pc.FILTER_LINEAR,
            addressU: pc.ADDRESS_REPEAT,
            addressV: pc.ADDRESS_CLAMP_TO_EDGE,
        });
        tex.setSource(canvas);
        return tex;
    }

    private createSharedVfxResources(): void {
        const device = this.app.graphicsDevice;

        this.haloMaterial = new pc.StandardMaterial();
        this.haloMaterial.name = 'CrystalHaloMaterial';
        this.haloMaterial.diffuse = new pc.Color(0.2, 0.95, 1.0);
        this.haloMaterial.emissive = new pc.Color(0.25, 0.95, 1.0);
        this.haloMaterial.emissiveIntensity = 1.6;
        this.haloMaterial.opacity = 0.65;
        this.haloMaterial.blendType = pc.BLEND_ADDITIVEALPHA;
        this.haloMaterial.depthWrite = false;
        this.haloMaterial.useLighting = false;
        this.haloMaterial.update();

        this.burstShardMaterial = new pc.StandardMaterial();
        this.burstShardMaterial.name = 'CrystalBurstShardMaterial';
        this.burstShardMaterial.diffuse = new pc.Color(0.5, 1.0, 0.95);
        this.burstShardMaterial.emissive = new pc.Color(0.35, 1.0, 0.95);
        this.burstShardMaterial.emissiveIntensity = 2.2;
        this.burstShardMaterial.opacity = 0.95;
        this.burstShardMaterial.blendType = pc.BLEND_ADDITIVEALPHA;
        this.burstShardMaterial.depthWrite = false;
        this.burstShardMaterial.useLighting = false;
        this.burstShardMaterial.update();

        this.burstRingMesh = pc.Mesh.fromGeometry(
            device,
            new pc.TorusGeometry({
                tubeRadius: 0.045,
                ringRadius: 0.62,
                segments: 24,
                sides: 8,
            })
        );
        this.burstRingMesh.incRefCount();

        this.burstShardMesh = pc.Mesh.fromGeometry(
            device,
            new pc.SphereGeometry({
                radius: 0.11,
                latitudeBands: 6,
                longitudeBands: 8,
            })
        );
        this.burstShardMesh.incRefCount();

        // Pre-allocate reusable burst slots so entities/buffers are never destroyed mid-game
        for (let i = 0; i < 3; i++) {
            this.burstPool.push(this.createBurstSlot(i));
        }
    }

    private populateWorld(): void {
        const rng = createSeededRng(WORLD_SEED);

        // 1. Ancient Ruin Sanctuary centerpiece + 2 scenic outposts
        this.spawnAncientRuin('ruin_sanctuary', 0, -48, 0, 1.35, true);
        this.spawnAncientRuin('ruin_outpost_west', -46, -16, 90, 1.0, false);
        this.spawnAncientRuin('ruin_outpost_east', 48, -20, -90, 1.0, false);

        // 2. 12 Collectible Vital Crystals
        for (let i = 0; i < CRYSTAL_LOCATIONS.length; i++) {
            const loc = CRYSTAL_LOCATIONS[i];
            this.spawnVitalCrystal(loc.id, loc.x, loc.z, i * 0.72);
        }

        // Track occupied points for clean spacing
        const treeAndRockPts: Array<{ x: number; z: number; r: number }> = [];
        const addOccupied = (x: number, z: number, r: number): void => {
            treeAndRockPts.push({ x, z, r });
        };

        // Reserve space around ruins and crystals
        addOccupied(0, -48, 7.5);
        addOccupied(-46, -16, 5.5);
        addOccupied(48, -20, 5.5);
        for (const c of CRYSTAL_LOCATIONS) {
            addOccupied(c.x, c.z, 3.0);
        }

        const isSpotClear = (x: number, z: number, minDist: number): boolean => {
            // Keep spawn meadow around (0, 12) clear
            if (Math.hypot(x, z - 12) < 10.5) return false;
            if (Math.hypot(x, z - 4) < 7.0) return false;
            // Keep main trails clear
            if (this.collisionWorld.getTrailMask(x, z) > 0.12) return false;

            for (const p of treeAndRockPts) {
                if (Math.hypot(x - p.x, z - p.z) < p.r + minDist) {
                    return false;
                }
            }
            return true;
        };

        // 3. ~45 Broadleaf Canopy Trees
        this.scatterProps({
            key: 'tree_canopy',
            targetCount: 45,
            maxAttempts: 1000,
            rng,
            minRadius: 11,
            maxRadius: 94,
            minSpacing: 4.8,
            minHeight: 0.9,
            maxHeight: 8.6,
            minNormalY: 0.84,
            scaleRange: [0.85, 1.25],
            sinkY: 0.12,
            isSpotClear,
            onPlaced: (id, x, z, y, scale) => {
                addOccupied(x, z, 2.2 * scale);
                this.collisionWorld.registerCollider({
                    id,
                    type: 'cylinder',
                    position: new pc.Vec3(x, y + 1.9 * scale, z),
                    radius: 0.46 * scale,
                    height: 3.8 * scale,
                    tag: 'tree',
                    blocksCamera: false,
                });
            },
        });

        // 4. ~35 Highland Pine Trees (favoring higher hillsides & outer foothills)
        this.scatterProps({
            key: 'tree_pine',
            targetCount: 35,
            maxAttempts: 1000,
            rng,
            minRadius: 18,
            maxRadius: 104,
            minSpacing: 4.4,
            minHeight: 2.5,
            maxHeight: 15.2,
            minNormalY: 0.72,
            scaleRange: [0.88, 1.32],
            sinkY: 0.12,
            isSpotClear,
            onPlaced: (id, x, z, y, scale) => {
                addOccupied(x, z, 1.9 * scale);
                this.collisionWorld.registerCollider({
                    id,
                    type: 'cylinder',
                    position: new pc.Vec3(x, y + 2.1 * scale, z),
                    radius: 0.42 * scale,
                    height: 4.2 * scale,
                    tag: 'tree',
                    blocksCamera: false,
                });
            },
        });

        // 5. ~40 Rock Clusters (with camera-blocking sphere colliders)
        this.scatterProps({
            key: 'rock_cluster',
            targetCount: 40,
            maxAttempts: 1000,
            rng,
            minRadius: 12,
            maxRadius: 104,
            minSpacing: 3.6,
            minHeight: -0.15,
            maxHeight: 16.0,
            minNormalY: 0.62,
            scaleRange: [0.85, 1.35],
            sinkY: 0.1,
            isSpotClear,
            onPlaced: (id, x, z, y, scale) => {
                addOccupied(x, z, 1.6 * scale);
                this.collisionWorld.registerCollider({
                    id,
                    type: 'sphere',
                    position: new pc.Vec3(x, y + 0.68 * scale, z),
                    radius: 1.15 * scale,
                    tag: 'rock',
                    blocksCamera: true,
                });
            },
        });

        // 6. ~55 Flowering Bushes (non-blocking decorative foliage)
        this.scatterProps({
            key: 'bush_flower',
            targetCount: 55,
            maxAttempts: 1000,
            rng,
            minRadius: 9,
            maxRadius: 95,
            minSpacing: 1.8,
            minHeight: 0.75,
            maxHeight: 9.2,
            minNormalY: 0.80,
            scaleRange: [0.85, 1.32],
            sinkY: 0.05,
            isSpotClear: (x, z, minDist) => {
                if (Math.hypot(x, z - 12) < 6.5) return false;
                if (this.collisionWorld.getTrailMask(x, z) > 0.25) return false;
                for (const p of treeAndRockPts) {
                    if (Math.hypot(x - p.x, z - p.z) < Math.min(p.r, 1.4) + minDist * 0.5) {
                        return false;
                    }
                }
                return true;
            },
        });
    }

    private spawnAncientRuin(
        id: string,
        x: number,
        z: number,
        yawDeg: number,
        scale: number,
        isCenterpiece: boolean
    ): void {
        const groundY = this.collisionWorld.getTerrainHeight(x, z);
        const entity = this.assetLoader.getBundle('ancient_ruin').instantiate(id);
        entity.setPosition(x, groundY - 0.08, z);
        entity.setEulerAngles(0, yawDeg, 0);
        entity.setLocalScale(scale, scale, scale);
        this.app.root.addChild(entity);

        this.props.push({
            id,
            key: 'ancient_ruin',
            entity,
            x,
            z,
            isLandmark: true,
            meshCount: countRenderMeshes(entity),
        });

        // Axis-aligned pillar + lintel box colliders matching ancient_ruin.glb archway geometry
        // (4.6m wide along local X, 2.3m deep along local Z, 5.51m tall along Y)
        const rotated90 = Math.abs(Math.abs(yawDeg) - 90) < 1;
        const pillarOffset = 1.62 * scale;
        const pillarHalfLong = 0.62 * scale;
        const pillarHalfThin = 0.95 * scale;
        const pillarHalfH = 2.2 * scale;

        if (!rotated90) {
            this.collisionWorld.registerCollider({
                id: `${id}_pillar_l`,
                type: 'box',
                position: new pc.Vec3(x - pillarOffset, groundY + pillarHalfH, z),
                radius: pillarHalfLong,
                halfExtents: new pc.Vec3(pillarHalfLong, pillarHalfH, pillarHalfThin),
                tag: 'ruin',
                blocksCamera: true,
            });
            this.collisionWorld.registerCollider({
                id: `${id}_pillar_r`,
                type: 'box',
                position: new pc.Vec3(x + pillarOffset, groundY + pillarHalfH, z),
                radius: pillarHalfLong,
                halfExtents: new pc.Vec3(pillarHalfLong, pillarHalfH, pillarHalfThin),
                tag: 'ruin',
                blocksCamera: true,
            });
            this.collisionWorld.registerCollider({
                id: `${id}_lintel`,
                type: 'box',
                position: new pc.Vec3(x, groundY + 4.72 * scale, z),
                radius: 2.3 * scale,
                halfExtents: new pc.Vec3(2.3 * scale, 0.8 * scale, pillarHalfThin),
                tag: 'ruin',
                blocksCamera: true,
            });
        } else {
            this.collisionWorld.registerCollider({
                id: `${id}_pillar_l`,
                type: 'box',
                position: new pc.Vec3(x, groundY + pillarHalfH, z - pillarOffset),
                radius: pillarHalfLong,
                halfExtents: new pc.Vec3(pillarHalfThin, pillarHalfH, pillarHalfLong),
                tag: 'ruin',
                blocksCamera: true,
            });
            this.collisionWorld.registerCollider({
                id: `${id}_pillar_r`,
                type: 'box',
                position: new pc.Vec3(x, groundY + pillarHalfH, z + pillarOffset),
                radius: pillarHalfLong,
                halfExtents: new pc.Vec3(pillarHalfThin, pillarHalfH, pillarHalfLong),
                tag: 'ruin',
                blocksCamera: true,
            });
            this.collisionWorld.registerCollider({
                id: `${id}_lintel`,
                type: 'box',
                position: new pc.Vec3(x, groundY + 4.72 * scale, z),
                radius: 2.3 * scale,
                halfExtents: new pc.Vec3(pillarHalfThin, 0.8 * scale, 2.3 * scale),
                tag: 'ruin',
                blocksCamera: true,
            });
        }

        // Sanctuary centerpiece glowing courtyard ring
        if (isCenterpiece && this.burstRingMesh && this.haloMaterial) {
            const sanctuaryRing = new pc.Entity('SanctuaryFloorHalo');
            const ringMi = new pc.MeshInstance(this.burstRingMesh, this.haloMaterial);
            sanctuaryRing.addComponent('render', {
                meshInstances: [ringMi],
                castShadows: false,
                receiveShadows: false,
            });
            sanctuaryRing.setPosition(x, groundY + 0.08, z - 3.5);
            sanctuaryRing.setLocalScale(3.6, 1, 3.6);
            this.app.root.addChild(sanctuaryRing);
        }
    }

    private spawnVitalCrystal(id: string, x: number, z: number, phase: number): void {
        const groundY = this.collisionWorld.getTerrainHeight(x, z);
        const baseY = groundY + 0.14;

        const entity = this.assetLoader.getBundle('vital_crystal').instantiate(id);
        entity.setPosition(x, baseY, z);
        this.app.root.addChild(entity);

        const haloEntity = new pc.Entity(`${id}_halo`);
        if (this.burstRingMesh && this.haloMaterial) {
            const haloMi = new pc.MeshInstance(this.burstRingMesh, this.haloMaterial);
            haloEntity.addComponent('render', {
                meshInstances: [haloMi],
                castShadows: false,
                receiveShadows: false,
            });
        }
        haloEntity.setPosition(x, groundY + 0.08, z);
        this.app.root.addChild(haloEntity);

        this.collisionWorld.registerCollider({
            id,
            type: 'cylinder',
            position: new pc.Vec3(x, groundY + 0.55, z),
            radius: 0.32,
            height: 1.2,
            tag: 'crystal',
            blocksCamera: false,
            collected: false,
        });

        this.crystals.set(id, {
            id,
            entity,
            haloEntity,
            x,
            baseY,
            z,
            phase,
            collected: false,
        });

        this.props.push({
            id,
            key: 'vital_crystal',
            entity,
            x,
            z,
            isLandmark: false,
            meshCount: countRenderMeshes(entity) + 1,
        });
    }

    private scatterProps(opts: {
        key: ModelAssetKey;
        targetCount: number;
        maxAttempts: number;
        rng: () => number;
        minRadius: number;
        maxRadius: number;
        minSpacing: number;
        minHeight: number;
        maxHeight: number;
        minNormalY: number;
        scaleRange: readonly [number, number];
        sinkY: number;
        isSpotClear: (x: number, z: number, minDist: number) => boolean;
        onPlaced?: (id: string, x: number, z: number, y: number, scale: number) => void;
    }): void {
        const normal = new pc.Vec3();
        let placed = 0;

        for (let attempt = 0; attempt < opts.maxAttempts && placed < opts.targetCount; attempt++) {
            const angle = opts.rng() * Math.PI * 2;
            const span = opts.maxRadius - opts.minRadius;
            const radius = opts.minRadius + Math.sqrt(opts.rng()) * span;
            const x = Math.cos(angle) * radius;
            const z = Math.sin(angle) * radius;

            const y = this.collisionWorld.getTerrainHeight(x, z);
            if (y < opts.minHeight || y > opts.maxHeight) continue;

            this.collisionWorld.getTerrainNormal(x, z, normal);
            if (normal.y < opts.minNormalY) continue;

            if (!opts.isSpotClear(x, z, opts.minSpacing)) continue;

            const scale =
                opts.scaleRange[0] +
                opts.rng() * (opts.scaleRange[1] - opts.scaleRange[0]);
            const yaw = opts.rng() * 360;
            const id = `${opts.key}_${placed + 1}`;

            const entity = this.assetLoader.getBundle(opts.key).instantiate(id);
            entity.setPosition(x, y - opts.sinkY, z);
            entity.setEulerAngles(0, yaw, 0);
            entity.setLocalScale(scale, scale, scale);
            this.app.root.addChild(entity);

            this.props.push({
                id,
                key: opts.key,
                entity,
                x,
                z,
                isLandmark: false,
                meshCount: countRenderMeshes(entity),
            });

            if (opts.onPlaced) {
                opts.onPlaced(id, x, z, y, scale);
            }
            placed++;
        }
    }

    private createInstancedGrass(initialCount: number): void {
        const device = this.app.graphicsDevice;

        // 3-blade stylized grass tuft mesh (base emerald -> sunlit lime-emerald tips)
        const positions = new Float32Array([
            // Blade 1 (center-front)
            -0.06, 0.0, 0.02,
             0.06, 0.0, 0.02,
             0.01, 0.46, 0.09,
            // Blade 2 (left angled)
            -0.11, 0.0, -0.04,
            -0.01, 0.0, 0.06,
            -0.15, 0.39, -0.06,
            // Blade 3 (right angled)
             0.01, 0.0, 0.05,
             0.12, 0.0, -0.05,
             0.16, 0.41, -0.05,
        ]);

        const normals = new Float32Array([
            0, 0.96, 0.25,  0, 0.96, 0.25,  0, 0.98, 0.2,
            -0.2, 0.96, 0, -0.2, 0.96, 0, -0.2, 0.98, 0,
            0.2, 0.96, 0,  0.2, 0.96, 0,  0.2, 0.98, 0,
        ]);

        const colors = new Uint8Array([
            38, 130, 56, 255,   38, 130, 56, 255,   138, 224, 86, 255,
            34, 122, 52, 255,   34, 122, 52, 255,   126, 214, 80, 255,
            40, 134, 58, 255,   40, 134, 58, 255,   144, 230, 92, 255,
        ]);

        const indices = new Uint16Array([0, 1, 2, 3, 4, 5, 6, 7, 8]);

        const mesh = new pc.Mesh(device);
        mesh.setPositions(positions);
        mesh.setNormals(normals);
        mesh.setColors32(colors);
        mesh.setIndices(indices);
        mesh.update(pc.PRIMITIVE_TRIANGLES, true);

        const mat = new pc.StandardMaterial();
        mat.name = 'InstancedGrassMaterial';
        mat.diffuse = new pc.Color(1, 1, 1);
        mat.diffuseVertexColor = true;
        mat.cull = pc.CULLFACE_NONE;
        mat.twoSidedLighting = true;
        mat.useMetalness = true;
        mat.metalness = 0.0;
        mat.gloss = 0.22;
        mat.update();

        const matrices = new Float32Array(MAX_GRASS_INSTANCES * 16);
        const rng = createSeededRng(WORLD_SEED + 99);
        const tmpPos = new pc.Vec3();
        const tmpRot = new pc.Quat();
        const tmpScale = new pc.Vec3();
        const tmpMat = new pc.Mat4();
        const tmpNormal = new pc.Vec3();

        let count = 0;
        let attempts = 0;
        while (count < MAX_GRASS_INSTANCES && attempts < MAX_GRASS_INSTANCES * 6) {
            attempts++;
            // Slightly favor central scenic valley (r in 3..88m) while covering whole meadow
            const angle = rng() * Math.PI * 2;
            const rBias = Math.pow(rng(), 0.72) * 88;
            const x = Math.cos(angle) * rBias;
            const z = Math.sin(angle) * rBias;

            const y = this.collisionWorld.getTerrainHeight(x, z);
            if (y < 0.85 || y > 9.0) continue;

            if (this.collisionWorld.getTrailMask(x, z) > 0.08) continue;

            // Keep stone sanctuary floor clean
            if (Math.hypot(x, z + 48) < 5.0) continue;

            this.collisionWorld.getTerrainNormal(x, z, tmpNormal);
            if (tmpNormal.y < 0.84) continue;

            const sXZ = 0.85 + rng() * 0.75;
            const sY = 0.78 + rng() * 0.82;
            tmpPos.set(x, y - 0.03, z);
            tmpRot.setFromEulerAngles(
                (rng() - 0.5) * 14,
                rng() * 360,
                (rng() - 0.5) * 14
            );
            tmpScale.set(sXZ, sY, sXZ);
            tmpMat.setTRS(tmpPos, tmpRot, tmpScale);

            matrices.set(tmpMat.data, count * 16);
            count++;
        }

        const vbFormat = pc.VertexFormat.getDefaultInstancingFormat(device);
        const instancingVb = new pc.VertexBuffer(device, vbFormat, MAX_GRASS_INSTANCES, {
            usage: pc.BUFFER_STATIC,
            data: matrices,
        });

        const meshInstance = new pc.MeshInstance(mesh, mat);
        meshInstance.setInstancing(instancingVb, false);

        const activeCount = Math.min(count, Math.max(0, initialCount));
        meshInstance.instancingCount = activeCount;

        const grassEntity = new pc.Entity('InstancedGrassField');
        grassEntity.addComponent('render', {
            meshInstances: [meshInstance],
            castShadows: false,
            receiveShadows: true,
        });
        this.app.root.addChild(grassEntity);

        this.totalGrassPlaced = count;
        this.grassEntity = grassEntity;
        this.grassMeshInstance = meshInstance;
        this.activeGrassCount = activeCount;
    }

    private createBurstSlot(slotIndex: number): BurstEffect {
        const particles: BurstParticle[] = [];

        if (this.burstRingMesh && this.burstShardMesh && this.burstShardMaterial) {
            const ringEntity = new pc.Entity(`CrystalBurstRing_${slotIndex}`);
            ringEntity.addComponent('render', {
                meshInstances: [new pc.MeshInstance(this.burstRingMesh, this.burstShardMaterial)],
                castShadows: false,
                receiveShadows: false,
            });
            ringEntity.enabled = false;
            this.app.root.addChild(ringEntity);
            particles.push({
                entity: ringEntity,
                vx: 0,
                vy: 0.9,
                vz: 0,
                baseScale: 0.7,
                isRing: true,
            });

            const shardCount = 10;
            for (let i = 0; i < shardCount; i++) {
                const shard = new pc.Entity(`CrystalShard_${slotIndex}_${i}`);
                shard.addComponent('render', {
                    meshInstances: [new pc.MeshInstance(this.burstShardMesh, this.burstShardMaterial)],
                    castShadows: false,
                    receiveShadows: false,
                });
                shard.enabled = false;
                this.app.root.addChild(shard);
                particles.push({
                    entity: shard,
                    vx: 0,
                    vy: 0,
                    vz: 0,
                    baseScale: 1.0,
                    isRing: false,
                });
            }
        }

        return {
            active: false,
            elapsed: 0,
            duration: 0.65,
            particles,
        };
    }

    private spawnCollectionBurst(x: number, y: number, z: number): void {
        if (this.burstPool.length === 0) {
            return;
        }

        let slot = this.burstPool.find((b) => !b.active);
        if (!slot) {
            // Reuse oldest active slot if more than pool size fire simultaneously
            slot = this.burstPool.reduce((oldest, curr) =>
                curr.elapsed > oldest.elapsed ? curr : oldest
            );
        }

        slot.active = true;
        slot.elapsed = 0;
        slot.duration = 0.65;

        let shardIdx = 0;
        const shardCount = Math.max(1, slot.particles.length - 1);
        for (const p of slot.particles) {
            p.entity.enabled = true;
            if (p.isRing) {
                p.vx = 0;
                p.vy = 0.9;
                p.vz = 0;
                p.baseScale = 0.7;
                p.entity.setPosition(x, y - 0.3, z);
                p.entity.setLocalScale(0.7, 1, 0.7);
            } else {
                const ang = (shardIdx / shardCount) * Math.PI * 2;
                const speed = 2.2 + (shardIdx % 3) * 0.75;
                p.vx = Math.cos(ang) * speed;
                p.vy = 2.8 + (shardIdx % 2) * 1.1;
                p.vz = Math.sin(ang) * speed;
                p.baseScale = 1.0;
                p.entity.setPosition(x, y, z);
                p.entity.setLocalScale(1, 1, 1);
                shardIdx++;
            }
        }
    }

    private updateBursts(dt: number): void {
        for (const burst of this.burstPool) {
            if (!burst.active) continue;

            burst.elapsed += dt;
            const t = Math.min(1, burst.elapsed / burst.duration);

            for (const p of burst.particles) {
                if (p.isRing) {
                    const s = p.baseScale + t * 4.2;
                    p.entity.setLocalScale(s, Math.max(0.1, 1 - t), s);
                    p.entity.translate(0, p.vy * dt, 0);
                } else {
                    p.vy -= 5.8 * dt;
                    p.entity.translate(p.vx * dt, p.vy * dt, p.vz * dt);
                    const s = Math.max(0.01, p.baseScale * (1 - t));
                    p.entity.setLocalScale(s, s, s);
                }
            }

            if (t >= 1) {
                burst.active = false;
                for (const p of burst.particles) {
                    p.entity.enabled = false;
                }
            }
        }
    }

    private createDriftingSkyClouds(initialQuality: QualitySettings): void {
        const device = this.app.graphicsDevice;
        const cloudMesh = pc.Mesh.fromGeometry(
            device,
            new pc.SphereGeometry({
                radius: 1.0,
                latitudeBands: 7,
                longitudeBands: 10,
            })
        );
        cloudMesh.incRefCount();
        this.cloudMesh = cloudMesh;

        const cloudMat = new pc.StandardMaterial();
        cloudMat.name = 'StylizedSkyCloudMaterial';
        cloudMat.diffuse = new pc.Color(0.98, 0.99, 1.0);
        cloudMat.emissive = new pc.Color(0.84, 0.92, 1.0);
        cloudMat.emissiveIntensity = 0.62;
        cloudMat.gloss = 0.08;
        cloudMat.metalness = 0.0;
        cloudMat.useMetalness = true;
        cloudMat.useFog = false;
        cloudMat.opacity = 0.88;
        cloudMat.blendType = pc.BLEND_NORMAL;
        cloudMat.depthWrite = true;
        cloudMat.update();

        const rng = createSeededRng(WORLD_SEED + 303);
        const clusterCount = 12;
        const puffsPerCluster = MAX_CLOUD_PUFFS / clusterCount;
        this.cloudPuffs.length = 0;

        for (let c = 0; c < clusterCount; c++) {
            const clusterX = (rng() - 0.5) * 210;
            const clusterZ = (rng() - 0.5) * 210;
            const clusterY = 38 + rng() * 14;
            const clusterDrift = 1.15 + rng() * 0.95;
            const clusterYaw = rng() * 360;

            for (let p = 0; p < puffsPerCluster; p++) {
                const isMain = p === 0;
                const ang = (p / Math.max(1, puffsPerCluster - 1)) * Math.PI * 2 + rng() * 0.6;
                const offsetR = isMain ? 0 : 2.8 + rng() * 3.2;
                this.cloudPuffs.push({
                    baseX: clusterX + Math.cos(ang) * offsetR,
                    baseY: clusterY + (isMain ? 0.8 : (rng() - 0.4) * 1.1),
                    baseZ: clusterZ + Math.sin(ang) * offsetR,
                    scaleX: isMain ? 5.6 + rng() * 2.2 : 3.2 + rng() * 2.1,
                    scaleY: isMain ? 2.1 + rng() * 0.65 : 1.35 + rng() * 0.6,
                    scaleZ: isMain ? 4.4 + rng() * 1.8 : 2.8 + rng() * 1.7,
                    yawDeg: clusterYaw + rng() * 30,
                    bobPhase: rng() * Math.PI * 2,
                    driftSpeed: clusterDrift,
                });
            }
        }

        const matrices = new Float32Array(MAX_CLOUD_PUFFS * 16);
        this.cloudMatrices = matrices;
        this.writeCloudMatrices(matrices);

        const vbFormat = pc.VertexFormat.getDefaultInstancingFormat(device);
        const instancingVb = new pc.VertexBuffer(device, vbFormat, MAX_CLOUD_PUFFS, {
            usage: pc.BUFFER_DYNAMIC,
            data: matrices,
        });
        this.cloudInstancingVb = instancingVb;

        const meshInstance = new pc.MeshInstance(cloudMesh, cloudMat);
        meshInstance.setInstancing(instancingVb, false);
        meshInstance.cull = false;
        const initialCount =
            initialQuality.tier === 'low' ? 24 : initialQuality.tier === 'medium' ? 36 : MAX_CLOUD_PUFFS;
        meshInstance.instancingCount = initialCount;
        this.activeCloudCount = initialCount;
        this.cloudMeshInstance = meshInstance;

        const cloudEntity = new pc.Entity('DriftingSkyClouds');
        cloudEntity.addComponent('render', {
            meshInstances: [meshInstance],
            castShadows: false,
            receiveShadows: false,
        });
        cloudEntity.enabled = initialCount > 0;
        this.app.root.addChild(cloudEntity);
        this.cloudEntity = cloudEntity;
    }

    private writeCloudMatrices(matrices: Float32Array): void {
        for (let i = 0; i < this.cloudPuffs.length; i++) {
            const puff = this.cloudPuffs[i];
            const bobY = Math.sin(this.elapsedTime * 0.35 + puff.bobPhase) * 0.35;
            this.tmpCloudPos.set(puff.baseX, puff.baseY + bobY, puff.baseZ);
            this.tmpCloudRot.setFromEulerAngles(0, puff.yawDeg, 0);
            this.tmpCloudScale.set(puff.scaleX, puff.scaleY, puff.scaleZ);
            this.tmpCloudMat.setTRS(this.tmpCloudPos, this.tmpCloudRot, this.tmpCloudScale);
            matrices.set(this.tmpCloudMat.data, i * 16);
        }
    }

    private updateDriftingSkyClouds(dt: number): void {
        if (!this.cloudInstancingVb || !this.cloudMatrices || this.activeCloudCount <= 0) {
            return;
        }
        const windLimit = 122;
        for (let i = 0; i < this.activeCloudCount; i++) {
            const puff = this.cloudPuffs[i];
            puff.baseX += puff.driftSpeed * dt;
            puff.baseZ += puff.driftSpeed * 0.36 * dt;
            if (puff.baseX > windLimit) puff.baseX -= windLimit * 2;
            if (puff.baseZ > windLimit) puff.baseZ -= windLimit * 2;
        }
        this.writeCloudMatrices(this.cloudMatrices);
        this.cloudInstancingVb.setData(this.cloudMatrices);
    }

    private createHabitatClearingAccents(): void {
        const device = this.app.graphicsDevice;
        const rng = createSeededRng(WORLD_SEED + 606);

        // Habitat clearings matching wild monster zones across the island
        const floraSpots: ReadonlyArray<{ x: number; z: number }> = [
            { x: -16, z: -18 },
            { x: 18, z: 16 },
        ];
        const aetherSpots: ReadonlyArray<{ x: number; z: number }> = [
            { x: -8, z: -42 },
            { x: -38, z: -18 },
        ];
        const terraSpots: ReadonlyArray<{ x: number; z: number }> = [
            { x: 42, z: -26 },
            { x: -40, z: 42 },
        ];

        // 1. Flora clearing mossy stepping stones (1 instanced draw call)
        const floraMesh = pc.Mesh.fromGeometry(
            device,
            new pc.CylinderGeometry({
                radius: 0.45,
                height: 0.16,
                heightSegments: 1,
                capSegments: 8,
            })
        );
        floraMesh.incRefCount();
        this.habitatMeshes.push(floraMesh);

        const floraMat = new pc.StandardMaterial();
        floraMat.name = 'HabitatFloraStoneMat';
        floraMat.diffuse = new pc.Color(0.32, 0.72, 0.38);
        floraMat.gloss = 0.25;
        floraMat.metalness = 0.0;
        floraMat.useMetalness = true;
        floraMat.update();

        const floraCount = this.spawnInstancedClearingRing(
            'HabitatFloraAccents',
            floraMesh,
            floraMat,
            floraSpots,
            7,
            2.6,
            5.8,
            [0.65, 1.35],
            [0.7, 1.35],
            rng
        );

        // 2. Aether clearing glowing runic shards (1 instanced draw call)
        const aetherMesh = pc.Mesh.fromGeometry(
            device,
            new pc.ConeGeometry({
                baseRadius: 0.22,
                peakRadius: 0.03,
                height: 0.75,
                heightSegments: 1,
                capSegments: 5,
            })
        );
        aetherMesh.incRefCount();
        this.habitatMeshes.push(aetherMesh);

        const aetherMat = new pc.StandardMaterial();
        aetherMat.name = 'HabitatAetherShardMat';
        aetherMat.diffuse = new pc.Color(0.24, 0.92, 1.0);
        aetherMat.emissive = new pc.Color(0.18, 0.85, 0.98);
        aetherMat.emissiveIntensity = 1.45;
        aetherMat.gloss = 0.8;
        aetherMat.metalness = 0.1;
        aetherMat.useMetalness = true;
        aetherMat.update();

        const aetherCount = this.spawnInstancedClearingRing(
            'HabitatAetherAccents',
            aetherMesh,
            aetherMat,
            aetherSpots,
            6,
            2.4,
            5.4,
            [0.7, 1.25],
            [0.75, 1.45],
            rng
        );

        // 3. Terra clearing weathered basalt cairns (1 instanced draw call)
        const terraMesh = pc.Mesh.fromGeometry(
            device,
            new pc.BoxGeometry({
                halfExtents: new pc.Vec3(0.28, 0.24, 0.26),
            })
        );
        terraMesh.incRefCount();
        this.habitatMeshes.push(terraMesh);

        const terraMat = new pc.StandardMaterial();
        terraMat.name = 'HabitatTerraCairnMat';
        terraMat.diffuse = new pc.Color(0.58, 0.41, 0.31);
        terraMat.emissive = new pc.Color(0.32, 0.17, 0.06);
        terraMat.emissiveIntensity = 0.22;
        terraMat.gloss = 0.2;
        terraMat.metalness = 0.05;
        terraMat.useMetalness = true;
        terraMat.update();

        const terraCount = this.spawnInstancedClearingRing(
            'HabitatTerraAccents',
            terraMesh,
            terraMat,
            terraSpots,
            6,
            2.8,
            6.2,
            [0.75, 1.4],
            [0.7, 1.3],
            rng
        );

        this.habitatAccentCount = floraCount + aetherCount + terraCount;
    }

    private spawnInstancedClearingRing(
        entityName: string,
        mesh: pc.Mesh,
        material: pc.StandardMaterial,
        centers: ReadonlyArray<{ x: number; z: number }>,
        perCenter: number,
        minRadius: number,
        maxRadius: number,
        xzScaleRange: readonly [number, number],
        yScaleRange: readonly [number, number],
        rng: () => number
    ): number {
        const total = centers.length * perCenter;
        if (total <= 0) return 0;

        const matrices = new Float32Array(total * 16);
        const pos = new pc.Vec3();
        const rot = new pc.Quat();
        const scale = new pc.Vec3();
        const mat = new pc.Mat4();
        let idx = 0;

        for (const center of centers) {
            for (let i = 0; i < perCenter; i++) {
                const ang = (i / perCenter) * Math.PI * 2 + (rng() - 0.5) * 0.55;
                const rad = minRadius + rng() * (maxRadius - minRadius);
                const x = center.x + Math.cos(ang) * rad;
                const z = center.z + Math.sin(ang) * rad;
                const y = this.collisionWorld.getTerrainHeight(x, z);

                const sXZ = xzScaleRange[0] + rng() * (xzScaleRange[1] - xzScaleRange[0]);
                const sY = yScaleRange[0] + rng() * (yScaleRange[1] - yScaleRange[0]);
                pos.set(x, y + 0.05 * sY, z);
                rot.setFromEulerAngles((rng() - 0.5) * 14, rng() * 360, (rng() - 0.5) * 14);
                scale.set(sXZ, sY, sXZ);
                mat.setTRS(pos, rot, scale);
                matrices.set(mat.data, idx * 16);
                idx++;
            }
        }

        const device = this.app.graphicsDevice;
        const vbFormat = pc.VertexFormat.getDefaultInstancingFormat(device);
        const vb = new pc.VertexBuffer(device, vbFormat, idx, {
            usage: pc.BUFFER_STATIC,
            data: matrices,
        });
        const mi = new pc.MeshInstance(mesh, material);
        mi.setInstancing(vb, false);
        mi.instancingCount = idx;

        const entity = new pc.Entity(entityName);
        entity.addComponent('render', {
            meshInstances: [mi],
            castShadows: false,
            receiveShadows: true,
        });
        this.app.root.addChild(entity);
        this.habitatEntities.push(entity);
        return idx;
    }
}
