import * as pc from 'playcanvas';
import { ICollisionWorld, InputState } from '../types/interfaces';

export interface CameraStateSnapshot {
    yawDeg: number;
    pitchDeg: number;
    targetDistance: number;
    currentDistance: number;
    occluded: boolean;
    sensitivity: number;
    position: { x: number; y: number; z: number };
    pivot: { x: number; y: number; z: number };
}

const PIVOT_HEIGHT_OFFSET = 1.45;
const MIN_PITCH_DEG = -12;
const MAX_PITCH_DEG = 68;
const MIN_DISTANCE = 3.2;
const MAX_DISTANCE = 9.5;
const DEFAULT_DISTANCE = 5.6;
const MIN_COLLISION_DISTANCE = 1.1;
const CAMERA_PADDING_RADIUS = 0.35;

const FOLLOW_SHARPNESS = 14;
const PULL_IN_SHARPNESS = 20;
const RECOVER_SHARPNESS = 6;
const BASE_LOOK_DEG_PER_PX = 0.24;

export class ThirdPersonCamera {
    private app: pc.Application;
    private collisionWorld: ICollisionWorld;
    public readonly entity: pc.Entity;

    private yawDeg = 0;
    private pitchDeg = 18;
    private targetDistance = DEFAULT_DISTANCE;
    private currentDistance = DEFAULT_DISTANCE;
    private sensitivity = 1.0;

    private currentPivot = new pc.Vec3(0, PIVOT_HEIGHT_OFFSET, 12);
    private targetPivot = new pc.Vec3(0, PIVOT_HEIGHT_OFFSET, 12);
    private desiredCamPos = new pc.Vec3();
    private finalCamPos = new pc.Vec3();
    private offsetDir = new pc.Vec3();
    private occluded = false;

    constructor(
        app: pc.Application,
        collisionWorld: ICollisionWorld,
        initialPlayerPos?: pc.Vec3
    ) {
        this.app = app;
        this.collisionWorld = collisionWorld;

        this.entity = new pc.Entity('MainCamera');
        this.entity.addComponent('camera', {
            clearColor: new pc.Color(0.46, 0.75, 0.96, 1),
            fov: 56,
            nearClip: 0.18,
            farClip: 180,
        });
        this.app.root.addChild(this.entity);

        if (initialPlayerPos) {
            this.snapToTarget(initialPlayerPos);
        } else {
            this.updateCameraTransform(0.016);
        }
    }

    public setSensitivity(multiplier: number): void {
        if (!Number.isFinite(multiplier)) return;
        this.sensitivity = Math.max(0.25, Math.min(2.5, multiplier));
    }

    public getSensitivity(): number {
        return this.sensitivity;
    }

    public setAngles(yawDeg: number, pitchDeg: number): void {
        if (Number.isFinite(yawDeg)) {
            this.yawDeg = yawDeg;
        }
        if (Number.isFinite(pitchDeg)) {
            this.pitchDeg = Math.max(MIN_PITCH_DEG, Math.min(MAX_PITCH_DEG, pitchDeg));
        }
    }

    public setFarClip(farClip: number): void {
        if (this.entity.camera && Number.isFinite(farClip)) {
            this.entity.camera.farClip = Math.max(60, farClip);
        }
    }

    public snapToTarget(playerPos: pc.Vec3): void {
        this.currentPivot.set(
            playerPos.x,
            playerPos.y + PIVOT_HEIGHT_OFFSET,
            playerPos.z
        );
        this.targetPivot.copy(this.currentPivot);
        this.currentDistance = this.targetDistance;
        this.updateCameraTransform(1.0);
    }

    public update(dt: number, playerPos: pc.Vec3, input: InputState): void {
        const clampedDt = Math.max(0.0001, Math.min(0.1, dt));

        // Orbit look input
        const lookScale = BASE_LOOK_DEG_PER_PX * this.sensitivity;
        if (input.lookDeltaX !== 0 || input.lookDeltaY !== 0) {
            this.yawDeg -= input.lookDeltaX * lookScale;
            this.pitchDeg = Math.max(
                MIN_PITCH_DEG,
                Math.min(MAX_PITCH_DEG, this.pitchDeg + input.lookDeltaY * lookScale)
            );
        }

        // Scroll / pinch zoom
        if (input.zoomDelta !== 0) {
            this.targetDistance = Math.max(
                MIN_DISTANCE,
                Math.min(MAX_DISTANCE, this.targetDistance + input.zoomDelta * 0.85)
            );
        }

        // Smooth pivot follow (critically damped exponential lerp ~14*dt)
        this.targetPivot.set(
            playerPos.x,
            playerPos.y + PIVOT_HEIGHT_OFFSET,
            playerPos.z
        );
        const followT = 1 - Math.exp(-FOLLOW_SHARPNESS * clampedDt);
        this.currentPivot.lerp(this.currentPivot, this.targetPivot, followT);

        this.updateCameraTransform(clampedDt);
    }

    private updateCameraTransform(dt: number): void {
        const yawRad = this.yawDeg * pc.math.DEG_TO_RAD;
        const pitchRad = this.pitchDeg * pc.math.DEG_TO_RAD;

        const cosPitch = Math.cos(pitchRad);
        const sinPitch = Math.sin(pitchRad);
        const sinYaw = Math.sin(yawRad);
        const cosYaw = Math.cos(yawRad);

        this.offsetDir.set(sinYaw * cosPitch, sinPitch, cosYaw * cosPitch);

        this.desiredCamPos.set(
            this.currentPivot.x + this.offsetDir.x * this.targetDistance,
            this.currentPivot.y + this.offsetDir.y * this.targetDistance,
            this.currentPivot.z + this.offsetDir.z * this.targetDistance
        );

        const hit = this.collisionWorld.raycastCamera(
            this.currentPivot,
            this.desiredCamPos,
            CAMERA_PADDING_RADIUS
        );

        let desiredDist = this.targetDistance;
        if (hit.hit) {
            desiredDist = Math.max(
                MIN_COLLISION_DISTANCE,
                Math.min(this.targetDistance, hit.distance)
            );
            this.occluded = true;
        } else {
            this.occluded = false;
        }

        if (desiredDist < this.currentDistance) {
            const pullT = 1 - Math.exp(-PULL_IN_SHARPNESS * dt);
            this.currentDistance += (desiredDist - this.currentDistance) * pullT;
        } else {
            const recoverT = 1 - Math.exp(-RECOVER_SHARPNESS * dt);
            this.currentDistance += (desiredDist - this.currentDistance) * recoverT;
        }

        this.currentDistance = Math.max(
            MIN_COLLISION_DISTANCE,
            Math.min(this.targetDistance, this.currentDistance)
        );

        this.finalCamPos.set(
            this.currentPivot.x + this.offsetDir.x * this.currentDistance,
            this.currentPivot.y + this.offsetDir.y * this.currentDistance,
            this.currentPivot.z + this.offsetDir.z * this.currentDistance
        );

        // Safety floor clamp so terrain never pokes through camera near plane
        const minTerrainY =
            this.collisionWorld.getTerrainHeight(this.finalCamPos.x, this.finalCamPos.z) +
            CAMERA_PADDING_RADIUS;
        if (this.finalCamPos.y < minTerrainY) {
            this.finalCamPos.y = minTerrainY;
        }

        this.entity.setPosition(this.finalCamPos);
        this.entity.lookAt(this.currentPivot);
    }

    public getForwardXZ(out = new pc.Vec3()): pc.Vec3 {
        const yawRad = this.yawDeg * pc.math.DEG_TO_RAD;
        out.set(-Math.sin(yawRad), 0, -Math.cos(yawRad));
        return out.normalize();
    }

    public getRightXZ(out = new pc.Vec3()): pc.Vec3 {
        const yawRad = this.yawDeg * pc.math.DEG_TO_RAD;
        out.set(Math.cos(yawRad), 0, -Math.sin(yawRad));
        return out.normalize();
    }

    public getYawDeg(): number {
        return this.yawDeg;
    }

    public getPitchDeg(): number {
        return this.pitchDeg;
    }

    public getCameraState(): CameraStateSnapshot {
        const pos = this.entity.getPosition();
        const wrappedYaw = ((((this.yawDeg % 360) + 540) % 360) - 180);
        return {
            yawDeg: Math.round(wrappedYaw * 100) / 100,
            pitchDeg: Math.round(this.pitchDeg * 100) / 100,
            targetDistance: Math.round(this.targetDistance * 100) / 100,
            currentDistance: Math.round(this.currentDistance * 100) / 100,
            occluded: this.occluded,
            sensitivity: this.sensitivity,
            position: {
                x: Math.round(pos.x * 100) / 100,
                y: Math.round(pos.y * 100) / 100,
                z: Math.round(pos.z * 100) / 100,
            },
            pivot: {
                x: Math.round(this.currentPivot.x * 100) / 100,
                y: Math.round(this.currentPivot.y * 100) / 100,
                z: Math.round(this.currentPivot.z * 100) / 100,
            },
        };
    }
}
