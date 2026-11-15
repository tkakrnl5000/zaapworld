import * as pc from 'playcanvas';
import { CollisionWorld } from '../physics/CollisionWorld';

const TERRAIN_SIZE = 240;
const TERRAIN_SEGMENTS = 160;
const LAKE_CENTER_X = 28;
const LAKE_CENTER_Z = 28;
const WATER_SIZE = 54;
const WATER_SEGMENTS = 48;

function clamp(v: number, min: number, max: number): number {
    return v < min ? min : v > max ? max : v;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
    const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
    return t * t * (3 - 2 * t);
}

function lerp(a: number, b: number, t: number): number {
    return a + (b - a) * t;
}

function mixRgb(
    out: [number, number, number],
    a: readonly [number, number, number],
    b: readonly [number, number, number],
    t: number
): void {
    out[0] = lerp(a[0], b[0], t);
    out[1] = lerp(a[1], b[1], t);
    out[2] = lerp(a[2], b[2], t);
}

export interface BuiltTerrainResult {
    terrainEntity: pc.Entity;
    waterEntity: pc.Entity;
    updateWater(elapsedTime: number): void;
}

/**
 * Builds the 160x160 stylized open-field terrain mesh with splatted vertex colors + micro-grain texture,
 * and the semi-transparent animated water mesh at y = 0.0 over the crystal lake basin.
 */
export class TerrainBuilder {
    private readonly app: pc.Application;
    private readonly collisionWorld: CollisionWorld;

    constructor(app: pc.Application, collisionWorld: CollisionWorld) {
        this.app = app;
        this.collisionWorld = collisionWorld;
    }

    build(): BuiltTerrainResult {
        const terrainEntity = this.buildTerrainEntity();
        const { waterEntity, updateWater } = this.buildWaterEntity();

        return {
            terrainEntity,
            waterEntity,
            updateWater,
        };
    }

    private buildTerrainEntity(): pc.Entity {
        const device = this.app.graphicsDevice;
        const gridCount = TERRAIN_SEGMENTS + 1;
        const vertexCount = gridCount * gridCount;
        const half = TERRAIN_SIZE * 0.5;
        const step = TERRAIN_SIZE / TERRAIN_SEGMENTS;

        const positions = new Float32Array(vertexCount * 3);
        const normals = new Float32Array(vertexCount * 3);
        const uvs = new Float32Array(vertexCount * 2);
        const colors = new Uint8Array(vertexCount * 4);

        const tmpNormal = new pc.Vec3();
        const rgb: [number, number, number] = [0, 0, 0];
        const grassBase: [number, number, number] = [0, 0, 0];
        const cliffRgb: [number, number, number] = [0, 0, 0];

        // Stylized vibrant color palette (0..1 sRGB)
        const MEADOW_EMERALD: readonly [number, number, number] = [0.24, 0.72, 0.28];
        const MEADOW_SUNLIT: readonly [number, number, number] = [0.43, 0.82, 0.30];
        const MEADOW_DEEP: readonly [number, number, number] = [0.16, 0.56, 0.25];
        const TRAIL_CORE: readonly [number, number, number] = [0.80, 0.65, 0.39];
        const TRAIL_EDGE: readonly [number, number, number] = [0.64, 0.53, 0.33];
        const SHORE_SAND: readonly [number, number, number] = [0.90, 0.82, 0.58];
        const LAKEBED_AQUA: readonly [number, number, number] = [0.22, 0.58, 0.60];
        const PLATEAU_STONE: readonly [number, number, number] = [0.60, 0.63, 0.56];
        const PLATEAU_MOSS: readonly [number, number, number] = [0.30, 0.65, 0.34];
        const CLIFF_SLATE: readonly [number, number, number] = [0.36, 0.42, 0.50];
        const CLIFF_HIGHLIGHT: readonly [number, number, number] = [0.54, 0.57, 0.62];

        for (let gz = 0; gz < gridCount; gz++) {
            const z = -half + gz * step;
            const v = gz / TERRAIN_SEGMENTS;

            for (let gx = 0; gx < gridCount; gx++) {
                const x = -half + gx * step;
                const u = gx / TERRAIN_SEGMENTS;
                const idx = gz * gridCount + gx;

                const y = this.collisionWorld.getTerrainHeight(x, z);
                this.collisionWorld.getTerrainNormal(x, z, tmpNormal);

                positions[idx * 3] = x;
                positions[idx * 3 + 1] = y;
                positions[idx * 3 + 2] = z;

                normals[idx * 3] = tmpNormal.x;
                normals[idx * 3 + 1] = tmpNormal.y;
                normals[idx * 3 + 2] = tmpNormal.z;

                uvs[idx * 2] = u;
                uvs[idx * 2 + 1] = v;

                // Procedural splat weights
                const slope = 1 - tmpNormal.y; // 0 = flat, ~0.29 = 45 deg
                const patch =
                    0.5 +
                    0.5 *
                        Math.sin(x * 0.085 + z * 0.065) *
                        Math.cos(x * 0.055 - z * 0.105);
                const speckle = 0.5 + 0.5 * Math.sin(x * 0.42 - z * 0.37);

                // 1. Emerald meadow base
                mixRgb(grassBase, MEADOW_EMERALD, MEADOW_SUNLIT, patch * 0.85);
                const hollowShade = 1 - smoothstep(1.3, 2.7, y);
                mixRgb(grassBase, grassBase, MEADOW_DEEP, hollowShade * 0.45);
                rgb[0] = grassBase[0];
                rgb[1] = grassBase[1];
                rgb[2] = grassBase[2];

                // 2. Sandy shoreline & crystal lakebed
                const dLake = Math.hypot(x - LAKE_CENTER_X, z - LAKE_CENTER_Z);
                if (dLake < 26 || y < 1.1) {
                    const shoreWeight = (1 - smoothstep(0.05, 1.05, y)) * (1 - smoothstep(21, 27, dLake) * 0.65);
                    if (y < -0.25) {
                        const deepBlend = smoothstep(-0.25, -1.25, y);
                        mixRgb(rgb, SHORE_SAND, LAKEBED_AQUA, deepBlend * 0.85);
                    } else if (shoreWeight > 0) {
                        mixRgb(rgb, rgb, SHORE_SAND, shoreWeight);
                    }
                }

                // 3. Mossy plateau stone on Sanctuary & Outpost pads
                const dSanctuary = Math.hypot(x, z + 48);
                const dOutpostW = Math.hypot(x + 46, z + 16);
                const dOutpostE = Math.hypot(x - 48, z + 20);
                const plateauStoneWeight = Math.max(
                    (1 - smoothstep(7.5, 12.0, dSanctuary)) * smoothstep(7.2, 8.2, y),
                    1 - smoothstep(3.5, 6.0, dOutpostW),
                    1 - smoothstep(3.5, 6.0, dOutpostE)
                );
                if (plateauStoneWeight > 0) {
                    const stonePatch = smoothstep(0.25, 0.78, patch);
                    const stoneR = lerp(PLATEAU_MOSS[0], PLATEAU_STONE[0], stonePatch);
                    const stoneG = lerp(PLATEAU_MOSS[1], PLATEAU_STONE[1], stonePatch);
                    const stoneB = lerp(PLATEAU_MOSS[2], PLATEAU_STONE[2], stonePatch);
                    rgb[0] = lerp(rgb[0], stoneR, plateauStoneWeight * 0.88);
                    rgb[1] = lerp(rgb[1], stoneG, plateauStoneWeight * 0.88);
                    rgb[2] = lerp(rgb[2], stoneB, plateauStoneWeight * 0.88);
                }

                // 4. Warm golden dirt trails
                const trailMask = this.collisionWorld.getTrailMask(x, z);
                if (trailMask > 0.01) {
                    const organicTrail = clamp(trailMask + (speckle - 0.5) * 0.14 * trailMask, 0, 1);
                    const coreMix = smoothstep(0.2, 0.85, organicTrail);
                    const trailR = lerp(TRAIL_EDGE[0], TRAIL_CORE[0], coreMix);
                    const trailG = lerp(TRAIL_EDGE[1], TRAIL_CORE[1], coreMix);
                    const trailB = lerp(TRAIL_EDGE[2], TRAIL_CORE[2], coreMix);
                    rgb[0] = lerp(rgb[0], trailR, organicTrail * 0.92);
                    rgb[1] = lerp(rgb[1], trailG, organicTrail * 0.92);
                    rgb[2] = lerp(rgb[2], trailB, organicTrail * 0.92);
                }

                // 5. Slate cliff faces & perimeter ridge rock
                const cliffWeight = smoothstep(0.10, 0.28, slope);
                const ridgeWeight = smoothstep(9.0, 14.5, y) * 0.9;
                const rockWeight = clamp(Math.max(cliffWeight, ridgeWeight) * (1 - trailMask * 0.85), 0, 1);
                if (rockWeight > 0.01) {
                    const strata = 0.5 + 0.5 * Math.sin(y * 1.85 + x * 0.11 + z * 0.08);
                    mixRgb(cliffRgb, CLIFF_SLATE, CLIFF_HIGHLIGHT, strata * 0.72);
                    rgb[0] = lerp(rgb[0], cliffRgb[0], rockWeight);
                    rgb[1] = lerp(rgb[1], cliffRgb[1], rockWeight);
                    rgb[2] = lerp(rgb[2], cliffRgb[2], rockWeight);
                }

                // Subtle ambient micro-contrast
                const micro = 0.95 + 0.08 * speckle;
                colors[idx * 4] = clamp(Math.round(rgb[0] * micro * 255), 0, 255);
                colors[idx * 4 + 1] = clamp(Math.round(rgb[1] * micro * 255), 0, 255);
                colors[idx * 4 + 2] = clamp(Math.round(rgb[2] * micro * 255), 0, 255);
                colors[idx * 4 + 3] = 255;
            }
        }

        const indexCount = TERRAIN_SEGMENTS * TERRAIN_SEGMENTS * 6;
        const indices = new Uint16Array(indexCount);
        let ptr = 0;
        for (let gz = 0; gz < TERRAIN_SEGMENTS; gz++) {
            for (let gx = 0; gx < TERRAIN_SEGMENTS; gx++) {
                const i0 = gz * gridCount + gx;
                const i1 = i0 + 1;
                const i2 = i0 + gridCount;
                const i3 = i2 + 1;

                // Counter-clockwise winding for +Y upward normal
                indices[ptr++] = i0;
                indices[ptr++] = i2;
                indices[ptr++] = i1;

                indices[ptr++] = i1;
                indices[ptr++] = i2;
                indices[ptr++] = i3;
            }
        }

        const mesh = new pc.Mesh(device);
        mesh.setPositions(positions);
        mesh.setNormals(normals);
        mesh.setUvs(0, uvs);
        mesh.setColors32(colors);
        mesh.setIndices(indices);
        mesh.update(pc.PRIMITIVE_TRIANGLES, true);

        const detailTex = this.createTerrainDetailTexture(device);
        const material = new pc.StandardMaterial();
        material.name = 'TerrainSplatMaterial';
        material.diffuse = new pc.Color(1, 1, 1);
        material.diffuseMap = detailTex;
        material.diffuseMapTiling = new pc.Vec2(42, 42);
        material.diffuseVertexColor = true;
        material.useMetalness = true;
        material.metalness = 0.0;
        material.gloss = 0.16;
        material.update();

        const meshInstance = new pc.MeshInstance(mesh, material);
        const entity = new pc.Entity('Terrain');
        entity.addComponent('render', {
            meshInstances: [meshInstance],
            castShadows: false,
            receiveShadows: true,
        });

        this.app.root.addChild(entity);
        return entity;
    }

    private buildWaterEntity(): {
        waterEntity: pc.Entity;
        updateWater: (elapsedTime: number) => void;
    } {
        const device = this.app.graphicsDevice;
        const gridCount = WATER_SEGMENTS + 1;
        const vertexCount = gridCount * gridCount;
        const half = WATER_SIZE * 0.5;
        const step = WATER_SIZE / WATER_SEGMENTS;
        const waterLevel = this.collisionWorld.getWaterLevel();

        const positions = new Float32Array(vertexCount * 3);
        const normals = new Float32Array(vertexCount * 3);
        const baseUvs = new Float32Array(vertexCount * 2);
        const animUvs = new Float32Array(vertexCount * 2);
        const colors = new Uint8Array(vertexCount * 4);
        const depths = new Float32Array(vertexCount);
        const worldCoords = new Float32Array(vertexCount * 2);

        for (let gz = 0; gz < gridCount; gz++) {
            const z = LAKE_CENTER_Z - half + gz * step;
            const v = (gz / WATER_SEGMENTS) * 4.5;

            for (let gx = 0; gx < gridCount; gx++) {
                const x = LAKE_CENTER_X - half + gx * step;
                const u = (gx / WATER_SEGMENTS) * 4.5;
                const idx = gz * gridCount + gx;

                const bedH = this.collisionWorld.getTerrainHeight(x, z);
                const depth = waterLevel - bedH;
                depths[idx] = depth;
                worldCoords[idx * 2] = x;
                worldCoords[idx * 2 + 1] = z;

                positions[idx * 3] = x;
                positions[idx * 3 + 1] = waterLevel;
                positions[idx * 3 + 2] = z;

                normals[idx * 3] = 0;
                normals[idx * 3 + 1] = 1;
                normals[idx * 3 + 2] = 0;

                baseUvs[idx * 2] = u;
                baseUvs[idx * 2 + 1] = v;
                animUvs[idx * 2] = u;
                animUvs[idx * 2 + 1] = v;

                // Initial vertex color + depth-based alpha
                const alpha = depth <= -0.15 ? 0 : Math.round(clamp(0.42 + depth * 0.34, 0.38, 0.84) * 255);
                colors[idx * 4] = 95;
                colors[idx * 4 + 1] = 228;
                colors[idx * 4 + 2] = 238;
                colors[idx * 4 + 3] = alpha;
            }
        }

        const indices = new Uint16Array(WATER_SEGMENTS * WATER_SEGMENTS * 6);
        let ptr = 0;
        for (let gz = 0; gz < WATER_SEGMENTS; gz++) {
            for (let gx = 0; gx < WATER_SEGMENTS; gx++) {
                const i0 = gz * gridCount + gx;
                const i1 = i0 + 1;
                const i2 = i0 + gridCount;
                const i3 = i2 + 1;

                indices[ptr++] = i0;
                indices[ptr++] = i2;
                indices[ptr++] = i1;

                indices[ptr++] = i1;
                indices[ptr++] = i2;
                indices[ptr++] = i3;
            }
        }

        const mesh = new pc.Mesh(device);
        mesh.setPositions(positions);
        mesh.setNormals(normals);
        mesh.setUvs(0, animUvs);
        mesh.setColors32(colors);
        mesh.setIndices(indices);
        mesh.update(pc.PRIMITIVE_TRIANGLES, true);

        const causticTex = this.createWaterCausticTexture(device);
        const material = new pc.StandardMaterial();
        material.name = 'CrystalLakeWaterMaterial';
        material.diffuse = new pc.Color(0.88, 0.98, 1.0);
        material.diffuseMap = causticTex;
        material.diffuseVertexColor = true;
        material.opacityVertexColor = true;
        material.opacityVertexColorChannel = 'a';
        material.emissive = new pc.Color(0.08, 0.36, 0.44);
        material.emissiveMap = causticTex;
        material.emissiveIntensity = 0.55;
        material.opacity = 0.88;
        material.blendType = pc.BLEND_NORMAL;
        material.depthWrite = false;
        material.useMetalness = true;
        material.metalness = 0.08;
        material.gloss = 0.88;
        material.update();

        const meshInstance = new pc.MeshInstance(mesh, material);
        const waterEntity = new pc.Entity('CrystalLakeWater');
        waterEntity.addComponent('render', {
            meshInstances: [meshInstance],
            castShadows: false,
            receiveShadows: true,
        });
        this.app.root.addChild(waterEntity);

        const updateWater = (elapsedTime: number): void => {
            const scrollU = elapsedTime * 0.045;
            const scrollV = elapsedTime * 0.032;

            for (let i = 0; i < vertexCount; i++) {
                const depth = depths[i];
                const wx = worldCoords[i * 2];
                const wz = worldCoords[i * 2 + 1];

                // Gentle wave height modulated by depth so shore edge stays cleanly anchored
                const ampMask = clamp(depth * 1.4, 0, 1);
                const wave =
                    Math.sin(wx * 0.46 + elapsedTime * 2.1) *
                    Math.cos(wz * 0.41 - elapsedTime * 1.65);
                const wave2 = Math.sin((wx + wz) * 0.28 - elapsedTime * 1.4);
                positions[i * 3 + 1] = waterLevel + (wave * 0.032 + wave2 * 0.018) * ampMask;

                // Animated shimmer UV drift
                animUvs[i * 2] = baseUvs[i * 2] + scrollU + Math.sin(wz * 0.22 + elapsedTime) * 0.025;
                animUvs[i * 2 + 1] = baseUvs[i * 2 + 1] + scrollV + Math.cos(wx * 0.22 - elapsedTime) * 0.025;

                // Shoreline foam + depth tint
                if (depth <= -0.1) {
                    colors[i * 4 + 3] = 0;
                } else {
                    const shoreBand = 1 - smoothstep(0.0, 0.42, depth);
                    const foamPulse = 0.5 + 0.5 * Math.sin(elapsedTime * 3.0 + wx * 0.5 + wz * 0.5);
                    const foam = shoreBand * (0.6 + 0.4 * foamPulse);
                    const deepT = smoothstep(0.25, 1.35, depth);

                    const r = lerp(lerp(0.32, 0.12, deepT), 0.96, foam);
                    const g = lerp(lerp(0.88, 0.66, deepT), 0.99, foam);
                    const b = lerp(lerp(0.92, 0.80, deepT), 1.0, foam);
                    const a = clamp(0.46 + depth * 0.28 + foam * 0.28, 0.42, 0.86);

                    colors[i * 4] = Math.round(r * 255);
                    colors[i * 4 + 1] = Math.round(g * 255);
                    colors[i * 4 + 2] = Math.round(b * 255);
                    colors[i * 4 + 3] = Math.round(a * 255);
                }
            }

            mesh.setPositions(positions);
            mesh.setUvs(0, animUvs);
            mesh.setColors32(colors);
            mesh.update(pc.PRIMITIVE_TRIANGLES, false);
        };

        return { waterEntity, updateWater };
    }

    private createTerrainDetailTexture(device: pc.GraphicsDevice): pc.Texture {
        const size = 128;
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');
        if (ctx) {
            const img = ctx.createImageData(size, size);
            let seed = 1337;
            const nextRand = (): number => {
                seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
                return seed / 4294967296;
            };
            for (let y = 0; y < size; y++) {
                for (let x = 0; x < size; x++) {
                    const p = (y * size + x) * 4;
                    const wave =
                        0.5 +
                        0.5 *
                            Math.sin((x / size) * Math.PI * 6) *
                            Math.cos((y / size) * Math.PI * 6);
                    const grain = (nextRand() - 0.5) * 24;
                    const val = clamp(Math.round(236 + (wave - 0.5) * 16 + grain), 205, 255);
                    img.data[p] = val;
                    img.data[p + 1] = val;
                    img.data[p + 2] = clamp(val - 2, 200, 255);
                    img.data[p + 3] = 255;
                }
            }
            ctx.putImageData(img, 0, 0);
        }

        const tex = new pc.Texture(device, {
            name: 'TerrainDetailTex',
            width: size,
            height: size,
            format: pc.PIXELFORMAT_RGBA8,
            srgb: true,
            mipmaps: true,
            minFilter: pc.FILTER_LINEAR_MIPMAP_LINEAR,
            magFilter: pc.FILTER_LINEAR,
            addressU: pc.ADDRESS_REPEAT,
            addressV: pc.ADDRESS_REPEAT,
            anisotropy: 4,
        });
        tex.setSource(canvas);
        return tex;
    }

    private createWaterCausticTexture(device: pc.GraphicsDevice): pc.Texture {
        const size = 128;
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');
        if (ctx) {
            ctx.fillStyle = '#6fe6f2';
            ctx.fillRect(0, 0, size, size);

            // Tileable stylized caustic cells
            const pts: Array<[number, number]> = [
                [18, 22], [62, 16], [104, 28],
                [32, 64], [78, 58], [116, 72],
                [20, 108], [66, 102], [102, 110],
            ];
            const img = ctx.getImageData(0, 0, size, size);
            for (let y = 0; y < size; y++) {
                for (let x = 0; x < size; x++) {
                    let minD1 = 9999;
                    let minD2 = 9999;
                    for (const [px, py] of pts) {
                        let dx = Math.abs(x - px);
                        let dy = Math.abs(y - py);
                        if (dx > size * 0.5) dx = size - dx;
                        if (dy > size * 0.5) dy = size - dy;
                        const d = Math.hypot(dx, dy);
                        if (d < minD1) {
                            minD2 = minD1;
                            minD1 = d;
                        } else if (d < minD2) {
                            minD2 = d;
                        }
                    }
                    const ridge = clamp(1 - (minD2 - minD1) / 8.5, 0, 1);
                    const glow = Math.pow(ridge, 2.2);
                    const p = (y * size + x) * 4;
                    img.data[p] = clamp(Math.round(130 + glow * 125), 0, 255);
                    img.data[p + 1] = clamp(Math.round(225 + glow * 30), 0, 255);
                    img.data[p + 2] = clamp(Math.round(238 + glow * 17), 0, 255);
                    img.data[p + 3] = 255;
                }
            }
            ctx.putImageData(img, 0, 0);
        }

        const tex = new pc.Texture(device, {
            name: 'WaterCausticTex',
            width: size,
            height: size,
            format: pc.PIXELFORMAT_RGBA8,
            srgb: true,
            mipmaps: true,
            minFilter: pc.FILTER_LINEAR_MIPMAP_LINEAR,
            magFilter: pc.FILTER_LINEAR,
            addressU: pc.ADDRESS_REPEAT,
            addressV: pc.ADDRESS_REPEAT,
        });
        tex.setSource(canvas);
        return tex;
    }
}
