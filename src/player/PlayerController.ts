import * as pc from 'playcanvas';
import { PLAYER_MAX_HP, PLAYER_MAX_HUNGER } from '../shared/NetworkProtocol';
import type {
    ICollisionWorld,
    InputState,
    LoadedModelBundle,
    PlayerTelemetry,
} from '../types/interfaces';

export interface PlayerControllerOptions {
    app: pc.Application;
    collisionWorld: ICollisionWorld;
    playerBundle: LoadedModelBundle;
    totalCrystals: number;
    onCollectCrystal: (colliderId: string) => boolean;
}

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

interface JointBinding {
    node: pc.GraphNode;
    restPos: pc.Vec3;
    restRot: pc.Quat;
}

// Movement & physics constants from spec
const ACCELERATION = 28;
const DECELERATION = 22;
const WALK_SPEED = 5.8;
const SPRINT_SPEED = 9.8;
const AIR_CONTROL = 0.65;
const GRAVITY = -24;
const JUMP_VELOCITY = 9.2;
const COYOTE_TIME_SEC = 0.12;
const JUMP_BUFFER_SEC = 0.12;

const MAX_STAMINA = 100;
const STAMINA_DRAIN_PER_SEC = 14;
const STAMINA_REGEN_PER_SEC = 22;
const STAMINA_RECOVERY_THRESHOLD = 12;

const PLAYER_RADIUS = 0.42;
const PLAYER_STEP_HEIGHT = 0.45;
const CRYSTAL_DETECT_RADIUS = 2.5;
const CRYSTAL_AUTO_COLLECT_RADIUS = 1.3;

const SPAWN_X = 0;
const SPAWN_Z = 12;

const SLOT_SPAWN_OFFSETS: Record<0 | 1 | 2, readonly [number, number]> = {
    0: [0, 12],
    1: [-2.2, 13.2],
    2: [2.2, 13.2],
};

const RECONCILE_DEADZONE_M = 0.65;
const RECONCILE_SNAP_M = 4.0;
const RECONCILE_DECAY_RATE = 14;

const DODGE_DURATION_SEC = 0.42;
const DODGE_IFRAME_SEC = 0.45;
const DODGE_COOLDOWN_SEC = 0.56;
const DODGE_STAMINA_COST = 20;
const DODGE_MIN_STAMINA = 12;
const DODGE_BURST_START_SPEED = 15.8;
const DODGE_BURST_END_SPEED = 9.2;

const MELEE_DURATION_SEC = 0.34;
const MELEE_COOLDOWN_SEC = 0.30;
const MELEE_COMBO_RESET_SEC = 1.15;
const RANGED_DURATION_SEC = 0.36;
const RANGED_COOLDOWN_SEC = 0.48;
const THROW_DURATION_SEC = 0.38;
const THROW_COOLDOWN_SEC = 0.42;
const HIT_ANIM_DURATION_SEC = 0.28;
const HIT_FLASH_DURATION_SEC = 0.22;

interface PlayerMaterialEntry {
    material: pc.StandardMaterial;
    baseDiffuse: pc.Color;
    baseEmissive: pc.Color;
    baseEmissiveIntensity: number;
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

export class PlayerController {
    private readonly app: pc.Application;
    private readonly collisionWorld: ICollisionWorld;
    private readonly totalCrystals: number;
    private readonly onCollectCrystal: (colliderId: string) => boolean;

    public readonly rootEntity: pc.Entity;
    private readonly visualPivot: pc.Entity;
    private readonly modelEntity: pc.Entity;

    private readonly joints = new Map<JointName, JointBinding>();
    private animComponent: pc.AnimComponent | null = null;
    private animClipMap = new Map<'idle' | 'walk' | 'run' | 'jump', string>();
    private activeAnimState: string | null = null;

    // Calibration constants for GLB coordinate orientation
    // manifest.json: player_explorer.glb faces +Z; PlayCanvas root faces -Z
    private modelYawOffsetDeg = 180;

    // Physics state
    private position = new pc.Vec3();
    private velocity = new pc.Vec3();
    private yawDeg = 0; // 0 faces -Z (toward Ancient Ruin Sanctuary)
    private prevYawDeg = 0;
    private yawRateDegPerSec = 0;
    private grounded = true;
    private inWater = false;
    private coyoteTimer = 0;
    private jumpBufferTimer = 0;

    // Gameplay state
    private stamina = MAX_STAMINA;
    private sprintExhausted = false;
    private crystalsCollected = 0;
    private nearbyHint: string | null = null;
    private state: PlayerTelemetry['state'] = 'idle';
    private locomotionState: 'idle' | 'walk' | 'run' | 'jump' | 'fall' = 'idle';

    // Phase 3 combat & survival state
    private hp = PLAYER_MAX_HP;
    private maxHp = PLAYER_MAX_HP;
    private combatManagedExternally = false;
    private dodgeTimer = 0;
    private dodgeInvulnTimer = 0;
    private dodgeCooldownTimer = 0;
    private respawnInvulnTimer = 0;
    private readonly dodgeDir = new pc.Vec3(0, 0, -1);

    private combatActionType: 'none' | 'melee' | 'ranged' | 'throw' | 'gather' | 'build' = 'none';
    private combatActionTimer = 0;
    private combatActionDuration = MELEE_DURATION_SEC;
    private meleeComboStep = 0;
    private meleeComboResetTimer = 0;
    private meleeCooldownTimer = 0;
    private rangedCooldownTimer = 0;
    private throwCooldownTimer = 0;
    private hunger = PLAYER_MAX_HUNGER;
    private maxHunger = PLAYER_MAX_HUNGER;
    private equippedTool = 'hands';

    private hitAnimTimer = 0;
    private hitFlashTimer = 0;
    private knockbackVelX = 0;
    private knockbackVelZ = 0;
    private hasLatestWishDir = false;
    private readonly latestWishDir = new pc.Vec3(0, 0, -1);
    private readonly clonedMaterials: PlayerMaterialEntry[] = [];
    private activeVisualTint: 'none' | 'hit' | 'dodge' = 'none';

    // Procedural animation state
    private idleTime = 0;
    private stridePhase = 0;
    private locomotionBlend = 0;
    private runBlend = 0;
    private airBlend = 0;
    private idleNeutralBlend = 1;
    private landingSquash = 0;
    private interactPulse = 0;

    // Scratch vectors/quaternions to avoid GC churn
    private readonly wishDir = new pc.Vec3();
    private readonly desiredPos = new pc.Vec3();
    private readonly prevPos = new pc.Vec3();
    private readonly reconcileVisualOffset = new pc.Vec3();
    private readonly tmpQuat = new pc.Quat();
    private readonly tmpRotQuat = new pc.Quat();
    private readonly tmpVec = new pc.Vec3();

    private onPostUpdateBound: () => void;

    constructor(options: PlayerControllerOptions) {
        this.app = options.app;
        this.collisionWorld = options.collisionWorld;
        this.totalCrystals = options.totalCrystals;
        this.onCollectCrystal = options.onCollectCrystal;

        const spawnY = this.collisionWorld.getTerrainHeight(SPAWN_X, SPAWN_Z);
        this.position.set(SPAWN_X, spawnY, SPAWN_Z);

        this.rootEntity = new pc.Entity('PlayerExplorerRoot');
        this.rootEntity.setPosition(this.position);
        this.rootEntity.setLocalEulerAngles(0, this.yawDeg, 0);

        this.visualPivot = new pc.Entity('PlayerVisualPivot');
        this.visualPivot.setLocalEulerAngles(0, 0, 0);
        this.rootEntity.addChild(this.visualPivot);

        this.modelEntity = options.playerBundle.instantiate('player_explorer');
        this.modelEntity.setLocalEulerAngles(0, this.modelYawOffsetDeg, 0);
        this.visualPivot.addChild(this.modelEntity);
        this.app.root.addChild(this.rootEntity);

        this.bindJointNodes();
        this.setupGlbAnimations(options.playerBundle);
        this.cloneMaterialsForCombatFeedback();

        this.onPostUpdateBound = () => {
            this.applyProceduralPolish();
        };
        this.app.on('postupdate', this.onPostUpdateBound);
    }

    public setCombatManagedExternally(managed: boolean): void {
        this.combatManagedExternally = managed;
    }

    public getHp(): number {
        return this.hp;
    }

    public getMaxHp(): number {
        return this.maxHp;
    }

    public getYawDeg(): number {
        return this.yawDeg;
    }

    public getAimDirectionXZ(out = new pc.Vec3()): pc.Vec3 {
        const rad = this.yawDeg * pc.math.DEG_TO_RAD;
        out.set(-Math.sin(rad), 0, -Math.cos(rad));
        return out.normalize();
    }

    public isDodging(): boolean {
        return this.dodgeTimer > 0 || this.dodgeInvulnTimer > 0;
    }

    public isInvulnerable(): boolean {
        return this.dodgeInvulnTimer > 0 || this.respawnInvulnTimer > 0;
    }

    public getAttackComboStep(): number {
        return this.meleeComboStep;
    }

    public setAuthoritativeHp(hp: number, maxHp?: number): void {
        if (typeof maxHp === 'number' && Number.isFinite(maxHp) && maxHp > 0) {
            this.maxHp = Math.round(maxHp);
        }
        if (!Number.isFinite(hp)) return;
        const clampedHp = clamp(Math.round(hp), 0, this.maxHp);
        if (clampedHp < this.hp) {
            this.hitFlashTimer = HIT_FLASH_DURATION_SEC;
            this.hitAnimTimer = Math.max(this.hitAnimTimer, HIT_ANIM_DURATION_SEC * 0.8);
        }
        this.hp = clampedHp;
    }

    public applyAutoAimAssist(
        targetX: number,
        targetZ: number,
        isCameraDragging: boolean
    ): number {
        const dx = targetX - this.position.x;
        const dz = targetZ - this.position.z;
        const distSq = dx * dx + dz * dz;
        if (!isCameraDragging && distSq > 1e-4) {
            const targetYaw = Math.atan2(-dx, -dz) * pc.math.RAD_TO_DEG;
            this.yawDeg = normalizeAngleDeg(targetYaw);
        }
        return this.yawDeg;
    }

    public triggerDodge(dirX?: number, dirZ?: number): boolean {
        if (this.dodgeTimer > 0 || this.dodgeCooldownTimer > 0) {
            return false;
        }
        if (this.stamina < DODGE_MIN_STAMINA) {
            return false;
        }

        this.stamina = Math.max(0, this.stamina - DODGE_STAMINA_COST);
        if (this.stamina <= 0) {
            this.sprintExhausted = true;
        }

        if (
            typeof dirX === 'number' &&
            typeof dirZ === 'number' &&
            Math.hypot(dirX, dirZ) > 1e-4
        ) {
            this.dodgeDir.set(dirX, 0, dirZ).normalize();
        } else if (this.hasLatestWishDir && this.latestWishDir.lengthSq() > 1e-4) {
            this.dodgeDir.copy(this.latestWishDir).normalize();
        } else {
            this.getAimDirectionXZ(this.dodgeDir);
        }

        this.yawDeg = normalizeAngleDeg(
            Math.atan2(-this.dodgeDir.x, -this.dodgeDir.z) * pc.math.RAD_TO_DEG
        );
        this.dodgeTimer = DODGE_DURATION_SEC;
        this.dodgeInvulnTimer = DODGE_IFRAME_SEC;
        this.dodgeCooldownTimer = DODGE_COOLDOWN_SEC;
        this.combatActionType = 'none';
        this.combatActionTimer = 0;
        this.velocity.x = this.dodgeDir.x * DODGE_BURST_START_SPEED;
        this.velocity.z = this.dodgeDir.z * DODGE_BURST_START_SPEED;
        this.state = 'dodge';
        return true;
    }

    public triggerMeleeAttack(aimYawDeg?: number | null): number {
        if (this.dodgeTimer > 0 || this.meleeCooldownTimer > 0) {
            return 0;
        }
        if (typeof aimYawDeg === 'number' && Number.isFinite(aimYawDeg)) {
            this.yawDeg = normalizeAngleDeg(aimYawDeg);
        }
        this.meleeComboStep =
            this.meleeComboResetTimer > 0 ? (this.meleeComboStep % 3) + 1 : 1;
        this.meleeComboResetTimer = MELEE_COMBO_RESET_SEC;
        this.meleeCooldownTimer = MELEE_COOLDOWN_SEC;
        this.combatActionType = 'melee';
        this.combatActionDuration = MELEE_DURATION_SEC;
        this.combatActionTimer = MELEE_DURATION_SEC;
        this.state = 'attack';

        // Crisp forward micro-lunge on melee swing
        const aim = this.getAimDirectionXZ(this.tmpVec);
        const lungeSpeed = this.meleeComboStep === 3 ? 4.2 : 2.8;
        this.velocity.x = lerp(this.velocity.x, aim.x * lungeSpeed, 0.55);
        this.velocity.z = lerp(this.velocity.z, aim.z * lungeSpeed, 0.55);
        return this.meleeComboStep;
    }

    public triggerRangedCast(aimYawDeg?: number | null): boolean {
        if (this.dodgeTimer > 0 || this.rangedCooldownTimer > 0) {
            return false;
        }
        if (typeof aimYawDeg === 'number' && Number.isFinite(aimYawDeg)) {
            this.yawDeg = normalizeAngleDeg(aimYawDeg);
        }
        this.rangedCooldownTimer = RANGED_COOLDOWN_SEC;
        this.combatActionType = 'ranged';
        this.combatActionDuration = RANGED_DURATION_SEC;
        this.combatActionTimer = RANGED_DURATION_SEC;
        this.state = 'attack';
        return true;
    }

    public triggerCaptureThrow(aimYawDeg?: number | null): boolean {
        if (this.dodgeTimer > 0 || this.throwCooldownTimer > 0) {
            return false;
        }
        if (typeof aimYawDeg === 'number' && Number.isFinite(aimYawDeg)) {
            this.yawDeg = normalizeAngleDeg(aimYawDeg);
        }
        this.throwCooldownTimer = THROW_COOLDOWN_SEC;
        this.combatActionType = 'throw';
        this.combatActionDuration = THROW_DURATION_SEC;
        this.combatActionTimer = THROW_DURATION_SEC;
        this.state = 'throw';
        return true;
    }

    /** Phase 4: Resource gathering swing animation (tree chop / stone strike / berry pluck). */
    public triggerGatherSwing(durationSec = 0.34, aimYawDeg?: number | null): boolean {
        if (this.dodgeTimer > 0) {
            return false;
        }
        if (typeof aimYawDeg === 'number' && Number.isFinite(aimYawDeg)) {
            this.yawDeg = normalizeAngleDeg(aimYawDeg);
        }
        const safeDuration = clamp(durationSec, 0.16, 1.0);
        this.combatActionType = 'gather';
        this.combatActionDuration = safeDuration;
        this.combatActionTimer = safeDuration;
        this.state = 'gather';
        return true;
    }

    /** Phase 4: Modular structure placement / demolish gesture. */
    public triggerBuildPose(durationSec = 0.3, aimYawDeg?: number | null): boolean {
        if (this.dodgeTimer > 0) {
            return false;
        }
        if (typeof aimYawDeg === 'number' && Number.isFinite(aimYawDeg)) {
            this.yawDeg = normalizeAngleDeg(aimYawDeg);
        }
        const safeDuration = clamp(durationSec, 0.14, 1.0);
        this.combatActionType = 'build';
        this.combatActionDuration = safeDuration;
        this.combatActionTimer = safeDuration;
        this.state = 'build';
        return true;
    }

    /** Phase 4: Apply healing (eat food / rest bed) or starvation drain without hit-recoil. */
    public applyExternalHpDelta(delta: number): void {
        if (!Number.isFinite(delta) || delta === 0) return;
        this.hp = clamp(Math.round(this.hp + delta), 0, this.maxHp);
    }

    /** Phase 4: Sync hunger & equipped tool telemetry from SurvivalBuildingManager. */
    public setHungerTelemetry(hunger: number, maxHunger: number, equippedTool: string): void {
        const safeMax = Number.isFinite(maxHunger) && maxHunger > 0 ? Math.round(maxHunger) : PLAYER_MAX_HUNGER;
        this.maxHunger = safeMax;
        this.hunger = Number.isFinite(hunger) ? clamp(Math.round(hunger), 0, safeMax) : safeMax;
        this.equippedTool = equippedTool || 'hands';
    }

    public triggerHitReaction(
        knockX = 0,
        knockZ = 0,
        knockSpeed = 5.5
    ): void {
        this.hitAnimTimer = HIT_ANIM_DURATION_SEC;
        this.hitFlashTimer = HIT_FLASH_DURATION_SEC;
        const len = Math.hypot(knockX, knockZ);
        if (len > 1e-4) {
            this.knockbackVelX = (knockX / len) * knockSpeed;
            this.knockbackVelZ = (knockZ / len) * knockSpeed;
        }
        if (this.dodgeTimer <= 0) {
            this.state = 'hit';
        }
    }

    public applyDamage(
        amount: number,
        knockX = 0,
        knockZ = 0,
        knockSpeed = 5.5
    ): boolean {
        if (this.isInvulnerable() || this.hp <= 0 || !Number.isFinite(amount) || amount <= 0) {
            return false;
        }
        this.hp = Math.max(0, Math.round(this.hp - amount));
        this.triggerHitReaction(knockX, knockZ, knockSpeed);
        return true;
    }

    public respawnAtCampfire(x = SPAWN_X, z = SPAWN_Z, invulnSec = 1.6): void {
        this.hp = this.maxHp;
        this.stamina = MAX_STAMINA;
        this.sprintExhausted = false;
        this.dodgeTimer = 0;
        this.dodgeInvulnTimer = 0;
        this.combatActionType = 'none';
        this.combatActionTimer = 0;
        this.hitAnimTimer = 0;
        this.hitFlashTimer = 0;
        this.knockbackVelX = 0;
        this.knockbackVelZ = 0;
        this.respawnInvulnTimer = invulnSec;
        this.teleport(x, z);
    }

    public setModelFacingOffsetDeg(deg: number): void {
        this.modelYawOffsetDeg = deg;
        this.modelEntity.setLocalEulerAngles(0, this.modelYawOffsetDeg, 0);
    }

    public teleport(x: number, z: number): void {
        const y = this.collisionWorld.getTerrainHeight(x, z);
        this.position.set(x, y, z);
        this.velocity.set(0, 0, 0);
        this.reconcileVisualOffset.set(0, 0, 0);
        this.grounded = true;
        this.coyoteTimer = COYOTE_TIME_SEC;
        this.jumpBufferTimer = 0;
        this.landingSquash = 0;
        this.applyRootTransform();
    }

    /**
     * Moves freshly joined or still-at-spawn players to a distinct co-op party spawn slot.
     */
    public setSpawnSlot(slotIndex: 0 | 1 | 2): void {
        const [targetX, targetZ] = SLOT_SPAWN_OFFSETS[slotIndex] ?? SLOT_SPAWN_OFFSETS[0];
        const distFromDefaultSpawn = Math.hypot(
            this.position.x - SPAWN_X,
            this.position.z - SPAWN_Z
        );
        if (distFromDefaultSpawn > 6.0) {
            return;
        }
        const distToTarget = Math.hypot(
            this.position.x - targetX,
            this.position.z - targetZ
        );
        if (distToTarget < 0.15) {
            return;
        }
        this.teleport(targetX, targetZ);
    }

    /**
     * Syncs the displayed collected crystal counter with room state.
     */
    public setCollectedCrystalCount(count: number): void {
        if (!Number.isFinite(count)) return;
        this.crystalsCollected = clamp(Math.round(count), 0, this.totalCrystals);
    }

    /**
     * Reconciles client-predicted state with authoritative server position/velocity.
     * Returns the correction distance in meters (0 if within deadzone).
     */
    public applyServerReconciliation(
        authPos: { x: number; y: number; z: number },
        authVel: { x: number; y: number; z: number },
        predictedPos: { x: number; y: number; z: number } | null
    ): number {
        const comparePos = predictedPos ?? this.position;
        const dx = comparePos.x - authPos.x;
        const dy = comparePos.y - authPos.y;
        const dz = comparePos.z - authPos.z;
        const errorMeters = Math.hypot(dx, dy, dz);

        if (!Number.isFinite(errorMeters) || errorMeters < RECONCILE_DEADZONE_M) {
            return 0;
        }

        if (errorMeters > RECONCILE_SNAP_M) {
            this.position.set(authPos.x, authPos.y, authPos.z);
            this.velocity.set(authVel.x, authVel.y, authVel.z);
            this.reconcileVisualOffset.set(0, 0, 0);
            this.applyRootTransform();
            return errorMeters;
        }

        const prevVisualX = this.position.x + this.reconcileVisualOffset.x;
        const prevVisualY = this.position.y + this.reconcileVisualOffset.y;
        const prevVisualZ = this.position.z + this.reconcileVisualOffset.z;

        this.position.set(authPos.x, authPos.y, authPos.z);
        this.reconcileVisualOffset.set(
            prevVisualX - authPos.x,
            prevVisualY - authPos.y,
            prevVisualZ - authPos.z
        );
        if (this.reconcileVisualOffset.lengthSq() > RECONCILE_SNAP_M * RECONCILE_SNAP_M) {
            this.reconcileVisualOffset.normalize().scale(RECONCILE_SNAP_M);
        }
        this.applyRootTransform();
        return errorMeters;
    }

    public update(
        dt: number,
        input: InputState,
        camForwardXZ: pc.Vec3,
        camRightXZ: pc.Vec3
    ): void {
        const clampedDt = Math.max(0.0001, Math.min(0.05, dt));
        this.prevPos.copy(this.position);
        this.prevYawDeg = this.yawDeg;

        // Tick combat & invulnerability timers
        this.dodgeInvulnTimer = Math.max(0, this.dodgeInvulnTimer - clampedDt);
        this.dodgeCooldownTimer = Math.max(0, this.dodgeCooldownTimer - clampedDt);
        this.respawnInvulnTimer = Math.max(0, this.respawnInvulnTimer - clampedDt);
        this.meleeCooldownTimer = Math.max(0, this.meleeCooldownTimer - clampedDt);
        this.rangedCooldownTimer = Math.max(0, this.rangedCooldownTimer - clampedDt);
        this.throwCooldownTimer = Math.max(0, this.throwCooldownTimer - clampedDt);
        this.meleeComboResetTimer = Math.max(0, this.meleeComboResetTimer - clampedDt);
        if (this.meleeComboResetTimer <= 0 && this.combatActionType !== 'melee') {
            this.meleeComboStep = 0;
        }
        this.hitAnimTimer = Math.max(0, this.hitAnimTimer - clampedDt);
        this.hitFlashTimer = Math.max(0, this.hitFlashTimer - clampedDt);
        if (this.combatActionTimer > 0) {
            this.combatActionTimer = Math.max(0, this.combatActionTimer - clampedDt);
            if (this.combatActionTimer <= 0) {
                this.combatActionType = 'none';
            }
        }

        // 1. Camera-relative wish direction
        const moveMag = clamp(input.moveMagnitude, 0, 1);
        this.wishDir.set(
            camRightXZ.x * input.moveX + camForwardXZ.x * -input.moveZ,
            0,
            camRightXZ.z * input.moveX + camForwardXZ.z * -input.moveZ
        );
        const wishLenSq = this.wishDir.lengthSq();
        const hasMoveInput = moveMag > 0.04 && wishLenSq > 1e-6;
        if (wishLenSq > 1e-6) {
            this.wishDir.normalize();
            this.hasLatestWishDir = hasMoveInput;
            this.latestWishDir.copy(this.wishDir);
        } else {
            this.wishDir.set(0, 0, 0);
            this.hasLatestWishDir = false;
        }

        // Fallback self-handling only if MonsterCombatManager is not attached
        if (!this.combatManagedExternally) {
            if (input.dodgePressed) {
                this.triggerDodge();
            } else if (input.meleePressed) {
                this.triggerMeleeAttack();
            } else if (input.rangedPressed) {
                this.triggerRangedCast();
            } else if (input.capturePressed) {
                this.triggerCaptureThrow();
            }
        }

        // 2. Stamina & sprint state
        const isDodgingNow = this.dodgeTimer > 0;
        const wantsSprint =
            !isDodgingNow && input.sprintHeld && hasMoveInput && !this.sprintExhausted;
        if (wantsSprint) {
            this.stamina = Math.max(0, this.stamina - STAMINA_DRAIN_PER_SEC * clampedDt);
            if (this.stamina <= 0) {
                this.sprintExhausted = true;
            }
        } else if (!isDodgingNow) {
            this.stamina = Math.min(
                MAX_STAMINA,
                this.stamina + STAMINA_REGEN_PER_SEC * clampedDt
            );
            if (this.sprintExhausted && this.stamina >= STAMINA_RECOVERY_THRESHOLD) {
                this.sprintExhausted = false;
            }
        }

        const isSprinting = wantsSprint && this.stamina > 0;

        // 3. Horizontal velocity (dodge burst vs locomotion + knockback)
        if (isDodgingNow) {
            this.dodgeTimer = Math.max(0, this.dodgeTimer - clampedDt);
            const progress = 1 - this.dodgeTimer / DODGE_DURATION_SEC;
            const burstSpeed = lerp(DODGE_BURST_START_SPEED, DODGE_BURST_END_SPEED, progress);
            this.velocity.x = this.dodgeDir.x * burstSpeed;
            this.velocity.z = this.dodgeDir.z * burstSpeed;
        } else {
            const targetMaxSpeed = (isSprinting ? SPRINT_SPEED : WALK_SPEED) * moveMag;
            const targetVx = hasMoveInput ? this.wishDir.x * targetMaxSpeed : 0;
            const targetVz = hasMoveInput ? this.wishDir.z * targetMaxSpeed : 0;

            const controlFactor = this.grounded ? 1.0 : AIR_CONTROL;
            const accelRate = (hasMoveInput ? ACCELERATION : DECELERATION) * controlFactor;
            const maxDeltaV = accelRate * clampedDt;

            const dvx = targetVx - this.velocity.x;
            const dvz = targetVz - this.velocity.z;
            const dvLen = Math.hypot(dvx, dvz);
            if (dvLen <= maxDeltaV || dvLen < 1e-6) {
                this.velocity.x = targetVx;
                this.velocity.z = targetVz;
            } else {
                const scale = maxDeltaV / dvLen;
                this.velocity.x += dvx * scale;
                this.velocity.z += dvz * scale;
            }

            if (
                Math.abs(this.knockbackVelX) > 0.05 ||
                Math.abs(this.knockbackVelZ) > 0.05
            ) {
                this.velocity.x += this.knockbackVelX * clampedDt * 8;
                this.velocity.z += this.knockbackVelZ * clampedDt * 8;
                const kbDecay = Math.exp(-10 * clampedDt);
                this.knockbackVelX *= kbDecay;
                this.knockbackVelZ *= kbDecay;
            } else {
                this.knockbackVelX = 0;
                this.knockbackVelZ = 0;
            }
        }

        // 4. Coyote time & jump buffer
        if (this.grounded) {
            this.coyoteTimer = COYOTE_TIME_SEC;
        } else {
            this.coyoteTimer = Math.max(0, this.coyoteTimer - clampedDt);
        }

        if (input.jumpPressed && !isDodgingNow) {
            this.jumpBufferTimer = JUMP_BUFFER_SEC;
        } else {
            this.jumpBufferTimer = Math.max(0, this.jumpBufferTimer - clampedDt);
        }

        if (this.jumpBufferTimer > 0 && this.coyoteTimer > 0 && !isDodgingNow) {
            this.velocity.y = JUMP_VELOCITY;
            this.grounded = false;
            this.coyoteTimer = 0;
            this.jumpBufferTimer = 0;
        }

        // 5. Gravity & gentle ground stickiness
        this.velocity.y += GRAVITY * clampedDt;
        if (this.grounded && this.velocity.y < -2.0) {
            this.velocity.y = -2.0;
        }

        // 6. Collision resolution
        this.desiredPos.set(
            this.position.x + this.velocity.x * clampedDt,
            this.position.y + this.velocity.y * clampedDt,
            this.position.z + this.velocity.z * clampedDt
        );

        const resolved = this.collisionWorld.resolveSphereMovement(
            this.position,
            this.desiredPos,
            PLAYER_RADIUS,
            PLAYER_STEP_HEIGHT
        );

        const wasGrounded = this.grounded;
        this.position.copy(resolved.position);
        this.grounded = resolved.grounded;

        if (this.grounded) {
            if (!wasGrounded && this.velocity.y < -3.5) {
                this.landingSquash = Math.min(1.0, Math.abs(this.velocity.y) / 14.0);
            }
            if (this.velocity.y < 0) {
                this.velocity.y = 0;
            }
        }

        // Damp horizontal velocity into obstacles so animation matches actual movement
        if (resolved.hitObstacle && clampedDt > 1e-4) {
            const actualVx = (this.position.x - this.prevPos.x) / clampedDt;
            const actualVz = (this.position.z - this.prevPos.z) / clampedDt;
            const blend = 1 - Math.exp(-16 * clampedDt);
            this.velocity.x = lerp(this.velocity.x, actualVx, blend);
            this.velocity.z = lerp(this.velocity.z, actualVz, blend);
        }

        // 7. Smooth facing yaw toward movement direction (preserved during dodge)
        const horizSpeed = Math.hypot(this.velocity.x, this.velocity.z);
        if (isDodgingNow) {
            this.yawDeg = normalizeAngleDeg(
                Math.atan2(-this.dodgeDir.x, -this.dodgeDir.z) * pc.math.RAD_TO_DEG
            );
        } else if (hasMoveInput && this.combatActionTimer <= 0.1) {
            const targetYaw = Math.atan2(-this.wishDir.x, -this.wishDir.z) * pc.math.RAD_TO_DEG;
            const deltaYaw = normalizeAngleDeg(targetYaw - this.yawDeg);
            const turnSharpness = this.grounded ? 14 : 7;
            this.yawDeg += deltaYaw * (1 - Math.exp(-turnSharpness * clampedDt));
            this.yawDeg = normalizeAngleDeg(this.yawDeg);
        }
        this.yawRateDegPerSec =
            normalizeAngleDeg(this.yawDeg - this.prevYawDeg) / clampedDt;

        // 8. Water & locomotion + combat state classification
        const waterLevel = this.collisionWorld.getWaterLevel();
        this.inWater = this.position.y < waterLevel - 0.05;

        if (!this.grounded) {
            this.locomotionState = this.velocity.y > 0.4 ? 'jump' : 'fall';
        } else if (horizSpeed < 0.25) {
            this.locomotionState = 'idle';
        } else if (horizSpeed > WALK_SPEED + 1.1 || (isSprinting && horizSpeed > 4.2)) {
            this.locomotionState = 'run';
        } else {
            this.locomotionState = 'walk';
        }

        if (this.dodgeTimer > 0) {
            this.state = 'dodge';
        } else if (this.hitAnimTimer > 0) {
            this.state = 'hit';
        } else if (this.combatActionTimer > 0) {
            if (this.combatActionType === 'throw') {
                this.state = 'throw';
            } else if (this.combatActionType === 'gather') {
                this.state = 'gather';
            } else if (this.combatActionType === 'build') {
                this.state = 'build';
            } else {
                this.state = 'attack';
            }
        } else {
            this.state = this.locomotionState;
        }

        // 9. Crystal detection & collection
        this.handleCrystalInteraction(input);

        // 10. Decay reconciliation visual offset and apply entity transforms and animation states
        if (this.reconcileVisualOffset.lengthSq() > 1e-8) {
            const decay = Math.exp(-RECONCILE_DECAY_RATE * clampedDt);
            this.reconcileVisualOffset.scale(decay);
            if (this.reconcileVisualOffset.lengthSq() < 1e-6) {
                this.reconcileVisualOffset.set(0, 0, 0);
            }
        }

        this.applyRootTransform();
        this.updateMaterialCombatTint();

        this.updateAnimationTimers(clampedDt, horizSpeed, isSprinting);
        this.updateGlbAnimationState(horizSpeed);
    }

    private applyRootTransform(): void {
        this.rootEntity.setPosition(
            this.position.x + this.reconcileVisualOffset.x,
            this.position.y + this.reconcileVisualOffset.y,
            this.position.z + this.reconcileVisualOffset.z
        );
        this.rootEntity.setLocalEulerAngles(0, this.yawDeg, 0);
    }

    public getPosition(): pc.Vec3 {
        return this.position.clone();
    }

    public getPositionRef(): pc.Vec3 {
        return this.position;
    }

    public getTelemetry(): PlayerTelemetry {
        const horizSpeed = Math.hypot(this.velocity.x, this.velocity.z);
        return {
            position: this.position.clone(),
            velocity: this.velocity.clone(),
            speed: Math.round(horizSpeed * 100) / 100,
            yawDeg: Math.round(this.yawDeg * 100) / 100,
            state: this.state,
            grounded: this.grounded,
            inWater: this.inWater,
            stamina: Math.round(this.stamina * 10) / 10,
            crystalsCollected: this.crystalsCollected,
            totalCrystals: this.totalCrystals,
            nearbyHint: this.nearbyHint,
            hp: this.hp,
            maxHp: this.maxHp,
            dodging: this.isDodging(),
            attackComboStep: this.meleeComboStep,
            hunger: this.hunger,
            maxHunger: this.maxHunger,
            equippedTool: this.equippedTool,
        };
    }

    public dispose(): void {
        this.app.off('postupdate', this.onPostUpdateBound);
        this.rootEntity.destroy();
        for (const entry of this.clonedMaterials) {
            entry.material.destroy();
        }
        this.clonedMaterials.length = 0;
    }

    private handleCrystalInteraction(input: InputState): void {
        const nearest = this.collisionWorld.findNearestInteractable(
            this.position,
            CRYSTAL_DETECT_RADIUS
        );

        if (!nearest || nearest.collected) {
            this.nearbyHint = null;
            return;
        }

        const dist = Math.hypot(
            nearest.position.x - this.position.x,
            nearest.position.z - this.position.z
        );

        this.nearbyHint = 'Vital Crystal nearby — Press E / Tap ACT';

        if (dist < CRYSTAL_AUTO_COLLECT_RADIUS || input.interactPressed) {
            const collected = this.onCollectCrystal(nearest.id);
            if (collected) {
                this.crystalsCollected += 1;
                this.interactPulse = 1.0;
                this.nearbyHint = null;
            }
        }
    }

    private bindJointNodes(): void {
        const allNodes: pc.GraphNode[] = [];
        const collectNodes = (node: pc.GraphNode) => {
            allNodes.push(node);
            for (const child of node.children) {
                collectNodes(child);
            }
        };
        collectNodes(this.modelEntity);

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
                this.joints.set(jointName, {
                    node: fallback,
                    restPos: fallback.getLocalPosition().clone(),
                    restRot: fallback.getLocalRotation().clone(),
                });
            }
        }
    }

    private setupGlbAnimations(bundle: LoadedModelBundle): void {
        const resource = bundle.containerAsset?.resource as
            | pc.ContainerResource
            | undefined;
        const animAssets = resource?.animations;
        if (!animAssets || animAssets.length === 0) {
            return;
        }

        const anim = this.modelEntity.addComponent('anim', {
            activate: true,
        }) as pc.AnimComponent;

        for (const asset of animAssets) {
            const track = asset.resource as pc.AnimTrack | undefined;
            if (!track) continue;
            const lower = (asset.name || track.name || '').toLowerCase();
            if (lower.includes('idle')) {
                anim.assignAnimation('idle', track, undefined, 1.0, true);
                this.animClipMap.set('idle', 'idle');
            } else if (lower.includes('walk')) {
                anim.assignAnimation('walk', track, undefined, 1.0, true);
                this.animClipMap.set('walk', 'walk');
            } else if (lower.includes('run')) {
                anim.assignAnimation('run', track, undefined, 1.0, true);
                this.animClipMap.set('run', 'run');
            } else if (lower.includes('jump') || lower.includes('fall')) {
                anim.assignAnimation('jump', track, undefined, 1.0, false);
                this.animClipMap.set('jump', 'jump');
            }
        }

        if (this.animClipMap.size === 0) {
            this.modelEntity.removeComponent('anim');
            return;
        }

        this.animComponent = anim;
        const initialClip =
            this.animClipMap.get('idle') ?? Array.from(this.animClipMap.values())[0];
        this.activeAnimState = initialClip;
        anim.baseLayer?.transition(initialClip, 0);
    }

    private updateAnimationTimers(
        dt: number,
        horizSpeed: number,
        isSprinting: boolean
    ): void {
        this.idleTime += dt;

        const targetLocomotion = this.grounded ? clamp(horizSpeed / WALK_SPEED, 0, 1) : 0;
        const targetRun =
            this.grounded && (isSprinting || horizSpeed > WALK_SPEED + 0.6)
                ? clamp((horizSpeed - WALK_SPEED) / (SPRINT_SPEED - WALK_SPEED), 0, 1)
                : 0;
        const targetAir = this.grounded ? 0 : 1;
        const targetIdleNeutral =
            this.grounded &&
            this.locomotionState === 'idle' &&
            this.dodgeTimer <= 0 &&
            this.combatActionTimer <= 0 &&
            this.hitAnimTimer <= 0
                ? 1
                : 0;

        const blendRate = 1 - Math.exp(-12 * dt);
        this.locomotionBlend = lerp(this.locomotionBlend, targetLocomotion, blendRate);
        this.runBlend = lerp(this.runBlend, targetRun, blendRate);
        this.airBlend = lerp(this.airBlend, targetAir, 1 - Math.exp(-14 * dt));
        this.idleNeutralBlend = lerp(
            this.idleNeutralBlend,
            targetIdleNeutral,
            1 - Math.exp(-10 * dt)
        );

        if (horizSpeed > 0.2 && this.grounded) {
            const strideFreq = lerp(7.2, 13.0, this.runBlend);
            this.stridePhase += dt * strideFreq;
        }

        this.landingSquash = Math.max(0, this.landingSquash - dt * 5.2);
        this.interactPulse = Math.max(0, this.interactPulse - dt * 3.5);
    }

    private updateGlbAnimationState(horizSpeed: number): void {
        if (!this.animComponent || !this.animComponent.baseLayer) return;

        let targetClip: string | undefined;
        if (!this.grounded) {
            targetClip =
                this.animClipMap.get('jump') ??
                this.animClipMap.get('run') ??
                this.animClipMap.get('idle');
        } else if (this.locomotionState === 'run') {
            targetClip =
                this.animClipMap.get('run') ??
                this.animClipMap.get('walk') ??
                this.animClipMap.get('idle');
        } else if (this.locomotionState === 'walk') {
            targetClip = this.animClipMap.get('walk') ?? this.animClipMap.get('idle');
        } else {
            targetClip = this.animClipMap.get('idle');
        }

        if (targetClip && targetClip !== this.activeAnimState) {
            this.activeAnimState = targetClip;
            this.animComponent.baseLayer.transition(targetClip, 0.16);
        }

        if (this.activeAnimState === 'walk') {
            this.animComponent.speed = clamp(horizSpeed / WALK_SPEED, 0.5, 1.35);
        } else if (this.activeAnimState === 'run') {
            this.animComponent.speed = clamp(horizSpeed / SPRINT_SPEED, 0.75, 1.3);
        } else {
            this.animComponent.speed = 1.0;
        }
    }

    private applyProceduralPolish(): void {
        this.applyRootTransform();

        // 1. Visual root lean, banking, and landing squash (in PlayerRoot frame: -Z forward, +X right)
        const forwardLean =
            this.locomotionBlend * lerp(5, 13, this.runBlend) +
            this.airBlend * (this.velocity.y > 0 ? -4 : 6);
        const turnBank = clamp(this.yawRateDegPerSec * 0.045, -10, 10) * this.locomotionBlend;

        const squashY = 1 - this.landingSquash * 0.2;
        const squashXZ = 1 + this.landingSquash * 0.14;

        this.visualPivot.setLocalPosition(0, 0, 0);
        this.visualPivot.setLocalEulerAngles(-forwardLean, 0, turnBank);
        this.visualPivot.setLocalScale(squashXZ, squashY, squashXZ);

        // If GLB animations are playing, add dynamic cape flutter & turn sway on top of evaluated pose
        const glbDrivingActive =
            this.animComponent !== null &&
            this.activeAnimState !== null &&
            this.animClipMap.has(
                this.locomotionState === 'fall' ? 'jump' : this.locomotionState
            );

        const phase = this.stridePhase;
        const strideSin = Math.sin(phase);
        const strideCos = Math.cos(phase);
        const doubleCos = Math.cos(phase * 2);
        const loco = this.locomotionBlend;
        const run = this.runBlend;
        const air = this.airBlend;
        const groundWeight = 1 - air;
        const speedNorm = clamp(Math.hypot(this.velocity.x, this.velocity.z) / SPRINT_SPEED, 0, 1);

        if (glbDrivingActive) {
            // Smoothly return lower limbs to neutral stand pose during Idle
            if (this.idleNeutralBlend > 0.02) {
                const legNames: JointName[] = ['Leg_L', 'Shin_L', 'Leg_R', 'Shin_R'];
                for (const legName of legNames) {
                    const legJoint = this.joints.get(legName);
                    if (!legJoint) continue;
                    this.tmpRotQuat.slerp(
                        legJoint.node.getLocalRotation(),
                        legJoint.restRot,
                        this.idleNeutralBlend
                    );
                    legJoint.node.setLocalRotation(this.tmpRotQuat);
                }
            }

            const capeJoint = this.joints.get('Cape');
            if (capeJoint) {
                const flutterPitch =
                    Math.sin(this.idleTime * 3.1) * 2.5 +
                    Math.sin(phase * 2) * 5.0 * loco +
                    speedNorm * 4.0;
                const flutterRoll =
                    Math.sin(this.idleTime * 2.1) * 2.2 + turnBank * 0.65;
                this.tmpQuat.setFromEulerAngles(flutterPitch, 0, flutterRoll);
                this.tmpRotQuat.mul2(capeJoint.node.getLocalRotation(), this.tmpQuat);
                capeJoint.node.setLocalRotation(this.tmpRotQuat);
            }
            this.applyCombatPoseOverlay(true, forwardLean, turnBank, squashXZ, squashY);
            return;
        }

        // 2. Full procedural fallback locomotion (glTF +Z forward: -X swings forward, +X bends back)
        const capeBillow =
            6 +
            speedNorm * 28 +
            air * 22 +
            Math.sin(this.idleTime * 2.3) * 3.5 +
            Math.sin(phase * 2) * 7 * loco;
        const capeSwayZ =
            Math.sin(this.idleTime * 1.7) * 2.5 + turnBank * 0.6;
        this.applyJointRotationOffset('Cape', capeBillow, 0, capeSwayZ);

        const breath = Math.sin(this.idleTime * 2.2);

        // Hips bob & counter-twist
        const hipBobY =
            (-doubleCos * 0.5 + 0.5) * lerp(0.035, 0.075, run) * loco * groundWeight -
            this.landingSquash * 0.08 +
            breath * 0.008 * (1 - loco);
        const hipYaw = strideSin * lerp(4, 8, run) * loco * groundWeight;
        this.applyJointPositionOffset('Hips', 0, hipBobY, 0);
        this.applyJointRotationOffset('Hips', 0, hipYaw, 0);

        // Torso breathing, lean & counter-twist (-X leans forward toward +Z)
        const torsoPitch =
            -breath * 1.4 * (1 - loco) -
            lerp(4, 11, run) * loco * groundWeight -
            air * (this.velocity.y > 0 ? -4 : 6);
        const torsoYaw = -hipYaw * 1.15;
        this.applyJointRotationOffset('Torso', torsoPitch, torsoYaw, 0);

        // Head stabilization & turn look-ahead
        const headYaw = clamp(this.yawRateDegPerSec * 0.05, -14, 14) - torsoYaw * 0.5;
        const headPitch =
            -torsoPitch * 0.45 +
            breath * 1.0 * (1 - loco) +
            air * (this.velocity.y > 0 ? -8 : 6);
        this.applyJointRotationOffset('Head', headPitch, headYaw, 0);

        // Backpack subtle bounce
        const packPitch =
            (-doubleCos * 3.0 * loco * groundWeight) + this.interactPulse * 8;
        this.applyJointRotationOffset('Backpack', packPitch, 0, 0);

        // Legs & Shins (-X swings leg forward toward +Z; +X bends knee backward toward -Z)
        const legAmp = lerp(28, 52, run) * loco * groundWeight;
        const legLAngle = -strideSin * legAmp - air * (this.velocity.y > 0 ? 34 : 18);
        const legRAngle = strideSin * legAmp - air * (this.velocity.y > 0 ? -18 : 10);

        const kneeLAngle =
            Math.max(0, -strideCos) * lerp(36, 62, run) * loco * groundWeight +
            air * (this.velocity.y > 0 ? 52 : 28) +
            this.landingSquash * 32;
        const kneeRAngle =
            Math.max(0, strideCos) * lerp(36, 62, run) * loco * groundWeight +
            air * (this.velocity.y > 0 ? 24 : 22) +
            this.landingSquash * 32;

        this.applyJointRotationOffset('Leg_L', legLAngle, 0, 0);
        this.applyJointRotationOffset('Leg_R', legRAngle, 0, 0);
        this.applyJointRotationOffset('Shin_L', kneeLAngle, 0, 0);
        this.applyJointRotationOffset('Shin_R', kneeRAngle, 0, 0);

        // Arms & ForeArms (-X swings arm forward; -X bends elbow forward)
        const armAmp = lerp(24, 48, run) * loco * groundWeight;
        const armLAngle =
            strideSin * armAmp -
            air * (this.velocity.y > 0 ? 45 : 22) -
            this.interactPulse * 35;
        const armRAngle =
            -strideSin * armAmp -
            air * (this.velocity.y > 0 ? 30 : 22) -
            this.interactPulse * 35;

        const armRoll = (1 - loco) * 5 + air * 22;
        const elbowBase = lerp(12, 56, run) * loco + (1 - loco) * 10 + air * 32;
        const forearmLAngle = -(elbowBase + Math.max(0, strideSin) * 18 * loco);
        const forearmRAngle = -(elbowBase + Math.max(0, -strideSin) * 18 * loco);

        this.applyJointRotationOffset('Arm_L', armLAngle, 0, armRoll);
        this.applyJointRotationOffset('Arm_R', armRAngle, 0, -armRoll);
        this.applyJointRotationOffset('ForeArm_L', forearmLAngle, 0, 0);
        this.applyJointRotationOffset('ForeArm_R', forearmRAngle, 0, 0);

        this.applyCombatPoseOverlay(false, forwardLean, turnBank, squashXZ, squashY);
    }

    private cloneMaterialsForCombatFeedback(): void {
        const sourceToClone = new Map<pc.Material, PlayerMaterialEntry>();
        const visit = (node: pc.GraphNode): void => {
            if (node instanceof pc.Entity && node.render) {
                for (const mi of node.render.meshInstances) {
                    const orig = mi.material;
                    if (!(orig instanceof pc.StandardMaterial)) continue;
                    let entry = sourceToClone.get(orig);
                    if (!entry) {
                        const cloned = orig.clone();
                        cloned.name = `${orig.name || 'PlayerMat'}_LocalClone`;
                        entry = {
                            material: cloned,
                            baseDiffuse: orig.diffuse.clone(),
                            baseEmissive: orig.emissive.clone(),
                            baseEmissiveIntensity: orig.emissiveIntensity,
                        };
                        sourceToClone.set(orig, entry);
                        this.clonedMaterials.push(entry);
                    }
                    mi.material = entry.material;
                }
            }
            for (const child of node.children) {
                visit(child);
            }
        };
        visit(this.modelEntity);
    }

    private updateMaterialCombatTint(): void {
        const desiredTint: 'none' | 'hit' | 'dodge' =
            this.hitFlashTimer > 0
                ? 'hit'
                : this.dodgeInvulnTimer > 0 || this.respawnInvulnTimer > 0
                  ? 'dodge'
                  : 'none';

        if (desiredTint === this.activeVisualTint) return;
        this.activeVisualTint = desiredTint;

        for (const entry of this.clonedMaterials) {
            const mat = entry.material;
            if (desiredTint === 'hit') {
                mat.diffuse.set(
                    lerp(entry.baseDiffuse.r, 1.0, 0.65),
                    lerp(entry.baseDiffuse.g, 0.22, 0.65),
                    lerp(entry.baseDiffuse.b, 0.22, 0.65)
                );
                mat.emissive.set(0.95, 0.18, 0.16);
                mat.emissiveIntensity = Math.max(1.5, entry.baseEmissiveIntensity);
            } else if (desiredTint === 'dodge') {
                mat.diffuse.set(
                    lerp(entry.baseDiffuse.r, 0.35, 0.45),
                    lerp(entry.baseDiffuse.g, 0.92, 0.45),
                    lerp(entry.baseDiffuse.b, 1.0, 0.45)
                );
                mat.emissive.set(0.22, 0.88, 1.0);
                mat.emissiveIntensity = Math.max(1.1, entry.baseEmissiveIntensity);
            } else {
                mat.diffuse.copy(entry.baseDiffuse);
                mat.emissive.copy(entry.baseEmissive);
                mat.emissiveIntensity = entry.baseEmissiveIntensity;
            }
            mat.update();
        }
    }

    private applyAdditiveOrPoseRotation(
        name: JointName,
        additiveOnGlb: boolean,
        pitchDeg: number,
        yawDeg: number,
        rollDeg: number
    ): void {
        const joint = this.joints.get(name);
        if (!joint) return;
        this.tmpQuat.setFromEulerAngles(pitchDeg, yawDeg, rollDeg);
        const baseRot = additiveOnGlb ? joint.node.getLocalRotation() : joint.restRot;
        this.tmpRotQuat.mul2(baseRot, this.tmpQuat);
        joint.node.setLocalRotation(this.tmpRotQuat);
    }

    private applyCombatPoseOverlay(
        additiveOnGlb: boolean,
        forwardLean: number,
        turnBank: number,
        squashXZ: number,
        squashY: number
    ): void {
        // Dodge 360-degree forward somersault burst
        if (this.dodgeTimer > 0) {
            const p = clamp(1 - this.dodgeTimer / DODGE_DURATION_SEC, 0, 1);
            const hopY = Math.sin(p * Math.PI) * 0.34;
            const rollPitch = -p * 360;
            this.visualPivot.setLocalPosition(0, hopY, 0);
            this.visualPivot.setLocalEulerAngles(rollPitch, 0, turnBank * 0.4);
            this.visualPivot.setLocalScale(1.06, 0.86, 1.06);

            this.applyAdditiveOrPoseRotation('Torso', additiveOnGlb, -28, 0, 0);
            this.applyAdditiveOrPoseRotation('Arm_L', additiveOnGlb, -45, 0, 16);
            this.applyAdditiveOrPoseRotation('Arm_R', additiveOnGlb, -45, 0, -16);
            this.applyAdditiveOrPoseRotation('Leg_L', additiveOnGlb, -48, 0, 0);
            this.applyAdditiveOrPoseRotation('Leg_R', additiveOnGlb, -48, 0, 0);
            this.applyAdditiveOrPoseRotation('Shin_L', additiveOnGlb, 72, 0, 0);
            this.applyAdditiveOrPoseRotation('Shin_R', additiveOnGlb, 72, 0, 0);
            return;
        }

        // Hit recoil flinch
        if (this.hitAnimTimer > 0) {
            const p = clamp(this.hitAnimTimer / HIT_ANIM_DURATION_SEC, 0, 1);
            const recoil = Math.sin(p * Math.PI);
            this.visualPivot.setLocalEulerAngles(-forwardLean + recoil * 18, 0, turnBank - recoil * 10);
            this.applyAdditiveOrPoseRotation('Torso', additiveOnGlb, recoil * 22, recoil * 14, 0);
            this.applyAdditiveOrPoseRotation('Arm_L', additiveOnGlb, -25 * recoil, 0, 28 * recoil);
            this.applyAdditiveOrPoseRotation('Arm_R', additiveOnGlb, -25 * recoil, 0, -28 * recoil);
            return;
        }

        if (this.combatActionTimer <= 0 || this.combatActionType === 'none') {
            return;
        }

        const p = clamp(1 - this.combatActionTimer / Math.max(0.05, this.combatActionDuration), 0, 1);
        const swingBell = Math.sin(p * Math.PI);

        if (this.combatActionType === 'melee') {
            if (this.meleeComboStep === 1) {
                const sweep = lerp(-1.0, 1.0, Math.min(1, p * 1.25));
                this.visualPivot.setLocalEulerAngles(-forwardLean - 12 * swingBell, sweep * 14, turnBank);
                this.applyAdditiveOrPoseRotation('Torso', additiveOnGlb, -12 * swingBell, -sweep * 32, 0);
                this.applyAdditiveOrPoseRotation('Arm_R', additiveOnGlb, -72 - swingBell * 24, sweep * 46, -24);
                this.applyAdditiveOrPoseRotation('ForeArm_R', additiveOnGlb, -48, 0, 0);
                this.applyAdditiveOrPoseRotation('Arm_L', additiveOnGlb, 22 * swingBell, 0, 20);
            } else if (this.meleeComboStep === 2) {
                const sweep = lerp(1.0, -1.0, Math.min(1, p * 1.25));
                this.visualPivot.setLocalEulerAngles(-forwardLean - 14 * swingBell, sweep * 16, turnBank);
                this.applyAdditiveOrPoseRotation('Torso', additiveOnGlb, -14 * swingBell, -sweep * 34, 0);
                this.applyAdditiveOrPoseRotation('Arm_R', additiveOnGlb, -78 - swingBell * 20, sweep * 52, -16);
                this.applyAdditiveOrPoseRotation('ForeArm_R', additiveOnGlb, -38, 0, 0);
                this.applyAdditiveOrPoseRotation('Arm_L', additiveOnGlb, -56 * swingBell, -sweep * 25, 18);
            } else {
                // 3rd hit overhead finisher slam
                const windup = p < 0.38 ? p / 0.38 : 1 - (p - 0.38) / 0.62;
                const slamPitch = p < 0.38 ? lerp(-25, -138, windup) : lerp(-138, -18, 1 - windup);
                const bodyLean = p < 0.38 ? 10 * windup : -22 * (1 - windup);
                const slamSquash = p > 0.55 ? 0.1 * Math.sin(((p - 0.55) / 0.45) * Math.PI) : 0;
                this.visualPivot.setLocalEulerAngles(-forwardLean + bodyLean, 0, turnBank);
                this.visualPivot.setLocalScale(squashXZ + slamSquash, squashY - slamSquash, squashXZ + slamSquash);
                this.applyAdditiveOrPoseRotation('Torso', additiveOnGlb, bodyLean, 0, 0);
                this.applyAdditiveOrPoseRotation('Arm_R', additiveOnGlb, slamPitch, 0, -14);
                this.applyAdditiveOrPoseRotation('Arm_L', additiveOnGlb, slamPitch, 0, 14);
                this.applyAdditiveOrPoseRotation('ForeArm_R', additiveOnGlb, -32, 0, 0);
                this.applyAdditiveOrPoseRotation('ForeArm_L', additiveOnGlb, -32, 0, 0);
            }
            return;
        }

        if (this.combatActionType === 'ranged') {
            this.visualPivot.setLocalEulerAngles(-forwardLean - 10 * swingBell, 0, turnBank);
            this.applyAdditiveOrPoseRotation('Torso', additiveOnGlb, -12 * swingBell, 0, 0);
            this.applyAdditiveOrPoseRotation('Arm_R', additiveOnGlb, -82 * swingBell, -14, -10);
            this.applyAdditiveOrPoseRotation('Arm_L', additiveOnGlb, -82 * swingBell, 14, 10);
            this.applyAdditiveOrPoseRotation('ForeArm_R', additiveOnGlb, -20 * swingBell, 0, 0);
            this.applyAdditiveOrPoseRotation('ForeArm_L', additiveOnGlb, -20 * swingBell, 0, 0);
            return;
        }

        if (this.combatActionType === 'throw') {
            const throwSwing = p < 0.35 ? lerp(48, -115, p / 0.35) : lerp(-115, -25, (p - 0.35) / 0.65);
            const twist = p < 0.35 ? lerp(24, -22, p / 0.35) : lerp(-22, 16, (p - 0.35) / 0.65);
            this.visualPivot.setLocalEulerAngles(-forwardLean - 10 * swingBell, twist * 0.4, turnBank);
            this.applyAdditiveOrPoseRotation('Torso', additiveOnGlb, -10 * swingBell, twist, 0);
            this.applyAdditiveOrPoseRotation('Arm_R', additiveOnGlb, throwSwing, 0, -18);
            this.applyAdditiveOrPoseRotation('ForeArm_R', additiveOnGlb, -30, 0, 0);
            this.applyAdditiveOrPoseRotation('Arm_L', additiveOnGlb, -34 * swingBell, 0, 22);
            return;
        }

        if (this.combatActionType === 'gather') {
            // Crisp downward chop / pickaxe strike followed by swift recovery
            const chop = p < 0.42 ? lerp(-110, 22, p / 0.42) : lerp(22, -18, (p - 0.42) / 0.58);
            const torsoLean = p < 0.42 ? lerp(12, -16, p / 0.42) : lerp(-16, 0, (p - 0.42) / 0.58);
            this.visualPivot.setLocalEulerAngles(-forwardLean + torsoLean * 0.45, 0, turnBank);
            this.applyAdditiveOrPoseRotation('Torso', additiveOnGlb, torsoLean, -14 * swingBell, 0);
            this.applyAdditiveOrPoseRotation('Arm_R', additiveOnGlb, chop, 14 * swingBell, -14);
            this.applyAdditiveOrPoseRotation('ForeArm_R', additiveOnGlb, -38 * swingBell, 0, 0);
            this.applyAdditiveOrPoseRotation('Arm_L', additiveOnGlb, -46 * swingBell, -12 * swingBell, 14);
            return;
        }

        if (this.combatActionType === 'build') {
            // Two-handed blueprint placement / hammer tap gesture
            this.visualPivot.setLocalEulerAngles(-forwardLean - 6 * swingBell, 0, turnBank);
            this.applyAdditiveOrPoseRotation('Torso', additiveOnGlb, -8 * swingBell, 0, 0);
            this.applyAdditiveOrPoseRotation('Arm_R', additiveOnGlb, -68 * swingBell, 16, -12);
            this.applyAdditiveOrPoseRotation('Arm_L', additiveOnGlb, -64 * swingBell, -16, 12);
            this.applyAdditiveOrPoseRotation('ForeArm_R', additiveOnGlb, -28 * swingBell, 0, 0);
            this.applyAdditiveOrPoseRotation('ForeArm_L', additiveOnGlb, -24 * swingBell, 0, 0);
        }
    }

    private applyJointPositionOffset(
        name: JointName,
        dx: number,
        dy: number,
        dz: number
    ): void {
        const joint = this.joints.get(name);
        if (!joint) return;
        this.tmpVec.set(
            joint.restPos.x + dx,
            joint.restPos.y + dy,
            joint.restPos.z + dz
        );
        joint.node.setLocalPosition(this.tmpVec);
    }

    private applyJointRotationOffset(
        name: JointName,
        pitchDeg: number,
        yawDeg: number,
        rollDeg: number
    ): void {
        const joint = this.joints.get(name);
        if (!joint) return;
        this.tmpQuat.setFromEulerAngles(pitchDeg, yawDeg, rollDeg);
        this.tmpRotQuat.mul2(joint.restRot, this.tmpQuat);
        joint.node.setLocalRotation(this.tmpRotQuat);
    }
}
