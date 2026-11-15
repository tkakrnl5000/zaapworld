import * as pc from 'playcanvas';
import { AssetLoader } from './assets/AssetLoader';
import { SoundManager } from './audio/SoundManager';
import {
    ThirdPersonCamera,
    type CameraStateSnapshot,
} from './camera/ThirdPersonCamera';
import {
    type CombatPlayerStatsSnapshot,
    type CompanionRosterSnapshot,
    type LockedTargetSnapshot,
    MonsterCombatManager,
} from './combat/MonsterCombatManager';
import { InputManager } from './input/InputManager';
import {
    RemotePlayerManager,
    type RemoteNameplateInfo,
} from './network/RemotePlayerManager';
import { CollisionWorld } from './physics/CollisionWorld';
import { PlayerController } from './player/PlayerController';
import {
    type CoopSessionStatus,
    type MonsterAIState,
    type MonsterSpeciesId,
    type NetworkSimulationOptions,
    isValidRoomCode,
    sanitizeRoomCode,
} from './shared/NetworkProtocol';
import {
    ExpansionHooks,
    type ExpansionSummary,
} from './systems/ExpansionHooks';
import { SurvivalBuildingManager } from './survival/SurvivalBuildingManager';
import { QualityManager } from './systems/QualityManager';
import type {
    PerformanceMetrics,
    PlayerTelemetry,
    QualityMode,
    QualitySettings,
} from './types/interfaces';
import {
    HudOverlay,
    type HudSurvivalState,
    type HudToastKind,
} from './ui/HudOverlay';
import { EnvironmentManager } from './world/EnvironmentManager';

export interface MultiplayerStateDebugSnapshot extends CoopSessionStatus {
    remotePlayerCount: number;
    nameplates: RemoteNameplateInfo[];
}

export interface DebugMonsterSnapshot {
    id: string;
    species: MonsterSpeciesId;
    name: string;
    level: number;
    hp: number;
    maxHp: number;
    aiState: MonsterAIState;
    distanceMeters: number;
    x: number | null;
    y: number | null;
    z: number | null;
    screenX: number | null;
    screenY: number | null;
    visible: boolean;
    targeted: boolean;
    captureProgress: number;
}

export type DebugCombatActionKind = Parameters<
    MonsterCombatManager['triggerDebugAction']
>[0];

export interface ZaapDebugApi {
    getMetrics: () => PerformanceMetrics & {
        pixelRatio: number;
        shadowsEnabled: boolean;
        drawDistance: number;
        grassInstanceCount: number;
    };
    getQualitySettings: () => QualitySettings;
    getPlayerTelemetry: () => PlayerTelemetry;
    setQualityMode: (mode: QualityMode) => QualitySettings;
    teleport: (x: number, z: number) => PlayerTelemetry;
    getExpansionStatus: () => ExpansionSummary;
    getCameraState: () => CameraStateSnapshot;
    setCameraAngles: (yawDeg: number, pitchDeg: number) => CameraStateSnapshot;
    createRoom: (
        displayName?: string,
        preferredRoomCode?: string,
        wsEndpoint?: string
    ) => Promise<CoopSessionStatus>;
    joinRoom: (
        roomCode: string,
        displayName?: string,
        wsEndpoint?: string
    ) => Promise<CoopSessionStatus>;
    leaveRoom: () => Promise<CoopSessionStatus>;
    getMultiplayerState: () => MultiplayerStateDebugSnapshot;
    simulateNetwork: (
        options: NetworkSimulationOptions
    ) => ReturnType<ExpansionHooks['coop']['simulateNetworkConditions']>;
    getMonsters: () => DebugMonsterSnapshot[];
    getPlayerCombat: () => CombatPlayerStatsSnapshot & {
        lockedTarget: LockedTargetSnapshot | null;
    };
    getCapturedRoster: () => ReturnType<
        MonsterCombatManager['getCapturedRoster']
    >;
    getCompanion: () => CompanionRosterSnapshot & {
        position: { x: number; y: number; z: number } | null;
    };
    triggerCombatAction: (
        kind: DebugCombatActionKind,
        value?: number
    ) => Record<string, unknown>;
    setMuted: (muted: boolean) => boolean;
    getSurvivalState: () => HudSurvivalState;
    triggerSurvivalAction: (action: string, arg?: string) => Record<string, unknown>;
}

declare global {
    interface Window {
        __ZAAP_DEBUG__?: ZaapDebugApi;
    }
}

function updateLoadingUi(percent: number, statusText: string): void {
    const barFill = document.getElementById('loading-bar-fill');
    const statusEl = document.getElementById('loading-status');
    if (barFill) {
        const clamped = Math.max(0, Math.min(100, percent));
        barFill.style.width = `${clamped.toFixed(0)}%`;
    }
    if (statusEl) {
        statusEl.textContent = statusText;
    }
}

function hideLoadingScreen(): void {
    const loadingScreen = document.getElementById('loading-screen');
    if (loadingScreen) {
        loadingScreen.classList.add('hidden');
    }
}

function isLikelyMobileDevice(): boolean {
    const ua = navigator.userAgent || '';
    const uaMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(
        ua
    );
    const minDim = Math.min(window.screen?.width ?? 1920, window.screen?.height ?? 1080);
    return uaMobile || (navigator.maxTouchPoints > 1 && minDim <= 1024);
}

async function bootstrap(): Promise<void> {
    const canvas = document.getElementById('app-canvas') as HTMLCanvasElement | null;
    if (!canvas) {
        throw new Error('Missing #app-canvas element');
    }
    const uiRoot = document.getElementById('ui-root');

    updateLoadingUi(8, 'Starting PlayCanvas WebGL2 engine...');

    const mobileDevice = isLikelyMobileDevice();
    const app = new pc.Application(canvas, {
        graphicsDeviceOptions: {
            preferWebGl2: true,
            antialias: !mobileDevice,
            alpha: false,
            powerPreference: 'high-performance',
        },
    });

    app.setCanvasFillMode(pc.FILLMODE_FILL_WINDOW);
    app.setCanvasResolution(pc.RESOLUTION_AUTO);
    app.start();

    const handleResize = () => {
        app.resizeCanvas();
    };
    window.addEventListener('resize', handleResize);

    const qualityManager = new QualityManager(app, null, 'auto');
    const collisionWorld = new CollisionWorld();
    const expansionHooks = new ExpansionHooks('local-explorer-1');
    const coop = expansionHooks.coop;
    const assetLoader = new AssetLoader();

    updateLoadingUi(15, 'Loading 3D models & textures...');
    await assetLoader.loadAll(app, (loaded, total, label) => {
        const ratio = total > 0 ? loaded / total : 1;
        const pct = 15 + ratio * 68;
        updateLoadingUi(pct, `Loading ${label} (${loaded}/${total})...`);
    });

    updateLoadingUi(88, 'Sculpting Aether Sanctuary & foliage...');
    const environment = new EnvironmentManager(app, collisionWorld, assetLoader);
    environment.initialize(qualityManager.getSettings());
    qualityManager.setDirectionalLight(environment.getDirectionalLight());
    expansionHooks.monsters.planWildSpawns(collisionWorld);

    updateLoadingUi(94, 'Spawning Explorer & orbital camera...');
    const playerBundle = assetLoader.getBundle('player_explorer');
    const playerController = new PlayerController({
        app,
        collisionWorld,
        playerBundle,
        totalCrystals: environment.getTotalCrystals(),
        onCollectCrystal: (colliderId: string) => {
            const collected = environment.collectCrystal(colliderId);
            if (collected) {
                coop.emitWorldEvent('crystal_collected', {
                    crystalId: colliderId,
                    collectedCount: environment.getCollectedCrystalCount(),
                });
            }
            return collected;
        },
    });

    const remotePlayerManager = new RemotePlayerManager(
        app,
        collisionWorld,
        playerBundle
    );

    const cameraController = new ThirdPersonCamera(
        app,
        collisionWorld,
        playerController.getPositionRef()
    );

    const syncCameraFarClip = (settings: QualitySettings) => {
        cameraController.setFarClip(Math.max(125, settings.drawDistance + 45));
    };
    syncCameraFarClip(qualityManager.getSettings());
    qualityManager.subscribe(syncCameraFarClip);

    const inputManager = new InputManager(canvas);
    const soundManager = new SoundManager(false);
    const monsterCombatManager = new MonsterCombatManager({
        app,
        worldRoot: app.root,
        collisionWorld,
        assetLoader,
        playerController,
        soundManager,
        remotePlayerManager,
        multiplayerClient: coop,
    });
    let survivalToastSink: ((msg: string, kind?: HudToastKind) => void) | null = null;
    const survivalManager = new SurvivalBuildingManager({
        app,
        worldRoot: app.root,
        collisionWorld,
        assetLoader,
        playerController,
        soundManager,
        monsterCombatManager,
        multiplayerClient: coop,
        onToast: (msg, kind) => survivalToastSink?.(msg, kind),
    });
    const hud = new HudOverlay(
        uiRoot,
        {
            onQualityModeChange: (mode: QualityMode) => {
                qualityManager.setMode(mode);
            },
            onSensitivityChange: (sensitivity: number) => {
                cameraController.setSensitivity(sensitivity);
            },
            onCreateRoom: (displayName: string) => {
                void coop.createRoom(displayName);
            },
            onJoinRoom: (roomCode: string, displayName: string) => {
                void coop.joinRoom(roomCode, displayName);
            },
            onLeaveRoom: () => {
                void coop.leaveRoom();
            },
            onToggleMute: () => soundManager.toggleMuted(),
            onSelectCompanion: (index: number) => {
                monsterCombatManager.selectCompanion(index);
            },
            onSummonOrRecallCompanion: (uid: string) => {
                monsterCombatManager.toggleSummonCompanion(uid);
            },
            onCraftItem: (recipeId) => {
                survivalManager.craftItem(recipeId);
            },
            onEquipTool: (toolId) => {
                survivalManager.equipTool(toolId);
            },
            onEatFood: () => {
                survivalManager.eatFood();
            },
            onRestBed: () => {
                survivalManager.restAtNearestBed();
            },
            onToggleBuildMode: (enabled) => {
                if (typeof enabled === 'boolean') {
                    survivalManager.setBuildMode(enabled);
                    return;
                }
                const { width, height } = readViewportSize();
                const current = survivalManager.getHudSurvivalState(
                    cameraController.entity,
                    width,
                    height
                ).buildMode;
                survivalManager.setBuildMode(!current);
            },
            onSelectBuildRecipe: (recipeId) => {
                survivalManager.selectBuildRecipe(recipeId);
            },
            onBuildRotate: () => {
                survivalManager.rotateBuildPreview();
            },
            onBuildPlace: () => {
                survivalManager.confirmBuildPlace();
            },
            onBuildDemolish: () => {
                survivalManager.demolishNearestOrTargetedStructure();
            },
            onAssignBaseWorker: (uid) => {
                survivalManager.assignBaseWorker(uid);
            },
            onUnassignBaseWorker: (uid) => {
                survivalManager.unassignBaseWorker(uid);
            },
        },
        cameraController.getSensitivity()
    );
    survivalToastSink = (msg, kind) => hud.showToast(msg, 2600, kind);
    hud.setMutedVisual(soundManager.isMuted());

    coop.onNotification((msg, kind) => {
        hud.showToast(msg, 2800, kind);
    });

    coop.onServerReconcile((authState, predictedPos) =>
        playerController.applyServerReconciliation(
            authState.position,
            authState.velocity,
            predictedPos
        )
    );

    coop.onWorldEvent((event) => {
        if (event.kind === 'crystal_collected') {
            const crystalId = event.payload.crystalId;
            if (typeof crystalId === 'string' && crystalId.length > 0) {
                environment.syncCollectedCrystals([crystalId], true);
                playerController.setCollectedCrystalCount(
                    environment.getCollectedCrystalCount()
                );
            }
        }
    });

    coop.onRoomJoined((status, reconnected) => {
        environment.syncCollectedCrystals(status.collectedCrystals, false);
        playerController.setCollectedCrystalCount(
            environment.getCollectedCrystalCount()
        );
        if (!reconnected) {
            playerController.setSpawnSlot(status.localSlotIndex);
            cameraController.snapToTarget(playerController.getPositionRef());
        }
        remotePlayerManager.syncRoomPlayers(
            status.localPlayerId,
            status.players,
            Date.now()
        );
    });

    coop.onSnapshot((status) => {
        if (status.collectedCrystals.length > 0) {
            environment.syncCollectedCrystals(status.collectedCrystals, true);
            playerController.setCollectedCrystalCount(
                environment.getCollectedCrystalCount()
            );
        }
        remotePlayerManager.syncRoomPlayers(
            status.localPlayerId,
            status.players,
            Date.now()
        );
    });

    const tmpForwardXZ = new pc.Vec3();
    const tmpRightXZ = new pc.Vec3();
    let latestNameplates: RemoteNameplateInfo[] = [];

    const readViewportSize = () => ({
        width: canvas.clientWidth || window.innerWidth,
        height: canvas.clientHeight || window.innerHeight,
    });

    const stepFrame = (dt: number) => {
        const input = inputManager.sampleFrame();
        const forwardXZ = cameraController.getForwardXZ(tmpForwardXZ);
        const rightXZ = cameraController.getRightXZ(tmpRightXZ);

        playerController.update(dt, input, forwardXZ, rightXZ);
        monsterCombatManager.update(dt, input, inputManager.isCameraDragging());
        survivalManager.update(dt, input, forwardXZ);
        if (input.craftPanelPressed) {
            hud.toggleCraftDrawer();
        }
        if (input.basePanelPressed) {
            hud.toggleBaseDrawer();
        }
        coop.update(dt, playerController.getTelemetry());

        const playerPos = playerController.getPositionRef();
        cameraController.update(dt, playerPos, input);

        const activeQuality = qualityManager.getSettings();
        const envStats = environment.update(dt, playerPos, activeQuality);
        qualityManager.update(dt, envStats.visibleInstances, envStats.culledObjects);

        const expansionStatus = expansionHooks.getStatus();
        const coopStatus = expansionStatus.coop.status;
        remotePlayerManager.syncRoomPlayers(
            coopStatus.localPlayerId,
            coopStatus.players,
            Date.now()
        );
        const { width, height } = readViewportSize();
        latestNameplates = remotePlayerManager.update(
            dt,
            cameraController.entity,
            width,
            height
        );
        const combatState = monsterCombatManager.getHudCombatState(
            cameraController.entity,
            width,
            height
        );
        const survivalState = survivalManager.getHudSurvivalState(
            cameraController.entity,
            width,
            height
        );

        hud.update(
            playerController.getTelemetry(),
            qualityManager.getMetrics(),
            inputManager.getJoystickVisualState(),
            inputManager.getActionButtonStates(),
            expansionStatus,
            latestNameplates,
            combatState,
            survivalState
        );
    };

    app.on('update', stepFrame);

    const buildMonsterDebugSnapshots = (): DebugMonsterSnapshot[] => {
        const { width, height } = readViewportSize();
        const snapshot = monsterCombatManager.getHudCombatState(
            cameraController.entity,
            width,
            height
        );
        const lockedId = snapshot.lockedTarget?.id ?? null;
        const plateById = new Map(
            snapshot.monsterPlates
                .filter((p) => !p.isCompanion)
                .map((p) => [p.id, p])
        );

        const coopStatus = coop.getStatus();
        if (coopStatus.state === 'connected' && coopStatus.monsters) {
            const pPos = playerController.getPositionRef();
            return coopStatus.monsters.map((m) => {
                const plate = plateById.get(m.id);
                return {
                    id: m.id,
                    species: m.species,
                    name: m.name,
                    level: m.level,
                    hp: Math.round(m.hp),
                    maxHp: Math.round(m.maxHp),
                    aiState: m.aiState,
                    distanceMeters: Number(
                        Math.hypot(m.x - pPos.x, m.z - pPos.z).toFixed(1)
                    ),
                    x: Number(m.x.toFixed(2)),
                    y: Number(m.y.toFixed(2)),
                    z: Number(m.z.toFixed(2)),
                    screenX: plate ? Number(plate.screenX.toFixed(1)) : null,
                    screenY: plate ? Number(plate.screenY.toFixed(1)) : null,
                    visible: Boolean(plate?.visible),
                    targeted: m.id === lockedId,
                    captureProgress: plate?.captureProgress ?? 0,
                };
            });
        }

        const results: DebugMonsterSnapshot[] = [];
        for (const plate of plateById.values()) {
            const entity = app.root.findByName(`Monster_${plate.id}`);
            const pos = entity ? entity.getPosition() : null;
            results.push({
                id: plate.id,
                species: plate.species,
                name: plate.name,
                level: plate.level,
                hp: Math.round(plate.hp),
                maxHp: Math.round(plate.maxHp),
                aiState: plate.aiState,
                distanceMeters: plate.distanceMeters,
                x: pos ? Number(pos.x.toFixed(2)) : null,
                y: pos ? Number(pos.y.toFixed(2)) : null,
                z: pos ? Number(pos.z.toFixed(2)) : null,
                screenX: Number(plate.screenX.toFixed(1)),
                screenY: Number(plate.screenY.toFixed(1)),
                visible: plate.visible,
                targeted: plate.id === lockedId,
                captureProgress: plate.captureProgress,
            });
        }
        return results;
    };

    const buildCompanionDebugSnapshot = () => {
        const comp = monsterCombatManager.getCompanionSnapshot();
        let position: { x: number; y: number; z: number } | null = null;
        if (comp.activeUid) {
            const coopStatus = coop.getStatus();
            const synced =
                coopStatus.state === 'connected'
                    ? coopStatus.companions?.find(
                          (c) => c.uid === comp.activeUid
                      )
                    : undefined;
            if (synced) {
                position = {
                    x: Number(synced.x.toFixed(2)),
                    y: Number(synced.y.toFixed(2)),
                    z: Number(synced.z.toFixed(2)),
                };
            } else {
                const entity = app.root.findByName(
                    `Companion_${comp.activeUid}`
                );
                if (entity) {
                    const p = entity.getPosition();
                    position = {
                        x: Number(p.x.toFixed(2)),
                        y: Number(p.y.toFixed(2)),
                        z: Number(p.z.toFixed(2)),
                    };
                }
            }
        }
        return {
            ...comp,
            position,
        };
    };

    // Expose automated verification & inspection handle
    window.__ZAAP_DEBUG__ = {
        getMetrics: () => {
            const settings = qualityManager.getSettings();
            return {
                ...qualityManager.getMetrics(),
                pixelRatio: settings.pixelRatio,
                shadowsEnabled: settings.shadowsEnabled,
                drawDistance: settings.drawDistance,
                grassInstanceCount: settings.grassInstanceCount,
            };
        },
        getQualitySettings: () => qualityManager.getSettings(),
        getPlayerTelemetry: () => playerController.getTelemetry(),
        setQualityMode: (mode: QualityMode) => {
            const next = qualityManager.setMode(mode);
            environment.update(0.016, playerController.getPositionRef(), next);
            return next;
        },
        teleport: (x: number, z: number) => {
            playerController.teleport(x, z);
            const pos = playerController.getPositionRef();
            cameraController.snapToTarget(pos);
            environment.update(0.016, pos, qualityManager.getSettings());
            return playerController.getTelemetry();
        },
        getExpansionStatus: () => expansionHooks.getStatus(),
        getCameraState: () => cameraController.getCameraState(),
        setCameraAngles: (yawDeg: number, pitchDeg: number) => {
            cameraController.setAngles(yawDeg, pitchDeg);
            cameraController.snapToTarget(playerController.getPositionRef());
            return cameraController.getCameraState();
        },
        createRoom: (
            displayName?: string,
            preferredRoomCode?: string,
            wsEndpoint?: string
        ) => coop.createRoom(displayName, preferredRoomCode, wsEndpoint),
        joinRoom: (roomCode: string, displayName?: string, wsEndpoint?: string) =>
            coop.joinRoom(roomCode, displayName, wsEndpoint),
        leaveRoom: () => coop.leaveRoom(),
        getMultiplayerState: () => ({
            ...coop.getStatus(),
            remotePlayerCount: remotePlayerManager.getRemotePlayerCount(),
            nameplates: latestNameplates.map((np) => ({ ...np })),
        }),
        simulateNetwork: (options: NetworkSimulationOptions) =>
            coop.simulateNetworkConditions(options),
        getMonsters: () => buildMonsterDebugSnapshots(),
        getPlayerCombat: () => ({
            ...monsterCombatManager.getLocalPlayerStats(),
            lockedTarget: monsterCombatManager.getLockedTargetInfo(),
        }),
        getCapturedRoster: () => monsterCombatManager.getCapturedRoster(),
        getCompanion: () => buildCompanionDebugSnapshot(),
        triggerCombatAction: (
            kind: DebugCombatActionKind,
            value?: number
        ) => monsterCombatManager.triggerDebugAction(kind, value),
        setMuted: (muted: boolean) => {
            soundManager.setMuted(muted);
            const nextMuted = soundManager.isMuted();
            hud.setMutedVisual(nextMuted);
            return nextMuted;
        },
        getSurvivalState: () => {
            const { width, height } = readViewportSize();
            return survivalManager.getHudSurvivalState(
                cameraController.entity,
                width,
                height
            );
        },
        triggerSurvivalAction: (action: string, arg?: string) =>
            survivalManager.triggerDebugAction(action, arg),
    };

    // Prime one update tick so HUD and camera state are immediately populated
    environment.update(
        0.016,
        playerController.getPositionRef(),
        qualityManager.getSettings()
    );
    const { width: initW, height: initH } = readViewportSize();
    hud.update(
        playerController.getTelemetry(),
        qualityManager.getMetrics(),
        inputManager.getJoystickVisualState(),
        inputManager.getActionButtonStates(),
        expansionHooks.getStatus(),
        latestNameplates,
        monsterCombatManager.getHudCombatState(
            cameraController.entity,
            initW,
            initH
        ),
        survivalManager.getHudSurvivalState(
            cameraController.entity,
            initW,
            initH
        )
    );
    updateLoadingUi(100, 'Ready — Welcome to Aether Sanctuary');
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            hideLoadingScreen();
        });
    });
    window.setTimeout(hideLoadingScreen, 300);

    // Support ?room=CODE invite links on startup
    const queryParams = new URLSearchParams(window.location.search);
    const rawRoomParam = queryParams.get('room');
    if (rawRoomParam) {
        const inviteCode = sanitizeRoomCode(rawRoomParam);
        if (isValidRoomCode(inviteCode)) {
            hud.setRoomCodeInput(inviteCode);
            void coop.joinRoom(inviteCode);
        } else {
            hud.showToast('유효하지 않은 초대 방 코드입니다.', 2800, 'error');
        }
    }

    window.addEventListener('beforeunload', () => {
        window.removeEventListener('resize', handleResize);
        app.off('update', stepFrame);
        survivalManager.dispose();
        monsterCombatManager.dispose();
        soundManager.dispose();
        remotePlayerManager.dispose();
        hud.dispose();
        inputManager.dispose();
        playerController.dispose();
        app.destroy();
    });
}

bootstrap().catch((err) => {
    console.error('ZAAPworld bootstrap failed:', err);
    updateLoadingUi(
        100,
        `Initialization error: ${err instanceof Error ? err.message : String(err)}`
    );
});
