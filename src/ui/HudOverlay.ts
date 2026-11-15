import type {
    ActionButtonStates,
    JoystickVisualState,
} from '../input/InputManager';
import type { RemoteNameplateInfo } from '../network/RemotePlayerManager';
import {
    type BaseWorkerAIState,
    type BaseWorkerSyncState,
    type CapturedMonsterRecord,
    type CompanionAIState,
    type CoopSessionStatus,
    CRAFT_RECIPE_LIST,
    type CraftRecipeId,
    MAX_BASE_WORKERS,
    MAX_PARTY_PLAYERS,
    MODULAR_STRUCTURE_RECIPE_LIST,
    type ModularStructureRecipeId,
    type MonsterAIState,
    type MonsterSpeciesId,
    type PlacedStructureSyncState,
    type PlayerSlotIndex,
    type PlayerSyncState,
    type ResourceKind,
    SLOT_PALETTE,
    SPECIES_WORK_SUITABILITY,
    STARTING_CAPTURE_SPHERES,
    type SharedResourceInventory,
    type ToolId,
    type WorkSuitabilityKind,
    createDefaultSharedResources,
    isValidRoomCode,
    sanitizeRoomCode,
} from '../shared/NetworkProtocol';
import type { ExpansionSummary } from '../systems/ExpansionHooks';
import type {
    PerformanceMetrics,
    PlayerTelemetry,
    QualityMode,
} from '../types/interfaces';

export interface CoopUiCallbacks {
    onCreateRoom: (displayName: string) => void;
    onJoinRoom: (roomCode: string, displayName: string) => void;
    onLeaveRoom: () => void;
}

export interface HudCallbacks extends Partial<CoopUiCallbacks> {
    onQualityModeChange: (mode: QualityMode) => void;
    onSensitivityChange: (sensitivity: number) => void;
    onToggleMute?: () => boolean | void;
    onSelectCompanion?: (index: number, uid: string) => void;
    onSummonOrRecallCompanion?: (uid: string) => void;
    onCraftItem?: (recipeId: CraftRecipeId) => void;
    onEquipTool?: (toolId: ToolId) => void;
    onEatFood?: () => void;
    onRestBed?: () => void;
    onToggleBuildMode?: (enabled?: boolean) => void;
    onSelectBuildRecipe?: (recipeId: ModularStructureRecipeId) => void;
    onBuildRotate?: () => void;
    onBuildPlace?: () => void;
    onBuildDemolish?: () => void;
    onAssignBaseWorker?: (uid: string) => void;
    onUnassignBaseWorker?: (uid: string) => void;
}

export interface SurvivalPlateInfo {
    id: string;
    label: string;
    kind: 'resource' | 'structure' | 'worker';
    hp?: number;
    maxHp?: number;
    energy?: number;
    maxEnergy?: number;
    stateTag?: string;
    screenX: number;
    screenY: number;
    visible: boolean;
    distanceMeters: number;
}

export interface HudSurvivalState {
    hunger: number;
    maxHunger: number;
    equippedTool: ToolId;
    unlockedTools: ToolId[];
    sharedResources: SharedResourceInventory;
    hasWorkbenchNearOrInBase: boolean;
    hasBedNear: boolean;
    nearestResourceLabel: string | null;
    nearestStructureLabel: string | null;
    nearestStructureId: string | null;
    buildMode: boolean;
    selectedBuildRecipe: ModularStructureRecipeId;
    buildRotationDeg: number;
    buildPreviewValid: boolean;
    buildPreviewReason: string | null;
    placedStructures: PlacedStructureSyncState[];
    baseWorkers: BaseWorkerSyncState[];
    capturedRoster: CapturedMonsterRecord[];
    activeCompanionUid: string | null;
    persistenceMode: string;
    plates: SurvivalPlateInfo[];
}

export interface HudPlayerCombatStats {
    hp: number;
    maxHp: number;
    captureSpheres: number;
    lootCount: number;
    dodging: boolean;
    attackComboStep: number;
    muted?: boolean;
}

export interface HudLockedTargetInfo {
    id: string;
    species: MonsterSpeciesId;
    name: string;
    level: number;
    hp: number;
    maxHp: number;
    aiState: MonsterAIState;
    distanceMeters: number;
    captureChancePct: number;
    capturingByMe?: boolean;
    lockedByOther?: boolean;
}

export interface HudMonsterPlateInfo {
    id: string;
    species: MonsterSpeciesId;
    name: string;
    level: number;
    hp: number;
    maxHp: number;
    aiState: MonsterAIState;
    screenX: number;
    screenY: number;
    visible: boolean;
    distanceMeters: number;
    isTargeted?: boolean;
    isCompanion?: boolean;
    captureProgress?: number;
}

export type HudCombatPopupKind =
    | 'damage'
    | 'heavy'
    | 'player_hit'
    | 'dodge'
    | 'capture_success'
    | 'capture_fail'
    | 'loot'
    | 'info';

export interface HudCombatPopupInfo {
    id: string;
    text: string;
    kind: HudCombatPopupKind;
    screenX: number;
    screenY: number;
    visible: boolean;
    ageRatio: number;
}

export interface HudCompanionSnapshot {
    roster: CapturedMonsterRecord[];
    activeUid: string | null;
    selectedIndex: number;
    activeState?: CompanionAIState | null;
    activeHp?: number;
    activeMaxHp?: number;
}

export interface HudCombatState {
    playerStats: HudPlayerCombatStats;
    lockedTarget: HudLockedTargetInfo | null;
    monsterPlates: HudMonsterPlateInfo[];
    combatPopups: HudCombatPopupInfo[];
    companions: HudCompanionSnapshot;
}

export type HudToastKind = 'info' | 'success' | 'warning' | 'error';

interface SpeciesTheme {
    elementLabel: string;
    colorHex: string;
    bgRgba: string;
    borderRgba: string;
    shortName: string;
}

const SPECIES_THEMES: Record<MonsterSpeciesId, SpeciesTheme> = {
    moss_hopper: {
        elementLabel: '풀',
        colorHex: '#34d399',
        bgRgba: 'rgba(16, 185, 129, 0.22)',
        borderRgba: 'rgba(52, 211, 153, 0.58)',
        shortName: '이끼 홉퍼',
    },
    aether_wisp: {
        elementLabel: '에테르',
        colorHex: '#38bdf8',
        bgRgba: 'rgba(14, 165, 233, 0.22)',
        borderRgba: 'rgba(56, 189, 248, 0.58)',
        shortName: '에테르 위습',
    },
    shale_golem: {
        elementLabel: '대지',
        colorHex: '#f59e0b',
        bgRgba: 'rgba(245, 158, 11, 0.22)',
        borderRgba: 'rgba(251, 191, 36, 0.58)',
        shortName: '혈암 골렘',
    },
};

function getSpeciesTheme(species: MonsterSpeciesId): SpeciesTheme {
    return SPECIES_THEMES[species] ?? SPECIES_THEMES.moss_hopper;
}

const TOOL_LABELS_KO: Record<ToolId, string> = {
    hands: '도구: 맨손',
    wood_axe: '도구: 벌목 도끼',
    stone_pickaxe: '도구: 채굴 곡괭이',
    aether_blade: '도구: 에테르 검',
};

const TOOL_SHORT_KO: Record<ToolId, string> = {
    hands: '맨손',
    wood_axe: '벌목 도끼',
    stone_pickaxe: '채굴 곡괭이',
    aether_blade: '에테르 검',
};

const RESOURCE_ORDER: ReadonlyArray<{ key: ResourceKind; labelKo: string }> = [
    { key: 'wood', labelKo: '목재' },
    { key: 'stone', labelKo: '석재' },
    { key: 'ore', labelKo: '광석' },
    { key: 'berry', labelKo: '열매' },
    { key: 'aether_shard', labelKo: '결정' },
    { key: 'cooked_berry', labelKo: '구운열매' },
];

const RESOURCE_LABELS_KO: Record<ResourceKind, string> = {
    wood: '목재',
    stone: '석재',
    ore: '광석',
    berry: '열매',
    aether_shard: '결정',
    cooked_berry: '구운열매',
};

const PLAYER_STATE_KO: Record<PlayerTelemetry['state'], string> = {
    idle: '대기',
    walk: '걷기',
    run: '질주',
    jump: '점프',
    fall: '낙하',
    attack: '공격',
    dodge: '회피',
    hit: '피격',
    throw: '투척',
    gather: '채집',
    build: '건축',
};

const MONSTER_AI_STATE_KO: Record<MonsterAIState, string> = {
    patrol: '순찰',
    rest: '휴식',
    observe: '관찰',
    alert: '경계',
    chase: '추적',
    attack: '공격',
    hit: '피격',
    flee: '도주',
    return: '복귀',
    capturing: '포획 중',
    captured: '포획됨',
    dead: '기절',
};

const WORK_SUITABILITY_KO: Record<WorkSuitabilityKind, string> = {
    lumbering: '벌목',
    mining: '채광',
    gathering: '채집',
    handiwork: '수작업',
    transporting: '운반',
};

const BUILD_PILL_LABELS_KO: Record<ModularStructureRecipeId, string> = {
    wood_foundation: '목재 토대',
    wood_wall: '목재 벽',
    wood_door: '목재 문',
    wood_roof: '목재 지붕',
    workbench: '작업대',
    storage_chest: '보관함',
    straw_bed: '건초 침대',
};

const QUALITY_TIER_KO: Record<string, string> = {
    auto: '자동',
    low: '낮음',
    medium: '중간',
    high: '높음',
};

function formatMonsterNameKo(species: MonsterSpeciesId, rawName: string): string {
    const theme = getSpeciesTheme(species);
    if (
        rawName === 'Moss Hopper' ||
        rawName === 'Aether Wisp' ||
        rawName === 'Shale Golem'
    ) {
        return theme.shortName;
    }
    return rawName || theme.shortName;
}

function formatWorkerStateTagKo(
    aiState: BaseWorkerAIState,
    activeWork: WorkSuitabilityKind | null
): string {
    if (aiState === 'work_gather') {
        if (activeWork === 'lumbering') return '벌목 중';
        if (activeWork === 'mining') return '채광 중';
        if (activeWork === 'gathering') return '채집 중';
        return '작업 중';
    }
    if (aiState === 'work_craft') return '제작 보조';
    if (aiState === 'transport') return '운반 중';
    if (aiState === 'rest') return '휴식 중';
    if (aiState === 'return') return '복귀 중';
    return '대기 중';
}

function formatSpeciesSuitabilityKo(species: MonsterSpeciesId): string {
    const map = SPECIES_WORK_SUITABILITY[species] ?? {};
    const parts = (Object.entries(map) as Array<[WorkSuitabilityKind, number]>)
        .filter(([, lv]) => lv > 0)
        .map(([kind, lv]) => `${WORK_SUITABILITY_KO[kind]} Lv.${lv}`);
    return `${getSpeciesTheme(species).shortName}: ${parts.join(' · ') || '대기'}`;
}

function translateBuildReasonKo(reason: string | null): string {
    if (!reason) return '설치 불가';
    const upper = reason.toUpperCase();
    if (upper.includes('OCCUPIED')) return '이미 설치된 칸';
    if (upper.includes('UNDERWATER') || upper.includes('WATER')) return '물 위 설치 불가';
    if (upper.includes('STEEP') || upper.includes('SLOPE')) return '경사가 너무 가파름';
    if (upper.includes('INSUFFICIENT') || upper.includes('RESOURCE')) return '자원 부족';
    if (upper.includes('RANGE')) return '거리 초과';
    return reason;
}

function hasEnoughResources(
    inventory: SharedResourceInventory,
    cost: Partial<SharedResourceInventory>
): boolean {
    for (const [k, amount] of Object.entries(cost) as Array<[ResourceKind, number | undefined]>) {
        if (typeof amount === 'number' && amount > 0 && (inventory[k] ?? 0) < amount) {
            return false;
        }
    }
    return true;
}

const HUD_STYLE_ID = 'zaap-hud-styles';

const HUD_CSS = `
#zaap-hud {
  position: relative;
  width: 100%;
  height: 100%;
  pointer-events: none;
  font-family: 'Segoe UI', system-ui, -apple-system, BlinkMacSystemFont, Roboto, sans-serif;
  color: #eff7ff;
}

.hud-glass {
  background: linear-gradient(145deg, rgba(11, 24, 38, 0.72), rgba(7, 15, 26, 0.58));
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  border: 1px solid rgba(130, 224, 245, 0.24);
  box-shadow: 0 8px 26px rgba(3, 10, 20, 0.36), inset 0 1px 0 rgba(255, 255, 255, 0.1);
}

/* Floating 3D Remote Player Nameplates, Monster & Survival World Plates */
#hud-nameplates,
#hud-monster-plates,
#hud-survival-plates,
#hud-combat-popups {
  position: absolute;
  inset: 0;
  overflow: hidden;
  pointer-events: none;
}

#hud-nameplates {
  z-index: 5;
}

#hud-monster-plates {
  z-index: 6;
}

#hud-survival-plates {
  z-index: 7;
}

#hud-combat-popups {
  z-index: 14;
}

.hud-splate {
  position: absolute;
  left: 0;
  top: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: 3px 7px;
  border-radius: 9px;
  background: rgba(8, 19, 31, 0.82);
  border: 1px solid rgba(125, 211, 252, 0.34);
  box-shadow: 0 4px 12px rgba(2, 8, 18, 0.45);
  color: #f0f9ff;
  font-size: 10px;
  font-weight: 800;
  white-space: nowrap;
  pointer-events: none;
  will-change: transform, opacity;
}

.hud-splate.kind-resource {
  border-color: rgba(110, 231, 183, 0.5);
  color: #d1fae5;
}

.hud-splate.kind-worker {
  border-color: rgba(56, 189, 248, 0.62);
  background: rgba(7, 25, 42, 0.85);
}

.hud-splate.kind-structure {
  border-color: rgba(251, 191, 36, 0.48);
  color: #fef3c7;
}

.hud-splate-row {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}

.hud-splate-tag {
  padding: 1px 5px;
  border-radius: 999px;
  font-size: 8.5px;
  font-weight: 800;
  background: rgba(20, 184, 166, 0.25);
  border: 1px solid rgba(94, 234, 212, 0.45);
  color: #99f6e4;
}

.hud-splate-track {
  width: 68px;
  height: 3.5px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.16);
  overflow: hidden;
}

.hud-splate-fill {
  height: 100%;
  border-radius: 999px;
  background: linear-gradient(90deg, #34d399, #38bdf8);
  transition: width 0.08s linear;
}

.hud-nameplate {
  position: absolute;
  left: 0;
  top: 0;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 8px;
  border-radius: 999px;
  background: rgba(7, 16, 28, 0.76);
  border: 1px solid rgba(148, 224, 245, 0.32);
  box-shadow: 0 4px 14px rgba(2, 8, 18, 0.45);
  color: #f0f9ff;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.01em;
  white-space: nowrap;
  pointer-events: none;
  will-change: transform, opacity;
}

.hud-nameplate.reconnecting {
  border-style: dashed;
  border-color: rgba(251, 191, 36, 0.7);
}

.hud-np-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.hud-np-name {
  max-width: 128px;
  overflow: hidden;
  text-overflow: ellipsis;
}

.hud-np-reconn {
  font-size: 10px;
  font-weight: 700;
  color: #fde68a;
}

/* World-space Monster HP Plates */
.hud-mplate {
  position: absolute;
  left: 0;
  top: 0;
  min-width: 98px;
  max-width: 146px;
  padding: 4px 7px 5px;
  border-radius: 10px;
  background: rgba(8, 18, 30, 0.8);
  border: 1px solid rgba(148, 224, 245, 0.28);
  box-shadow: 0 5px 14px rgba(2, 8, 18, 0.5);
  display: flex;
  flex-direction: column;
  gap: 3px;
  pointer-events: none;
  will-change: transform, opacity;
}

.hud-mplate.targeted {
  border-color: rgba(251, 191, 36, 0.88);
  box-shadow: 0 0 14px rgba(251, 191, 36, 0.42);
}

.hud-mplate.companion {
  border-color: rgba(94, 234, 212, 0.7);
  background: rgba(8, 28, 32, 0.82);
}

.hud-mplate-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 5px;
  font-size: 10px;
  font-weight: 800;
  line-height: 1.1;
}

.hud-mplate-left {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
}

.hud-mplate-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
}

.hud-mplate-name {
  color: #f0f9ff;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.hud-mplate-lv {
  color: #bae6fd;
  font-size: 9px;
  font-weight: 800;
  flex-shrink: 0;
}

.hud-mplate-track {
  width: 100%;
  height: 5px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.14);
  overflow: hidden;
}

.hud-mplate-fill {
  height: 100%;
  border-radius: 999px;
  transition: width 0.08s linear;
}

.hud-mplate-tag {
  font-size: 8.5px;
  font-weight: 800;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: #fde68a;
  text-align: center;
  display: none;
}

.hud-mplate-tag.visible {
  display: block;
}

/* Floating Combat Damage & Capture Popups */
.hud-cpopup {
  position: absolute;
  left: 0;
  top: 0;
  font-weight: 900;
  font-size: 14px;
  letter-spacing: 0.02em;
  white-space: nowrap;
  text-shadow: 0 2px 8px rgba(0, 0, 0, 0.85), 0 0 3px rgba(0, 0, 0, 0.9);
  pointer-events: none;
  will-change: transform, opacity;
}

.hud-cpopup.kind-damage { color: #f8fafc; font-size: 14px; }
.hud-cpopup.kind-heavy { color: #fde047; font-size: 17px; }
.hud-cpopup.kind-player_hit { color: #fb7185; font-size: 15px; }
.hud-cpopup.kind-dodge { color: #67e8f9; font-size: 13px; letter-spacing: 0.06em; }
.hud-cpopup.kind-capture_success { color: #6ee7b7; font-size: 16px; }
.hud-cpopup.kind-capture_fail { color: #fda4af; font-size: 14px; }
.hud-cpopup.kind-loot { color: #a7f3d0; font-size: 13px; }
.hud-cpopup.kind-info { color: #bae6fd; font-size: 12.5px; }

/* Portrait Orientation Advisory */
#hud-portrait-banner {
  position: absolute;
  top: 10px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 40;
  display: none;
  align-items: center;
  gap: 10px;
  max-width: min(92vw, 440px);
  padding: 8px 12px;
  border-radius: 14px;
  background: linear-gradient(135deg, rgba(18, 42, 66, 0.9), rgba(11, 25, 42, 0.88));
  border: 1px solid rgba(94, 234, 212, 0.45);
  box-shadow: 0 10px 28px rgba(0, 0, 0, 0.45);
  pointer-events: auto;
  font-size: 12px;
  line-height: 1.35;
}

#hud-portrait-banner.visible {
  display: flex;
}

#hud-portrait-dismiss {
  flex-shrink: 0;
  border: 1px solid rgba(255, 255, 255, 0.22);
  background: rgba(255, 255, 255, 0.1);
  color: #f0f9ff;
  border-radius: 8px;
  padding: 4px 8px;
  font-size: 11px;
  font-weight: 700;
  cursor: pointer;
}

/* Top-Left Player Status Card */
#hud-top-left {
  position: absolute;
  top: 10px;
  left: 12px;
  z-index: 16;
  width: min(304px, 44vw);
  padding: 7px 10px;
  border-radius: 14px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.hud-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
}

.hud-player-badge {
  display: flex;
  align-items: center;
  gap: 6px;
  font-weight: 700;
  font-size: 11.5px;
  letter-spacing: 0.01em;
  min-width: 0;
}

.hud-player-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.hud-avatar-dot {
  width: 19px;
  height: 19px;
  border-radius: 7px;
  background: linear-gradient(135deg, #2dd4bf, #0ea5e9);
  border: 1px solid rgba(255, 255, 255, 0.45);
  display: grid;
  place-items: center;
  font-size: 10px;
  font-weight: 800;
  color: #062133;
  box-shadow: 0 0 10px rgba(45, 212, 191, 0.45);
  flex-shrink: 0;
}

.hud-top-pills {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex-shrink: 0;
}

.hud-crystal-pill {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 7px;
  border-radius: 999px;
  background: rgba(20, 184, 166, 0.18);
  border: 1px solid rgba(94, 234, 212, 0.4);
  font-size: 10.5px;
  font-weight: 700;
  color: #a7f3d0;
}

.hud-crystal-gem {
  width: 7px;
  height: 7px;
  transform: rotate(45deg);
  background: linear-gradient(135deg, #99f6e4, #22d3ee);
  box-shadow: 0 0 8px #5eead4;
}

/* HP + Stamina + Hunger bars */
.hud-bars-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 4px 8px;
  align-items: center;
}

.hud-bar-wrap {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
}

.hud-bar-label {
  font-size: 9px;
  font-weight: 800;
  letter-spacing: 0.02em;
  color: rgba(196, 224, 245, 0.88);
  flex-shrink: 0;
}

.hud-bar-track {
  flex: 1;
  min-width: 34px;
  height: 6.5px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.12);
  overflow: hidden;
  border: 1px solid rgba(255, 255, 255, 0.1);
}

#hud-hp-fill {
  width: 100%;
  height: 100%;
  border-radius: 999px;
  background: linear-gradient(90deg, #10b981, #34d399);
  box-shadow: 0 0 8px rgba(52, 211, 153, 0.55);
  transition: width 0.1s ease-out, background 0.18s ease;
}

#hud-hp-text,
#hud-hunger-text {
  font-size: 9px;
  font-weight: 800;
  font-variant-numeric: tabular-nums;
  color: #d1fae5;
  flex-shrink: 0;
}

#hud-hunger-text {
  color: #fde68a;
}

#hud-stamina-fill {
  width: 100%;
  height: 100%;
  border-radius: 999px;
  background: linear-gradient(90deg, #2dd4bf, #38bdf8);
  box-shadow: 0 0 8px rgba(56, 189, 248, 0.55);
  transition: width 0.08s linear, background 0.18s ease;
}

#hud-hunger-fill {
  width: 100%;
  height: 100%;
  border-radius: 999px;
  background: linear-gradient(90deg, #f59e0b, #fbbf24);
  box-shadow: 0 0 7px rgba(251, 191, 36, 0.45);
  transition: width 0.12s linear, background 0.18s ease;
}

#hud-tool-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 1.5px 7px;
  border-radius: 999px;
  font-size: 9px;
  font-weight: 800;
  background: rgba(16, 185, 129, 0.18);
  border: 1px solid rgba(52, 211, 153, 0.42);
  color: #a7f3d0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.hud-meta-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 5px;
  font-size: 9.5px;
  color: rgba(212, 232, 248, 0.85);
}

.hud-resource-badges {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
}

.hud-res-badge {
  padding: 1.5px 6px;
  border-radius: 999px;
  font-size: 9px;
  font-weight: 800;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

#hud-spheres-badge {
  background: rgba(14, 165, 233, 0.2);
  border: 1px solid rgba(56, 189, 248, 0.42);
  color: #bae6fd;
}

#hud-spheres-badge.empty {
  background: rgba(239, 68, 68, 0.2);
  border-color: rgba(248, 113, 113, 0.5);
  color: #fecaca;
}

#hud-loot-badge {
  background: rgba(245, 158, 11, 0.18);
  border: 1px solid rgba(251, 191, 36, 0.4);
  color: #fde68a;
}

#hud-state-pill {
  padding: 1.5px 6px;
  border-radius: 999px;
  font-size: 9px;
  font-weight: 800;
  letter-spacing: 0.02em;
  background: rgba(56, 189, 248, 0.2);
  border: 1px solid rgba(125, 211, 252, 0.35);
  color: #bae6fd;
}

#hud-coords {
  font-variant-numeric: tabular-nums;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 9px;
  color: rgba(203, 226, 244, 0.82);
  white-space: nowrap;
}

/* Top-Center Shared Resource & Quick Action Bar */
#hud-resource-bar {
  position: absolute;
  top: 44px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 20;
  width: min(560px, calc(100vw - 650px));
  min-width: 280px;
  padding: 5px 8px;
  border-radius: 13px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  pointer-events: auto;
  touch-action: manipulation;
}

.hud-res-row {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-wrap: wrap;
  gap: 4px;
  width: 100%;
}

.hud-res-chip {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 1.5px 6px;
  border-radius: 999px;
  background: rgba(15, 34, 52, 0.72);
  border: 1px solid rgba(125, 211, 252, 0.24);
  font-size: 9.5px;
  font-weight: 700;
  color: #dbeafe;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.hud-res-chip-val {
  color: #6ee7b7;
  font-weight: 800;
}

.hud-quick-row {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  width: 100%;
}

.hud-quick-btn {
  pointer-events: auto;
  touch-action: manipulation;
  border: 1px solid rgba(125, 211, 252, 0.34);
  background: rgba(14, 116, 144, 0.24);
  color: #e0f2fe;
  border-radius: 8px;
  padding: 3px 8px;
  font-size: 10px;
  font-weight: 800;
  cursor: pointer;
  white-space: nowrap;
  transition: background 0.12s ease, border-color 0.12s ease, transform 0.08s ease;
}

.hud-quick-btn:hover {
  border-color: rgba(94, 234, 212, 0.7);
}

.hud-quick-btn.active,
.hud-quick-btn.pressed {
  background: linear-gradient(135deg, rgba(20, 184, 166, 0.5), rgba(14, 165, 233, 0.44));
  border-color: rgba(94, 234, 212, 0.92);
  color: #ffffff;
  box-shadow: 0 0 12px rgba(45, 212, 191, 0.38);
}

/* Top-Center Target Lock-On Banner */
#hud-target-banner {
  position: absolute;
  top: 104px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 18;
  width: min(312px, calc(100vw - 610px));
  min-width: 210px;
  padding: 6px 10px;
  border-radius: 13px;
  display: none;
  flex-direction: column;
  gap: 4px;
  pointer-events: none;
}

#hud-target-banner.visible {
  display: flex;
}

.hud-target-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
}

.hud-target-id {
  display: flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
}

#hud-target-species-badge {
  padding: 1.5px 6px;
  border-radius: 999px;
  font-size: 9px;
  font-weight: 900;
  letter-spacing: 0.05em;
  border: 1px solid transparent;
  flex-shrink: 0;
}

#hud-target-name {
  font-size: 11.5px;
  font-weight: 800;
  color: #f8fafc;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.hud-target-chips {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}

#hud-target-ai-chip {
  padding: 1.5px 6px;
  border-radius: 999px;
  font-size: 9px;
  font-weight: 800;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  background: rgba(148, 163, 184, 0.22);
  border: 1px solid rgba(148, 163, 184, 0.42);
  color: #e2e8f0;
}

#hud-target-ai-chip.aggressive {
  background: rgba(239, 68, 68, 0.24);
  border-color: rgba(248, 113, 113, 0.56);
  color: #fecaca;
}

#hud-target-ai-chip.capturing {
  background: rgba(20, 184, 166, 0.28);
  border-color: rgba(94, 234, 212, 0.72);
  color: #99f6e4;
}

#hud-target-capture-chip {
  padding: 1.5px 6px;
  border-radius: 999px;
  font-size: 9.5px;
  font-weight: 800;
  font-variant-numeric: tabular-nums;
  background: rgba(16, 185, 129, 0.22);
  border: 1px solid rgba(52, 211, 153, 0.52);
  color: #a7f3d0;
}

.hud-target-bar-row {
  display: flex;
  align-items: center;
  gap: 7px;
}

.hud-target-hp-track {
  flex: 1;
  height: 6px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.14);
  overflow: hidden;
  border: 1px solid rgba(255, 255, 255, 0.12);
}

#hud-target-hp-fill {
  width: 100%;
  height: 100%;
  border-radius: 999px;
  background: linear-gradient(90deg, #10b981, #34d399);
  transition: width 0.08s linear, background 0.15s ease;
}

#hud-target-hp-text {
  font-size: 9.5px;
  font-weight: 800;
  font-variant-numeric: tabular-nums;
  color: #e2e8f0;
  white-space: nowrap;
}

/* Companion Party Strip */
#hud-companion-strip {
  position: absolute;
  top: 128px;
  left: 12px;
  z-index: 16;
  max-width: min(304px, 44vw);
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 5px;
  pointer-events: none;
}

.hud-comp-empty {
  padding: 4px 9px;
  border-radius: 999px;
  font-size: 10px;
  font-weight: 700;
  color: rgba(203, 226, 244, 0.78);
  pointer-events: none;
}

.hud-comp-chip {
  pointer-events: auto;
  touch-action: manipulation;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 8px;
  border-radius: 11px;
  color: #eef7ff;
  font-size: 10px;
  font-weight: 700;
  cursor: pointer;
  background: linear-gradient(145deg, rgba(11, 24, 38, 0.76), rgba(7, 15, 26, 0.64));
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  border: 1px solid rgba(130, 224, 245, 0.28);
  box-shadow: 0 4px 12px rgba(2, 8, 18, 0.36);
  transition: transform 0.08s ease, border-color 0.14s ease, box-shadow 0.14s ease;
}

.hud-comp-chip:hover {
  border-color: rgba(94, 234, 212, 0.65);
}

.hud-comp-chip.selected {
  border-color: rgba(125, 211, 252, 0.85);
}

.hud-comp-chip.active {
  border-color: rgba(52, 211, 153, 0.92);
  background: linear-gradient(145deg, rgba(16, 62, 56, 0.82), rgba(8, 32, 36, 0.74));
  box-shadow: 0 0 14px rgba(52, 211, 153, 0.36);
}

.hud-comp-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
}

.hud-comp-meta {
  display: flex;
  flex-direction: column;
  gap: 2px;
  align-items: flex-start;
  line-height: 1.05;
}

.hud-comp-title {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  white-space: nowrap;
}

.hud-comp-hp-track {
  width: 44px;
  height: 3.5px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.16);
  overflow: hidden;
}

.hud-comp-hp-fill {
  height: 100%;
  border-radius: 999px;
  background: #34d399;
}

.hud-comp-badge {
  padding: 1px 4px;
  border-radius: 999px;
  font-size: 8.5px;
  font-weight: 800;
  letter-spacing: 0.04em;
  background: rgba(255, 255, 255, 0.1);
  color: #cbd5e1;
}

.hud-comp-chip.active .hud-comp-badge {
  background: rgba(16, 185, 129, 0.34);
  color: #a7f3d0;
}

/* Compact Co-op Status Pill Button */
#hud-coop-btn {
  position: absolute;
  top: 10px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 26;
  pointer-events: auto;
  touch-action: manipulation;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 11px;
  border-radius: 999px;
  color: #eef8ff;
  font-size: 11px;
  font-weight: 800;
  letter-spacing: 0.03em;
  cursor: pointer;
  white-space: nowrap;
  max-width: min(290px, calc(100vw - 550px));
  transition: border-color 0.16s ease, box-shadow 0.16s ease, transform 0.1s ease;
}

#hud-coop-btn:hover {
  border-color: rgba(94, 234, 212, 0.65);
}

#hud-coop-btn.open {
  border-color: rgba(94, 234, 212, 0.88);
  box-shadow: 0 0 18px rgba(45, 212, 191, 0.35);
}

#hud-coop-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
  background: #94a3b8;
  box-shadow: 0 0 6px rgba(148, 163, 184, 0.5);
}

#hud-coop-dot.connected {
  background: #34d399;
  box-shadow: 0 0 9px rgba(52, 211, 153, 0.88);
}

#hud-coop-dot.syncing {
  background: #fbbf24;
  box-shadow: 0 0 9px rgba(251, 191, 36, 0.85);
  animation: coopPulse 1.1s ease-in-out infinite;
}

@keyframes coopPulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.45; transform: scale(0.84); }
}

#hud-coop-label {
  font-variant-numeric: tabular-nums;
  overflow: hidden;
  text-overflow: ellipsis;
}

#hud-coop-code-badge {
  display: none;
  padding: 1px 6px;
  border-radius: 999px;
  background: rgba(45, 212, 191, 0.2);
  border: 1px solid rgba(94, 234, 212, 0.42);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 10px;
  font-weight: 800;
  color: #99f6e4;
}

#hud-coop-code-badge.visible {
  display: inline-block;
}

.hud-coop-slots {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  flex-shrink: 0;
}

.hud-coop-slot-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.16);
  border: 1px solid rgba(255, 255, 255, 0.25);
  transition: transform 0.15s ease, opacity 0.15s ease;
}

.hud-coop-slot-dot.active {
  border-color: rgba(255, 255, 255, 0.72);
  transform: scale(1.08);
}

.hud-coop-slot-dot.reconnecting {
  opacity: 0.52;
  animation: coopPulse 1.1s ease-in-out infinite;
}

/* Co-op Glassmorphic Modal */
#hud-coop-modal {
  position: absolute;
  top: 52px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 30;
  display: none;
  flex-direction: column;
  gap: 8px;
  width: min(376px, calc(100vw - 32px));
  max-height: calc(100vh - 96px);
  overflow-y: auto;
  padding: 11px 13px;
  border-radius: 16px;
  pointer-events: auto;
  touch-action: manipulation;
  box-shadow: 0 14px 36px rgba(2, 8, 18, 0.58), inset 0 1px 0 rgba(255, 255, 255, 0.14);
}

#hud-coop-modal.open {
  display: flex;
}

#hud-coop-modal input {
  user-select: text;
  -webkit-user-select: text;
  touch-action: manipulation;
}

.coop-modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.coop-modal-title-wrap {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 12.5px;
  font-weight: 800;
  color: #e0f2fe;
}

#coop-modal-state-tag {
  padding: 2px 7px;
  border-radius: 999px;
  font-size: 9.5px;
  font-weight: 800;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  background: rgba(148, 163, 184, 0.22);
  border: 1px solid rgba(148, 163, 184, 0.4);
  color: #cbd5e1;
}

#coop-modal-state-tag.connected {
  background: rgba(16, 185, 129, 0.22);
  border-color: rgba(52, 211, 153, 0.55);
  color: #a7f3d0;
}

#coop-modal-state-tag.syncing {
  background: rgba(245, 158, 11, 0.24);
  border-color: rgba(251, 191, 36, 0.58);
  color: #fde68a;
}

#coop-modal-close {
  border: 1px solid rgba(255, 255, 255, 0.18);
  background: rgba(255, 255, 255, 0.08);
  color: #e2e8f0;
  width: 24px;
  height: 24px;
  border-radius: 8px;
  font-size: 13px;
  font-weight: 800;
  line-height: 1;
  cursor: pointer;
  display: grid;
  place-items: center;
}

.coop-controls-block {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.coop-controls-block.hidden {
  display: none;
}

.coop-input-row {
  display: flex;
  align-items: center;
  gap: 6px;
}

.coop-text-input {
  flex: 1;
  min-width: 0;
  height: 31px;
  padding: 0 9px;
  border-radius: 9px;
  border: 1px solid rgba(130, 224, 245, 0.28);
  background: rgba(6, 15, 26, 0.72);
  color: #f8fafc;
  font-size: 12px;
  font-weight: 600;
  outline: none;
}

.coop-text-input:focus {
  border-color: rgba(94, 234, 212, 0.85);
  box-shadow: 0 0 0 2px rgba(45, 212, 191, 0.18);
}

#coop-code-input {
  text-transform: uppercase;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  letter-spacing: 0.08em;
}

.coop-btn {
  height: 31px;
  padding: 0 11px;
  border-radius: 9px;
  border: 1px solid rgba(130, 224, 245, 0.32);
  background: rgba(14, 165, 233, 0.22);
  color: #e0f2fe;
  font-size: 11.5px;
  font-weight: 800;
  cursor: pointer;
  white-space: nowrap;
  transition: background 0.14s ease, border-color 0.14s ease, opacity 0.14s ease;
}

.coop-btn:disabled {
  opacity: 0.5;
  cursor: default;
}

.coop-btn.primary {
  background: linear-gradient(135deg, rgba(20, 184, 166, 0.45), rgba(14, 165, 233, 0.42));
  border-color: rgba(94, 234, 212, 0.72);
  color: #ffffff;
}

.coop-btn.danger {
  background: rgba(239, 68, 68, 0.22);
  border-color: rgba(248, 113, 113, 0.55);
  color: #fecaca;
}

.coop-active-room-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  padding: 6px 8px;
  border-radius: 10px;
  background: rgba(15, 36, 56, 0.6);
  border: 1px solid rgba(94, 234, 212, 0.3);
}

.coop-room-code-wrap {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.coop-room-code-label {
  font-size: 10px;
  font-weight: 700;
  color: rgba(186, 230, 253, 0.78);
}

#coop-room-code-display {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 13px;
  font-weight: 800;
  letter-spacing: 0.08em;
  color: #99f6e4;
}

.coop-active-actions {
  display: flex;
  align-items: center;
  gap: 5px;
  flex-shrink: 0;
}

#coop-error-msg {
  display: none;
  padding: 5px 8px;
  border-radius: 8px;
  font-size: 11px;
  font-weight: 700;
  line-height: 1.3;
  background: rgba(239, 68, 68, 0.2);
  border: 1px solid rgba(248, 113, 113, 0.52);
  color: #fecaca;
}

#coop-error-msg.visible {
  display: block;
}

#coop-error-msg.warning {
  background: rgba(245, 158, 11, 0.2);
  border-color: rgba(251, 191, 36, 0.52);
  color: #fde68a;
}

#coop-party-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.coop-party-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 5px 8px;
  border-radius: 9px;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(148, 213, 255, 0.14);
  font-size: 11px;
}

.coop-party-row.empty {
  opacity: 0.56;
}

.coop-party-row.reconnecting {
  border-style: dashed;
  border-color: rgba(251, 191, 36, 0.55);
}

.coop-party-left {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.coop-slot-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 22px;
  height: 18px;
  padding: 0 5px;
  border-radius: 6px;
  font-size: 10px;
  font-weight: 800;
  color: #051824;
  flex-shrink: 0;
}

.coop-party-name {
  font-weight: 700;
  color: #f1f5f9;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.coop-party-right {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}

.coop-party-state {
  padding: 1px 6px;
  border-radius: 999px;
  font-size: 9.5px;
  font-weight: 800;
  letter-spacing: 0.04em;
  background: rgba(56, 189, 248, 0.18);
  border: 1px solid rgba(125, 211, 252, 0.34);
  color: #bae6fd;
}

.coop-party-state.reconnecting {
  background: rgba(245, 158, 11, 0.22);
  border-color: rgba(251, 191, 36, 0.52);
  color: #fde68a;
}

.coop-party-state.empty {
  background: rgba(148, 163, 184, 0.15);
  border-color: rgba(148, 163, 184, 0.28);
  color: #94a3b8;
}

#coop-net-stats {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-variant-numeric: tabular-nums;
  font-size: 10px;
  color: rgba(186, 230, 253, 0.85);
  padding-top: 2px;
  border-top: 1px solid rgba(148, 213, 255, 0.14);
}

/* Top-Right Performance, Quality, Audio & Expansion Cluster */
#hud-top-right {
  position: absolute;
  top: 10px;
  right: 12px;
  z-index: 16;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 6px;
  max-width: min(335px, 49vw);
}

#hud-perf-card {
  padding: 8px 10px;
  border-radius: 14px;
  display: flex;
  flex-direction: column;
  gap: 5px;
  pointer-events: auto;
  width: 100%;
}

.hud-perf-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 5px;
  flex-wrap: nowrap;
}

.hud-perf-badges {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
}

#hud-fps-badge {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 2px 7px;
  border-radius: 999px;
  font-size: 10.5px;
  font-weight: 800;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  background: rgba(16, 185, 129, 0.2);
  border: 1px solid rgba(52, 211, 153, 0.5);
  color: #a7f3d0;
}

#hud-fps-badge.fps-warn {
  background: rgba(245, 158, 11, 0.22);
  border-color: rgba(251, 191, 36, 0.55);
  color: #fde68a;
}

#hud-fps-badge.fps-low {
  background: rgba(239, 68, 68, 0.24);
  border-color: rgba(248, 113, 113, 0.6);
  color: #fecaca;
}

#hud-tier-pill {
  padding: 2px 6px;
  border-radius: 999px;
  font-size: 9.5px;
  font-weight: 800;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  white-space: nowrap;
  background: rgba(99, 102, 241, 0.22);
  border: 1px solid rgba(165, 180, 252, 0.4);
  color: #e0e7ff;
}

#btn-mute {
  border: 1px solid rgba(125, 211, 252, 0.36);
  background: rgba(14, 165, 233, 0.18);
  color: #e0f2fe;
  border-radius: 8px;
  padding: 2px 7px;
  font-size: 11px;
  font-weight: 800;
  line-height: 1.2;
  cursor: pointer;
  flex-shrink: 0;
  touch-action: manipulation;
  transition: background 0.14s ease, border-color 0.14s ease;
}

#btn-mute.muted {
  background: rgba(239, 68, 68, 0.22);
  border-color: rgba(248, 113, 113, 0.55);
  color: #fecaca;
}

.hud-quality-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 4px;
}

.hud-quality-btns {
  display: flex;
  gap: 3px;
}

.hud-q-btn {
  border: 1px solid rgba(255, 255, 255, 0.16);
  background: rgba(255, 255, 255, 0.06);
  color: rgba(226, 240, 252, 0.85);
  border-radius: 7px;
  padding: 3px 7px;
  font-size: 10.5px;
  font-weight: 700;
  cursor: pointer;
  transition: background 0.14s ease, border-color 0.14s ease, color 0.14s ease;
}

.hud-q-btn.active {
  background: linear-gradient(135deg, rgba(45, 212, 191, 0.34), rgba(14, 165, 233, 0.32));
  border-color: rgba(110, 244, 224, 0.72);
  color: #ffffff;
  box-shadow: 0 0 10px rgba(45, 212, 191, 0.28);
}

#hud-expansion-toggle {
  border: 1px solid rgba(125, 211, 252, 0.32);
  background: rgba(14, 165, 233, 0.16);
  color: #bae6fd;
  border-radius: 7px;
  padding: 3px 7px;
  font-size: 10px;
  font-weight: 700;
  cursor: pointer;
  white-space: nowrap;
}

.hud-sens-row {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 10px;
  color: rgba(203, 226, 244, 0.84);
}

#hud-sens-slider {
  flex: 1;
  min-width: 68px;
  accent-color: #2dd4bf;
  cursor: pointer;
  height: 4px;
}

#hud-sens-value {
  font-variant-numeric: tabular-nums;
  font-weight: 700;
  min-width: 30px;
  text-align: right;
  color: #99f6e4;
}

/* Expansion Ready Drawer */
#hud-expansion-drawer {
  display: none;
  width: 100%;
  padding: 9px 11px;
  border-radius: 13px;
  pointer-events: auto;
  font-size: 11px;
  line-height: 1.38;
  flex-direction: column;
  gap: 7px;
  max-height: 50vh;
  overflow-y: auto;
}

#hud-expansion-drawer.open {
  display: flex;
}

.hud-exp-item {
  padding: 6px 8px;
  border-radius: 9px;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(148, 213, 255, 0.15);
}

.hud-exp-title {
  display: flex;
  justify-content: space-between;
  font-weight: 700;
  font-size: 11px;
  color: #a5f3fc;
  margin-bottom: 2px;
}

.hud-exp-badge {
  font-size: 9.5px;
  padding: 1px 6px;
  border-radius: 999px;
  background: rgba(16, 185, 129, 0.22);
  color: #6ee7b7;
}

.hud-exp-detail {
  color: rgba(215, 232, 246, 0.78);
  font-size: 10px;
}

/* Bottom-Left Dynamic Virtual Joystick */
#joystick-zone {
  position: absolute;
  left: 10px;
  bottom: 10px;
  z-index: 16;
  width: clamp(132px, 24vw, 188px);
  height: clamp(124px, 32vh, 176px);
  pointer-events: auto;
  touch-action: none;
}

#joystick-ring {
  position: fixed;
  width: 108px;
  height: 108px;
  border-radius: 50%;
  background: radial-gradient(circle, rgba(255, 255, 255, 0.03) 40%, rgba(125, 211, 252, 0.14) 100%);
  border: 1.5px solid rgba(148, 224, 245, 0.36);
  box-shadow: 0 0 18px rgba(14, 165, 233, 0.15), inset 0 0 12px rgba(255, 255, 255, 0.06);
  transform: translate(-50%, -50%);
  pointer-events: none;
  opacity: 0.58;
  transition: opacity 0.14s ease, border-color 0.14s ease;
}

#joystick-ring.active {
  opacity: 0.96;
  border-color: rgba(94, 234, 212, 0.78);
  box-shadow: 0 0 24px rgba(45, 212, 191, 0.35), inset 0 0 16px rgba(94, 234, 212, 0.14);
}

#joystick-ring.auto-sprint {
  border-color: rgba(251, 191, 36, 0.9);
  box-shadow: 0 0 26px rgba(245, 158, 11, 0.42), inset 0 0 16px rgba(251, 191, 36, 0.18);
}

#joystick-knob {
  position: fixed;
  width: 44px;
  height: 44px;
  border-radius: 50%;
  background: radial-gradient(circle at 35% 30%, #d8fff9 0%, #2dd4bf 55%, #0284c7 100%);
  border: 1.5px solid rgba(255, 255, 255, 0.75);
  box-shadow: 0 4px 16px rgba(14, 165, 233, 0.55);
  transform: translate(-50%, -50%);
  pointer-events: none;
  opacity: 0.78;
}

#joystick-knob.active {
  opacity: 1;
  box-shadow: 0 0 22px rgba(94, 234, 212, 0.85);
}

#joystick-knob.auto-sprint {
  background: radial-gradient(circle at 35% 30%, #fef9c3 0%, #fbbf24 58%, #ea580c 100%);
  box-shadow: 0 0 24px rgba(251, 191, 36, 0.9);
}

/* Bottom-Right Combat & Movement Action Cluster */
#hud-action-pad {
  position: absolute;
  right: 16px;
  bottom: 14px;
  z-index: 16;
  width: 212px;
  height: 214px;
  pointer-events: none;
}

.hud-touch-btn {
  position: absolute;
  pointer-events: auto;
  touch-action: none;
  border-radius: 50%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 1px;
  color: #f0f9ff;
  font-weight: 800;
  letter-spacing: 0.03em;
  line-height: 1;
  cursor: pointer;
  background: linear-gradient(145deg, rgba(16, 36, 56, 0.76), rgba(9, 20, 34, 0.66));
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  border: 1.5px solid rgba(148, 224, 245, 0.4);
  box-shadow: 0 8px 22px rgba(2, 10, 20, 0.42), inset 0 1px 0 rgba(255, 255, 255, 0.16);
  transition: transform 0.08s ease, border-color 0.12s ease, box-shadow 0.12s ease, background 0.12s ease, opacity 0.14s ease;
}

.hud-touch-btn.pressed {
  transform: scale(0.92);
  border-color: rgba(110, 244, 224, 0.95);
  box-shadow: 0 0 20px rgba(45, 212, 191, 0.65);
}

.hud-btn-icon {
  font-size: 14px;
  line-height: 1;
}

.hud-btn-sub {
  font-size: 8.5px;
  font-weight: 800;
  opacity: 0.82;
}

/* Primary melee thumb target + radial combat arc */
#btn-melee {
  right: 6px;
  bottom: 6px;
  width: 72px;
  height: 72px;
  font-size: 10.5px;
  background: linear-gradient(145deg, rgba(244, 63, 94, 0.42), rgba(190, 18, 60, 0.34));
  border-color: rgba(253, 164, 175, 0.78);
  box-shadow: 0 8px 24px rgba(190, 18, 60, 0.36), inset 0 1px 0 rgba(255, 255, 255, 0.22);
}

#btn-melee .hud-btn-icon {
  font-size: 18px;
}

#btn-jump {
  right: 2px;
  bottom: 88px;
  width: 58px;
  height: 58px;
  font-size: 9.5px;
  border-color: rgba(94, 234, 212, 0.56);
}

#btn-dodge {
  right: 88px;
  bottom: 4px;
  width: 56px;
  height: 56px;
  font-size: 9px;
  background: linear-gradient(145deg, rgba(16, 185, 129, 0.34), rgba(6, 95, 70, 0.34));
  border-color: rgba(110, 231, 183, 0.65);
}

#btn-ranged {
  right: 76px;
  bottom: 70px;
  width: 56px;
  height: 56px;
  font-size: 9px;
  background: linear-gradient(145deg, rgba(14, 165, 233, 0.38), rgba(29, 78, 216, 0.32));
  border-color: rgba(125, 211, 252, 0.68);
}

#btn-capture {
  right: 62px;
  bottom: 136px;
  width: 54px;
  height: 54px;
  font-size: 9px;
  background: linear-gradient(145deg, rgba(245, 158, 11, 0.34), rgba(180, 83, 9, 0.3));
  border-color: rgba(252, 211, 77, 0.62);
}

#btn-capture.can-capture {
  border-color: rgba(110, 231, 183, 0.95);
  box-shadow: 0 0 18px rgba(52, 211, 153, 0.65);
}

#btn-interact {
  right: 2px;
  bottom: 156px;
  width: 52px;
  height: 52px;
  font-size: 9px;
  opacity: 0.74;
}

#btn-interact.near-crystal {
  opacity: 1;
  background: linear-gradient(145deg, rgba(20, 184, 166, 0.58), rgba(6, 182, 212, 0.45));
  border-color: rgba(153, 246, 228, 0.96);
  box-shadow: 0 0 22px rgba(45, 212, 191, 0.78);
  animation: hudInteractPulse 1.3s ease-in-out infinite;
}

#btn-sprint {
  right: 154px;
  bottom: 6px;
  width: 52px;
  height: 52px;
  font-size: 9px;
}

#btn-sprint.sprint-on {
  background: linear-gradient(145deg, rgba(245, 158, 11, 0.45), rgba(217, 119, 6, 0.36));
  border-color: rgba(252, 211, 77, 0.9);
  box-shadow: 0 0 18px rgba(245, 158, 11, 0.52);
  color: #fef3c7;
}

#btn-summon {
  right: 144px;
  bottom: 72px;
  width: 52px;
  height: 52px;
  font-size: 8.5px;
  background: linear-gradient(145deg, rgba(139, 92, 246, 0.36), rgba(91, 33, 182, 0.3));
  border-color: rgba(196, 181, 253, 0.64);
}

#btn-summon.companion-active {
  background: linear-gradient(145deg, rgba(20, 184, 166, 0.48), rgba(59, 130, 246, 0.36));
  border-color: rgba(94, 234, 212, 0.92);
  box-shadow: 0 0 16px rgba(45, 212, 191, 0.55);
}

#btn-summon.empty-roster {
  opacity: 0.58;
}

@keyframes hudInteractPulse {
  0%, 100% { transform: scale(1); }
  50% { transform: scale(1.06); }
}

/* Nearby prompt, survival context & toast */
#hud-nearby-hint,
#hud-survival-context {
  position: absolute;
  bottom: 24px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 22;
  padding: 5px 13px;
  border-radius: 999px;
  font-size: 11.5px;
  font-weight: 700;
  color: #ccfbf1;
  border-color: rgba(94, 234, 212, 0.6);
  display: none;
  white-space: nowrap;
  max-width: min(400px, calc(100vw - 440px));
  overflow: hidden;
  text-overflow: ellipsis;
  pointer-events: none;
}

#hud-survival-context {
  color: #fef3c7;
  border-color: rgba(251, 191, 36, 0.55);
}

#hud-nearby-hint.visible,
#hud-survival-context.visible {
  display: block;
}

#zaap-hud.build-mode-active #hud-nearby-hint,
#zaap-hud.build-mode-active #hud-survival-context {
  bottom: 98px;
}

/* Phase 4 Survival Drawers (Craft & Base Worker) */
.hud-survival-drawer {
  position: absolute;
  top: 102px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 28;
  display: none;
  flex-direction: column;
  gap: 8px;
  width: min(472px, calc(100vw - 440px));
  max-height: calc(100vh - 196px);
  overflow-y: auto;
  padding: 10px 12px;
  border-radius: 15px;
  pointer-events: auto;
  touch-action: manipulation;
  box-shadow: 0 14px 36px rgba(2, 8, 18, 0.62), inset 0 1px 0 rgba(255, 255, 255, 0.14);
}

.hud-survival-drawer.open {
  display: flex;
}

.hud-drawer-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding-bottom: 4px;
  border-bottom: 1px solid rgba(148, 213, 255, 0.16);
}

.hud-drawer-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 800;
  color: #e0f2fe;
}

.hud-drawer-badge {
  padding: 2px 7px;
  border-radius: 999px;
  font-size: 9.5px;
  font-weight: 800;
  background: rgba(20, 184, 166, 0.22);
  border: 1px solid rgba(94, 234, 212, 0.45);
  color: #99f6e4;
}

.hud-drawer-badge.warn {
  background: rgba(245, 158, 11, 0.22);
  border-color: rgba(251, 191, 36, 0.48);
  color: #fde68a;
}

.hud-drawer-close {
  border: 1px solid rgba(255, 255, 255, 0.18);
  background: rgba(255, 255, 255, 0.08);
  color: #e2e8f0;
  width: 24px;
  height: 24px;
  border-radius: 8px;
  font-size: 13px;
  font-weight: 800;
  line-height: 1;
  cursor: pointer;
  display: grid;
  place-items: center;
}

.hud-drawer-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.hud-drawer-card {
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 7px 9px;
  border-radius: 10px;
  background: rgba(15, 32, 50, 0.68);
  border: 1px solid rgba(125, 211, 252, 0.2);
}

.hud-drawer-card-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
}

.hud-drawer-card-title {
  font-size: 11.5px;
  font-weight: 800;
  color: #f0f9ff;
}

.hud-drawer-card-sub {
  font-size: 9.5px;
  color: rgba(203, 226, 244, 0.8);
}

.hud-drawer-chips {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
}

.hud-cost-chip {
  padding: 1.5px 6px;
  border-radius: 999px;
  font-size: 9.5px;
  font-weight: 700;
  background: rgba(16, 185, 129, 0.18);
  border: 1px solid rgba(52, 211, 153, 0.42);
  color: #a7f3d0;
}

.hud-cost-chip.missing {
  background: rgba(239, 68, 68, 0.18);
  border-color: rgba(248, 113, 113, 0.48);
  color: #fecaca;
}

.hud-wb-chip {
  padding: 1.5px 6px;
  border-radius: 999px;
  font-size: 9px;
  font-weight: 800;
  background: rgba(245, 158, 11, 0.2);
  border: 1px solid rgba(251, 191, 36, 0.45);
  color: #fde68a;
}

.hud-wb-chip.ok {
  background: rgba(14, 165, 233, 0.2);
  border-color: rgba(56, 189, 248, 0.45);
  color: #bae6fd;
}

.hud-drawer-actions {
  display: flex;
  align-items: center;
  gap: 5px;
  flex-shrink: 0;
}

.hud-mini-btn {
  padding: 4px 9px;
  border-radius: 8px;
  border: 1px solid rgba(94, 234, 212, 0.55);
  background: rgba(20, 184, 166, 0.28);
  color: #ecfeff;
  font-size: 10px;
  font-weight: 800;
  cursor: pointer;
  white-space: nowrap;
}

.hud-mini-btn.secondary {
  border-color: rgba(125, 211, 252, 0.45);
  background: rgba(14, 165, 233, 0.24);
}

.hud-mini-btn.equipped,
.hud-mini-btn.active {
  border-color: rgba(52, 211, 153, 0.9);
  background: rgba(16, 185, 129, 0.44);
  color: #ffffff;
}

.hud-mini-btn.unavailable {
  opacity: 0.56;
  border-color: rgba(148, 163, 184, 0.36);
  background: rgba(100, 116, 139, 0.22);
}

.hud-mini-btn.danger {
  border-color: rgba(248, 113, 113, 0.55);
  background: rgba(239, 68, 68, 0.24);
  color: #fecaca;
}

.hud-worker-energy-row {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 9.5px;
  color: #cbd5e1;
}

.hud-worker-energy-track {
  flex: 1;
  height: 5px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.14);
  overflow: hidden;
}

.hud-worker-energy-fill {
  height: 100%;
  border-radius: 999px;
  background: linear-gradient(90deg, #38bdf8, #34d399);
}

.hud-drawer-section-label {
  font-size: 10px;
  font-weight: 800;
  color: #93c5fd;
  letter-spacing: 0.03em;
  margin-top: 2px;
}

/* Phase 4 Modular Build Dock (Bottom-Center, strictly clear of joystick & action pad) */
#hud-build-dock {
  position: absolute;
  bottom: 10px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 24;
  width: min(500px, calc(100vw - 440px));
  min-width: 240px;
  padding: 6px 8px;
  border-radius: 14px;
  display: none;
  flex-direction: column;
  gap: 5px;
  pointer-events: auto;
  touch-action: manipulation;
}

#hud-build-dock.visible {
  display: flex;
}

.hud-build-recipes {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: center;
  gap: 3px;
}

.hud-build-pill {
  padding: 3px 6px;
  border-radius: 8px;
  border: 1px solid rgba(125, 211, 252, 0.28);
  background: rgba(15, 34, 54, 0.72);
  color: #dbeafe;
  font-size: 9.5px;
  font-weight: 800;
  cursor: pointer;
  white-space: nowrap;
}

.hud-build-pill.active {
  background: linear-gradient(135deg, rgba(20, 184, 166, 0.52), rgba(14, 165, 233, 0.45));
  border-color: rgba(94, 234, 212, 0.92);
  color: #ffffff;
  box-shadow: 0 0 10px rgba(45, 212, 191, 0.35);
}

.hud-build-pill.insufficient {
  opacity: 0.64;
}

.hud-build-controls {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 5px;
  flex-wrap: wrap;
}

#hud-build-status {
  padding: 2px 7px;
  border-radius: 999px;
  font-size: 9.5px;
  font-weight: 800;
  background: rgba(16, 185, 129, 0.2);
  border: 1px solid rgba(52, 211, 153, 0.52);
  color: #a7f3d0;
  white-space: nowrap;
}

#hud-build-status.invalid {
  background: rgba(239, 68, 68, 0.22);
  border-color: rgba(248, 113, 113, 0.56);
  color: #fecaca;
}

.hud-build-btns {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}

.hud-build-action-btn {
  padding: 4px 8px;
  border-radius: 8px;
  border: 1px solid rgba(125, 211, 252, 0.4);
  background: rgba(14, 116, 144, 0.32);
  color: #f0f9ff;
  font-size: 10px;
  font-weight: 800;
  cursor: pointer;
  white-space: nowrap;
}

#btn-build-place.valid {
  border-color: rgba(52, 211, 153, 0.9);
  background: rgba(16, 185, 129, 0.44);
  color: #ffffff;
}

#btn-build-place.invalid {
  border-color: rgba(248, 113, 113, 0.55);
  background: rgba(239, 68, 68, 0.22);
  color: #fecaca;
}

#btn-build-demolish {
  border-color: rgba(251, 191, 36, 0.55);
  background: rgba(245, 158, 11, 0.24);
  color: #fef3c7;
}

#btn-build-cancel {
  border-color: rgba(255, 255, 255, 0.26);
  background: rgba(100, 116, 139, 0.3);
}

#btn-interact {
  font-size: 7.5px;
  line-height: 1.05;
  text-align: center;
}

#hud-toast {
  position: absolute;
  top: 106px;
  left: 50%;
  transform: translateX(-50%) translateY(-8px);
  z-index: 35;
  padding: 7px 15px;
  border-radius: 999px;
  font-size: 12.5px;
  font-weight: 700;
  color: #ecfeff;
  border-color: rgba(94, 234, 212, 0.65);
  opacity: 0;
  transition: opacity 0.22s ease, transform 0.22s ease;
  pointer-events: none;
  white-space: nowrap;
  max-width: min(86vw, 440px);
  overflow: hidden;
  text-overflow: ellipsis;
}

#zaap-hud.coop-modal-open #hud-toast {
  top: auto;
  bottom: 24px;
}

#zaap-hud.coop-modal-open.build-mode-active #hud-toast {
  top: auto;
  bottom: 98px;
}

#hud-toast.visible {
  opacity: 1;
  transform: translateX(-50%) translateY(0);
}

#hud-toast.toast-success {
  border-color: rgba(52, 211, 153, 0.78);
  color: #d1fae5;
}

#hud-toast.toast-warning {
  border-color: rgba(251, 191, 36, 0.78);
  color: #fef3c7;
}

#hud-toast.toast-error {
  border-color: rgba(248, 113, 113, 0.82);
  color: #fee2e2;
}

/* Portrait / very narrow screens */
@media (max-width: 759px) and (min-height: 481px) {
  #hud-coop-btn {
    top: 112px;
    left: 10px;
    transform: none;
    max-width: calc(100vw - 20px);
  }
  #hud-resource-bar {
    top: 142px;
    width: calc(100vw - 20px);
    min-width: 0;
  }
  #hud-target-banner {
    top: 204px;
    width: min(330px, calc(100vw - 20px));
  }
  #hud-companion-strip {
    top: 256px;
    left: 10px;
    max-width: calc(100vw - 20px);
  }
  #hud-coop-modal,
  .hud-survival-drawer {
    top: 144px;
    width: min(366px, calc(100vw - 20px));
    max-height: calc(100vh - 332px);
  }
  #hud-build-dock {
    bottom: 200px;
    width: calc(100vw - 20px);
    min-width: 0;
  }
}

/* Mobile Landscape 844x390 & Compact Viewports */
@media (max-height: 480px), (max-width: 920px) {
  #hud-top-left {
    top: 6px;
    left: 8px;
    width: min(244px, 29vw);
    padding: 5px 8px;
    gap: 3px;
  }
  #hud-top-right {
    top: 6px;
    right: 8px;
    max-width: min(244px, 29vw);
  }
  #hud-perf-card {
    padding: 5px 7px;
    gap: 3px;
  }
  .hud-q-btn {
    padding: 2px 5px;
    font-size: 9.5px;
  }
  #hud-expansion-toggle {
    padding: 2px 5px;
    font-size: 9.5px;
  }
  #hud-expansion-drawer {
    max-height: calc(100vh - 250px);
    padding: 6px 8px;
    gap: 4px;
  }
  .hud-exp-item {
    padding: 4px 6px;
  }
  #hud-coop-btn {
    top: 6px;
    padding: 3px 9px;
    font-size: 10px;
    gap: 5px;
    max-width: min(300px, calc(100vw - 516px));
  }
  #hud-resource-bar {
    top: 32px;
    width: min(326px, calc(100vw - 508px));
    min-width: 240px;
    padding: 4px 6px;
    gap: 3px;
  }
  .hud-res-chip {
    padding: 1px 5px;
    font-size: 9px;
  }
  .hud-quick-btn {
    padding: 2px 6px;
    font-size: 9.5px;
  }
  #hud-target-banner {
    top: 86px;
    width: min(252px, calc(100vw - 520px));
    min-width: 196px;
    padding: 4px 8px;
    gap: 3px;
  }
  #hud-companion-strip {
    top: 94px;
    left: 8px;
    max-width: min(244px, 29vw);
    gap: 4px;
  }
  .hud-comp-chip {
    padding: 3px 6px;
    font-size: 9px;
  }
  #hud-coop-modal {
    top: 86px;
    width: min(400px, calc(100vw - 436px));
    max-height: calc(100vh - 98px);
    padding: 7px 10px;
    gap: 5px;
  }
  .hud-survival-drawer {
    top: 86px;
    width: min(404px, calc(100vw - 434px));
    max-height: calc(100vh - 96px);
    padding: 7px 9px;
    gap: 6px;
  }
  #zaap-hud.build-mode-active .hud-survival-drawer {
    max-height: calc(100vh - 180px);
  }
  .coop-controls-block {
    gap: 4px;
  }
  .coop-text-input,
  .coop-btn {
    height: 27px;
    font-size: 11px;
  }
  .coop-active-room-row {
    padding: 4px 7px;
  }
  #coop-party-list {
    gap: 3px;
  }
  .coop-party-row {
    padding: 3px 7px;
    font-size: 10.5px;
  }
  #hud-toast,
  #zaap-hud.coop-modal-open #hud-toast {
    top: 86px;
    bottom: auto;
    padding: 5px 11px;
    font-size: 11px;
    max-width: min(320px, calc(100vw - 440px));
  }
  #joystick-zone {
    left: 8px;
    bottom: 8px;
    width: 168px;
    height: 148px;
  }
  #hud-action-pad {
    right: 8px;
    bottom: 8px;
    width: 184px;
    height: 186px;
  }
  #hud-build-dock {
    bottom: 8px;
    width: min(400px, calc(100vw - 436px));
    min-width: 240px;
    padding: 5px 6px;
    gap: 4px;
  }
  .hud-build-pill {
    padding: 2px 5px;
    font-size: 9px;
  }
  .hud-build-action-btn {
    padding: 3px 6px;
    font-size: 9.5px;
  }
  #hud-build-status {
    font-size: 9px;
    padding: 1.5px 6px;
  }
  .hud-btn-icon {
    font-size: 12px;
  }
  .hud-btn-sub {
    display: none;
  }
  #btn-melee {
    right: 6px;
    bottom: 6px;
    width: 64px;
    height: 64px;
    font-size: 9.5px;
  }
  #btn-melee .hud-btn-icon {
    font-size: 16px;
  }
  #btn-jump {
    right: 2px;
    bottom: 78px;
    width: 52px;
    height: 52px;
    font-size: 8.5px;
  }
  #btn-dodge {
    right: 78px;
    bottom: 4px;
    width: 50px;
    height: 50px;
    font-size: 8.5px;
  }
  #btn-ranged {
    right: 68px;
    bottom: 62px;
    width: 50px;
    height: 50px;
    font-size: 8.5px;
  }
  #btn-capture {
    right: 54px;
    bottom: 120px;
    width: 48px;
    height: 48px;
    font-size: 8.5px;
  }
  #btn-interact {
    right: 0;
    bottom: 138px;
    width: 46px;
    height: 46px;
    font-size: 7.5px;
  }
  #btn-sprint {
    right: 136px;
    bottom: 4px;
    width: 46px;
    height: 46px;
    font-size: 8.5px;
  }
  #btn-summon {
    right: 128px;
    bottom: 64px;
    width: 46px;
    height: 46px;
    font-size: 8px;
  }
  #hud-nearby-hint,
  #hud-survival-context {
    bottom: 14px;
    max-width: min(360px, calc(100vw - 436px));
  }
  #zaap-hud.build-mode-active #hud-nearby-hint,
  #zaap-hud.build-mode-active #hud-survival-context {
    bottom: 92px;
  }
}

@media (max-width: 759px) and (max-height: 480px) {
  #hud-coop-btn {
    top: 90px;
    left: 8px;
    transform: none;
    max-width: 240px;
  }
  #hud-resource-bar {
    top: 6px;
    width: min(290px, calc(100vw - 460px));
    min-width: 180px;
  }
  #hud-target-banner {
    top: 64px;
    left: 50%;
    transform: translateX(-50%);
    width: 220px;
    min-width: 180px;
  }
  #hud-companion-strip {
    top: 120px;
    left: 8px;
    max-width: 240px;
  }
  #hud-coop-modal,
  .hud-survival-drawer {
    top: 84px;
    width: min(320px, calc(100vw - 368px));
    max-height: calc(100vh - 96px);
  }
}
`;

export class HudOverlay {
    private root: HTMLElement;
    private callbacks: HudCallbacks;

    private hudContainer!: HTMLElement;
    private nameplatesContainer!: HTMLElement;
    private monsterPlatesContainer!: HTMLElement;
    private survivalPlatesContainer!: HTMLElement;
    private combatPopupsContainer!: HTMLElement;

    private readonly nameplateElements = new Map<
        string,
        {
            root: HTMLElement;
            dot: HTMLElement;
            name: HTMLElement;
            reconn: HTMLElement;
        }
    >();

    private readonly monsterPlateElements = new Map<
        string,
        {
            root: HTMLElement;
            dot: HTMLElement;
            name: HTMLElement;
            lv: HTMLElement;
            fill: HTMLElement;
            tag: HTMLElement;
        }
    >();

    private readonly survivalPlateElements = new Map<
        string,
        {
            root: HTMLElement;
            label: HTMLElement;
            tag: HTMLElement;
            track: HTMLElement;
            fill: HTMLElement;
        }
    >();

    private readonly combatPopupElements = new Map<string, HTMLElement>();

    private portraitBanner!: HTMLElement;
    private portraitDismissed = false;

    private avatarDotEl!: HTMLElement;
    private hpFillEl!: HTMLElement;
    private hpTextEl!: HTMLElement;
    private staminaFill!: HTMLElement;
    private hungerFillEl!: HTMLElement;
    private hungerTextEl!: HTMLElement;
    private toolBadgeEl!: HTMLElement;
    private crystalCounterEl!: HTMLElement;
    private spheresBadgeEl!: HTMLElement;
    private lootBadgeEl!: HTMLElement;
    private statePillEl!: HTMLElement;
    private coordsEl!: HTMLElement;

    private resourceValueEls = new Map<ResourceKind, HTMLElement>();
    private eatBtnEl!: HTMLButtonElement;
    private craftPanelBtnEl!: HTMLButtonElement;
    private buildModeBtnEl!: HTMLButtonElement;
    private basePanelBtnEl!: HTMLButtonElement;

    private craftDrawerEl!: HTMLElement;
    private baseDrawerEl!: HTMLElement;
    private craftDrawerOpen = false;
    private baseDrawerOpen = false;
    private lastCraftSig = '';
    private lastBaseSig = '';

    private buildDockEl!: HTMLElement;
    private buildStatusEl!: HTMLElement;
    private buildRotateBtnEl!: HTMLButtonElement;
    private buildPlaceBtnEl!: HTMLButtonElement;
    private buildDemolishBtnEl!: HTMLButtonElement;
    private buildCancelBtnEl!: HTMLButtonElement;
    private buildRecipeBtns = new Map<ModularStructureRecipeId, HTMLButtonElement>();
    private survivalContextEl!: HTMLElement;
    private latestSurvivalState: HudSurvivalState | null = null;

    private targetBannerEl!: HTMLElement;
    private targetSpeciesBadgeEl!: HTMLElement;
    private targetNameEl!: HTMLElement;
    private targetAiChipEl!: HTMLElement;
    private targetCaptureChipEl!: HTMLElement;
    private targetHpFillEl!: HTMLElement;
    private targetHpTextEl!: HTMLElement;

    private companionStripEl!: HTMLElement;
    private lastCompanionSig = '';

    private fpsBadgeEl!: HTMLElement;
    private fpsTextEl!: HTMLElement;
    private tierPillEl!: HTMLElement;
    private muteBtnEl!: HTMLButtonElement;
    private qualityButtons = new Map<QualityMode, HTMLButtonElement>();
    private sensSliderEl!: HTMLInputElement;
    private sensValueEl!: HTMLElement;

    private expansionToggleBtn!: HTMLButtonElement;
    private expansionDrawerEl!: HTMLElement;
    private expansionOpen = false;
    private lastExpansionSummaryJson = '';

    private coopBtnEl!: HTMLButtonElement;
    private coopDotEl!: HTMLElement;
    private coopLabelEl!: HTMLElement;
    private coopCodeBadgeEl!: HTMLElement;
    private coopSlotDots: HTMLElement[] = [];

    private coopModalEl!: HTMLElement;
    private coopModalOpen = false;
    private coopModalStateTagEl!: HTMLElement;
    private coopLobbyControlsEl!: HTMLElement;
    private coopActiveControlsEl!: HTMLElement;
    private coopNicknameInput!: HTMLInputElement;
    private coopCreateBtn!: HTMLButtonElement;
    private coopCodeInput!: HTMLInputElement;
    private coopJoinBtn!: HTMLButtonElement;
    private coopRoomCodeDisplayEl!: HTMLElement;
    private coopCopyBtn!: HTMLButtonElement;
    private coopLeaveBtn!: HTMLButtonElement;
    private coopErrorMsgEl!: HTMLElement;
    private coopPartyListEl!: HTMLElement;
    private coopNetStatsEl!: HTMLElement;
    private localValidationError: string | null = null;
    private lastPartySignature = '';
    private lastCoopRoomCode: string | null = null;
    private copyFeedbackTimer: number | null = null;
    private nicknameSyncedFromStatus = false;

    private joystickZoneEl!: HTMLElement;
    private joystickRingEl!: HTMLElement;
    private joystickKnobEl!: HTMLElement;

    private actionPadEl!: HTMLElement;
    private jumpBtnEl!: HTMLButtonElement;
    private sprintBtnEl!: HTMLButtonElement;
    private interactBtnEl!: HTMLButtonElement;
    private meleeBtnEl!: HTMLButtonElement;
    private rangedBtnEl!: HTMLButtonElement;
    private dodgeBtnEl!: HTMLButtonElement;
    private captureBtnEl!: HTMLButtonElement;
    private summonBtnEl!: HTMLButtonElement;

    private nearbyHintEl!: HTMLElement;
    private toastEl!: HTMLElement;
    private toastTimer: number | null = null;
    private lastCrystalCount = 0;
    private mutedVisual = false;

    private onResizeBound: () => void;
    private onKeyDownBound: (e: KeyboardEvent) => void;

    constructor(
        uiRoot: HTMLElement | null,
        callbacks: HudCallbacks,
        initialSensitivity = 1.0
    ) {
        this.root = uiRoot ?? this.ensureUiRoot();
        this.callbacks = callbacks;

        this.injectStyles();
        this.buildDom(initialSensitivity);

        this.onResizeBound = () => {
            this.updateOrientationBanner();
            this.positionRestingJoystick();
            this.clampExpansionDrawerHeight();
            this.clampCoopModalBounds();
        };
        this.onKeyDownBound = (e: KeyboardEvent) => this.handleKeyDown(e);
        window.addEventListener('resize', this.onResizeBound);
        window.addEventListener('orientationchange', this.onResizeBound);
        window.addEventListener('keydown', this.onKeyDownBound);

        this.updateOrientationBanner();
        this.positionRestingJoystick();
    }

    public setMutedVisual(muted: boolean): void {
        this.mutedVisual = Boolean(muted);
        this.muteBtnEl.classList.toggle('muted', this.mutedVisual);
        this.muteBtnEl.textContent = this.mutedVisual ? '🔇' : '🔊';
        this.muteBtnEl.setAttribute('aria-pressed', this.mutedVisual ? 'true' : 'false');
    }

    public toggleCraftDrawer(force?: boolean): boolean {
        const next = typeof force === 'boolean' ? force : !this.craftDrawerOpen;
        if (next) {
            if (this.expansionOpen) this.setExpansionOpen(false);
            if (this.coopModalOpen) this.setCoopModalOpen(false);
            if (this.baseDrawerOpen) this.toggleBaseDrawer(false);
            this.lastCraftSig = '';
        }
        this.craftDrawerOpen = next;
        this.craftDrawerEl.classList.toggle('open', next);
        this.craftPanelBtnEl.classList.toggle('active', next);
        this.craftPanelBtnEl.setAttribute('aria-expanded', next ? 'true' : 'false');
        if (next) {
            this.renderCraftDrawer(this.latestSurvivalState);
        }
        return this.craftDrawerOpen;
    }

    public toggleBaseDrawer(force?: boolean): boolean {
        const next = typeof force === 'boolean' ? force : !this.baseDrawerOpen;
        if (next) {
            if (this.expansionOpen) this.setExpansionOpen(false);
            if (this.coopModalOpen) this.setCoopModalOpen(false);
            if (this.craftDrawerOpen) this.toggleCraftDrawer(false);
            this.lastBaseSig = '';
        }
        this.baseDrawerOpen = next;
        this.baseDrawerEl.classList.toggle('open', next);
        this.basePanelBtnEl.classList.toggle('active', next);
        this.basePanelBtnEl.setAttribute('aria-expanded', next ? 'true' : 'false');
        if (next) {
            this.renderBaseDrawer(this.latestSurvivalState);
        }
        return this.baseDrawerOpen;
    }

    public isCraftDrawerOpen(): boolean {
        return this.craftDrawerOpen;
    }

    public isBaseDrawerOpen(): boolean {
        return this.baseDrawerOpen;
    }

    public setBuildModeVisual(enabled: boolean): void {
        this.hudContainer.classList.toggle('build-mode-active', enabled);
        this.buildDockEl.classList.toggle('visible', enabled);
        this.buildModeBtnEl.classList.toggle('active', enabled);
        this.buildModeBtnEl.setAttribute('aria-pressed', enabled ? 'true' : 'false');
    }

    public update(
        telemetry: PlayerTelemetry,
        metrics: PerformanceMetrics,
        joystick: JoystickVisualState,
        buttons: ActionButtonStates,
        expansionSummary?: ExpansionSummary,
        remoteNameplates?: RemoteNameplateInfo[],
        combatState?: HudCombatState,
        survivalState?: HudSurvivalState
    ): void {
        // 1. Player HP, Stamina, Hunger & Equipped Tool
        const maxHp = Math.max(1, combatState?.playerStats.maxHp ?? telemetry.maxHp ?? 100);
        const hp = Math.max(0, Math.min(maxHp, combatState?.playerStats.hp ?? telemetry.hp ?? maxHp));
        const hpPct = (hp / maxHp) * 100;
        this.hpFillEl.style.width = `${hpPct.toFixed(1)}%`;
        this.hpTextEl.textContent = `${Math.round(hp)}`;
        if (hpPct <= 28) {
            this.hpFillEl.style.background = 'linear-gradient(90deg, #ef4444, #f43f5e)';
        } else if (hpPct <= 55) {
            this.hpFillEl.style.background = 'linear-gradient(90deg, #f59e0b, #fbbf24)';
        } else {
            this.hpFillEl.style.background = 'linear-gradient(90deg, #10b981, #34d399)';
        }

        const staminaPct = Math.max(0, Math.min(100, telemetry.stamina));
        this.staminaFill.style.width = `${staminaPct.toFixed(1)}%`;
        if (staminaPct < 22) {
            this.staminaFill.style.background = 'linear-gradient(90deg, #f97316, #ef4444)';
        } else if (staminaPct < 45) {
            this.staminaFill.style.background = 'linear-gradient(90deg, #f59e0b, #fbbf24)';
        } else {
            this.staminaFill.style.background = 'linear-gradient(90deg, #2dd4bf, #38bdf8)';
        }

        const maxHunger = Math.max(1, survivalState?.maxHunger ?? telemetry.maxHunger ?? 100);
        const hunger = Math.max(
            0,
            Math.min(maxHunger, survivalState?.hunger ?? telemetry.hunger ?? maxHunger)
        );
        const hungerPct = (hunger / maxHunger) * 100;
        this.hungerFillEl.style.width = `${hungerPct.toFixed(1)}%`;
        this.hungerTextEl.textContent = `${Math.round(hunger)}`;
        if (hungerPct <= 25) {
            this.hungerFillEl.style.background = 'linear-gradient(90deg, #ef4444, #f97316)';
        } else if (hungerPct <= 50) {
            this.hungerFillEl.style.background = 'linear-gradient(90deg, #f59e0b, #fbbf24)';
        } else {
            this.hungerFillEl.style.background = 'linear-gradient(90deg, #fbbf24, #34d399)';
        }

        const equippedTool = (survivalState?.equippedTool ?? telemetry.equippedTool ?? 'hands') as ToolId;
        this.toolBadgeEl.textContent = TOOL_LABELS_KO[equippedTool] ?? TOOL_LABELS_KO.hands;

        // Capture spheres & loot badges
        const spheres = Math.max(
            0,
            Math.round(combatState?.playerStats.captureSpheres ?? STARTING_CAPTURE_SPHERES)
        );
        const loot = Math.max(0, Math.round(combatState?.playerStats.lootCount ?? 0));
        this.spheresBadgeEl.textContent = `구체: ${spheres}`;
        this.spheresBadgeEl.classList.toggle('empty', spheres <= 0);
        this.lootBadgeEl.textContent = `전리품: ${loot}`;

        if (typeof combatState?.playerStats.muted === 'boolean' && combatState.playerStats.muted !== this.mutedVisual) {
            this.setMutedVisual(combatState.playerStats.muted);
        }

        // 2. Sync crystal baseline on room entry so pre-collected crystals don't falsely toast
        const activeRoomCode = expansionSummary?.coop.status.roomCode ?? null;
        if (activeRoomCode && activeRoomCode !== this.lastCoopRoomCode) {
            this.lastCrystalCount = Math.max(this.lastCrystalCount, telemetry.crystalsCollected);
        }
        this.lastCoopRoomCode = activeRoomCode;

        this.crystalCounterEl.textContent = `${telemetry.crystalsCollected}/${telemetry.totalCrystals}`;
        if (telemetry.crystalsCollected > this.lastCrystalCount) {
            if (telemetry.crystalsCollected >= telemetry.totalCrystals) {
                this.showToast(
                    `모든 에테르 수정(${telemetry.totalCrystals}/${telemetry.totalCrystals}) 조율 완료!`,
                    2800,
                    'success'
                );
            } else {
                this.showToast(
                    `에테르 수정 수집 (${telemetry.crystalsCollected}/${telemetry.totalCrystals})`,
                    2400,
                    'info'
                );
            }
        }
        this.lastCrystalCount = telemetry.crystalsCollected;

        // 3. Player state pill & coords
        const stateText = telemetry.dodging
            ? '회피'
            : telemetry.inWater
              ? '도강'
              : (PLAYER_STATE_KO[telemetry.state] ?? '대기');
        this.statePillEl.textContent = stateText;
        this.coordsEl.textContent = `X:${telemetry.position.x.toFixed(1)} Y:${telemetry.position.y.toFixed(1)} Z:${telemetry.position.z.toFixed(1)}`;

        // 4. FPS & quality badge
        const fpsVal = Math.round(metrics.fps);
        this.fpsTextEl.textContent = `${fpsVal} FPS · ${metrics.frameTimeMs.toFixed(1)}ms`;
        this.fpsBadgeEl.classList.remove('fps-warn', 'fps-low');
        if (metrics.fps < 28) {
            this.fpsBadgeEl.classList.add('fps-low');
        } else if (metrics.fps < 45) {
            this.fpsBadgeEl.classList.add('fps-warn');
        }

        const tierKo = QUALITY_TIER_KO[metrics.qualityTier] ?? metrics.qualityTier.toUpperCase();
        this.tierPillEl.textContent = `등급: ${tierKo}`;

        for (const [mode, btn] of this.qualityButtons.entries()) {
            btn.classList.toggle('active', mode === metrics.qualityMode);
        }

        // 5. Expansion drawer & Co-op UI
        if (expansionSummary) {
            const rosterCount =
                survivalState?.capturedRoster.length ??
                combatState?.companions.roster.length ??
                expansionSummary.monsters.capturedCount;
            const summaryKey = `${expansionSummary.coop.status.state}:${expansionSummary.coop.status.peerCount}:${expansionSummary.coop.status.connectedPlayers}:${expansionSummary.monsters.speciesCount}:${rosterCount}:${expansionSummary.building.recipeCount}:${survivalState?.placedStructures.length ?? expansionSummary.building.placedCount}`;
            if (summaryKey !== this.lastExpansionSummaryJson) {
                this.lastExpansionSummaryJson = summaryKey;
                this.renderExpansionSummary(expansionSummary, rosterCount);
            }
            this.updateCoopUi(expansionSummary.coop.status);
        }

        // 6. Remote 3D Nameplates
        this.updateRemoteNameplates(remoteNameplates ?? []);

        // 7. Phase 3 Combat Target Banner, Companion Strip, World Plates & Popups
        this.updateTargetBanner(combatState?.lockedTarget ?? null);
        this.updateCompanionStrip(combatState?.companions ?? null);
        this.updateMonsterPlates(
            combatState?.monsterPlates ?? [],
            combatState?.lockedTarget?.id ?? null
        );
        this.updateCombatPopups(combatState?.combatPopups ?? []);

        // 7b. Phase 4 Survival Inventory, Crafting, Build Dock, Base Workers & 3D Plates
        this.updateSurvivalUi(survivalState ?? null, buttons);

        // 8. Dynamic Virtual Joystick
        const ringDiam = joystick.radius * 2;
        this.joystickRingEl.style.width = `${ringDiam}px`;
        this.joystickRingEl.style.height = `${ringDiam}px`;

        if (joystick.active) {
            this.joystickRingEl.style.left = `${joystick.centerX}px`;
            this.joystickRingEl.style.top = `${joystick.centerY}px`;
            this.joystickKnobEl.style.left = `${joystick.knobX}px`;
            this.joystickKnobEl.style.top = `${joystick.knobY}px`;
            this.joystickRingEl.classList.add('active');
            this.joystickKnobEl.classList.add('active');
            this.joystickRingEl.classList.toggle('auto-sprint', joystick.autoSprinting);
            this.joystickKnobEl.classList.toggle('auto-sprint', joystick.autoSprinting);
        } else {
            this.joystickRingEl.classList.remove('active', 'auto-sprint');
            this.joystickKnobEl.classList.remove('active', 'auto-sprint');
            this.positionRestingJoystick();
        }

        // 9. Touch Action & Combat Buttons + Interact Hint
        this.jumpBtnEl.classList.toggle('pressed', buttons.jumpActive);
        this.sprintBtnEl.classList.toggle('pressed', buttons.sprintActive);
        this.sprintBtnEl.classList.toggle(
            'sprint-on',
            buttons.sprintToggled || buttons.sprintActive
        );
        this.interactBtnEl.classList.toggle('pressed', buttons.interactActive);
        this.meleeBtnEl.classList.toggle('pressed', buttons.meleeActive);
        this.rangedBtnEl.classList.toggle('pressed', buttons.rangedActive);
        this.dodgeBtnEl.classList.toggle('pressed', buttons.dodgeActive);
        this.captureBtnEl.classList.toggle('pressed', buttons.captureActive);
        this.summonBtnEl.classList.toggle('pressed', buttons.summonActive);

        const canCaptureTarget = Boolean(
            combatState?.lockedTarget &&
                spheres > 0 &&
                combatState.lockedTarget.aiState !== 'capturing' &&
                combatState.lockedTarget.aiState !== 'captured' &&
                combatState.lockedTarget.aiState !== 'dead'
        );
        this.captureBtnEl.classList.toggle('can-capture', canCaptureTarget);

        const hasCompanionOut = Boolean(combatState?.companions.activeUid);
        const emptyRoster = (combatState?.companions.roster.length ?? 0) === 0;
        this.summonBtnEl.classList.toggle('companion-active', hasCompanionOut);
        this.summonBtnEl.classList.toggle('empty-roster', emptyRoster);
        const summonLabel = this.summonBtnEl.querySelector('.hud-btn-label');
        if (summonLabel) {
            summonLabel.textContent = hasCompanionOut ? '복귀' : '동료';
        }

        const nearSurvival = Boolean(
            survivalState?.nearestResourceLabel || survivalState?.nearestStructureLabel
        );
        const nearCrystal = telemetry.nearbyHint !== null;
        this.interactBtnEl.classList.toggle('near-crystal', nearCrystal || nearSurvival);
        if (telemetry.nearbyHint) {
            this.nearbyHintEl.textContent = telemetry.nearbyHint;
            this.nearbyHintEl.classList.add('visible');
        } else {
            this.nearbyHintEl.classList.remove('visible');
        }
    }

    public showToast(
        message: string,
        durationMs = 2600,
        kind: HudToastKind = 'info'
    ): void {
        this.toastEl.textContent = message;
        this.toastEl.classList.remove('toast-info', 'toast-success', 'toast-warning', 'toast-error');
        this.toastEl.classList.add(`toast-${kind}`, 'visible');
        if (this.toastTimer !== null) {
            window.clearTimeout(this.toastTimer);
        }
        this.toastTimer = window.setTimeout(() => {
            this.toastEl.classList.remove('visible');
            this.toastTimer = null;
        }, durationMs);
    }

    public setCoopModalOpen(open: boolean): void {
        if (open) {
            if (this.expansionOpen) this.setExpansionOpen(false);
            if (this.craftDrawerOpen) this.toggleCraftDrawer(false);
            if (this.baseDrawerOpen) this.toggleBaseDrawer(false);
        }
        this.coopModalOpen = open;
        this.coopModalEl.classList.toggle('open', open);
        this.coopBtnEl.classList.toggle('open', open);
        this.coopBtnEl.setAttribute('aria-expanded', open ? 'true' : 'false');
        this.hudContainer.classList.toggle('coop-modal-open', open);
        if (open) {
            this.clampCoopModalBounds();
        } else {
            this.coopModalEl.style.top = '';
            this.coopModalEl.style.maxHeight = '';
        }
    }

    public isCoopModalOpen(): boolean {
        return this.coopModalOpen;
    }

    public setRoomCodeInput(roomCode: string): void {
        this.coopCodeInput.value = sanitizeRoomCode(roomCode);
    }

    public setNicknameInput(displayName: string): void {
        this.coopNicknameInput.value = displayName.slice(0, 16);
        this.nicknameSyncedFromStatus = true;
    }

    public dispose(): void {
        window.removeEventListener('resize', this.onResizeBound);
        window.removeEventListener('orientationchange', this.onResizeBound);
        window.removeEventListener('keydown', this.onKeyDownBound);
        if (this.toastTimer !== null) {
            window.clearTimeout(this.toastTimer);
        }
        if (this.copyFeedbackTimer !== null) {
            window.clearTimeout(this.copyFeedbackTimer);
        }
        this.nameplateElements.clear();
        this.monsterPlateElements.clear();
        this.survivalPlateElements.clear();
        this.combatPopupElements.clear();
        this.resourceValueEls.clear();
        this.buildRecipeBtns.clear();
        this.root.innerHTML = '';
    }

    private ensureUiRoot(): HTMLElement {
        const el = document.createElement('div');
        el.id = 'ui-root';
        document.body.appendChild(el);
        return el;
    }

    private injectStyles(): void {
        const existing = document.getElementById(HUD_STYLE_ID);
        if (existing) {
            existing.textContent = HUD_CSS;
            return;
        }
        const style = document.createElement('style');
        style.id = HUD_STYLE_ID;
        style.textContent = HUD_CSS;
        document.head.appendChild(style);
    }

    private buildDom(initialSensitivity: number): void {
        const resourceChipsHtml = RESOURCE_ORDER.map(
            ({ key, labelKo }) =>
                `<span class="hud-res-chip" data-res-kind="${key}">${labelKo} <strong class="hud-res-chip-val" id="hud-res-${key}-val">0</strong></span>`
        ).join('');

        const buildPillsHtml = MODULAR_STRUCTURE_RECIPE_LIST.map(
            (recipe) =>
                `<button class="hud-build-pill" type="button" data-build-recipe="${recipe.recipeId}" data-hud-interactive="true">${BUILD_PILL_LABELS_KO[recipe.recipeId] ?? recipe.nameKo}</button>`
        ).join('');

        this.root.innerHTML = `
<div id="zaap-hud">
  <div id="hud-nameplates" aria-hidden="true"></div>
  <div id="hud-monster-plates" aria-hidden="true"></div>
  <div id="hud-survival-plates" aria-hidden="true"></div>
  <div id="hud-combat-popups" aria-hidden="true"></div>

  <div id="hud-portrait-banner" data-hud-interactive="true" role="status">
    <span>📱 가로 모드(Landscape)로 회전하면 최적의 조작감을 경험할 수 있습니다</span>
    <button id="hud-portrait-dismiss" data-hud-interactive="true" type="button">닫기</button>
  </div>

  <div id="hud-top-left" class="hud-glass">
    <div class="hud-row">
      <div class="hud-player-badge">
        <div class="hud-avatar-dot">Z</div>
        <span class="hud-player-name">에테르 탐험가</span>
      </div>
      <div class="hud-top-pills">
        <div class="hud-crystal-pill" title="에테르 수정">
          <span class="hud-crystal-gem"></span>
          <span id="hud-crystal-count">0/12</span>
        </div>
        <span id="hud-state-pill">대기</span>
      </div>
    </div>
    <div class="hud-bars-grid">
      <div class="hud-bar-wrap" title="체력">
        <span class="hud-bar-label">체력</span>
        <div class="hud-bar-track">
          <div id="hud-hp-fill"></div>
        </div>
        <span id="hud-hp-text">100</span>
      </div>
      <div class="hud-bar-wrap" title="기력">
        <span class="hud-bar-label">기력</span>
        <div class="hud-bar-track">
          <div id="hud-stamina-fill"></div>
        </div>
      </div>
      <div class="hud-bar-wrap" title="포만감">
        <span class="hud-bar-label">포만감</span>
        <div class="hud-bar-track">
          <div id="hud-hunger-fill"></div>
        </div>
        <span id="hud-hunger-text">100</span>
      </div>
      <span id="hud-tool-badge">도구: 맨손</span>
    </div>
    <div class="hud-meta-row">
      <div class="hud-resource-badges">
        <span id="hud-spheres-badge" class="hud-res-badge">구체: ${STARTING_CAPTURE_SPHERES}</span>
        <span id="hud-loot-badge" class="hud-res-badge">전리품: 0</span>
      </div>
      <span id="hud-coords">X:0.0 Y:2.2 Z:12.0</span>
    </div>
  </div>

  <div id="hud-companion-strip" aria-label="동료 파티"></div>

  <button id="hud-coop-btn" class="hud-glass" data-hud-interactive="true" type="button" aria-expanded="false" aria-controls="hud-coop-modal">
    <span id="hud-coop-dot"></span>
    <span id="hud-coop-label">오프라인</span>
    <span id="hud-coop-code-badge"></span>
    <span class="hud-coop-slots" aria-hidden="true">
      <span class="hud-coop-slot-dot" data-slot="0"></span>
      <span class="hud-coop-slot-dot" data-slot="1"></span>
      <span class="hud-coop-slot-dot" data-slot="2"></span>
    </span>
  </button>

  <div id="hud-resource-bar" class="hud-glass" data-hud-interactive="true" aria-label="공유 자원 및 생존 단축키">
    <div class="hud-res-row">${resourceChipsHtml}</div>
    <div class="hud-quick-row">
      <button id="btn-eat" class="hud-quick-btn" data-hud-interactive="true" type="button" title="음식 섭취 (F)">섭취 F</button>
      <button id="btn-craft-panel" class="hud-quick-btn" data-hud-interactive="true" type="button" aria-expanded="false" aria-controls="hud-craft-drawer" title="제작창 (C)">제작 C</button>
      <button id="btn-build-mode" class="hud-quick-btn" data-hud-interactive="true" type="button" aria-pressed="false" title="건축 모드 (B)">건축 B</button>
      <button id="btn-base-panel" class="hud-quick-btn" data-hud-interactive="true" type="button" aria-expanded="false" aria-controls="hud-base-drawer" title="거점 관리 (P)">거점 P</button>
    </div>
  </div>

  <div id="hud-target-banner" class="hud-glass" aria-live="polite">
    <div class="hud-target-head">
      <div class="hud-target-id">
        <span id="hud-target-species-badge">풀</span>
        <span id="hud-target-name">이끼 홉퍼 · Lv.1</span>
      </div>
      <div class="hud-target-chips">
        <span id="hud-target-ai-chip">순찰</span>
        <span id="hud-target-capture-chip">포획 25%</span>
      </div>
    </div>
    <div class="hud-target-bar-row">
      <div class="hud-target-hp-track">
        <div id="hud-target-hp-fill"></div>
      </div>
      <span id="hud-target-hp-text">110/110 · 8.0m</span>
    </div>
  </div>

  <div id="hud-coop-modal" class="hud-glass" data-hud-interactive="true" role="dialog" aria-label="3인 협동 파티">
    <div class="coop-modal-header" data-hud-interactive="true">
      <div class="coop-modal-title-wrap">
        <span>3인 협동 파티</span>
        <span id="coop-modal-state-tag">오프라인</span>
      </div>
      <button id="coop-modal-close" data-hud-interactive="true" type="button" aria-label="협동 창 닫기">×</button>
    </div>

    <div id="coop-lobby-controls" class="coop-controls-block" data-hud-interactive="true">
      <div class="coop-input-row" data-hud-interactive="true">
        <input id="coop-nickname-input" class="coop-text-input" data-hud-interactive="true" type="text" maxlength="16" placeholder="닉네임 (탐험가)" value="탐험가" aria-label="닉네임" />
        <button id="coop-create-btn" class="coop-btn primary" data-hud-interactive="true" type="button">방 만들기</button>
      </div>
      <div class="coop-input-row" data-hud-interactive="true">
        <input id="coop-code-input" class="coop-text-input" data-hud-interactive="true" type="text" maxlength="12" placeholder="방 코드 (3~12자)" aria-label="방 코드" />
        <button id="coop-join-btn" class="coop-btn" data-hud-interactive="true" type="button">참가</button>
      </div>
    </div>

    <div id="coop-active-controls" class="coop-controls-block hidden" data-hud-interactive="true">
      <div class="coop-active-room-row" data-hud-interactive="true">
        <div class="coop-room-code-wrap">
          <span class="coop-room-code-label">방 코드</span>
          <span id="coop-room-code-display">------</span>
        </div>
        <div class="coop-active-actions" data-hud-interactive="true">
          <button id="coop-copy-btn" class="coop-btn primary" data-hud-interactive="true" type="button">링크 복사</button>
          <button id="coop-leave-btn" class="coop-btn danger" data-hud-interactive="true" type="button">방 나가기</button>
        </div>
      </div>
    </div>

    <div id="coop-error-msg" role="alert"></div>

    <div id="coop-party-list" data-hud-interactive="true"></div>

    <div id="coop-net-stats">
      <span>지연: 0ms</span>
      <span>↑ 0.0 KB/s · ↓ 0.0 KB/s</span>
    </div>
  </div>

  <div id="hud-craft-drawer" class="hud-glass hud-survival-drawer" data-hud-interactive="true" role="dialog" aria-label="제작 및 도구"></div>
  <div id="hud-base-drawer" class="hud-glass hud-survival-drawer" data-hud-interactive="true" role="dialog" aria-label="거점 일꾼 관리"></div>

  <div id="hud-top-right">
    <div id="hud-perf-card" class="hud-glass" data-hud-interactive="true">
      <div class="hud-perf-top">
        <div class="hud-perf-badges">
          <span id="hud-fps-badge"><span id="hud-fps">60 FPS · 16.7ms</span></span>
          <span id="hud-tier-pill">등급: 자동</span>
        </div>
        <button id="btn-mute" data-hud-interactive="true" type="button" aria-label="음소거 전환" aria-pressed="false" title="소리 켜기/끄기">🔊</button>
      </div>
      <div class="hud-quality-row">
        <div class="hud-quality-btns" data-hud-interactive="true">
          <button class="hud-q-btn" data-quality-mode="auto" data-hud-interactive="true" type="button">자동</button>
          <button class="hud-q-btn" data-quality-mode="low" data-hud-interactive="true" type="button">낮음</button>
          <button class="hud-q-btn" data-quality-mode="medium" data-hud-interactive="true" type="button">중간</button>
          <button class="hud-q-btn" data-quality-mode="high" data-hud-interactive="true" type="button">높음</button>
        </div>
        <button id="hud-expansion-toggle" data-hud-interactive="true" type="button">확장 ▾</button>
      </div>
      <div class="hud-sens-row" data-hud-interactive="true">
        <span>시점 감도</span>
        <input id="hud-sens-slider" data-hud-interactive="true" type="range" min="0.3" max="2.5" step="0.05" value="${initialSensitivity.toFixed(2)}" />
        <span id="hud-sens-value">${initialSensitivity.toFixed(1)}x</span>
      </div>
    </div>

    <div id="hud-expansion-drawer" class="hud-glass" data-hud-interactive="true"></div>
  </div>

  <div id="hud-toast" class="hud-glass"></div>
  <div id="hud-nearby-hint" class="hud-glass"></div>
  <div id="hud-survival-context" class="hud-glass"></div>

  <div id="hud-build-dock" class="hud-glass" data-hud-interactive="true" aria-label="모듈 건축 바">
    <div class="hud-build-recipes">${buildPillsHtml}</div>
    <div class="hud-build-controls">
      <span id="hud-build-status">0° · 설치 가능</span>
      <div class="hud-build-btns">
        <button id="btn-build-rotate" class="hud-build-action-btn" data-hud-interactive="true" type="button">회전</button>
        <button id="btn-build-place" class="hud-build-action-btn valid" data-hud-interactive="true" type="button">배치</button>
        <button id="btn-build-demolish" class="hud-build-action-btn" data-hud-interactive="true" type="button">철거</button>
        <button id="btn-build-cancel" class="hud-build-action-btn" data-hud-interactive="true" type="button">닫기</button>
      </div>
    </div>
  </div>

  <div id="joystick-zone">
    <div id="joystick-ring"></div>
    <div id="joystick-knob"></div>
  </div>

  <div id="hud-action-pad">
    <button id="btn-interact" class="hud-touch-btn" type="button" aria-label="채집 및 동작 (E)">
      <span class="hud-btn-icon">✦</span>
      <span>채집/동작</span>
      <span class="hud-btn-sub">E</span>
    </button>
    <button id="btn-capture" class="hud-touch-btn" type="button" aria-label="몬스터 포획 (V)">
      <span class="hud-btn-icon">◎</span>
      <span>포획</span>
      <span class="hud-btn-sub">V</span>
    </button>
    <button id="btn-jump" class="hud-touch-btn" type="button" aria-label="점프 (Space)">
      <span class="hud-btn-icon">▲</span>
      <span>점프</span>
    </button>
    <button id="btn-ranged" class="hud-touch-btn" type="button" aria-label="원거리 마법 (K)">
      <span class="hud-btn-icon">✧</span>
      <span>마법</span>
      <span class="hud-btn-sub">K</span>
    </button>
    <button id="btn-summon" class="hud-touch-btn" type="button" aria-label="동료 소환 및 복귀 (R)">
      <span class="hud-btn-icon">◈</span>
      <span class="hud-btn-label">동료</span>
      <span class="hud-btn-sub">R</span>
    </button>
    <button id="btn-sprint" class="hud-touch-btn" type="button" aria-label="질주 (Shift)">
      <span class="hud-btn-icon">⚡</span>
      <span>질주</span>
    </button>
    <button id="btn-dodge" class="hud-touch-btn" type="button" aria-label="회피 구르기 (Q)">
      <span class="hud-btn-icon">⇶</span>
      <span>회피</span>
      <span class="hud-btn-sub">Q</span>
    </button>
    <button id="btn-melee" class="hud-touch-btn" type="button" aria-label="근접 공격 (J)">
      <span class="hud-btn-icon">⚔</span>
      <span>공격</span>
      <span class="hud-btn-sub">J</span>
    </button>
  </div>
</div>
`;

        this.hudContainer = this.root.querySelector('#zaap-hud')!;
        this.nameplatesContainer = this.root.querySelector('#hud-nameplates')!;
        this.monsterPlatesContainer = this.root.querySelector('#hud-monster-plates')!;
        this.survivalPlatesContainer = this.root.querySelector('#hud-survival-plates')!;
        this.combatPopupsContainer = this.root.querySelector('#hud-combat-popups')!;

        this.portraitBanner = this.root.querySelector('#hud-portrait-banner')!;
        const dismissBtn = this.root.querySelector('#hud-portrait-dismiss')!;
        dismissBtn.addEventListener('click', () => {
            this.portraitDismissed = true;
            this.portraitBanner.classList.remove('visible');
        });

        this.avatarDotEl = this.root.querySelector('.hud-avatar-dot')!;
        this.hpFillEl = this.root.querySelector('#hud-hp-fill')!;
        this.hpTextEl = this.root.querySelector('#hud-hp-text')!;
        this.staminaFill = this.root.querySelector('#hud-stamina-fill')!;
        this.hungerFillEl = this.root.querySelector('#hud-hunger-fill')!;
        this.hungerTextEl = this.root.querySelector('#hud-hunger-text')!;
        this.toolBadgeEl = this.root.querySelector('#hud-tool-badge')!;
        this.crystalCounterEl = this.root.querySelector('#hud-crystal-count')!;
        this.spheresBadgeEl = this.root.querySelector('#hud-spheres-badge')!;
        this.lootBadgeEl = this.root.querySelector('#hud-loot-badge')!;
        this.statePillEl = this.root.querySelector('#hud-state-pill')!;
        this.coordsEl = this.root.querySelector('#hud-coords')!;

        for (const { key } of RESOURCE_ORDER) {
            const valEl = this.root.querySelector<HTMLElement>(`#hud-res-${key}-val`);
            if (valEl) {
                this.resourceValueEls.set(key, valEl);
            }
        }
        this.eatBtnEl = this.root.querySelector('#btn-eat')!;
        this.craftPanelBtnEl = this.root.querySelector('#btn-craft-panel')!;
        this.buildModeBtnEl = this.root.querySelector('#btn-build-mode')!;
        this.basePanelBtnEl = this.root.querySelector('#btn-base-panel')!;

        this.craftDrawerEl = this.root.querySelector('#hud-craft-drawer')!;
        this.baseDrawerEl = this.root.querySelector('#hud-base-drawer')!;

        this.buildDockEl = this.root.querySelector('#hud-build-dock')!;
        this.buildStatusEl = this.root.querySelector('#hud-build-status')!;
        this.buildRotateBtnEl = this.root.querySelector('#btn-build-rotate')!;
        this.buildPlaceBtnEl = this.root.querySelector('#btn-build-place')!;
        this.buildDemolishBtnEl = this.root.querySelector('#btn-build-demolish')!;
        this.buildCancelBtnEl = this.root.querySelector('#btn-build-cancel')!;
        this.root.querySelectorAll<HTMLButtonElement>('[data-build-recipe]').forEach((btn) => {
            const recipeId = btn.dataset.buildRecipe as ModularStructureRecipeId | undefined;
            if (recipeId) {
                this.buildRecipeBtns.set(recipeId, btn);
            }
        });
        this.survivalContextEl = this.root.querySelector('#hud-survival-context')!;

        this.targetBannerEl = this.root.querySelector('#hud-target-banner')!;
        this.targetSpeciesBadgeEl = this.root.querySelector('#hud-target-species-badge')!;
        this.targetNameEl = this.root.querySelector('#hud-target-name')!;
        this.targetAiChipEl = this.root.querySelector('#hud-target-ai-chip')!;
        this.targetCaptureChipEl = this.root.querySelector('#hud-target-capture-chip')!;
        this.targetHpFillEl = this.root.querySelector('#hud-target-hp-fill')!;
        this.targetHpTextEl = this.root.querySelector('#hud-target-hp-text')!;

        this.companionStripEl = this.root.querySelector('#hud-companion-strip')!;

        this.fpsBadgeEl = this.root.querySelector('#hud-fps-badge')!;
        this.fpsTextEl = this.root.querySelector('#hud-fps')!;
        this.tierPillEl = this.root.querySelector('#hud-tier-pill')!;
        this.muteBtnEl = this.root.querySelector('#btn-mute')!;
        this.muteBtnEl.addEventListener('click', () => {
            const nextMuted = this.callbacks.onToggleMute?.();
            if (typeof nextMuted === 'boolean') {
                this.setMutedVisual(nextMuted);
            } else {
                this.setMutedVisual(!this.mutedVisual);
            }
        });

        const qButtons = this.root.querySelectorAll<HTMLButtonElement>('[data-quality-mode]');
        qButtons.forEach((btn) => {
            const mode = btn.dataset.qualityMode as QualityMode;
            this.qualityButtons.set(mode, btn);
            btn.addEventListener('click', () => {
                this.callbacks.onQualityModeChange(mode);
            });
        });

        this.sensSliderEl = this.root.querySelector('#hud-sens-slider')!;
        this.sensValueEl = this.root.querySelector('#hud-sens-value')!;
        this.sensSliderEl.addEventListener('input', () => {
            const val = parseFloat(this.sensSliderEl.value);
            this.sensValueEl.textContent = `${val.toFixed(1)}x`;
            this.callbacks.onSensitivityChange(val);
        });

        this.expansionToggleBtn = this.root.querySelector('#hud-expansion-toggle')!;
        this.expansionDrawerEl = this.root.querySelector('#hud-expansion-drawer')!;
        this.expansionToggleBtn.addEventListener('click', () => {
            this.setExpansionOpen(!this.expansionOpen);
        });

        this.coopBtnEl = this.root.querySelector('#hud-coop-btn')!;
        this.coopDotEl = this.root.querySelector('#hud-coop-dot')!;
        this.coopLabelEl = this.root.querySelector('#hud-coop-label')!;
        this.coopCodeBadgeEl = this.root.querySelector('#hud-coop-code-badge')!;
        this.coopSlotDots = Array.from(
            this.root.querySelectorAll<HTMLElement>('.hud-coop-slot-dot')
        );

        this.coopModalEl = this.root.querySelector('#hud-coop-modal')!;
        this.coopModalStateTagEl = this.root.querySelector('#coop-modal-state-tag')!;
        this.coopLobbyControlsEl = this.root.querySelector('#coop-lobby-controls')!;
        this.coopActiveControlsEl = this.root.querySelector('#coop-active-controls')!;
        this.coopNicknameInput = this.root.querySelector('#coop-nickname-input')!;
        this.coopCreateBtn = this.root.querySelector('#coop-create-btn')!;
        this.coopCodeInput = this.root.querySelector('#coop-code-input')!;
        this.coopJoinBtn = this.root.querySelector('#coop-join-btn')!;
        this.coopRoomCodeDisplayEl = this.root.querySelector('#coop-room-code-display')!;
        this.coopCopyBtn = this.root.querySelector('#coop-copy-btn')!;
        this.coopLeaveBtn = this.root.querySelector('#coop-leave-btn')!;
        this.coopErrorMsgEl = this.root.querySelector('#coop-error-msg')!;
        this.coopPartyListEl = this.root.querySelector('#coop-party-list')!;
        this.coopNetStatsEl = this.root.querySelector('#coop-net-stats')!;

        this.bindCoopEvents();
        this.bindSurvivalEvents();

        this.joystickZoneEl = this.root.querySelector('#joystick-zone')!;
        this.joystickRingEl = this.root.querySelector('#joystick-ring')!;
        this.joystickKnobEl = this.root.querySelector('#joystick-knob')!;

        this.actionPadEl = this.root.querySelector('#hud-action-pad')!;
        this.jumpBtnEl = this.root.querySelector('#btn-jump')!;
        this.sprintBtnEl = this.root.querySelector('#btn-sprint')!;
        this.interactBtnEl = this.root.querySelector('#btn-interact')!;
        this.meleeBtnEl = this.root.querySelector('#btn-melee')!;
        this.rangedBtnEl = this.root.querySelector('#btn-ranged')!;
        this.dodgeBtnEl = this.root.querySelector('#btn-dodge')!;
        this.captureBtnEl = this.root.querySelector('#btn-capture')!;
        this.summonBtnEl = this.root.querySelector('#btn-summon')!;
        // Prevent focused action buttons from intercepting Spacebar jumps
        const actionButtons = [
            this.jumpBtnEl,
            this.sprintBtnEl,
            this.interactBtnEl,
            this.meleeBtnEl,
            this.rangedBtnEl,
            this.dodgeBtnEl,
            this.captureBtnEl,
            this.summonBtnEl,
            this.eatBtnEl,
            this.craftPanelBtnEl,
            this.buildModeBtnEl,
            this.basePanelBtnEl,
            this.buildRotateBtnEl,
            this.buildPlaceBtnEl,
            this.buildDemolishBtnEl,
            this.buildCancelBtnEl,
        ];
        for (const btn of actionButtons) {
            btn.addEventListener('focus', () => btn.blur());
        }

        this.nearbyHintEl = this.root.querySelector('#hud-nearby-hint')!;
        this.toastEl = this.root.querySelector('#hud-toast')!;
    }

    private bindCoopEvents(): void {
        this.coopBtnEl.addEventListener('click', () => {
            this.setCoopModalOpen(!this.coopModalOpen);
        });

        const closeBtn = this.root.querySelector('#coop-modal-close')!;
        closeBtn.addEventListener('click', () => {
            this.setCoopModalOpen(false);
        });

        this.coopCodeInput.addEventListener('input', () => {
            const sanitized = sanitizeRoomCode(this.coopCodeInput.value);
            if (this.coopCodeInput.value !== sanitized) {
                this.coopCodeInput.value = sanitized;
            }
            if (this.localValidationError) {
                this.localValidationError = null;
            }
        });

        this.coopCreateBtn.addEventListener('click', () => {
            this.localValidationError = null;
            const nickname = this.readNicknameValue();
            this.coopNicknameInput.blur();
            this.callbacks.onCreateRoom?.(nickname);
        });

        const submitJoin = () => {
            const code = sanitizeRoomCode(this.coopCodeInput.value);
            this.coopCodeInput.value = code;
            if (!isValidRoomCode(code)) {
                this.localValidationError = '방 코드는 영문/숫자 3~12자여야 합니다.';
                this.renderCoopError(this.localValidationError, false);
                return;
            }
            this.localValidationError = null;
            const nickname = this.readNicknameValue();
            this.coopCodeInput.blur();
            this.coopNicknameInput.blur();
            this.callbacks.onJoinRoom?.(code, nickname);
        };

        this.coopJoinBtn.addEventListener('click', submitJoin);
        this.coopCodeInput.addEventListener('keydown', (e: KeyboardEvent) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                submitJoin();
            }
        });
        this.coopNicknameInput.addEventListener('keydown', (e: KeyboardEvent) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                this.coopNicknameInput.blur();
            }
        });

        this.coopCopyBtn.addEventListener('click', () => {
            const code = this.coopRoomCodeDisplayEl.textContent?.trim() ?? '';
            if (!code || code === '------') return;
            const inviteUrl = this.buildInviteUrl(code);
            void this.copyToClipboard(inviteUrl).then((copied) => {
                if (copied) {
                    this.showToast(`초대 링크 복사됨: ?room=${code}`, 2400, 'success');
                    this.coopCopyBtn.textContent = '복사됨 ✓';
                    if (this.copyFeedbackTimer !== null) {
                        window.clearTimeout(this.copyFeedbackTimer);
                    }
                    this.copyFeedbackTimer = window.setTimeout(() => {
                        this.coopCopyBtn.textContent = '링크 복사';
                        this.copyFeedbackTimer = null;
                    }, 1600);
                } else {
                    this.showToast(`방 코드: ${code}`, 2600, 'info');
                }
            });
        });

        this.coopLeaveBtn.addEventListener('click', () => {
            this.localValidationError = null;
            this.callbacks.onLeaveRoom?.();
        });
    }

    private hasActiveInputManager(): boolean {
        return Boolean((window as unknown as { __ZAAP_INPUT__?: unknown }).__ZAAP_INPUT__);
    }

    private bindSurvivalEvents(): void {
        // Standalone fallback listeners when InputManager is not active; when InputManager is mounted,
        // pointer/keyboard events route cleanly through sampleFrame() -> main.ts to prevent double-firing.
        this.eatBtnEl.addEventListener('click', () => {
            if (!this.hasActiveInputManager()) {
                this.callbacks.onEatFood?.();
            }
        });
        this.craftPanelBtnEl.addEventListener('click', () => {
            if (!this.hasActiveInputManager()) {
                this.toggleCraftDrawer();
            }
        });
        this.buildModeBtnEl.addEventListener('click', () => {
            if (!this.hasActiveInputManager()) {
                this.callbacks.onToggleBuildMode?.();
            }
        });
        this.basePanelBtnEl.addEventListener('click', () => {
            if (!this.hasActiveInputManager()) {
                this.toggleBaseDrawer();
            }
        });
        this.buildRotateBtnEl.addEventListener('click', () => {
            if (!this.hasActiveInputManager()) {
                this.callbacks.onBuildRotate?.();
            }
        });
        this.buildPlaceBtnEl.addEventListener('click', () => {
            if (!this.hasActiveInputManager()) {
                this.callbacks.onBuildPlace?.();
            }
        });
        this.buildDemolishBtnEl.addEventListener('click', () => {
            if (!this.hasActiveInputManager()) {
                this.callbacks.onBuildDemolish?.();
            }
        });

        this.buildCancelBtnEl.addEventListener('click', () => {
            this.callbacks.onToggleBuildMode?.(false);
        });

        for (const [recipeId, btn] of this.buildRecipeBtns.entries()) {
            btn.addEventListener('click', () => {
                this.callbacks.onSelectBuildRecipe?.(recipeId);
            });
        }

        this.craftDrawerEl.addEventListener('click', (e: MouseEvent) => {
            const target = e.target as HTMLElement | null;
            if (!target) return;

            if (target.closest('#btn-craft-close')) {
                this.toggleCraftDrawer(false);
                return;
            }
            const craftBtn = target.closest<HTMLElement>('[data-craft-recipe]');
            if (craftBtn?.dataset.craftRecipe) {
                this.callbacks.onCraftItem?.(craftBtn.dataset.craftRecipe as CraftRecipeId);
                return;
            }
            const equipBtn = target.closest<HTMLElement>('[data-equip-tool]');
            if (equipBtn?.dataset.equipTool) {
                this.callbacks.onEquipTool?.(equipBtn.dataset.equipTool as ToolId);
                return;
            }
            if (target.closest('[data-rest-bed]')) {
                this.callbacks.onRestBed?.();
            }
        });

        this.baseDrawerEl.addEventListener('click', (e: MouseEvent) => {
            const target = e.target as HTMLElement | null;
            if (!target) return;

            if (target.closest('#btn-base-close')) {
                this.toggleBaseDrawer(false);
                return;
            }
            const assignBtn = target.closest<HTMLElement>('[data-worker-assign]');
            if (assignBtn?.dataset.workerAssign) {
                this.callbacks.onAssignBaseWorker?.(assignBtn.dataset.workerAssign);
                return;
            }
            const unassignBtn = target.closest<HTMLElement>('[data-worker-unassign]');
            if (unassignBtn?.dataset.workerUnassign) {
                this.callbacks.onUnassignBaseWorker?.(unassignBtn.dataset.workerUnassign);
            }
        });
    }

    private handleKeyDown(e: KeyboardEvent): void {
        const activeTag = document.activeElement?.tagName;
        const isTyping =
            activeTag === 'INPUT' || activeTag === 'TEXTAREA' || activeTag === 'SELECT';

        if (e.code === 'Escape') {
            if (isTyping && document.activeElement instanceof HTMLElement) {
                document.activeElement.blur();
            }
            if (this.coopModalOpen) {
                this.setCoopModalOpen(false);
            } else if (this.craftDrawerOpen) {
                this.toggleCraftDrawer(false);
            } else if (this.baseDrawerOpen) {
                this.toggleBaseDrawer(false);
            } else if (this.expansionOpen) {
                this.setExpansionOpen(false);
            } else if (this.latestSurvivalState?.buildMode) {
                this.callbacks.onToggleBuildMode?.(false);
            }
            return;
        }

        if (isTyping || e.repeat || e.ctrlKey || e.metaKey || e.altKey) {
            return;
        }
        if (this.hasActiveInputManager()) {
            return;
        }

        if (e.code === 'KeyC') {
            this.toggleCraftDrawer();
        } else if (e.code === 'KeyP') {
            this.toggleBaseDrawer();
        }
    }

    private updateSurvivalUi(
        survival: HudSurvivalState | null,
        buttons: ActionButtonStates
    ): void {
        this.latestSurvivalState = survival;

        const inventory = survival?.sharedResources ?? createDefaultSharedResources();
        for (const { key } of RESOURCE_ORDER) {
            const valEl = this.resourceValueEls.get(key);
            if (valEl) {
                valEl.textContent = String(Math.max(0, Math.floor(inventory[key] ?? 0)));
            }
        }

        this.eatBtnEl.classList.toggle('pressed', Boolean(buttons.eatActive));
        this.craftPanelBtnEl.classList.toggle('pressed', Boolean(buttons.craftPanelActive));
        this.buildModeBtnEl.classList.toggle('pressed', Boolean(buttons.buildModeActive));
        this.basePanelBtnEl.classList.toggle('pressed', Boolean(buttons.basePanelActive));
        this.buildRotateBtnEl.classList.toggle('pressed', Boolean(buttons.buildRotateActive));
        this.buildPlaceBtnEl.classList.toggle('pressed', Boolean(buttons.buildPlaceActive));
        this.buildDemolishBtnEl.classList.toggle('pressed', Boolean(buttons.buildDemolishActive));

        this.setBuildModeVisual(Boolean(survival?.buildMode));

        if (!survival) {
            this.survivalContextEl.classList.remove('visible');
            this.updateSurvivalPlates([]);
            if (this.craftDrawerOpen) {
                this.renderCraftDrawer(null);
            }
            if (this.baseDrawerOpen) {
                this.renderBaseDrawer(null);
            }
            return;
        }

        this.updateBuildDock(survival, inventory);
        this.updateSurvivalPlates(survival.plates);

        let contextText = '';
        if (survival.buildMode) {
            const pieceLabel =
                BUILD_PILL_LABELS_KO[survival.selectedBuildRecipe] ?? survival.selectedBuildRecipe;
            const statusText = survival.buildPreviewValid
                ? '배치 가능'
                : translateBuildReasonKo(survival.buildPreviewReason);
            contextText = `건축: ${pieceLabel} (${survival.buildRotationDeg}°) · ${statusText}`;
        } else if (survival.hasBedNear) {
            contextText = `${survival.nearestStructureLabel ?? '건초 침대'} · 제작(C)에서 [침대 휴식] 또는 [X 철거]`;
        } else if (survival.nearestResourceLabel) {
            contextText = `${survival.nearestResourceLabel} [E/공격 채집]`;
        } else if (survival.nearestStructureLabel) {
            contextText = `${survival.nearestStructureLabel} [X 철거]`;
        }

        if (contextText) {
            this.survivalContextEl.textContent = contextText;
            this.survivalContextEl.classList.add('visible');
        } else {
            this.survivalContextEl.classList.remove('visible');
        }

        if (this.craftDrawerOpen) {
            this.renderCraftDrawer(survival);
        }
        if (this.baseDrawerOpen) {
            this.renderBaseDrawer(survival);
        }
    }

    private updateBuildDock(
        survival: HudSurvivalState,
        inventory: SharedResourceInventory
    ): void {
        for (const recipe of MODULAR_STRUCTURE_RECIPE_LIST) {
            const btn = this.buildRecipeBtns.get(recipe.recipeId);
            if (!btn) continue;
            const isSelected = survival.selectedBuildRecipe === recipe.recipeId;
            const affordable = hasEnoughResources(inventory, recipe.cost);
            btn.classList.toggle('active', isSelected);
            btn.classList.toggle('insufficient', !affordable);
            const costSummary = (Object.entries(recipe.cost) as Array<[ResourceKind, number | undefined]>)
                .filter(([, amount]) => typeof amount === 'number' && amount > 0)
                .map(([k, amount]) => `${RESOURCE_LABELS_KO[k]} ${amount}`)
                .join(' ');
            btn.title = `${recipe.nameKo} (${costSummary})`;
        }

        const deg = ((Math.round(survival.buildRotationDeg) % 360) + 360) % 360;
        const statusMsg = survival.buildPreviewValid
            ? `${deg}° · 설치 가능`
            : `${deg}° · ${translateBuildReasonKo(survival.buildPreviewReason)}`;
        this.buildStatusEl.textContent = statusMsg;
        this.buildStatusEl.classList.toggle('invalid', !survival.buildPreviewValid);
        this.buildPlaceBtnEl.classList.toggle('valid', survival.buildPreviewValid);
        this.buildPlaceBtnEl.classList.toggle('invalid', !survival.buildPreviewValid);
        this.buildDemolishBtnEl.classList.toggle('unavailable', !survival.nearestStructureId);
    }

    private renderCraftDrawer(survival: HudSurvivalState | null): void {
        const inventory = survival?.sharedResources ?? createDefaultSharedResources();
        const equippedTool: ToolId = survival?.equippedTool ?? 'hands';
        const unlocked = survival?.unlockedTools ?? ['hands'];
        const hasWorkbench = Boolean(survival?.hasWorkbenchNearOrInBase);
        const hasBedNear = Boolean(survival?.hasBedNear);

        const invSig = RESOURCE_ORDER.map(({ key }) => inventory[key] ?? 0).join(',');
        const sig = `${invSig}|${equippedTool}|${unlocked.join(',')}|${hasWorkbench ? 1 : 0}|${hasBedNear ? 1 : 0}`;
        if (sig === this.lastCraftSig) {
            return;
        }
        this.lastCraftSig = sig;

        const cardsHtml = CRAFT_RECIPE_LIST.map((recipe) => {
            const costEntries = Object.entries(recipe.cost) as Array<
                [ResourceKind, number | undefined]
            >;
            const costChips = costEntries
                .filter(([, amt]) => typeof amt === 'number' && amt > 0)
                .map(([kind, amt = 0]) => {
                    const missing = (inventory[kind] ?? 0) < amt;
                    return `<span class="hud-cost-chip${missing ? ' missing' : ''}">${RESOURCE_LABELS_KO[kind]} ${amt}</span>`;
                })
                .join('');

            const wbBadge = recipe.requiresWorkbench
                ? `<span class="hud-wb-chip${hasWorkbench ? ' ok' : ''}">${hasWorkbench ? '작업대 연결' : '작업대 필요'}</span>`
                : '';

            const canCraft =
                hasEnoughResources(inventory, recipe.cost) &&
                (!recipe.requiresWorkbench || hasWorkbench);

            const toolId = recipe.unlocksTool;
            const isUnlocked = toolId ? unlocked.includes(toolId) : false;
            const isEquipped = toolId ? equippedTool === toolId : false;

            const equipBtnHtml = toolId && isUnlocked
                ? `<button class="hud-mini-btn secondary${isEquipped ? ' equipped' : ''}" type="button" data-equip-tool="${toolId}" data-hud-interactive="true">${isEquipped ? `장착 중 (${TOOL_SHORT_KO[toolId]})` : '장착'}</button>`
                : '';

            return `
      <div class="hud-drawer-card">
        <div class="hud-drawer-card-top">
          <div>
            <div class="hud-drawer-card-title">${this.escapeHtml(recipe.nameKo)}</div>
            <div class="hud-drawer-card-sub">${this.escapeHtml(recipe.description)}</div>
          </div>
          <div class="hud-drawer-actions">
            ${equipBtnHtml}
            <button class="hud-mini-btn${canCraft ? '' : ' unavailable'}" type="button" data-craft-recipe="${recipe.recipeId}" data-hud-interactive="true">제작</button>
          </div>
        </div>
        <div class="hud-drawer-chips">${costChips}${wbBadge}</div>
      </div>`;
        }).join('');

        const bedHtml = hasBedNear
            ? `
      <div class="hud-drawer-card">
        <div class="hud-drawer-card-top">
          <div>
            <div class="hud-drawer-card-title">건초 침대 휴식</div>
            <div class="hud-drawer-card-sub">체력과 포만감을 회복하고 밤낮을 안정화합니다.</div>
          </div>
          <div class="hud-drawer-actions">
            <button class="hud-mini-btn secondary" type="button" data-rest-bed="true" data-hud-interactive="true">침대 휴식</button>
          </div>
        </div>
      </div>`
            : '';

        this.craftDrawerEl.innerHTML = `
      <div class="hud-drawer-head">
        <div class="hud-drawer-title">
          <span>제작 &amp; 도구</span>
          <span class="hud-drawer-badge${hasWorkbench ? '' : ' warn'}">${hasWorkbench ? '작업대 연결' : '맨손/휴대 제작'}</span>
        </div>
        <button id="btn-craft-close" class="hud-drawer-close" type="button" data-hud-interactive="true" aria-label="제작창 닫기">×</button>
      </div>
      <div class="hud-drawer-list">
        ${bedHtml}
        ${cardsHtml}
      </div>
    `;
    }

    private renderBaseDrawer(survival: HudSurvivalState | null): void {
        const workers = survival?.baseWorkers ?? [];
        const roster = survival?.capturedRoster ?? [];
        const activeCompanionUid = survival?.activeCompanionUid ?? null;

        const workerSig = workers
            .map((w) => `${w.uid}:${w.aiState}:${w.activeWork ?? ''}:${w.carryingKind ?? ''}`)
            .join(',');
        const rosterSig = roster
            .map((r) => `${r.uid}:${r.species}:${r.nickname}:${r.level}`)
            .join(',');
        const sig = `${workers.length}|${workerSig}|${rosterSig}|${activeCompanionUid ?? ''}|${survival?.placedStructures.length ?? 0}`;

        if (sig === this.lastBaseSig) {
            this.updateBaseWorkerEnergyBars(workers);
            return;
        }
        this.lastBaseSig = sig;

        const workerByUid = new Map<string, BaseWorkerSyncState>();
        for (const w of workers) {
            workerByUid.set(w.uid, w);
        }

        const activeWorkersHtml =
            workers.length === 0
                ? `<div class="hud-drawer-card"><div class="hud-drawer-card-sub">거점에 배치된 일꾼이 없습니다. 아래 보유 동료에서 [거점 배치]를 눌러 자동 채집/운반을 시작하세요.</div></div>`
                : workers
                      .map((w) => {
                          const stateLabel = formatWorkerStateTagKo(w.aiState, w.activeWork);
                          const maxE = Math.max(1, w.maxEnergy || 100);
                          const pct = Math.max(0, Math.min(100, (w.energy / maxE) * 100));
                          const carryInfo =
                              w.carryingKind && w.carryingAmount > 0
                                  ? ` · 운반: ${RESOURCE_LABELS_KO[w.carryingKind]} ${w.carryingAmount}`
                                  : '';
                          return `
      <div class="hud-drawer-card">
        <div class="hud-drawer-card-top">
          <div>
            <div class="hud-drawer-card-title">${this.escapeHtml(formatMonsterNameKo(w.species, w.nickname))} Lv.${w.level}</div>
            <div class="hud-drawer-card-sub">${this.escapeHtml(formatSpeciesSuitabilityKo(w.species))} · ${stateLabel}${carryInfo}</div>
          </div>
          <div class="hud-drawer-actions">
            <button class="hud-mini-btn danger" type="button" data-worker-unassign="${this.escapeHtml(w.uid)}" data-hud-interactive="true">배치 해제</button>
          </div>
        </div>
        <div class="hud-worker-energy-row">
          <span>기력</span>
          <div class="hud-worker-energy-track">
            <div class="hud-worker-energy-fill" data-worker-energy-fill="${this.escapeHtml(w.uid)}" style="width:${pct.toFixed(0)}%"></div>
          </div>
          <span data-worker-energy-text="${this.escapeHtml(w.uid)}">${Math.round(pct)}%</span>
        </div>
      </div>`;
                      })
                      .join('');

        const rosterHtml =
            roster.length === 0
                ? `<div class="hud-drawer-card"><div class="hud-drawer-card-sub">포획한 동료가 아직 없습니다. 야생 몬스터를 약화시킨 뒤 V(포획)로 포획해 거점에 배치하세요.</div></div>`
                : roster
                      .map((rec) => {
                          const assigned = workerByUid.has(rec.uid);
                          const isOut = activeCompanionUid === rec.uid;
                          const canAssign = !assigned && workers.length < MAX_BASE_WORKERS;
                          const btnHtml = assigned
                              ? `<button class="hud-mini-btn danger" type="button" data-worker-unassign="${this.escapeHtml(rec.uid)}" data-hud-interactive="true">배치 해제</button>`
                              : `<button class="hud-mini-btn${canAssign ? '' : ' unavailable'}" type="button" data-worker-assign="${this.escapeHtml(rec.uid)}" data-hud-interactive="true">${isOut ? '동행 중→거점 배치' : '거점 배치'}</button>`;
                          return `
      <div class="hud-drawer-card">
        <div class="hud-drawer-card-top">
          <div>
            <div class="hud-drawer-card-title">${this.escapeHtml(formatMonsterNameKo(rec.species, rec.nickname))} Lv.${rec.level}</div>
            <div class="hud-drawer-card-sub">${this.escapeHtml(formatSpeciesSuitabilityKo(rec.species))}</div>
          </div>
          <div class="hud-drawer-actions">${btnHtml}</div>
        </div>
      </div>`;
                      })
                      .join('');

        this.baseDrawerEl.innerHTML = `
      <div class="hud-drawer-head">
        <div class="hud-drawer-title">
          <span>거점 일꾼 ${workers.length}/${MAX_BASE_WORKERS}</span>
          <span class="hud-drawer-badge">시설 ${survival?.placedStructures.length ?? 0}개</span>
        </div>
        <button id="btn-base-close" class="hud-drawer-close" type="button" data-hud-interactive="true" aria-label="거점 창 닫기">×</button>
      </div>
      <div class="hud-drawer-list">
        <div class="hud-drawer-section-label">배치된 거점 일꾼</div>
        ${activeWorkersHtml}
        <div class="hud-drawer-section-label">보유 동료 적성</div>
        ${rosterHtml}
      </div>
    `;
    }

    private updateBaseWorkerEnergyBars(workers: BaseWorkerSyncState[]): void {
        for (const w of workers) {
            const maxE = Math.max(1, w.maxEnergy || 100);
            const pct = Math.max(0, Math.min(100, (w.energy / maxE) * 100));
            const escapedUid = CSS.escape ? CSS.escape(w.uid) : w.uid;
            const fillEl = this.baseDrawerEl.querySelector<HTMLElement>(
                `[data-worker-energy-fill="${escapedUid}"]`
            );
            if (fillEl) {
                fillEl.style.width = `${pct.toFixed(0)}%`;
            }
            const textEl = this.baseDrawerEl.querySelector<HTMLElement>(
                `[data-worker-energy-text="${escapedUid}"]`
            );
            if (textEl) {
                textEl.textContent = `${Math.round(pct)}%`;
            }
        }
    }

    private updateSurvivalPlates(plates: SurvivalPlateInfo[]): void {
        const seen = new Set<string>();

        for (const plate of plates) {
            seen.add(plate.id);
            let entry = this.survivalPlateElements.get(plate.id);
            if (!entry) {
                const root = document.createElement('div');
                root.className = `hud-splate kind-${plate.kind}`;

                const row = document.createElement('div');
                row.className = 'hud-splate-row';
                const label = document.createElement('span');
                const tag = document.createElement('span');
                tag.className = 'hud-splate-tag';
                row.appendChild(label);
                row.appendChild(tag);

                const track = document.createElement('div');
                track.className = 'hud-splate-track';
                const fill = document.createElement('div');
                fill.className = 'hud-splate-fill';
                track.appendChild(fill);

                root.appendChild(row);
                root.appendChild(track);
                this.survivalPlatesContainer.appendChild(root);

                entry = { root, label, tag, track, fill };
                this.survivalPlateElements.set(plate.id, entry);
            }

            if (!plate.visible) {
                entry.root.style.display = 'none';
                continue;
            }

            entry.root.style.display = 'flex';
            entry.root.className = `hud-splate kind-${plate.kind}`;
            entry.label.textContent = plate.label;

            if (plate.stateTag) {
                entry.tag.textContent = plate.stateTag;
                entry.tag.style.display = 'inline-block';
            } else {
                entry.tag.style.display = 'none';
            }

            const ratio =
                typeof plate.hp === 'number' && typeof plate.maxHp === 'number' && plate.maxHp > 0
                    ? Math.max(0, Math.min(1, plate.hp / plate.maxHp))
                    : typeof plate.energy === 'number' &&
                        typeof plate.maxEnergy === 'number' &&
                        plate.maxEnergy > 0
                      ? Math.max(0, Math.min(1, plate.energy / plate.maxEnergy))
                      : null;

            if (ratio !== null) {
                entry.track.style.display = 'block';
                entry.fill.style.width = `${(ratio * 100).toFixed(0)}%`;
            } else {
                entry.track.style.display = 'none';
            }

            const distFade =
                plate.distanceMeters <= 16
                    ? 1
                    : Math.max(0.28, 1 - ((plate.distanceMeters - 16) / 28) * 0.72);
            const scale =
                plate.distanceMeters <= 10
                    ? 1
                    : Math.max(0.78, 1 - (plate.distanceMeters - 10) / 70);

            entry.root.style.left = `${plate.screenX.toFixed(1)}px`;
            entry.root.style.top = `${plate.screenY.toFixed(1)}px`;
            entry.root.style.opacity = distFade.toFixed(2);
            entry.root.style.transform = `translate(-50%, -100%) scale(${scale.toFixed(2)})`;
        }

        for (const [id, entry] of this.survivalPlateElements.entries()) {
            if (!seen.has(id)) {
                entry.root.remove();
                this.survivalPlateElements.delete(id);
            }
        }
    }

    private escapeHtml(value: string): string {
        return value
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    private updateTargetBanner(target: HudLockedTargetInfo | null): void {
        if (!target) {
            this.targetBannerEl.classList.remove('visible');
            return;
        }

        const theme = getSpeciesTheme(target.species);
        this.targetBannerEl.classList.add('visible');

        this.targetSpeciesBadgeEl.textContent = theme.elementLabel;
        this.targetSpeciesBadgeEl.style.color = theme.colorHex;
        this.targetSpeciesBadgeEl.style.background = theme.bgRgba;
        this.targetSpeciesBadgeEl.style.borderColor = theme.borderRgba;

        this.targetNameEl.textContent = `${formatMonsterNameKo(target.species, target.name)} · Lv.${target.level}`;

        const aiKo = MONSTER_AI_STATE_KO[target.aiState] ?? target.aiState.toUpperCase();
        this.targetAiChipEl.textContent = target.lockedByOther ? '타인 포획' : aiKo;
        this.targetAiChipEl.classList.toggle(
            'aggressive',
            target.aiState === 'attack' || target.aiState === 'chase' || target.aiState === 'alert'
        );
        this.targetAiChipEl.classList.toggle(
            'capturing',
            target.aiState === 'capturing' || Boolean(target.capturingByMe)
        );

        const capPct = Math.max(0, Math.min(100, Math.round(target.captureChancePct)));
        this.targetCaptureChipEl.textContent = `포획 ${capPct}%`;

        const safeMax = Math.max(1, target.maxHp);
        const hpRatio = Math.max(0, Math.min(1, target.hp / safeMax));
        this.targetHpFillEl.style.width = `${(hpRatio * 100).toFixed(1)}%`;
        if (hpRatio <= 0.28) {
            this.targetHpFillEl.style.background = 'linear-gradient(90deg, #ef4444, #f97316)';
        } else if (hpRatio <= 0.6) {
            this.targetHpFillEl.style.background = 'linear-gradient(90deg, #f59e0b, #fbbf24)';
        } else {
            this.targetHpFillEl.style.background = `linear-gradient(90deg, ${theme.colorHex}, #34d399)`;
        }

        this.targetHpTextEl.textContent = `${Math.max(0, Math.round(target.hp))}/${Math.round(safeMax)} · ${target.distanceMeters.toFixed(1)}m`;
    }

    private updateCompanionStrip(companions: HudCompanionSnapshot | null): void {
        if (!companions) {
            if (this.lastCompanionSig !== 'none') {
                this.lastCompanionSig = 'none';
                this.companionStripEl.innerHTML = '';
            }
            return;
        }

        const visibleRoster = companions.roster.slice(0, 4);
        const sig = visibleRoster.length === 0
            ? 'empty'
            : visibleRoster
                  .map((r, i) => {
                      const isActive = r.uid === companions.activeUid;
                      const hpVal = isActive && typeof companions.activeHp === 'number'
                          ? Math.round(companions.activeHp)
                          : Math.round(r.hp);
                      return `${i}:${r.uid}:${r.nickname}:${r.level}:${hpVal}:${r.maxHp}:${isActive ? 1 : 0}:${companions.selectedIndex === i ? 1 : 0}:${isActive ? companions.activeState ?? '' : ''}`;
                  })
                  .join('|');

        if (sig === this.lastCompanionSig) {
            return;
        }
        this.lastCompanionSig = sig;
        this.companionStripEl.innerHTML = '';

        if (visibleRoster.length === 0) {
            const emptyPill = document.createElement('div');
            emptyPill.className = 'hud-comp-empty hud-glass';
            emptyPill.textContent = '파티: 0/4 · 약화 후 V/포획';
            this.companionStripEl.appendChild(emptyPill);
            return;
        }

        visibleRoster.forEach((rec, index) => {
            const theme = getSpeciesTheme(rec.species);
            const isActive = rec.uid === companions.activeUid;
            const isSelected = index === companions.selectedIndex;

            const chip = document.createElement('button');
            chip.type = 'button';
            chip.className = 'hud-comp-chip';
            chip.setAttribute('data-hud-interactive', 'true');
            chip.setAttribute('data-companion-index', String(index));
            if (isActive) chip.classList.add('active');
            if (isSelected) chip.classList.add('selected');

            const dot = document.createElement('span');
            dot.className = 'hud-comp-dot';
            dot.style.background = theme.colorHex;
            dot.style.boxShadow = `0 0 7px ${theme.colorHex}`;

            const meta = document.createElement('div');
            meta.className = 'hud-comp-meta';

            const title = document.createElement('span');
            title.className = 'hud-comp-title';
            title.textContent = `${formatMonsterNameKo(rec.species, rec.nickname)} Lv.${rec.level}`;

            const track = document.createElement('span');
            track.className = 'hud-comp-hp-track';
            const fill = document.createElement('span');
            fill.className = 'hud-comp-hp-fill';
            const hp = isActive && typeof companions.activeHp === 'number' ? companions.activeHp : rec.hp;
            const maxHp = isActive && typeof companions.activeMaxHp === 'number' ? companions.activeMaxHp : rec.maxHp;
            const pct = Math.max(0, Math.min(100, (hp / Math.max(1, maxHp)) * 100));
            fill.style.width = `${pct.toFixed(0)}%`;
            fill.style.background = theme.colorHex;
            track.appendChild(fill);

            meta.appendChild(title);
            meta.appendChild(track);

            const badge = document.createElement('span');
            badge.className = 'hud-comp-badge';
            badge.textContent = isActive ? '출전' : `${index + 1}`;

            chip.appendChild(dot);
            chip.appendChild(meta);
            chip.appendChild(badge);

            chip.addEventListener('click', () => {
                this.callbacks.onSelectCompanion?.(index, rec.uid);
                this.callbacks.onSummonOrRecallCompanion?.(rec.uid);
            });

            this.companionStripEl.appendChild(chip);
        });
    }

    private updateMonsterPlates(
        plates: HudMonsterPlateInfo[],
        lockedTargetId: string | null = null
    ): void {
        const seen = new Set<string>();

        for (const plate of plates) {
            seen.add(plate.id);
            let entry = this.monsterPlateElements.get(plate.id);
            if (!entry) {
                const root = document.createElement('div');
                root.className = 'hud-mplate';

                const head = document.createElement('div');
                head.className = 'hud-mplate-head';
                const left = document.createElement('div');
                left.className = 'hud-mplate-left';
                const dot = document.createElement('span');
                dot.className = 'hud-mplate-dot';
                const name = document.createElement('span');
                name.className = 'hud-mplate-name';
                const lv = document.createElement('span');
                lv.className = 'hud-mplate-lv';
                left.appendChild(dot);
                left.appendChild(name);
                head.appendChild(left);
                head.appendChild(lv);

                const track = document.createElement('div');
                track.className = 'hud-mplate-track';
                const fill = document.createElement('div');
                fill.className = 'hud-mplate-fill';
                track.appendChild(fill);

                const tag = document.createElement('div');
                tag.className = 'hud-mplate-tag';

                root.appendChild(head);
                root.appendChild(track);
                root.appendChild(tag);
                this.monsterPlatesContainer.appendChild(root);

                entry = { root, dot, name, lv, fill, tag };
                this.monsterPlateElements.set(plate.id, entry);
            }

            if (!plate.visible || plate.aiState === 'dead' || plate.aiState === 'captured') {
                entry.root.style.display = 'none';
                continue;
            }

            const theme = getSpeciesTheme(plate.species);
            entry.root.style.display = 'flex';
            const isTargeted =
                Boolean(plate.isTargeted) ||
                (lockedTargetId !== null && plate.id === lockedTargetId && !plate.isCompanion);
            entry.root.classList.toggle('targeted', isTargeted);
            entry.root.classList.toggle('companion', Boolean(plate.isCompanion));

            entry.dot.style.background = theme.colorHex;
            entry.dot.style.boxShadow = `0 0 6px ${theme.colorHex}`;
            entry.name.textContent = formatMonsterNameKo(plate.species, plate.name);
            entry.lv.textContent = plate.isCompanion ? '동료' : `Lv.${plate.level}`;

            const pct = Math.max(0, Math.min(100, (plate.hp / Math.max(1, plate.maxHp)) * 100));
            entry.fill.style.width = `${pct.toFixed(1)}%`;
            entry.fill.style.background = plate.isCompanion
                ? '#2dd4bf'
                : pct <= 28
                  ? '#ef4444'
                  : pct <= 58
                    ? '#f59e0b'
                    : theme.colorHex;

            if (plate.aiState === 'capturing') {
                entry.tag.textContent = '포획 중...';
                entry.tag.classList.add('visible');
            } else if (plate.aiState === 'flee') {
                entry.tag.textContent = '도주 중';
                entry.tag.classList.add('visible');
            } else if (plate.aiState === 'attack') {
                entry.tag.textContent = '공격!';
                entry.tag.classList.add('visible');
            } else {
                entry.tag.classList.remove('visible');
            }

            const distFade =
                plate.distanceMeters <= 20
                    ? 1
                    : Math.max(0.25, 1 - ((plate.distanceMeters - 20) / 30) * 0.75);
            const scale =
                plate.distanceMeters <= 10
                    ? 1
                    : Math.max(0.76, 1 - (plate.distanceMeters - 10) / 65);

            entry.root.style.left = `${plate.screenX.toFixed(1)}px`;
            entry.root.style.top = `${plate.screenY.toFixed(1)}px`;
            entry.root.style.opacity = distFade.toFixed(2);
            entry.root.style.transform = `translate(-50%, -100%) scale(${scale.toFixed(2)})`;
        }

        for (const [id, entry] of this.monsterPlateElements.entries()) {
            if (!seen.has(id)) {
                entry.root.remove();
                this.monsterPlateElements.delete(id);
            }
        }
    }

    private updateCombatPopups(popups: HudCombatPopupInfo[]): void {
        const seen = new Set<string>();

        for (const popup of popups) {
            seen.add(popup.id);
            let el = this.combatPopupElements.get(popup.id);
            if (!el) {
                el = document.createElement('div');
                el.className = 'hud-cpopup';
                this.combatPopupsContainer.appendChild(el);
                this.combatPopupElements.set(popup.id, el);
            }

            if (!popup.visible) {
                el.style.display = 'none';
                continue;
            }

            el.style.display = 'block';
            el.className = `hud-cpopup kind-${popup.kind}`;
            el.textContent = popup.text;

            const age = Math.max(0, Math.min(1, popup.ageRatio));
            const risePx = age * 36;
            const opacity = age < 0.65 ? 1 : Math.max(0, 1 - (age - 0.65) / 0.35);
            const scale = age < 0.15 ? 0.85 + (age / 0.15) * 0.3 : 1.15 - age * 0.15;

            el.style.left = `${popup.screenX.toFixed(1)}px`;
            el.style.top = `${(popup.screenY - risePx).toFixed(1)}px`;
            el.style.opacity = opacity.toFixed(2);
            el.style.transform = `translate(-50%, -50%) scale(${scale.toFixed(2)})`;
        }

        for (const [id, el] of this.combatPopupElements.entries()) {
            if (!seen.has(id)) {
                el.remove();
                this.combatPopupElements.delete(id);
            }
        }
    }

    private readNicknameValue(): string {
        const cleaned = this.coopNicknameInput.value
            .trim()
            .replace(/\s+/g, ' ')
            .slice(0, 16);
        const finalName = cleaned.length > 0 ? cleaned : '탐험가';
        this.coopNicknameInput.value = finalName;
        return finalName;
    }

    private buildInviteUrl(roomCode: string): string {
        try {
            const url = new URL(window.location.href);
            url.searchParams.set('room', roomCode);
            return url.toString();
        } catch {
            return `?room=${encodeURIComponent(roomCode)}`;
        }
    }

    private async copyToClipboard(text: string): Promise<boolean> {
        try {
            if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
                await navigator.clipboard.writeText(text);
                return true;
            }
        } catch {
            // Fall through to execCommand fallback
        }
        try {
            const textarea = document.createElement('textarea');
            textarea.value = text;
            textarea.setAttribute('readonly', '');
            textarea.style.position = 'fixed';
            textarea.style.left = '-9999px';
            document.body.appendChild(textarea);
            textarea.select();
            const ok = document.execCommand('copy');
            document.body.removeChild(textarea);
            return ok;
        } catch {
            return false;
        }
    }

    private setExpansionOpen(open: boolean): void {
        if (open) {
            if (this.coopModalOpen) this.setCoopModalOpen(false);
            if (this.craftDrawerOpen) this.toggleCraftDrawer(false);
            if (this.baseDrawerOpen) this.toggleBaseDrawer(false);
        }
        this.expansionOpen = open;
        this.expansionDrawerEl.classList.toggle('open', open);
        this.expansionToggleBtn.textContent = open ? '확장 ▴' : '확장 ▾';
        if (open) {
            this.clampExpansionDrawerHeight();
        } else {
            this.expansionDrawerEl.style.maxHeight = '';
        }
    }

    private updateCoopUi(status: CoopSessionStatus): void {
        if (
            !this.nicknameSyncedFromStatus &&
            document.activeElement !== this.coopNicknameInput &&
            status.localDisplayName
        ) {
            this.coopNicknameInput.value = status.localDisplayName.slice(0, 16);
            this.nicknameSyncedFromStatus = true;
        }

        const localPalette = SLOT_PALETTE[status.localSlotIndex] ?? SLOT_PALETTE[0];
        if (status.state === 'connected') {
            this.avatarDotEl.style.background = localPalette.hex;
            this.avatarDotEl.style.boxShadow = `0 0 10px ${localPalette.hex}`;
        } else {
            this.avatarDotEl.style.background = '';
            this.avatarDotEl.style.boxShadow = '';
        }

        const isConnected = status.state === 'connected';
        const isSyncing =
            status.state === 'connecting' || status.state === 'reconnecting';

        this.coopDotEl.classList.toggle('connected', isConnected);
        this.coopDotEl.classList.toggle('syncing', isSyncing);

        if (isConnected) {
            const rttText = `${Math.max(0, Math.round(status.metrics.rttMs))}ms`;
            this.coopLabelEl.textContent = `협동 LIVE ${status.connectedPlayers}/${status.maxPartyPlayers} · ${rttText}`;
        } else if (isSyncing) {
            this.coopLabelEl.textContent = '동기화 중...';
        } else {
            this.coopLabelEl.textContent = '오프라인';
        }

        if (status.roomCode && status.state !== 'offline') {
            this.coopCodeBadgeEl.textContent = status.roomCode;
            this.coopCodeBadgeEl.classList.add('visible');
        } else {
            this.coopCodeBadgeEl.textContent = '';
            this.coopCodeBadgeEl.classList.remove('visible');
        }

        for (let i = 0; i < MAX_PARTY_PLAYERS; i++) {
            const dot = this.coopSlotDots[i];
            if (!dot) continue;
            const slotIdx = i as PlayerSlotIndex;
            const player = status.players.find((p) => p.slotIndex === slotIdx);
            const palette = SLOT_PALETTE[slotIdx];
            if (player) {
                dot.style.background = palette.hex;
                dot.style.boxShadow = `0 0 6px ${palette.hex}`;
                dot.classList.add('active');
                dot.classList.toggle('reconnecting', !player.connected);
            } else {
                dot.style.background = '';
                dot.style.boxShadow = '';
                dot.classList.remove('active', 'reconnecting');
            }
        }

        this.coopModalStateTagEl.classList.toggle('connected', isConnected);
        this.coopModalStateTagEl.classList.toggle('syncing', isSyncing);
        if (isConnected) {
            this.coopModalStateTagEl.textContent = `협동 LIVE ${status.connectedPlayers}/${status.maxPartyPlayers}`;
        } else if (status.state === 'reconnecting') {
            this.coopModalStateTagEl.textContent = '재접속 중';
        } else if (status.state === 'connecting') {
            this.coopModalStateTagEl.textContent = '연결 중';
        } else {
            this.coopModalStateTagEl.textContent = '오프라인';
        }

        const inActiveRoom = Boolean(status.roomCode && status.state !== 'offline');
        this.coopLobbyControlsEl.classList.toggle('hidden', inActiveRoom);
        this.coopActiveControlsEl.classList.toggle('hidden', !inActiveRoom);

        this.coopCreateBtn.disabled = status.state === 'connecting';
        this.coopJoinBtn.disabled = status.state === 'connecting';

        if (inActiveRoom && status.roomCode) {
            this.coopRoomCodeDisplayEl.textContent = status.roomCode;
        } else {
            this.coopRoomCodeDisplayEl.textContent = '------';
        }

        if (status.lastError) {
            this.localValidationError = null;
            this.renderCoopError(status.lastError, false);
        } else if (this.localValidationError) {
            this.renderCoopError(this.localValidationError, false);
        } else if (status.state === 'reconnecting' && status.roomCode) {
            this.renderCoopError(
                `방 ${status.roomCode} 연결 복구 중...`,
                true
            );
        } else {
            this.renderCoopError(null, false);
        }

        const partySig = this.buildPartySignature(status);
        if (partySig !== this.lastPartySignature) {
            this.lastPartySignature = partySig;
            this.renderPartyList(status);
        }

        const rttMs = Math.max(0, Math.round(status.metrics.rttMs));
        const txKb = (status.metrics.bytesSentPerSec / 1024).toFixed(1);
        const rxKb = (status.metrics.bytesReceivedPerSec / 1024).toFixed(1);
        const tickHz = Math.round(status.metrics.tickRateHz);
        this.coopNetStatsEl.innerHTML = `<span>지연: ${rttMs}ms${tickHz > 0 ? ` · ${tickHz}Hz` : ''}</span><span>↑ ${txKb} KB/s · ↓ ${rxKb} KB/s</span>`;
    }

    private renderCoopError(message: string | null, isWarning: boolean): void {
        if (!message) {
            this.coopErrorMsgEl.textContent = '';
            this.coopErrorMsgEl.classList.remove('visible', 'warning');
            return;
        }
        this.coopErrorMsgEl.textContent = message;
        this.coopErrorMsgEl.classList.add('visible');
        this.coopErrorMsgEl.classList.toggle('warning', isWarning);
    }

    private buildPartySignature(status: CoopSessionStatus): string {
        const slotParts: string[] = [];
        for (let i = 0; i < MAX_PARTY_PLAYERS; i++) {
            const p = status.players.find((entry) => entry.slotIndex === i);
            if (!p) {
                slotParts.push(`${i}:empty`);
            } else {
                slotParts.push(
                    `${i}:${p.playerId}:${p.displayName}:${p.animState}:${p.connected ? 1 : 0}:${p.crystalsCollected}`
                );
            }
        }
        return `${status.state}|${status.localPlayerId}|${status.localDisplayName}|${slotParts.join('|')}`;
    }

    private renderPartyList(status: CoopSessionStatus): void {
        this.coopPartyListEl.innerHTML = '';

        for (let i = 0; i < MAX_PARTY_PLAYERS; i++) {
            const slotIdx = i as PlayerSlotIndex;
            const palette = SLOT_PALETTE[slotIdx];
            const player: PlayerSyncState | undefined = status.players.find(
                (p) => p.slotIndex === slotIdx
            );

            const row = document.createElement('div');
            row.className = 'coop-party-row';

            const left = document.createElement('div');
            left.className = 'coop-party-left';

            const badge = document.createElement('span');
            badge.className = 'coop-slot-badge';
            badge.textContent = `${slotIdx + 1}`;
            badge.style.background = palette.hex;

            const nameSpan = document.createElement('span');
            nameSpan.className = 'coop-party-name';

            const right = document.createElement('div');
            right.className = 'coop-party-right';

            const stateSpan = document.createElement('span');
            stateSpan.className = 'coop-party-state';

            if (player) {
                const isLocal = player.playerId === status.localPlayerId;
                nameSpan.textContent = isLocal
                    ? `${player.displayName} (나)`
                    : player.displayName;
                if (!player.connected) {
                    row.classList.add('reconnecting');
                    stateSpan.classList.add('reconnecting');
                    stateSpan.textContent = '재접속 중';
                } else {
                    const animKo =
                        PLAYER_STATE_KO[player.animState as PlayerTelemetry['state']] ??
                        player.animState;
                    stateSpan.textContent = animKo;
                }
            } else if (status.state === 'offline' && slotIdx === 0) {
                nameSpan.textContent = `${status.localDisplayName} (나)`;
                stateSpan.classList.add('empty');
                stateSpan.textContent = '오프라인';
            } else {
                row.classList.add('empty');
                nameSpan.textContent = '빈 슬롯';
                stateSpan.classList.add('empty');
                stateSpan.textContent = '대기';
            }

            left.appendChild(badge);
            left.appendChild(nameSpan);
            right.appendChild(stateSpan);
            row.appendChild(left);
            row.appendChild(right);
            this.coopPartyListEl.appendChild(row);
        }
    }

    private updateRemoteNameplates(nameplates: RemoteNameplateInfo[]): void {
        const seenIds = new Set<string>();

        for (const info of nameplates) {
            seenIds.add(info.playerId);
            let entry = this.nameplateElements.get(info.playerId);
            if (!entry) {
                const root = document.createElement('div');
                root.className = 'hud-nameplate';
                const dot = document.createElement('span');
                dot.className = 'hud-np-dot';
                const name = document.createElement('span');
                name.className = 'hud-np-name';
                const reconn = document.createElement('span');
                reconn.className = 'hud-np-reconn';
                reconn.textContent = '(재접속 중)';
                root.appendChild(dot);
                root.appendChild(name);
                root.appendChild(reconn);
                this.nameplatesContainer.appendChild(root);
                entry = { root, dot, name, reconn };
                this.nameplateElements.set(info.playerId, entry);
            }

            if (!info.visible) {
                entry.root.style.display = 'none';
                continue;
            }

            entry.root.style.display = 'inline-flex';
            entry.dot.style.background = info.colorHex;
            entry.dot.style.boxShadow = `0 0 8px ${info.colorHex}`;
            entry.name.textContent = info.displayName;
            entry.reconn.style.display = info.connected ? 'none' : 'inline';
            entry.root.classList.toggle('reconnecting', !info.connected);

            const distFade =
                info.distanceMeters <= 22
                    ? 1
                    : Math.max(0.28, 1 - ((info.distanceMeters - 22) / 68) * 0.72);
            const opacity = info.connected ? distFade : Math.min(distFade, 0.65);
            const scale =
                info.distanceMeters <= 12
                    ? 1
                    : Math.max(0.8, 1 - (info.distanceMeters - 12) / 140);

            entry.root.style.left = `${info.screenX}px`;
            entry.root.style.top = `${info.screenY}px`;
            entry.root.style.opacity = opacity.toFixed(2);
            entry.root.style.transform = `translate(-50%, -100%) scale(${scale.toFixed(2)})`;
        }

        for (const [playerId, entry] of this.nameplateElements.entries()) {
            if (!seenIds.has(playerId)) {
                entry.root.remove();
                this.nameplateElements.delete(playerId);
            }
        }
    }

    private clampExpansionDrawerHeight(): void {
        if (!this.expansionOpen) return;
        this.expansionDrawerEl.style.maxHeight = '';
        const drawerRect = this.expansionDrawerEl.getBoundingClientRect();
        const padRect = this.actionPadEl.getBoundingClientRect();
        if (drawerRect.top <= 0 || padRect.top <= 0) return;
        const available = Math.floor(padRect.top - drawerRect.top - 12);
        const cap = Math.min(Math.floor(window.innerHeight * 0.5), available);
        this.expansionDrawerEl.style.maxHeight = `${Math.max(64, cap)}px`;
    }

    private clampCoopModalBounds(): void {
        if (!this.coopModalOpen) return;
        this.coopModalEl.style.top = '';
        this.coopModalEl.style.maxHeight = '';

        if (window.innerHeight <= 440) {
            const topLeftEl = this.root.querySelector('#hud-top-left');
            const topRightEl = this.root.querySelector('#hud-top-right');
            const topLeftBottom = topLeftEl?.getBoundingClientRect().bottom ?? 86;
            const topRightBottom = topRightEl?.getBoundingClientRect().bottom ?? 90;
            const btnBottom = this.coopBtnEl.getBoundingClientRect().bottom ?? 38;
            const minTop = Math.max(
                96,
                Math.ceil(Math.max(topLeftBottom, topRightBottom, btnBottom) + 6)
            );
            const maxH = Math.max(128, window.innerHeight - minTop - 10);
            this.coopModalEl.style.top = `${minTop}px`;
            this.coopModalEl.style.maxHeight = `${maxH}px`;
        }
    }

    private updateOrientationBanner(): void {
        const isPortrait = window.innerHeight > window.innerWidth;
        if (!isPortrait) {
            this.portraitBanner.classList.remove('visible');
            return;
        }
        this.portraitBanner.classList.toggle('visible', !this.portraitDismissed);
    }

    private positionRestingJoystick(): void {
        const rect = this.joystickZoneEl.getBoundingClientRect();
        const cx = rect.width > 0 ? rect.left + rect.width * 0.48 : 82;
        const cy = rect.height > 0 ? rect.top + rect.height * 0.54 : window.innerHeight - 82;
        this.joystickRingEl.style.left = `${cx}px`;
        this.joystickRingEl.style.top = `${cy}px`;
        this.joystickKnobEl.style.left = `${cx}px`;
        this.joystickKnobEl.style.top = `${cy}px`;
    }

    private renderExpansionSummary(summary: ExpansionSummary, capturedCount: number): void {
        const speciesNames = summary.monsters.species
            .map((s) => formatMonsterNameKo(s.speciesId as MonsterSpeciesId, s.name))
            .join(', ');
        const recipeNames = MODULAR_STRUCTURE_RECIPE_LIST.map(
            (r) => BUILD_PILL_LABELS_KO[r.recipeId] ?? r.nameKo
        ).join(', ');

        const stateLabel =
            summary.coop.status.state === 'connected'
                ? '연결됨'
                : summary.coop.status.state === 'connecting' ||
                    summary.coop.status.state === 'reconnecting'
                  ? '동기화 중'
                  : '오프라인';

        this.expansionDrawerEl.innerHTML = `
      <div class="hud-exp-item">
        <div class="hud-exp-title">
          <span>3인 협동 동기화</span>
          <span class="hud-exp-badge">최대 ${summary.coop.maxPartyPlayers}인</span>
        </div>
        <div class="hud-exp-detail">
          프로토콜 v${summary.coop.status.protocolVersion} · 상태: ${stateLabel} · 참여: ${summary.coop.status.peerCount}/${summary.coop.maxPartyPlayers}
        </div>
      </div>
      <div class="hud-exp-item">
        <div class="hud-exp-title">
          <span>몬스터 도감 &amp; 포획</span>
          <span class="hud-exp-badge">${summary.monsters.speciesCount}종 · 포획 ${capturedCount}</span>
        </div>
        <div class="hud-exp-detail">${this.escapeHtml(speciesNames)}</div>
      </div>
      <div class="hud-exp-item">
        <div class="hud-exp-title">
          <span>거점 건축 (${summary.building.gridSizeMeters}m 격자)</span>
          <span class="hud-exp-badge">${MODULAR_STRUCTURE_RECIPE_LIST.length}종 설계</span>
        </div>
        <div class="hud-exp-detail">${this.escapeHtml(recipeNames)}</div>
      </div>
    `;
    }
}
