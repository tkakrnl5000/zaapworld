import * as pc from 'playcanvas';
import {
    ColliderVolume,
    ICollisionWorld,
    RaycastHit,
} from '../types/interfaces';

const WORLD_HALF_SIZE = 120;
const PLAYABLE_MAX_RADIUS = 108;
const SPATIAL_CELL_SIZE = 8;
const MAX_WALKABLE_SLOPE_COS = Math.cos((48 * Math.PI) / 180); // ~0.66913
const PLAYER_HEIGHT = 1.75;

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

/** Deterministic 2D hash in [0, 1). */
function hash2D(ix: number, iz: number): number {
    let n = Math.imul(ix, 374761393) + Math.imul(iz, 668265263);
    n = (n ^ (n >>> 13)) >>> 0;
    n = Math.imul(n, 1274126177) >>> 0;
    return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}

/** C2-continuous quintic 2D value noise in [0, 1]. */
function valueNoise2D(x: number, z: number): number {
    const ix = Math.floor(x);
    const iz = Math.floor(z);
    const fx = x - ix;
    const fz = z - iz;

    const u = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
    const v = fz * fz * fz * (fz * (fz * 6 - 15) + 10);

    const a = hash2D(ix, iz);
    const b = hash2D(ix + 1, iz);
    const c = hash2D(ix, iz + 1);
    const d = hash2D(ix + 1, iz + 1);

    return lerp(lerp(a, b, u), lerp(c, d, u), v);
}

/** 3-octave FBM in [-1, 1]. */
function fbm2D(x: number, z: number): number {
    let sum = 0;
    let amp = 0.55;
    let freq = 1;
    let norm = 0;
    for (let i = 0; i < 3; i++) {
        sum += (valueNoise2D(x * freq, z * freq) * 2 - 1) * amp;
        norm += amp;
        amp *= 0.5;
        freq *= 2.07;
    }
    return sum / norm;
}

/**
 * Computes winding trail centerline X for the northern Sanctuary ascent (z in [-42, 14]).
 */
export function getNorthTrailCenterX(z: number): number {
    const env = smoothstep(14, 2, z) * smoothstep(-44, -33, z);
    const phase = ((12 - z) / 52) * Math.PI * 1.75;
    return 6.2 * Math.sin(phase) * env;
}

/**
 * Computes winding trail centerline X for the southern meadow path (z in [12, 86]).
 */
export function getSouthTrailCenterX(z: number): number {
    const env = smoothstep(10, 22, z) * smoothstep(88, 72, z);
    const phase = ((z - 12) / 72) * Math.PI * 1.55;
    return 7.5 * Math.sin(phase) * env;
}

/**
 * Returns trail mask in [0, 1] at world (x, z) for terrain sculpting, painting, and prop exclusion.
 */
export function sampleTrailMask(x: number, z: number): number {
    let mask = 0;

    // 1. North Sanctuary trail from (0, 12) up to (0, -43)
    if (z >= -46 && z <= 16) {
        const cx = getNorthTrailCenterX(clamp(z, -43, 12));
        const dz = z < -43 ? -43 - z : z > 12 ? z - 12 : 0;
        const d = Math.hypot(x - cx, dz);
        const halfWidth = 3.2;
        mask = Math.max(mask, 1 - smoothstep(halfWidth * 0.45, halfWidth, d));
    }

    // 2. South Valley trail from (0, 12) toward (0, 84)
    if (z >= 10 && z <= 88) {
        const cx = getSouthTrailCenterX(clamp(z, 12, 84));
        const dz = z < 12 ? 12 - z : z > 84 ? z - 84 : 0;
        const d = Math.hypot(x - cx, dz);
        const halfWidth = 3.0;
        mask = Math.max(mask, 1 - smoothstep(halfWidth * 0.45, halfWidth, d));
    }

    // 3. Scenic lakeside branch from (2, 16) toward western sandy beach (14.5, 24)
    {
        const ax = 2;
        const az = 16;
        const bx = 14.5;
        const bz = 24;
        const abx = bx - ax;
        const abz = bz - az;
        const lenSq = abx * abx + abz * abz;
        const t = clamp(((x - ax) * abx + (z - az) * abz) / lenSq, 0, 1);
        const px = ax + abx * t;
        const pz = az + abz * t;
        const d = Math.hypot(x - px, z - pz);
        mask = Math.max(mask, 1 - smoothstep(1.3, 2.7, d));
    }

    return clamp(mask, 0, 1);
}

/**
 * Analytical island terrain heightfield (240m x 240m) used by both physics and mesh builder.
 */
export function sampleIslandHeight(x: number, z: number): number {
    // Base rolling meadow & hills
    const rolling =
        2.35 +
        1.65 * fbm2D(x * 0.018 + 3.1, z * 0.018 - 1.7) +
        0.55 * Math.sin(x * 0.055) * Math.cos(z * 0.052);

    // Gentle central spawn meadow around (0, 0) to (0, 14) at ~2.2m
    const dSpawn = Math.hypot(x * 0.9, z - 6.5);
    const spawnFlat = 1 - smoothstep(10, 22, dSpawn);
    const spawnHeight = 2.2 + 0.08 * Math.sin(x * 0.14) * Math.cos(z * 0.14);
    let h = lerp(rolling, spawnHeight, spawnFlat * 0.92);

    // Scenic rolling hill knolls around the valley (away from spawn/lake/center trail)
    const westKnoll = Math.exp(-((x + 48) * (x + 48) + (z + 16) * (z + 16)) / (2 * 16 * 16));
    const eastKnoll = Math.exp(-((x - 48) * (x - 48) + (z + 20) * (z + 20)) / (2 * 17 * 17));
    const southWestHill = Math.exp(-((x + 44) * (x + 44) + (z - 46) * (z - 46)) / (2 * 18 * 18));
    h += westKnoll * 3.1 + eastKnoll * 3.2 + southWestHill * 2.6;

    // Flatten small stone pads for the 2 scenic ruin outposts
    const dOutpostW = Math.hypot(x + 46, z + 16);
    const outpostWMask = 1 - smoothstep(5.5, 11, dOutpostW);
    h = lerp(h, 5.2, outpostWMask * 0.9);

    const dOutpostE = Math.hypot(x - 48, z + 20);
    const outpostEMask = 1 - smoothstep(5.5, 11, dOutpostE);
    h = lerp(h, 5.4, outpostEMask * 0.9);

    // Elevated Ancient Ruin Sanctuary plateau at (0, -48) at height ~8.5m
    // Slightly steep cliff flanks on N/W/E, smooth trail approach on S
    const dxPlat = x;
    const dzPlat = z + 48;
    const dPlat = Math.hypot(dxPlat, dzPlat);
    const anglePlat = Math.atan2(dzPlat, dxPlat);
    const platEdgeJitter = 1.1 * Math.sin(anglePlat * 4 + 0.4) + 0.7 * Math.cos(anglePlat * 3 - 0.9);
    const platInnerR = 11.2 + platEdgeJitter * 0.5;
    // South approach ramp spans z in [-40, -2] along north trail; keep flank steep outside south corridor
    const southCorridor = smoothstep(14, 4.5, Math.abs(x - getNorthTrailCenterX(clamp(z, -42, 0)))) * smoothstep(-48, -36, z);
    const platOuterR = lerp(16.2 + platEdgeJitter, 28, southCorridor);
    const platMask = 1 - smoothstep(platInnerR, platOuterR, dPlat);
    h = lerp(h, 8.5, platMask);

    // Winding North ramp sculpting along trail from z = -2 (2.2m) up to z = -40 (8.5m)
    if (z >= -44 && z <= 4) {
        const trailCx = getNorthTrailCenterX(clamp(z, -43, 12));
        const dTrail = Math.abs(x - trailCx);
        const rampBlend = (1 - smoothstep(3.2, 8.8, dTrail)) * smoothstep(2, -5, z) * smoothstep(-45, -37, z);
        const rampProgress = smoothstep(-2, -37, z);
        const rampTargetH = lerp(2.2, 8.5, rampProgress);
        h = lerp(h, rampTargetH, rampBlend * 0.92);
    }

    // Crystal lake basin around (28, 28) dipping down to -1.4m (water level 0.0)
    const lx = x - 28;
    const lz = z - 28;
    const dLake = Math.hypot(lx, lz);
    const lakeAngle = Math.atan2(lz, lx);
    const lakeWobble = 1.6 * Math.sin(lakeAngle * 3 + 0.6) + 1.0 * Math.cos(lakeAngle * 2 - 0.4);
    const lakeShoreOuter = 20.5 + lakeWobble;
    const lakeBasinMask = 1 - smoothstep(3.5, lakeShoreOuter, dLake);
    // Use sharper basin bowl inside shoreline so center reaches -1.4m and shoreline crosses 0.0m cleanly
    const deepBowl = Math.pow(lakeBasinMask, 0.88);
    h = lerp(h, -1.42, deepBowl);

    // Subtle trail leveling on South & Lakeside trails for clean footing
    const southTrailMask = sampleTrailMask(x, z);
    if (southTrailMask > 0 && z > 10) {
        const smoothPathNoise = 2.15 + 0.45 * Math.sin(z * 0.045);
        h = lerp(h, Math.max(0.45, Math.min(h, smoothPathNoise + 0.9)), southTrailMask * 0.35);
    }

    // Outer perimeter mountain ridge (10m..22m) around radius 95..120m
    const radialDist = Math.hypot(x, z);
    if (radialDist > 76) {
        const ridgeRamp = smoothstep(78, 108, radialDist);
        const theta = Math.atan2(z, x);
        const ridgePeaks =
            11.2 +
            4.6 * (0.5 + 0.5 * Math.sin(theta * 5 + 0.9)) +
            3.2 * (0.5 + 0.5 * Math.cos(theta * 9 - 0.4)) +
            3.4 * (0.5 + 0.5 * fbm2D(x * 0.045 + 7.2, z * 0.045 - 4.8));
        // Slight notch on south-east for visual depth, still >= 10m at rim
        const ridgeHeight = clamp(ridgePeaks, 10.2, 22.0);
        h = lerp(h, ridgeHeight, ridgeRamp);
    }

    return h;
}

/**
 * Spatial-hashed collision world with analytical terrain heightfield,
 * sphere/cylinder/box obstacle push-out, slope limiting, and camera raycasting.
 */
export class CollisionWorld implements ICollisionWorld {
    private readonly colliders = new Map<string, ColliderVolume>();
    private readonly grid = new Map<string, Set<string>>();
    private readonly colliderCells = new Map<string, string[]>();

    getTerrainHeight(x: number, z: number): number {
        const cx = clamp(x, -WORLD_HALF_SIZE, WORLD_HALF_SIZE);
        const cz = clamp(z, -WORLD_HALF_SIZE, WORLD_HALF_SIZE);
        return sampleIslandHeight(cx, cz);
    }

    getTerrainNormal(x: number, z: number, out?: pc.Vec3): pc.Vec3 {
        const eps = 0.25;
        const hL = this.getTerrainHeight(x - eps, z);
        const hR = this.getTerrainHeight(x + eps, z);
        const hD = this.getTerrainHeight(x, z - eps);
        const hU = this.getTerrainHeight(x, z + eps);

        const target = out ?? new pc.Vec3();
        target.set(hL - hR, 2 * eps, hD - hU).normalize();
        return target;
    }

    getWaterLevel(): number {
        return 0.0;
    }

    /** Exposes deterministic trail mask in [0, 1] for TerrainBuilder and EnvironmentManager. */
    getTrailMask(x: number, z: number): number {
        return sampleTrailMask(x, z);
    }

    /** Returns all registered colliders (read-only view for debugging/inspection). */
    getAllColliders(): ReadonlyArray<ColliderVolume> {
        return Array.from(this.colliders.values());
    }

    registerCollider(collider: ColliderVolume): void {
        if (this.colliders.has(collider.id)) {
            this.removeFromGrid(collider.id);
        }
        this.colliders.set(collider.id, collider);
        if (!collider.collected) {
            this.insertIntoGrid(collider);
        }
    }

    removeCollider(id: string): void {
        const existing = this.colliders.get(id);
        if (existing) {
            existing.collected = true;
            this.removeFromGrid(id);
            this.colliders.delete(id);
        }
    }

    resolveSphereMovement(
        currentPos: pc.Vec3,
        desiredPos: pc.Vec3,
        radius: number,
        stepHeight = 0.45
    ): {
        position: pc.Vec3;
        grounded: boolean;
        hitObstacle: boolean;
        groundNormal: pc.Vec3;
    } {
        let px = desiredPos.x;
        let py = desiredPos.y;
        let pz = desiredPos.z;
        let hitObstacle = false;
        let walkableTopY = -Infinity;

        const minX = Math.min(currentPos.x, px) - radius - 2.0;
        const maxX = Math.max(currentPos.x, px) + radius + 2.0;
        const minZ = Math.min(currentPos.z, pz) - radius - 2.0;
        const maxZ = Math.max(currentPos.z, pz) + radius + 2.0;
        const candidates = this.queryAABB(minX, minZ, maxX, maxZ);

        // Iterative horizontal resolution against solid colliders
        for (let iter = 0; iter < 3; iter++) {
            for (const col of candidates) {
                if (col.collected) continue;

                const cx = col.position.x;
                const cy = col.position.y;
                const cz = col.position.z;

                if (col.type === 'cylinder') {
                    const halfH = (col.height ?? 4.0) * 0.5;
                    const colBottom = cy - halfH;
                    const colTop = cy + halfH;

                    if (colBottom >= py + PLAYER_HEIGHT || colTop <= currentPos.y + stepHeight) {
                        // Allow standing on top of short cylinders (like ruin plinths)
                        if (
                            (col.tag === 'ruin' || col.tag === 'prop') &&
                            colTop <= currentPos.y + stepHeight + 0.08 &&
                            Math.hypot(px - cx, pz - cz) < col.radius + radius * 0.5
                        ) {
                            if (colTop > walkableTopY) walkableTopY = colTop;
                        }
                        continue;
                    }

                    const dx = px - cx;
                    const dz = pz - cz;
                    const minDist = radius + col.radius;
                    const distSq = dx * dx + dz * dz;
                    if (distSq < minDist * minDist) {
                        hitObstacle = true;
                        const dist = Math.sqrt(distSq);
                        if (dist > 1e-5) {
                            const push = (minDist - dist) / dist;
                            px += dx * push;
                            pz += dz * push;
                        } else {
                            px += minDist;
                        }
                    }
                } else if (col.type === 'sphere') {
                    const colTop = cy + col.radius;
                    const colBottom = cy - col.radius;
                    if (colBottom >= py + PLAYER_HEIGHT || colTop <= currentPos.y + stepHeight) {
                        continue;
                    }

                    const closestY = clamp(cy, py + radius, py + PLAYER_HEIGHT - radius);
                    const dy = closestY - cy;
                    const combined = radius + col.radius;
                    const remSq = combined * combined - dy * dy;
                    if (remSq <= 0) continue;

                    const dx = px - cx;
                    const dz = pz - cz;
                    const distSq = dx * dx + dz * dz;
                    if (distSq < remSq) {
                        hitObstacle = true;
                        const horizNeeded = Math.sqrt(remSq);
                        const dist = Math.sqrt(distSq);
                        if (dist > 1e-5) {
                            const scale = horizNeeded / dist;
                            px = cx + dx * scale;
                            pz = cz + dz * scale;
                        } else {
                            px = cx + horizNeeded;
                        }
                    }
                } else if (col.type === 'box') {
                    const hx = col.halfExtents?.x ?? col.radius;
                    const hy = col.halfExtents?.y ?? (col.height ?? 2.0) * 0.5;
                    const hz = col.halfExtents?.z ?? col.radius;
                    const colBottom = cy - hy;
                    const colTop = cy + hy;

                    const qx = clamp(px, cx - hx, cx + hx);
                    const qz = clamp(pz, cz - hz, cz + hz);
                    const dx = px - qx;
                    const dz = pz - qz;
                    const horizDistSq = dx * dx + dz * dz;

                    if (colTop <= currentPos.y + stepHeight + 0.08) {
                        if (
                            (col.tag === 'ruin' || col.tag === 'prop' || col.tag === 'rock') &&
                            horizDistSq < radius * radius * 0.75
                        ) {
                            if (colTop > walkableTopY) walkableTopY = colTop;
                        }
                        continue;
                    }

                    if (colBottom >= py + PLAYER_HEIGHT) {
                        continue;
                    }

                    if (dx === 0 && dz === 0) {
                        // Inside box footprint: push out along shallowest axis
                        hitObstacle = true;
                        const penLeft = px - (cx - hx);
                        const penRight = cx + hx - px;
                        const penBack = pz - (cz - hz);
                        const penFront = cz + hz - pz;
                        const minPen = Math.min(penLeft, penRight, penBack, penFront);
                        if (minPen === penLeft) px = cx - hx - radius;
                        else if (minPen === penRight) px = cx + hx + radius;
                        else if (minPen === penBack) pz = cz - hz - radius;
                        else pz = cz + hz + radius;
                    } else if (horizDistSq < radius * radius) {
                        hitObstacle = true;
                        const dist = Math.sqrt(horizDistSq);
                        const push = (radius - dist) / dist;
                        px += dx * push;
                        pz += dz * push;
                    }
                }
            }
        }

        // Playable island world boundary clamp (radius = 108m)
        const radialSq = px * px + pz * pz;
        if (radialSq > PLAYABLE_MAX_RADIUS * PLAYABLE_MAX_RADIUS) {
            const r = Math.sqrt(radialSq);
            px = (px / r) * PLAYABLE_MAX_RADIUS;
            pz = (pz / r) * PLAYABLE_MAX_RADIUS;
            hitObstacle = true;
        }

        // Slope limit check (> 48 degrees) with smooth cliff-side sliding
        const startGroundY = this.getTerrainHeight(currentPos.x, currentPos.z);
        const nearGround = currentPos.y <= startGroundY + stepHeight;
        const slopeNormal = new pc.Vec3();

        if (nearGround) {
            for (let sIter = 0; sIter < 2; sIter++) {
                this.getTerrainNormal(px, pz, slopeNormal);
                const targetTerrainY = this.getTerrainHeight(px, pz);
                if (slopeNormal.y < MAX_WALKABLE_SLOPE_COS && targetTerrainY > currentPos.y - 0.05) {
                    const mx = px - currentPos.x;
                    const mz = pz - currentPos.z;
                    const hLen = Math.hypot(slopeNormal.x, slopeNormal.z);
                    if (hLen > 1e-4) {
                        const ux = slopeNormal.x / hLen;
                        const uz = slopeNormal.z / hLen;
                        const dot = mx * ux + mz * uz;
                        if (dot < 0) {
                            px = currentPos.x + (mx - dot * ux);
                            pz = currentPos.z + (mz - dot * uz);
                            hitObstacle = true;
                            continue;
                        }
                    }
                    // Fallback: if still trying to climb higher on steep cliff, hold horizontal pos
                    if (targetTerrainY > startGroundY + 0.03) {
                        px = currentPos.x;
                        pz = currentPos.z;
                        hitObstacle = true;
                    }
                }
                break;
            }
        }

        // Grounding & slope snap
        const terrainY = this.getTerrainHeight(px, pz);
        const groundNormal = this.getTerrainNormal(px, pz);
        let surfaceY = terrainY;
        let onWalkableProp = false;
        if (walkableTopY > terrainY) {
            surfaceY = walkableTopY;
            onWalkableProp = true;
        }

        let grounded = false;
        const movingUpward = desiredPos.y > currentPos.y + 0.015;

        if (py <= surfaceY + 0.025) {
            // If airborne landing onto an overly steep cliff (> 48 deg), slide downhill slightly
            if (!onWalkableProp && groundNormal.y < MAX_WALKABLE_SLOPE_COS && py < terrainY) {
                const hLen = Math.hypot(groundNormal.x, groundNormal.z);
                if (hLen > 1e-4) {
                    const slideStep = Math.min(0.25, (terrainY - py) * 0.65 + 0.04);
                    px += (groundNormal.x / hLen) * slideStep;
                    pz += (groundNormal.z / hLen) * slideStep;
                    py = this.getTerrainHeight(px, pz);
                    this.getTerrainNormal(px, pz, groundNormal);
                    grounded = groundNormal.y >= MAX_WALKABLE_SLOPE_COS;
                } else {
                    py = surfaceY;
                    grounded = true;
                }
                hitObstacle = true;
            } else {
                py = surfaceY;
                grounded = true;
            }
        } else if (
            !movingUpward &&
            currentPos.y <= startGroundY + 0.1 &&
            py - surfaceY <= stepHeight * 0.5
        ) {
            // Smooth downhill slope adherence
            py = surfaceY;
            grounded = true;
        }

        if (onWalkableProp && grounded) {
            groundNormal.set(0, 1, 0);
        }

        return {
            position: new pc.Vec3(px, py, pz),
            grounded,
            hitObstacle,
            groundNormal,
        };
    }

    raycastCamera(
        origin: pc.Vec3,
        target: pc.Vec3,
        paddingRadius = 0.35
    ): RaycastHit {
        const dx = target.x - origin.x;
        const dy = target.y - origin.y;
        const dz = target.z - origin.z;
        const segLen = Math.hypot(dx, dy, dz);

        if (segLen < 1e-5) {
            return {
                hit: false,
                point: target.clone(),
                normal: new pc.Vec3(0, 1, 0),
                distance: 0,
            };
        }

        const dirX = dx / segLen;
        const dirY = dy / segLen;
        const dirZ = dz / segLen;

        let closestDist = segLen;
        let hit = false;
        let hitNormal = new pc.Vec3(0, 1, 0);
        let hitTag: string | undefined;

        // 1. Fine terrain sampling against (getTerrainHeight + paddingRadius)
        const steps = Math.max(16, Math.ceil(segLen / 0.22));
        let prevDist = 0;
        for (let i = 1; i <= steps; i++) {
            const dist = (i / steps) * segLen;
            const sx = origin.x + dirX * dist;
            const sy = origin.y + dirY * dist;
            const sz = origin.z + dirZ * dist;
            const minAllowedY = this.getTerrainHeight(sx, sz) + paddingRadius;

            if (sy < minAllowedY) {
                // Binary search refinement for exact crossing
                let lo = prevDist;
                let hi = dist;
                for (let b = 0; b < 6; b++) {
                    const mid = (lo + hi) * 0.5;
                    const mx = origin.x + dirX * mid;
                    const my = origin.y + dirY * mid;
                    const mz = origin.z + dirZ * mid;
                    if (my < this.getTerrainHeight(mx, mz) + paddingRadius) {
                        hi = mid;
                    } else {
                        lo = mid;
                    }
                }
                const refined = Math.max(0.05, lo);
                if (refined < closestDist) {
                    closestDist = refined;
                    hit = true;
                    hitTag = 'terrain';
                    hitNormal = this.getTerrainNormal(
                        origin.x + dirX * refined,
                        origin.z + dirZ * refined
                    );
                }
                break;
            }
            prevDist = dist;
        }

        // 2. Analytical ray intersections against blocksCamera colliders in segment AABB
        const segMinX = Math.min(origin.x, target.x) - paddingRadius - 1;
        const segMaxX = Math.max(origin.x, target.x) + paddingRadius + 1;
        const segMinZ = Math.min(origin.z, target.z) - paddingRadius - 1;
        const segMaxZ = Math.max(origin.z, target.z) + paddingRadius + 1;
        const candidates = this.queryAABB(segMinX, segMinZ, segMaxX, segMaxZ);

        for (const col of candidates) {
            if (!col.blocksCamera || col.collected) continue;

            if (col.type === 'sphere') {
                const res = intersectRaySphere(
                    origin.x,
                    origin.y,
                    origin.z,
                    dirX,
                    dirY,
                    dirZ,
                    col.position.x,
                    col.position.y,
                    col.position.z,
                    col.radius + paddingRadius
                );
                if (res && res.t < closestDist) {
                    closestDist = res.t;
                    hit = true;
                    hitTag = col.tag;
                    hitNormal.set(res.nx, res.ny, res.nz);
                }
            } else if (col.type === 'cylinder') {
                const res = intersectRayCylinder(
                    origin.x,
                    origin.y,
                    origin.z,
                    dirX,
                    dirY,
                    dirZ,
                    col.position.x,
                    col.position.y,
                    col.position.z,
                    col.radius + paddingRadius,
                    (col.height ?? 4.0) + paddingRadius
                );
                if (res && res.t < closestDist) {
                    closestDist = res.t;
                    hit = true;
                    hitTag = col.tag;
                    hitNormal.set(res.nx, res.ny, res.nz);
                }
            } else if (col.type === 'box') {
                const hx = (col.halfExtents?.x ?? col.radius) + paddingRadius;
                const hy = (col.halfExtents?.y ?? (col.height ?? 2.0) * 0.5) + paddingRadius;
                const hz = (col.halfExtents?.z ?? col.radius) + paddingRadius;
                const res = intersectRayAABB(
                    origin.x,
                    origin.y,
                    origin.z,
                    dirX,
                    dirY,
                    dirZ,
                    col.position.x - hx,
                    col.position.y - hy,
                    col.position.z - hz,
                    col.position.x + hx,
                    col.position.y + hy,
                    col.position.z + hz
                );
                if (res && res.t < closestDist) {
                    closestDist = res.t;
                    hit = true;
                    hitTag = col.tag;
                    hitNormal.set(res.nx, res.ny, res.nz);
                }
            }
        }

        const hitPoint = new pc.Vec3(
            origin.x + dirX * closestDist,
            origin.y + dirY * closestDist,
            origin.z + dirZ * closestDist
        );

        return {
            hit,
            point: hitPoint,
            normal: hitNormal,
            distance: closestDist,
            colliderTag: hitTag,
        };
    }

    findNearestInteractable(
        pos: pc.Vec3,
        maxRadius: number
    ): ColliderVolume | null {
        const candidates = this.queryAABB(
            pos.x - maxRadius,
            pos.z - maxRadius,
            pos.x + maxRadius,
            pos.z + maxRadius
        );
        let best: ColliderVolume | null = null;
        let bestDistSq = maxRadius * maxRadius;

        for (const col of candidates) {
            if (col.collected || col.tag !== 'crystal') continue;
            const dx = col.position.x - pos.x;
            const dy = col.position.y - pos.y;
            const dz = col.position.z - pos.z;
            const distSq = dx * dx + dy * dy + dz * dz;
            if (distSq <= bestDistSq) {
                bestDistSq = distSq;
                best = col;
            }
        }

        return best;
    }

    private getColliderBoundsXZ(col: ColliderVolume): [number, number, number, number] {
        const extX = col.type === 'box' ? col.halfExtents?.x ?? col.radius : col.radius;
        const extZ = col.type === 'box' ? col.halfExtents?.z ?? col.radius : col.radius;
        return [
            col.position.x - extX,
            col.position.z - extZ,
            col.position.x + extX,
            col.position.z + extZ,
        ];
    }

    private insertIntoGrid(col: ColliderVolume): void {
        const [minX, minZ, maxX, maxZ] = this.getColliderBoundsXZ(col);
        const cMinX = Math.floor(minX / SPATIAL_CELL_SIZE);
        const cMaxX = Math.floor(maxX / SPATIAL_CELL_SIZE);
        const cMinZ = Math.floor(minZ / SPATIAL_CELL_SIZE);
        const cMaxZ = Math.floor(maxZ / SPATIAL_CELL_SIZE);

        const keys: string[] = [];
        for (let cx = cMinX; cx <= cMaxX; cx++) {
            for (let cz = cMinZ; cz <= cMaxZ; cz++) {
                const key = `${cx},${cz}`;
                let bucket = this.grid.get(key);
                if (!bucket) {
                    bucket = new Set<string>();
                    this.grid.set(key, bucket);
                }
                bucket.add(col.id);
                keys.push(key);
            }
        }
        this.colliderCells.set(col.id, keys);
    }

    private removeFromGrid(id: string): void {
        const keys = this.colliderCells.get(id);
        if (!keys) return;
        for (const key of keys) {
            const bucket = this.grid.get(key);
            if (bucket) {
                bucket.delete(id);
                if (bucket.size === 0) {
                    this.grid.delete(key);
                }
            }
        }
        this.colliderCells.delete(id);
    }

    private queryAABB(
        minX: number,
        minZ: number,
        maxX: number,
        maxZ: number
    ): ColliderVolume[] {
        const cMinX = Math.floor(minX / SPATIAL_CELL_SIZE);
        const cMaxX = Math.floor(maxX / SPATIAL_CELL_SIZE);
        const cMinZ = Math.floor(minZ / SPATIAL_CELL_SIZE);
        const cMaxZ = Math.floor(maxZ / SPATIAL_CELL_SIZE);

        const seen = new Set<string>();
        const result: ColliderVolume[] = [];

        for (let cx = cMinX; cx <= cMaxX; cx++) {
            for (let cz = cMinZ; cz <= cMaxZ; cz++) {
                const bucket = this.grid.get(`${cx},${cz}`);
                if (!bucket) continue;
                for (const id of bucket) {
                    if (seen.has(id)) continue;
                    seen.add(id);
                    const col = this.colliders.get(id);
                    if (col && !col.collected) {
                        result.push(col);
                    }
                }
            }
        }

        return result;
    }
}

interface RayPrimitiveHit {
    t: number;
    nx: number;
    ny: number;
    nz: number;
}

function intersectRaySphere(
    ox: number,
    oy: number,
    oz: number,
    dx: number,
    dy: number,
    dz: number,
    cx: number,
    cy: number,
    cz: number,
    r: number
): RayPrimitiveHit | null {
    const ocx = ox - cx;
    const ocy = oy - cy;
    const ocz = oz - cz;
    const b = ocx * dx + ocy * dy + ocz * dz;
    const c = ocx * ocx + ocy * ocy + ocz * ocz - r * r;
    const disc = b * b - c;
    if (disc < 0) return null;

    const sqrtD = Math.sqrt(disc);
    const t0 = -b - sqrtD;
    const t1 = -b + sqrtD;
    if (t1 < 0) return null;

    const t = t0 >= 0 ? t0 : 0.05;
    const hx = ox + dx * t - cx;
    const hy = oy + dy * t - cy;
    const hz = oz + dz * t - cz;
    const invL = 1 / (Math.hypot(hx, hy, hz) || 1);
    return { t, nx: hx * invL, ny: hy * invL, nz: hz * invL };
}

function intersectRayCylinder(
    ox: number,
    oy: number,
    oz: number,
    dx: number,
    dy: number,
    dz: number,
    cx: number,
    cy: number,
    cz: number,
    r: number,
    height: number
): RayPrimitiveHit | null {
    const yMin = cy - height * 0.5;
    const yMax = cy + height * 0.5;
    const rx = ox - cx;
    const rz = oz - cz;

    let best: RayPrimitiveHit | null = null;

    // Side intersection in XZ
    const a = dx * dx + dz * dz;
    const b = rx * dx + rz * dz;
    const c = rx * rx + rz * rz - r * r;

    if (c <= 0 && oy >= yMin && oy <= yMax) {
        // Ray starts inside padded cylinder
        const len = Math.hypot(rx, rz) || 1;
        return { t: 0.05, nx: rx / len, ny: 0, nz: rz / len };
    }

    if (a > 1e-8) {
        const disc = b * b - a * c;
        if (disc >= 0) {
            const sqrtD = Math.sqrt(disc);
            const tSide = (-b - sqrtD) / a;
            if (tSide >= 0) {
                const hy = oy + dy * tSide;
                if (hy >= yMin && hy <= yMax) {
                    const nx = (rx + dx * tSide) / r;
                    const nz = (rz + dz * tSide) / r;
                    best = { t: tSide, nx, ny: 0, nz };
                }
            }
        }
    }

    // Top and bottom caps
    if (Math.abs(dy) > 1e-6) {
        for (const [capY, capNy] of [
            [yMax, 1],
            [yMin, -1],
        ] as const) {
            const tCap = (capY - oy) / dy;
            if (tCap >= 0 && (!best || tCap < best.t)) {
                const px = rx + dx * tCap;
                const pz = rz + dz * tCap;
                if (px * px + pz * pz <= r * r) {
                    best = { t: tCap, nx: 0, ny: capNy, nz: 0 };
                }
            }
        }
    }

    return best;
}

function intersectRayAABB(
    ox: number,
    oy: number,
    oz: number,
    dx: number,
    dy: number,
    dz: number,
    minX: number,
    minY: number,
    minZ: number,
    maxX: number,
    maxY: number,
    maxZ: number
): RayPrimitiveHit | null {
    let tMin = -Infinity;
    let tMax = Infinity;
    let enterNx = 0;
    let enterNy = 0;
    let enterNz = 0;

    const axes = [
        [ox, dx, minX, maxX, 1, 0, 0],
        [oy, dy, minY, maxY, 0, 1, 0],
        [oz, dz, minZ, maxZ, 0, 0, 1],
    ] as const;

    for (const [o, d, bMin, bMax, ax, ay, az] of axes) {
        if (Math.abs(d) < 1e-8) {
            if (o < bMin || o > bMax) return null;
        } else {
            const invD = 1 / d;
            let t1 = (bMin - o) * invD;
            let t2 = (bMax - o) * invD;
            let sign = -1;
            if (t1 > t2) {
                const tmp = t1;
                t1 = t2;
                t2 = tmp;
                sign = 1;
            }
            if (t1 > tMin) {
                tMin = t1;
                enterNx = ax * sign;
                enterNy = ay * sign;
                enterNz = az * sign;
            }
            if (t2 < tMax) {
                tMax = t2;
            }
            if (tMin > tMax) return null;
        }
    }

    if (tMax < 0) return null;
    if (tMin < 0) {
        // Origin inside padded box
        return { t: 0.05, nx: -dx, ny: -dy, nz: -dz };
    }
    return { t: tMin, nx: enterNx, ny: enterNy, nz: enterNz };
}
