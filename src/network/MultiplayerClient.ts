import type { PlayerTelemetry } from '../types/interfaces';
import {
    type BaseWorkerSyncState,
    type C2SCombatActionMessage,
    type C2SMessage,
    type C2SSurvivalActionMessage,
    type C2SWorldEventMessage,
    type CapturedMonsterRecord,
    type CombatActionKind,
    type CompanionSyncState,
    type CoopConnectionState,
    type CoopNetworkMetrics,
    type CoopSessionStatus,
    type CraftRecipeId,
    MAX_PARTY_PLAYERS,
    type ModularStructureRecipeId,
    type MonsterSyncState,
    NETWORK_TICK_HZ,
    type NetworkSimulationOptions,
    PROTOCOL_VERSION,
    type PlacedStructureSyncState,
    type PlayerCombatState,
    type PlayerSlotIndex,
    type PlayerSyncPacket,
    type PlayerSyncState,
    type RemotePeerSnapshot,
    type ResourceNodeSyncState,
    type S2CCombatEventMessage,
    type S2CMessage,
    type S2CSurvivalEventMessage,
    type SharedResourceInventory,
    type SurvivalActionKind,
    type ToolId,
    type Vec3Tuple,
    type WorkSuitabilityKind,
    type WorldEventKind,
    type WorldEventPacket,
    createDefaultSharedResources,
    createEmptyNetworkMetrics,
    isValidRoomCode,
    playerSyncStateToPacket,
    sanitizeDisplayName,
    sanitizeRoomCode,
} from '../shared/NetworkProtocol';

export type CoopNotificationKind = 'info' | 'success' | 'warning' | 'error';

export type WorldEventCallback = (event: WorldEventPacket) => void;
export type CombatEventCallback = (event: S2CCombatEventMessage) => void;
export type SurvivalEventCallback = (event: S2CSurvivalEventMessage) => void;
export type ServerReconcileCallback = (
    authState: PlayerSyncState,
    predictedPos: Vec3Tuple | null
) => number | void;
export type NotificationCallback = (
    message: string,
    kind: CoopNotificationKind
) => void;
export type SnapshotCallback = (status: CoopSessionStatus) => void;
export type RoomJoinedCallback = (
    status: CoopSessionStatus,
    reconnected: boolean
) => void;

export interface CombatActionRequest {
    action: CombatActionKind;
    targetMonsterId?: string | null;
    companionUid?: string | null;
    aimYaw?: number;
    originX?: number;
    originY?: number;
    originZ?: number;
    dirX?: number;
    dirZ?: number;
}

export interface SurvivalActionRequest {
    action: SurvivalActionKind;
    nodeId?: string | null;
    craftRecipeId?: CraftRecipeId | null;
    toolId?: ToolId | null;
    foodKind?: 'berry' | 'cooked_berry' | null;
    structureRecipeId?: ModularStructureRecipeId | null;
    structureId?: string | null;
    gridX?: number;
    gridZ?: number;
    layer?: 0 | 1 | 2;
    rotationYawDeg?: number;
    x?: number;
    y?: number;
    z?: number;
    companionUid?: string | null;
    workPreference?: WorkSuitabilityKind | null;
}

interface PredictedFrame {
    seq: number;
    position: Vec3Tuple;
    velocity: Vec3Tuple;
    timestampMs: number;
}

interface TrafficSample {
    timeMs: number;
    bytes: number;
}

const SESSION_TOKEN_STORAGE_KEY = 'zaapworld.coop.sessionToken';
const PLAYER_ID_STORAGE_KEY = 'zaapworld.coop.playerId';
const DISPLAY_NAME_STORAGE_KEY = 'zaapworld.coop.displayName';

const TICK_INTERVAL_SEC = 1 / NETWORK_TICK_HZ;
const PING_INTERVAL_MS = 2000;
const CONNECT_TIMEOUT_MS = 8000;
const MAX_PREDICTION_HISTORY = 128;
const MAX_QUEUED_EVENTS = 64;
const RECONNECT_BACKOFF_MIN_MS = 500;
const RECONNECT_BACKOFF_MAX_MS = 4000;

function generateRandomId(prefix: string): string {
    try {
        if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
            return `${prefix}-${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
        }
    } catch {
        // Fallback below
    }
    const randA = Math.floor(Math.random() * 0xffffffff)
        .toString(36)
        .padStart(6, '0');
    const randB = Math.floor(Math.random() * 0xffffffff)
        .toString(36)
        .padStart(6, '0');
    return `${prefix}-${randA}${randB}`;
}

function readSessionStorage(key: string): string | null {
    try {
        if (typeof window !== 'undefined' && window.sessionStorage) {
            return window.sessionStorage.getItem(key);
        }
    } catch {
        // Storage unavailable
    }
    return null;
}

function writeSessionStorage(key: string, value: string): void {
    try {
        if (typeof window !== 'undefined' && window.sessionStorage) {
            window.sessionStorage.setItem(key, value);
        }
    } catch {
        // Storage unavailable
    }
}

function readLocalStorage(key: string): string | null {
    try {
        if (typeof window !== 'undefined' && window.localStorage) {
            return window.localStorage.getItem(key);
        }
    } catch {
        // Storage unavailable
    }
    return null;
}

function writeLocalStorage(key: string, value: string): void {
    try {
        if (typeof window !== 'undefined' && window.localStorage) {
            window.localStorage.setItem(key, value);
        }
    } catch {
        // Storage unavailable
    }
}

export function resolveDefaultWsEndpoint(): string {
    if (typeof location !== 'undefined' && location.host) {
        const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
        return `${proto}//${location.host}/ws`;
    }
    return 'ws://127.0.0.1:3001/ws';
}

export class MultiplayerClient {
    public readonly maxPlayers = MAX_PARTY_PLAYERS;

    private readonly sessionToken: string;
    private localPlayerId: string;
    private localDisplayName: string;
    private localSlotIndex: PlayerSlotIndex = 0;

    private state: CoopConnectionState = 'offline';
    private roomCode: string | null = null;
    private wsEndpoint: string | null = null;
    private lastError: string | null = null;

    private ws: WebSocket | null = null;
    private connectionNonce = 0;
    private manualLeave = false;
    private kickedDuplicate = false;
    private pendingMode: 'create' | 'join' | null = null;
    private pendingPreferredRoomCode: string | undefined;
    private pendingIsReconnect = false;

    private seq = 0;
    private combatSeq = 0;
    private survivalSeq = 0;
    private eventCounter = 0;
    private stateSendAccumSec = TICK_INTERVAL_SEC;
    private reconnectAttempt = 0;
    private reconnectTimerId: number | null = null;
    private connectTimeoutId: number | null = null;
    private pingTimerId: number | null = null;
    private pingSeq = 0;

    private readonly playersById = new Map<string, PlayerSyncState>();
    private readonly peersById = new Map<string, RemotePeerSnapshot>();
    private readonly collectedCrystals = new Set<string>();
    private readonly predictionHistory = new Map<number, PredictedFrame>();
    private readonly queuedEvents: C2SWorldEventMessage[] = [];
    private monsters: MonsterSyncState[] = [];
    private companions: CompanionSyncState[] = [];
    private capturedRoster: CapturedMonsterRecord[] = [];
    private sharedResources: SharedResourceInventory = createDefaultSharedResources();
    private resourceNodes: ResourceNodeSyncState[] = [];
    private structures: PlacedStructureSyncState[] = [];
    private baseWorkers: BaseWorkerSyncState[] = [];
    private persistenceMode: string | null = null;

    private readonly worldEventListeners = new Set<WorldEventCallback>();
    private readonly combatEventListeners = new Set<CombatEventCallback>();
    private readonly survivalEventListeners = new Set<SurvivalEventCallback>();
    private readonly reconcileListeners = new Set<ServerReconcileCallback>();
    private readonly notificationListeners = new Set<NotificationCallback>();
    private readonly snapshotListeners = new Set<SnapshotCallback>();
    private readonly roomJoinedListeners = new Set<RoomJoinedCallback>();

    private pendingConnectResolvers: Array<(status: CoopSessionStatus) => void> = [];

    // Metrics & traffic window tracking
    private readonly sentSamples: TrafficSample[] = [];
    private readonly recvSamples: TrafficSample[] = [];
    private readonly snapshotTimestampsMs: number[] = [];
    private readonly delayedTimers = new Set<number>();
    private metrics: CoopNetworkMetrics = createEmptyNetworkMetrics();
    private lastRttSampleMs = 0;

    // Network simulation controls (for verification / latency & packet loss testing)
    private simConfig: {
        latencyMs: number;
        jitterMs: number;
        dropRate: number;
    } = {
        latencyMs: 0,
        jitterMs: 0,
        dropRate: 0,
    };
    private forcedReconnectDelayMs = 0;

    constructor(initialPlayerId?: string) {
        const storedToken = readSessionStorage(SESSION_TOKEN_STORAGE_KEY);
        if (storedToken) {
            this.sessionToken = storedToken;
        } else {
            this.sessionToken = generateRandomId('tok');
            writeSessionStorage(SESSION_TOKEN_STORAGE_KEY, this.sessionToken);
        }

        const customId =
            initialPlayerId && initialPlayerId !== 'local-explorer-1'
                ? initialPlayerId
                : null;
        const storedPlayerId = readSessionStorage(PLAYER_ID_STORAGE_KEY);
        if (customId) {
            this.localPlayerId = customId;
        } else if (storedPlayerId) {
            this.localPlayerId = storedPlayerId;
        } else {
            this.localPlayerId = generateRandomId('exp');
            writeSessionStorage(PLAYER_ID_STORAGE_KEY, this.localPlayerId);
        }

        const savedName = readLocalStorage(DISPLAY_NAME_STORAGE_KEY);
        this.localDisplayName = sanitizeDisplayName(savedName ?? 'Explorer');
    }

    public setDisplayName(name: string): string {
        this.localDisplayName = sanitizeDisplayName(name);
        writeLocalStorage(DISPLAY_NAME_STORAGE_KEY, this.localDisplayName);
        return this.localDisplayName;
    }

    public getDisplayName(): string {
        return this.localDisplayName;
    }

    public getSessionToken(): string {
        return this.sessionToken;
    }

    public createRoom(
        displayName?: string,
        preferredRoomCode?: string,
        wsEndpoint?: string
    ): Promise<CoopSessionStatus> {
        if (displayName !== undefined) {
            this.setDisplayName(displayName);
        }
        const preferred = preferredRoomCode
            ? sanitizeRoomCode(preferredRoomCode)
            : undefined;
        if (preferred && !isValidRoomCode(preferred)) {
            this.lastError = '방 코드는 영문/숫자 3~12자여야 합니다.';
            this.emitNotification(this.lastError, 'error');
            this.emitSnapshot();
            return Promise.resolve(this.getStatus());
        }

        return this.openConnection({
            mode: 'create',
            roomCode: preferred ?? null,
            preferredRoomCode: preferred,
            isReconnect: false,
            wsEndpoint: wsEndpoint ?? resolveDefaultWsEndpoint(),
        });
    }

    public joinRoom(
        roomCode: string,
        displayName?: string,
        wsEndpoint?: string
    ): Promise<CoopSessionStatus> {
        if (displayName !== undefined) {
            this.setDisplayName(displayName);
        }
        const sanitized = sanitizeRoomCode(roomCode);
        if (!isValidRoomCode(sanitized)) {
            this.lastError = '올바른 방 코드를 입력하세요 (영문/숫자 3~12자).';
            this.emitNotification(this.lastError, 'error');
            this.emitSnapshot();
            return Promise.resolve(this.getStatus());
        }

        return this.openConnection({
            mode: 'join',
            roomCode: sanitized,
            preferredRoomCode: undefined,
            isReconnect: false,
            wsEndpoint: wsEndpoint ?? resolveDefaultWsEndpoint(),
        });
    }

    /** Backward-compatible helper matching CoopSessionManagerStub signature. */
    public connect(roomCode: string, wsEndpoint?: string): CoopSessionStatus {
        void this.joinRoom(roomCode, this.localDisplayName, wsEndpoint);
        return this.getStatus();
    }

    public leaveRoom(): Promise<CoopSessionStatus> {
        this.manualLeave = true;
        this.kickedDuplicate = false;
        this.clearReconnectTimer();
        this.clearConnectTimeout();
        this.stopPingTimer();
        this.clearDelayedTimers();

        const activeWs = this.ws;
        const activeRoom = this.roomCode;
        if (activeWs && activeWs.readyState === WebSocket.OPEN && activeRoom) {
            this.sendRawImmediate({
                type: 'c2s_leave_room',
                protocolVersion: PROTOCOL_VERSION,
                roomCode: activeRoom,
            });
        }

        this.teardownSocket(activeWs, 1000, 'Left room');
        this.resetRoomState();
        this.resolvePendingConnects();
        this.emitSnapshot();
        return Promise.resolve(this.getStatus());
    }

    /** Backward-compatible helper matching CoopSessionManagerStub signature. */
    public disconnect(): void {
        void this.leaveRoom();
    }

    public update(dt: number, localTelemetry: PlayerTelemetry): void {
        if (this.state !== 'connected' || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
            return;
        }
        const clampedDt = Math.max(0, Math.min(0.25, dt));
        this.stateSendAccumSec += clampedDt;
        if (this.stateSendAccumSec < TICK_INTERVAL_SEC) {
            return;
        }
        this.stateSendAccumSec = Math.min(
            this.stateSendAccumSec - TICK_INTERVAL_SEC,
            TICK_INTERVAL_SEC
        );

        this.seq += 1;
        const now = Date.now();
        const pos: Vec3Tuple = {
            x: Number(localTelemetry.position.x.toFixed(3)),
            y: Number(localTelemetry.position.y.toFixed(3)),
            z: Number(localTelemetry.position.z.toFixed(3)),
        };
        const vel: Vec3Tuple = {
            x: Number(localTelemetry.velocity.x.toFixed(3)),
            y: Number(localTelemetry.velocity.y.toFixed(3)),
            z: Number(localTelemetry.velocity.z.toFixed(3)),
        };

        this.predictionHistory.set(this.seq, {
            seq: this.seq,
            position: pos,
            velocity: vel,
            timestampMs: now,
        });
        if (this.predictionHistory.size > MAX_PREDICTION_HISTORY) {
            const oldestKey = this.predictionHistory.keys().next().value;
            if (oldestKey !== undefined) {
                this.predictionHistory.delete(oldestKey);
            }
        }

        const combatState: PlayerCombatState =
            localTelemetry.state === 'attack' ||
            localTelemetry.state === 'dodge' ||
            localTelemetry.state === 'hit' ||
            localTelemetry.state === 'throw'
                ? localTelemetry.state
                : 'idle';

        this.sendMessage(
            {
                type: 'c2s_player_state',
                protocolVersion: PROTOCOL_VERSION,
                seq: this.seq,
                timestampMs: now,
                position: pos,
                velocity: vel,
                yawDeg: Number(localTelemetry.yawDeg.toFixed(1)),
                animState: localTelemetry.state,
                grounded: localTelemetry.grounded,
                inWater: localTelemetry.inWater,
                stamina: Math.round(localTelemetry.stamina),
                crystalsCollected: localTelemetry.crystalsCollected,
                combatState,
            },
            true
        );
    }

    public sendCombatAction(params: CombatActionRequest): boolean {
        if (this.state !== 'connected' || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
            return false;
        }
        this.combatSeq += 1;
        const aimYaw = Number.isFinite(params.aimYaw) ? (params.aimYaw as number) : 0;
        const rad = (aimYaw * Math.PI) / 180;
        const defaultDirX = -Math.sin(rad);
        const defaultDirZ = -Math.cos(rad);
        const dirX = Number.isFinite(params.dirX) ? (params.dirX as number) : defaultDirX;
        const dirZ = Number.isFinite(params.dirZ) ? (params.dirZ as number) : defaultDirZ;

        const msg: C2SCombatActionMessage = {
            type: 'c2s_combat_action',
            protocolVersion: PROTOCOL_VERSION,
            seq: this.combatSeq,
            clientTime: Date.now(),
            action: params.action,
            targetMonsterId: params.targetMonsterId ?? null,
            companionUid: params.companionUid ?? null,
            aimYaw: Number(aimYaw.toFixed(1)),
            originX: Number((params.originX ?? 0).toFixed(3)),
            originY: Number((params.originY ?? 0).toFixed(3)),
            originZ: Number((params.originZ ?? 0).toFixed(3)),
            dirX: Number(dirX.toFixed(4)),
            dirZ: Number(dirZ.toFixed(4)),
        };
        this.sendMessage(msg, false);
        return true;
    }

    public getMonsters(): MonsterSyncState[] {
        return this.monsters;
    }

    public getCompanions(): CompanionSyncState[] {
        return this.companions;
    }

    public getCapturedRoster(): CapturedMonsterRecord[] {
        return this.capturedRoster;
    }

    public sendSurvivalAction(payload: SurvivalActionRequest): boolean {
        if (this.state !== 'connected' || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
            return false;
        }
        this.survivalSeq += 1;
        const msg: C2SSurvivalActionMessage = {
            type: 'c2s_survival_action',
            protocolVersion: PROTOCOL_VERSION,
            seq: this.survivalSeq,
            clientTime: Date.now(),
            action: payload.action,
            nodeId: payload.nodeId ?? null,
            craftRecipeId: payload.craftRecipeId ?? null,
            toolId: payload.toolId ?? null,
            foodKind: payload.foodKind ?? null,
            structureRecipeId: payload.structureRecipeId ?? null,
            structureId: payload.structureId ?? null,
            gridX: payload.gridX,
            gridZ: payload.gridZ,
            layer: payload.layer,
            rotationYawDeg: payload.rotationYawDeg,
            x: payload.x !== undefined ? Number(payload.x.toFixed(3)) : undefined,
            y: payload.y !== undefined ? Number(payload.y.toFixed(3)) : undefined,
            z: payload.z !== undefined ? Number(payload.z.toFixed(3)) : undefined,
            companionUid: payload.companionUid ?? null,
            workPreference: payload.workPreference ?? null,
        };
        this.sendMessage(msg, false);
        return true;
    }

    public getSharedResources(): SharedResourceInventory {
        return { ...this.sharedResources };
    }

    public getResourceNodes(): ResourceNodeSyncState[] {
        return this.resourceNodes;
    }

    public getPlacedStructures(): PlacedStructureSyncState[] {
        return this.structures;
    }

    public getBaseWorkers(): BaseWorkerSyncState[] {
        return this.baseWorkers;
    }

    public getPersistenceMode(): string | null {
        return this.persistenceMode;
    }

    public getLocalPlayerState(): PlayerSyncState | null {
        return this.playersById.get(this.localPlayerId) ?? null;
    }

    public emitWorldEvent(
        kind: WorldEventKind,
        payload: Record<string, string | number | boolean>
    ): WorldEventPacket {
        this.eventCounter += 1;
        const now = Date.now();
        const eventId = `${this.localPlayerId}-${now}-${this.eventCounter}`;
        const roomCode = this.roomCode ?? 'LOCAL-SOLO';

        if (kind === 'crystal_collected' && typeof payload.crystalId === 'string') {
            this.collectedCrystals.add(payload.crystalId);
        }

        const msg: C2SWorldEventMessage = {
            type: 'c2s_world_event',
            protocolVersion: PROTOCOL_VERSION,
            eventId,
            kind,
            timestampMs: now,
            payload: { ...payload },
        };

        if (this.state === 'connected' && this.ws?.readyState === WebSocket.OPEN) {
            this.sendMessage(msg, false);
        } else if (this.state === 'connecting' || this.state === 'reconnecting') {
            this.queuedEvents.push(msg);
            if (this.queuedEvents.length > MAX_QUEUED_EVENTS) {
                this.queuedEvents.shift();
            }
        }

        return {
            type: 'world_event',
            protocolVersion: PROTOCOL_VERSION,
            roomCode,
            eventId,
            kind,
            actorId: this.localPlayerId,
            timestampMs: now,
            payload: { ...payload },
        };
    }

    /** Backward-compatible helper matching CoopSessionManagerStub signature. */
    public buildPlayerSyncPacket(
        telemetry: PlayerTelemetry,
        displayName = this.localDisplayName
    ): PlayerSyncPacket {
        this.seq += 1;
        return {
            type: 'player_sync',
            protocolVersion: PROTOCOL_VERSION,
            roomCode: this.roomCode ?? 'LOCAL-SOLO',
            playerId: this.localPlayerId,
            displayName,
            seq: this.seq,
            timestampMs: Date.now(),
            position: {
                x: Number(telemetry.position.x.toFixed(3)),
                y: Number(telemetry.position.y.toFixed(3)),
                z: Number(telemetry.position.z.toFixed(3)),
            },
            velocity: {
                x: Number(telemetry.velocity.x.toFixed(3)),
                y: Number(telemetry.velocity.y.toFixed(3)),
                z: Number(telemetry.velocity.z.toFixed(3)),
            },
            yawDeg: Number(telemetry.yawDeg.toFixed(1)),
            animState: telemetry.state,
            stamina: Math.round(telemetry.stamina),
            crystalsCollected: telemetry.crystalsCollected,
        };
    }

    public onWorldEvent(cb: WorldEventCallback): () => void {
        this.worldEventListeners.add(cb);
        return () => {
            this.worldEventListeners.delete(cb);
        };
    }

    public onCombatEvent(cb: CombatEventCallback): () => void {
        this.combatEventListeners.add(cb);
        return () => {
            this.combatEventListeners.delete(cb);
        };
    }

    public onSurvivalEvent(cb: SurvivalEventCallback): () => void {
        this.survivalEventListeners.add(cb);
        return () => {
            this.survivalEventListeners.delete(cb);
        };
    }

    public onServerReconcile(cb: ServerReconcileCallback): () => void {
        this.reconcileListeners.add(cb);
        return () => {
            this.reconcileListeners.delete(cb);
        };
    }

    public onNotification(cb: NotificationCallback): () => void {
        this.notificationListeners.add(cb);
        return () => {
            this.notificationListeners.delete(cb);
        };
    }

    public onSnapshot(cb: SnapshotCallback): () => void {
        this.snapshotListeners.add(cb);
        return () => {
            this.snapshotListeners.delete(cb);
        };
    }

    public onRoomJoined(cb: RoomJoinedCallback): () => void {
        this.roomJoinedListeners.add(cb);
        return () => {
            this.roomJoinedListeners.delete(cb);
        };
    }

    public simulateNetworkConditions(options: NetworkSimulationOptions): {
        latencyMs: number;
        jitterMs: number;
        dropRate: number;
        disconnectTriggered: boolean;
    } {
        if (typeof options.latencyMs === 'number' && Number.isFinite(options.latencyMs)) {
            this.simConfig.latencyMs = Math.max(0, options.latencyMs);
        }
        if (typeof options.jitterMs === 'number' && Number.isFinite(options.jitterMs)) {
            this.simConfig.jitterMs = Math.max(0, options.jitterMs);
        }
        if (typeof options.dropRate === 'number' && Number.isFinite(options.dropRate)) {
            this.simConfig.dropRate = Math.max(0, Math.min(1, options.dropRate));
        }

        let disconnectTriggered = false;
        if (
            typeof options.disconnectTemporaryMs === 'number' &&
            options.disconnectTemporaryMs > 0 &&
            this.ws &&
            (this.state === 'connected' || this.state === 'connecting')
        ) {
            disconnectTriggered = true;
            this.forcedReconnectDelayMs = Math.max(50, options.disconnectTemporaryMs);
            this.manualLeave = false;
            this.kickedDuplicate = false;
            const socketToDrop = this.ws;
            // Closing intentionally without manualLeave triggers unexpected-drop reconnect path
            socketToDrop.close(4000, 'Simulated temporary disconnect');
        }

        return {
            ...this.simConfig,
            disconnectTriggered,
        };
    }

    public getStatus(): CoopSessionStatus {
        const now = Date.now();
        const traffic = this.computeTrafficRates(now);
        const players = Array.from(this.playersById.values()).sort(
            (a, b) => a.slotIndex - b.slotIndex
        );
        const peers = Array.from(this.peersById.values()).sort(
            (a, b) => a.slotIndex - b.slotIndex
        );
        const connectedPlayers =
            this.state === 'offline'
                ? 1
                : Math.max(
                      1,
                      players.filter((p) => p.connected).length
                  );

        return {
            state: this.state,
            maxPartyPlayers: MAX_PARTY_PLAYERS,
            roomCode: this.roomCode,
            localPlayerId: this.localPlayerId,
            localDisplayName: this.localDisplayName,
            localSlotIndex: this.localSlotIndex,
            peerCount: peers.length,
            connectedPlayers,
            peers,
            players,
            collectedCrystals: Array.from(this.collectedCrystals),
            queuedOutgoingEvents: this.queuedEvents.length,
            protocolVersion: PROTOCOL_VERSION,
            wsEndpoint: this.wsEndpoint,
            lastError: this.lastError,
            metrics: {
                ...this.metrics,
                ...traffic,
            },
            monsters: this.monsters,
            companions: this.companions,
            capturedRoster: this.capturedRoster,
            sharedResources: { ...this.sharedResources },
            resourceNodes: this.resourceNodes,
            structures: this.structures,
            baseWorkers: this.baseWorkers,
            persistenceMode: this.persistenceMode ?? undefined,
        };
    }

    public dispose(): void {
        void this.leaveRoom();
        this.worldEventListeners.clear();
        this.combatEventListeners.clear();
        this.survivalEventListeners.clear();
        this.reconcileListeners.clear();
        this.notificationListeners.clear();
        this.snapshotListeners.clear();
        this.roomJoinedListeners.clear();
    }

    // ========================================================================
    // Internal WebSocket Lifecycle & Reconnect
    // ========================================================================

    private openConnection(params: {
        mode: 'create' | 'join';
        roomCode: string | null;
        preferredRoomCode?: string;
        isReconnect: boolean;
        wsEndpoint: string;
    }): Promise<CoopSessionStatus> {
        this.clearReconnectTimer();
        this.clearConnectTimeout();
        this.stopPingTimer();
        this.clearDelayedTimers();

        if (this.ws) {
            const oldWs = this.ws;
            if (oldWs.readyState === WebSocket.OPEN && this.roomCode && !params.isReconnect) {
                this.sendRawImmediate({
                    type: 'c2s_leave_room',
                    protocolVersion: PROTOCOL_VERSION,
                    roomCode: this.roomCode,
                });
            }
            this.teardownSocket(oldWs, 1000, 'Switching room');
        }

        if (!params.isReconnect) {
            this.playersById.clear();
            this.peersById.clear();
            this.collectedCrystals.clear();
            this.predictionHistory.clear();
            this.queuedEvents.length = 0;
            this.monsters = [];
            this.companions = [];
            this.capturedRoster = [];
            this.sharedResources = createDefaultSharedResources();
            this.resourceNodes = [];
            this.structures = [];
            this.baseWorkers = [];
            this.persistenceMode = null;
            this.seq = 0;
            this.combatSeq = 0;
            this.survivalSeq = 0;
            this.reconnectAttempt = 0;
            this.metrics = createEmptyNetworkMetrics();
            this.lastRttSampleMs = 0;
            this.sentSamples.length = 0;
            this.recvSamples.length = 0;
            this.snapshotTimestampsMs.length = 0;
        }

        this.manualLeave = false;
        this.kickedDuplicate = false;
        this.lastError = null;
        this.pendingMode = params.mode;
        this.pendingPreferredRoomCode = params.preferredRoomCode;
        this.pendingIsReconnect = params.isReconnect;
        this.roomCode = params.roomCode;
        this.wsEndpoint = params.wsEndpoint;
        this.state = params.isReconnect ? 'reconnecting' : 'connecting';

        const nonce = ++this.connectionNonce;

        let socket: WebSocket;
        try {
            socket = new WebSocket(params.wsEndpoint);
        } catch (err) {
            const msg = `서버 연결 실패: ${err instanceof Error ? err.message : String(err)}`;
            this.lastError = msg;
            this.state = 'offline';
            this.emitNotification(msg, 'error');
            this.emitSnapshot();
            return Promise.resolve(this.getStatus());
        }

        this.ws = socket;
        this.emitSnapshot();

        return new Promise<CoopSessionStatus>((resolve) => {
            this.pendingConnectResolvers.push(resolve);

            this.connectTimeoutId = globalThis.setTimeout(() => {
                if (this.connectionNonce !== nonce || this.ws !== socket) return;
                if (this.state === 'connected') return;
                const timeoutMsg = '서버 응답 시간이 초과되었습니다.';
                this.lastError = timeoutMsg;
                socket.close(4002, 'Connect timeout');
            }, CONNECT_TIMEOUT_MS) as unknown as number;

            socket.addEventListener('open', () => {
                if (this.connectionNonce !== nonce || this.ws !== socket) {
                    socket.close(1000, 'Superseded');
                    return;
                }
                if (this.pendingMode === 'create' && !this.pendingIsReconnect) {
                    this.sendRawImmediate({
                        type: 'c2s_create_room',
                        protocolVersion: PROTOCOL_VERSION,
                        sessionToken: this.sessionToken,
                        playerId: this.localPlayerId,
                        displayName: this.localDisplayName,
                        preferredRoomCode: this.pendingPreferredRoomCode,
                    });
                } else {
                    const targetCode = this.roomCode;
                    if (!targetCode) {
                        this.lastError = '방 코드가 비어 있습니다.';
                        this.state = 'offline';
                        this.teardownSocket(socket, 1000, 'Missing room code');
                        this.resolvePendingConnects();
                        return;
                    }
                    this.sendRawImmediate({
                        type: 'c2s_join_room',
                        protocolVersion: PROTOCOL_VERSION,
                        roomCode: targetCode,
                        sessionToken: this.sessionToken,
                        playerId: this.localPlayerId,
                        displayName: this.localDisplayName,
                        isReconnect: this.pendingIsReconnect,
                    });
                }
            });

            socket.addEventListener('message', (event: MessageEvent) => {
                if (this.connectionNonce !== nonce || this.ws !== socket) return;
                if (typeof event.data !== 'string') return;
                this.handleRawIncoming(event.data, nonce, socket);
            });

            socket.addEventListener('error', () => {
                if (this.connectionNonce !== nonce || this.ws !== socket) return;
                if (!this.lastError) {
                    this.lastError = 'WebSocket 통신 오류가 발생했습니다.';
                }
            });

            socket.addEventListener('close', (closeEvent: CloseEvent) => {
                if (this.connectionNonce !== nonce || this.ws !== socket) return;
                this.ws = null;
                this.clearConnectTimeout();
                this.stopPingTimer();

                if (closeEvent.code === 4001) {
                    this.kickedDuplicate = true;
                }

                if (this.manualLeave || this.kickedDuplicate) {
                    this.state = 'offline';
                    this.resolvePendingConnects();
                    this.emitSnapshot();
                    return;
                }

                // If initial join/create failed with explicit room error (ROOM_FULL, ROOM_NOT_FOUND), do not loop reconnect
                if (
                    !this.pendingIsReconnect &&
                    this.state === 'connecting' &&
                    this.lastError &&
                    this.pendingConnectResolvers.length > 0
                ) {
                    this.state = 'offline';
                    this.resolvePendingConnects();
                    this.emitSnapshot();
                    return;
                }

                // Unexpected drop while in a room (or during reconnect): exponential backoff 500ms..4000ms
                if (this.roomCode) {
                    this.scheduleReconnect();
                } else {
                    this.state = 'offline';
                    this.resolvePendingConnects();
                    this.emitSnapshot();
                }
            });
        });
    }

    private scheduleReconnect(): void {
        this.clearReconnectTimer();
        this.state = 'reconnecting';
        const expDelay = Math.min(
            RECONNECT_BACKOFF_MAX_MS,
            RECONNECT_BACKOFF_MIN_MS * Math.pow(2, this.reconnectAttempt)
        );
        const delayMs =
            this.forcedReconnectDelayMs > 0
                ? this.forcedReconnectDelayMs
                : expDelay;
        this.forcedReconnectDelayMs = 0;
        this.reconnectAttempt += 1;

        this.emitNotification(
            `연결이 끊어졌습니다. ${(delayMs / 1000).toFixed(1)}초 후 재연결 시도...`,
            'warning'
        );
        this.emitSnapshot();

        const targetRoom = this.roomCode;
        const targetWs = this.wsEndpoint ?? resolveDefaultWsEndpoint();
        if (!targetRoom) {
            this.state = 'offline';
            this.resolvePendingConnects();
            this.emitSnapshot();
            return;
        }

        this.reconnectTimerId = globalThis.setTimeout(() => {
            this.reconnectTimerId = null;
            if (this.manualLeave || this.kickedDuplicate || !this.roomCode) return;
            void this.openConnection({
                mode: 'join',
                roomCode: targetRoom,
                isReconnect: true,
                wsEndpoint: targetWs,
            });
        }, delayMs) as unknown as number;
    }

    private handleRawIncoming(
        rawJson: string,
        nonce: number,
        socket: WebSocket
    ): void {
        const now = Date.now();
        this.recvSamples.push({ timeMs: now, bytes: rawJson.length });

        let parsed: S2CMessage;
        try {
            parsed = JSON.parse(rawJson) as S2CMessage;
        } catch {
            return;
        }

        if (!parsed || typeof parsed.type !== 'string') {
            return;
        }

        // Simulate packet loss / one-way receive latency when network simulation is active
        if (
            parsed.type === 's2c_room_snapshot' &&
            this.simConfig.dropRate > 0 &&
            Math.random() < this.simConfig.dropRate
        ) {
            return;
        }
        if (
            parsed.type === 's2c_room_snapshot' ||
            parsed.type === 's2c_pong' ||
            parsed.type === 's2c_combat_event' ||
            parsed.type === 's2c_survival_event'
        ) {
            const delayMs = this.computeSimulatedOneWayDelayMs();
            if (delayMs > 0) {
                const timerId = globalThis.setTimeout(() => {
                    this.delayedTimers.delete(timerId);
                    if (this.connectionNonce !== nonce || this.ws !== socket) return;
                    this.processServerMessage(parsed);
                }, delayMs) as unknown as number;
                this.delayedTimers.add(timerId);
                return;
            }
        }

        this.processServerMessage(parsed);
    }

    private processServerMessage(msg: S2CMessage): void {
        switch (msg.type) {
            case 's2c_room_joined': {
                this.clearConnectTimeout();
                this.state = 'connected';
                this.roomCode = msg.roomCode;
                this.localPlayerId = msg.playerId;
                this.localSlotIndex = msg.slotIndex;
                this.localDisplayName = msg.displayName;
                this.lastError = null;
                this.reconnectAttempt = 0;
                this.pendingIsReconnect = true;
                this.stateSendAccumSec = TICK_INTERVAL_SEC;

                writeSessionStorage(PLAYER_ID_STORAGE_KEY, this.localPlayerId);

                this.collectedCrystals.clear();
                for (const id of msg.collectedCrystals) {
                    this.collectedCrystals.add(id);
                }

                this.monsters = Array.isArray(msg.monsters) ? msg.monsters : [];
                this.companions = Array.isArray(msg.companions) ? msg.companions : [];
                if (Array.isArray(msg.capturedRoster)) {
                    this.capturedRoster = msg.capturedRoster;
                }
                this.sharedResources = msg.sharedResources
                    ? { ...msg.sharedResources }
                    : createDefaultSharedResources();
                this.resourceNodes = Array.isArray(msg.resourceNodes) ? msg.resourceNodes : [];
                this.structures = Array.isArray(msg.structures) ? msg.structures : [];
                this.baseWorkers = Array.isArray(msg.baseWorkers) ? msg.baseWorkers : [];
                this.persistenceMode =
                    typeof msg.persistenceMode === 'string' ? msg.persistenceMode : null;

                this.applyPlayerRoster(msg.roomCode, msg.players);
                this.flushQueuedEvents();
                this.startPingTimer();
                this.sendPingNow();

                const status = this.getStatus();
                for (const cb of this.roomJoinedListeners) {
                    cb(status, msg.reconnected);
                }
                this.emitNotification(
                    msg.reconnected
                        ? `방 ${msg.roomCode} 재연결 완료 (슬롯 ${msg.slotIndex + 1})`
                        : `방 ${msg.roomCode} 참가 완료 (슬롯 ${msg.slotIndex + 1})`,
                    'success'
                );
                this.resolvePendingConnects();
                this.emitSnapshot();
                break;
            }

            case 's2c_room_snapshot': {
                const now = Date.now();
                this.snapshotTimestampsMs.push(now);
                this.pruneOldTimestamps(this.snapshotTimestampsMs, now - 1000);
                this.metrics.tickRateHz = this.snapshotTimestampsMs.length;

                this.collectedCrystals.clear();
                for (const id of msg.collectedCrystals) {
                    this.collectedCrystals.add(id);
                }

                if (Array.isArray(msg.monsters)) {
                    this.monsters = msg.monsters;
                }
                if (Array.isArray(msg.companions)) {
                    this.companions = msg.companions;
                }
                if (Array.isArray(msg.capturedRoster)) {
                    this.capturedRoster = msg.capturedRoster;
                }
                if (msg.sharedResources) {
                    this.sharedResources = { ...msg.sharedResources };
                }
                if (Array.isArray(msg.resourceNodes)) {
                    this.resourceNodes = msg.resourceNodes;
                }
                if (Array.isArray(msg.structures)) {
                    this.structures = msg.structures;
                }
                if (Array.isArray(msg.baseWorkers)) {
                    this.baseWorkers = msg.baseWorkers;
                }
                if (typeof msg.persistenceMode === 'string') {
                    this.persistenceMode = msg.persistenceMode;
                }

                this.applyPlayerRoster(msg.roomCode, msg.players);

                if (msg.localState && msg.lastAckSeq > 0) {
                    const predicted = this.predictionHistory.get(msg.lastAckSeq) ?? null;
                    for (const seqKey of this.predictionHistory.keys()) {
                        if (seqKey <= msg.lastAckSeq) {
                            this.predictionHistory.delete(seqKey);
                        }
                    }

                    const predictedPos = predicted ? { ...predicted.position } : null;
                    let correctionMeters = 0;
                    for (const cb of this.reconcileListeners) {
                        const ret = cb(msg.localState, predictedPos);
                        if (typeof ret === 'number' && ret > correctionMeters) {
                            correctionMeters = ret;
                        }
                    }
                    if (correctionMeters === 0 && predictedPos) {
                        const dx = msg.localState.position.x - predictedPos.x;
                        const dy = msg.localState.position.y - predictedPos.y;
                        const dz = msg.localState.position.z - predictedPos.z;
                        const err = Math.hypot(dx, dy, dz);
                        if (err >= 0.65) {
                            correctionMeters = err;
                        }
                    }
                    if (correctionMeters > 0) {
                        this.metrics.reconcileCount += 1;
                        this.metrics.lastCorrectionMeters = Number(
                            correctionMeters.toFixed(3)
                        );
                    }
                }

                this.emitSnapshot();
                break;
            }

            case 's2c_room_error': {
                this.clearConnectTimeout();
                this.lastError = msg.message;
                this.emitNotification(msg.message, 'error');
                if (this.state !== 'connected') {
                    this.state = 'offline';
                    if (
                        msg.code === 'ROOM_NOT_FOUND' ||
                        msg.code === 'ROOM_FULL' ||
                        msg.code === 'INVALID_ROOM_CODE'
                    ) {
                        this.manualLeave = true;
                        this.roomCode = null;
                        this.teardownSocket(this.ws, 1000, msg.code);
                    }
                    this.resolvePendingConnects();
                }
                this.emitSnapshot();
                break;
            }

            case 's2c_world_event': {
                if (Array.isArray(msg.collectedCrystals)) {
                    this.collectedCrystals.clear();
                    for (const id of msg.collectedCrystals) {
                        this.collectedCrystals.add(id);
                    }
                } else if (
                    msg.kind === 'crystal_collected' &&
                    typeof msg.payload?.crystalId === 'string'
                ) {
                    this.collectedCrystals.add(msg.payload.crystalId);
                }

                if (msg.actorId !== this.localPlayerId) {
                    const packet: WorldEventPacket = {
                        type: 'world_event',
                        protocolVersion: msg.protocolVersion,
                        roomCode: msg.roomCode,
                        eventId: msg.eventId,
                        kind: msg.kind,
                        actorId: msg.actorId,
                        timestampMs: msg.timestampMs,
                        payload: { ...msg.payload },
                    };
                    for (const cb of this.worldEventListeners) {
                        cb(packet);
                    }
                    if (msg.kind === 'crystal_collected') {
                        const who = msg.actorName ?? '파티원';
                        this.emitNotification(
                            `${who}님이 바이탈 크리스탈을 획득했습니다!`,
                            'info'
                        );
                    }
                }
                this.emitSnapshot();
                break;
            }

            case 's2c_player_joined': {
                this.upsertPlayer(msg.roomCode, msg.player);
                if (msg.player.playerId !== this.localPlayerId) {
                    this.emitNotification(
                        `${msg.player.displayName}님이 파티에 합류했습니다 (슬롯 ${msg.player.slotIndex + 1})`,
                        'info'
                    );
                }
                this.emitSnapshot();
                break;
            }

            case 's2c_player_reconnecting': {
                const existing = this.playersById.get(msg.playerId);
                if (existing) {
                    existing.connected = false;
                }
                const peer = this.peersById.get(msg.playerId);
                if (peer) {
                    peer.connected = false;
                }
                if (msg.playerId !== this.localPlayerId) {
                    this.emitNotification(
                        `${msg.displayName}님의 연결이 불안정합니다 (재접속 대기중)...`,
                        'warning'
                    );
                }
                this.emitSnapshot();
                break;
            }

            case 's2c_player_reconnected': {
                this.upsertPlayer(msg.roomCode, msg.player);
                if (msg.player.playerId !== this.localPlayerId) {
                    this.emitNotification(
                        `${msg.player.displayName}님이 다시 연결되었습니다!`,
                        'success'
                    );
                }
                this.emitSnapshot();
                break;
            }

            case 's2c_player_left': {
                this.playersById.delete(msg.playerId);
                this.peersById.delete(msg.playerId);
                if (msg.playerId !== this.localPlayerId) {
                    const reasonLabel =
                        msg.reason === 'timeout' ? '연결 시간 초과' : '퇴장';
                    this.emitNotification(
                        `${msg.displayName}님이 방에서 ${reasonLabel}했습니다.`,
                        'info'
                    );
                }
                this.emitSnapshot();
                break;
            }

            case 's2c_kicked_duplicate': {
                this.kickedDuplicate = true;
                this.lastError = msg.message;
                this.emitNotification(msg.message, 'warning');
                this.resetRoomState();
                this.resolvePendingConnects();
                this.emitSnapshot();
                break;
            }

            case 's2c_combat_event': {
                if (
                    msg.event === 'capture_result' &&
                    msg.captureSuccess &&
                    msg.capturedRecord &&
                    msg.actorId === this.localPlayerId
                ) {
                    const already = this.capturedRoster.some(
                        (r) => r.uid === msg.capturedRecord?.uid
                    );
                    if (!already) {
                        this.capturedRoster = [...this.capturedRoster, msg.capturedRecord];
                    }
                }
                for (const cb of this.combatEventListeners) {
                    cb(msg);
                }
                break;
            }

            case 's2c_survival_event': {
                if (msg.sharedResources) {
                    this.sharedResources = { ...msg.sharedResources };
                }
                if (msg.event === 'structure_placed' && msg.structure) {
                    const placed = msg.structure;
                    this.structures = [
                        ...this.structures.filter((s) => s.id !== placed.id),
                        placed,
                    ];
                } else if (msg.event === 'structure_demolished' && msg.targetId) {
                    this.structures = this.structures.filter((s) => s.id !== msg.targetId);
                } else if (msg.event === 'worker_assigned' && msg.worker) {
                    const assigned = msg.worker;
                    this.baseWorkers = [
                        ...this.baseWorkers.filter((w) => w.uid !== assigned.uid),
                        assigned,
                    ];
                } else if (msg.event === 'worker_unassigned' && msg.targetId) {
                    this.baseWorkers = this.baseWorkers.filter((w) => w.uid !== msg.targetId);
                } else if (msg.event === 'node_depleted' && msg.targetId) {
                    this.resourceNodes = this.resourceNodes.map((n) =>
                        n.id === msg.targetId ? { ...n, hp: 0, depleted: true } : n
                    );
                } else if (msg.event === 'node_respawned' && msg.targetId) {
                    this.resourceNodes = this.resourceNodes.map((n) =>
                        n.id === msg.targetId
                            ? { ...n, hp: n.maxHp, depleted: false, respawnRemainingMs: 0 }
                            : n
                    );
                }

                for (const cb of this.survivalEventListeners) {
                    cb(msg);
                }
                break;
            }

            case 's2c_pong': {
                const now = Date.now();
                const sentTime = Number(msg.clientTimeMs);
                if (!Number.isFinite(sentTime) || sentTime <= 0) {
                    break;
                }
                const sampleRtt = Math.max(1, Math.round(now - sentTime));
                if (this.lastRttSampleMs > 0) {
                    const diff = Math.abs(sampleRtt - this.lastRttSampleMs);
                    this.metrics.jitterMs = Math.round(
                        this.metrics.jitterMs + (diff - this.metrics.jitterMs) * 0.25
                    );
                }
                this.lastRttSampleMs = sampleRtt;
                this.metrics.rttMs = sampleRtt;
                break;
            }
        }
    }

    private applyPlayerRoster(roomCode: string, players: PlayerSyncState[]): void {
        const activeIds = new Set<string>();
        for (const p of players) {
            activeIds.add(p.playerId);
            this.upsertPlayer(roomCode, p);
        }
        for (const id of this.playersById.keys()) {
            if (!activeIds.has(id)) {
                this.playersById.delete(id);
                this.peersById.delete(id);
            }
        }
    }

    private upsertPlayer(roomCode: string, state: PlayerSyncState): void {
        this.playersById.set(state.playerId, state);
        if (state.playerId === this.localPlayerId) {
            this.localSlotIndex = state.slotIndex;
            this.localDisplayName = state.displayName;
            return;
        }
        this.peersById.set(state.playerId, {
            playerId: state.playerId,
            displayName: state.displayName,
            slotIndex: state.slotIndex,
            lastPacket: playerSyncStateToPacket(roomCode, state),
            lastSeenMs: Date.now(),
            connected: state.connected,
            rttMs: state.rttMs,
        });
    }

    private flushQueuedEvents(): void {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
        while (this.queuedEvents.length > 0) {
            const next = this.queuedEvents.shift();
            if (next) {
                this.sendRawImmediate(next);
            }
        }
    }

    private sendMessage(msg: C2SMessage, allowDropOrDelay: boolean): void {
        if (allowDropOrDelay && this.simConfig.dropRate > 0) {
            if (Math.random() < this.simConfig.dropRate) {
                return;
            }
        }
        const delayMs = allowDropOrDelay ? this.computeSimulatedOneWayDelayMs() : 0;
        if (delayMs > 0) {
            const activeWs = this.ws;
            const timerId = globalThis.setTimeout(() => {
                this.delayedTimers.delete(timerId);
                if (this.ws !== activeWs || !activeWs || activeWs.readyState !== WebSocket.OPEN) {
                    return;
                }
                this.sendRawImmediate(msg);
            }, delayMs) as unknown as number;
            this.delayedTimers.add(timerId);
            return;
        }
        this.sendRawImmediate(msg);
    }

    private sendRawImmediate(msg: C2SMessage): void {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
        const json = JSON.stringify(msg);
        this.sentSamples.push({ timeMs: Date.now(), bytes: json.length });
        this.ws.send(json);
    }

    private computeSimulatedOneWayDelayMs(): number {
        if (this.simConfig.latencyMs <= 0 && this.simConfig.jitterMs <= 0) {
            return 0;
        }
        const halfRtt = this.simConfig.latencyMs * 0.5;
        const jitter =
            this.simConfig.jitterMs > 0
                ? (Math.random() * 2 - 1) * this.simConfig.jitterMs * 0.5
                : 0;
        return Math.max(0, Math.round(halfRtt + jitter));
    }

    private computeTrafficRates(now: number): {
        bytesSentPerSec: number;
        bytesReceivedPerSec: number;
        packetsSentPerSec: number;
        packetsReceivedPerSec: number;
    } {
        const cutoff = now - 1000;
        while (this.sentSamples.length > 0 && this.sentSamples[0].timeMs < cutoff) {
            this.sentSamples.shift();
        }
        while (this.recvSamples.length > 0 && this.recvSamples[0].timeMs < cutoff) {
            this.recvSamples.shift();
        }
        this.pruneOldTimestamps(this.snapshotTimestampsMs, cutoff);

        let bytesSentPerSec = 0;
        for (const s of this.sentSamples) bytesSentPerSec += s.bytes;
        let bytesReceivedPerSec = 0;
        for (const r of this.recvSamples) bytesReceivedPerSec += r.bytes;

        return {
            bytesSentPerSec,
            bytesReceivedPerSec,
            packetsSentPerSec: this.sentSamples.length,
            packetsReceivedPerSec: this.recvSamples.length,
        };
    }

    private pruneOldTimestamps(arr: number[], cutoff: number): void {
        while (arr.length > 0 && arr[0] < cutoff) {
            arr.shift();
        }
    }

    private startPingTimer(): void {
        this.stopPingTimer();
        this.pingTimerId = globalThis.setInterval(() => {
            this.sendPingNow();
        }, PING_INTERVAL_MS) as unknown as number;
    }

    private sendPingNow(): void {
        if (this.state !== 'connected' || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
            return;
        }
        this.pingSeq += 1;
        this.sendMessage(
            {
                type: 'c2s_ping',
                clientTimeMs: Date.now(),
                seq: this.pingSeq,
            },
            true
        );
    }

    private stopPingTimer(): void {
        if (this.pingTimerId !== null) {
            globalThis.clearInterval(this.pingTimerId);
            this.pingTimerId = null;
        }
    }

    private clearReconnectTimer(): void {
        if (this.reconnectTimerId !== null) {
            globalThis.clearTimeout(this.reconnectTimerId);
            this.reconnectTimerId = null;
        }
    }

    private clearConnectTimeout(): void {
        if (this.connectTimeoutId !== null) {
            globalThis.clearTimeout(this.connectTimeoutId);
            this.connectTimeoutId = null;
        }
    }

    private clearDelayedTimers(): void {
        for (const timerId of this.delayedTimers) {
            globalThis.clearTimeout(timerId);
        }
        this.delayedTimers.clear();
    }

    private teardownSocket(
        socket: WebSocket | null,
        code: number,
        reason: string
    ): void {
        this.connectionNonce += 1;
        if (this.ws === socket) {
            this.ws = null;
        }
        if (
            socket &&
            (socket.readyState === WebSocket.OPEN ||
                socket.readyState === WebSocket.CONNECTING)
        ) {
            try {
                socket.close(code, reason);
            } catch {
                // Ignore close error
            }
        }
    }

    private resetRoomState(): void {
        this.state = 'offline';
        this.roomCode = null;
        this.localSlotIndex = 0;
        this.playersById.clear();
        this.peersById.clear();
        this.collectedCrystals.clear();
        this.predictionHistory.clear();
        this.queuedEvents.length = 0;
        this.monsters = [];
        this.companions = [];
        this.capturedRoster = [];
        this.sharedResources = createDefaultSharedResources();
        this.resourceNodes = [];
        this.structures = [];
        this.baseWorkers = [];
        this.persistenceMode = null;
        this.combatSeq = 0;
        this.survivalSeq = 0;
        this.metrics = createEmptyNetworkMetrics();
        this.lastRttSampleMs = 0;
        this.sentSamples.length = 0;
        this.recvSamples.length = 0;
        this.snapshotTimestampsMs.length = 0;
    }

    private resolvePendingConnects(): void {
        if (this.pendingConnectResolvers.length === 0) return;
        const status = this.getStatus();
        const resolvers = this.pendingConnectResolvers.splice(0);
        for (const resolve of resolvers) {
            resolve(status);
        }
    }

    private emitNotification(message: string, kind: CoopNotificationKind): void {
        for (const cb of this.notificationListeners) {
            cb(message, kind);
        }
    }

    private emitSnapshot(): void {
        const status = this.getStatus();
        for (const cb of this.snapshotListeners) {
            cb(status);
        }
    }
}
