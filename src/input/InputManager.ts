import { InputState } from '../types/interfaces';

export interface JoystickVisualState {
    active: boolean;
    centerX: number;
    centerY: number;
    knobX: number;
    knobY: number;
    radius: number;
    magnitude: number;
    autoSprinting: boolean;
}

export interface ActionButtonStates {
    jumpActive: boolean;
    sprintActive: boolean;
    sprintToggled: boolean;
    interactActive: boolean;
    meleeActive: boolean;
    rangedActive: boolean;
    dodgeActive: boolean;
    captureActive: boolean;
    summonActive: boolean;
    eatActive?: boolean;
    buildModeActive?: boolean;
    craftPanelActive?: boolean;
    basePanelActive?: boolean;
    buildRotateActive?: boolean;
    buildPlaceActive?: boolean;
    buildDemolishActive?: boolean;
}

export type SurvivalInputAction =
    | 'eat'
    | 'buildMode'
    | 'craftPanel'
    | 'basePanel'
    | 'buildRotate'
    | 'buildPlace'
    | 'buildDemolish';

export type CombatInputAction =
    | 'jump'
    | 'interact'
    | 'melee'
    | 'ranged'
    | 'dodge'
    | 'capture'
    | 'summon'
    | SurvivalInputAction;

export interface ZaapInputHelper {
    /**
     * Programmatically set movement axes.
     * x: -1 (left) .. +1 (right)
     * z: -1 (forward / screen-up) .. +1 (backward / screen-down)
     */
    setMove: (x: number, z: number) => void;
    triggerJump: () => void;
    setSprint: (held: boolean) => void;
    addLookDelta: (dx: number, dy: number) => void;
    addZoomDelta?: (dz: number) => void;
    triggerInteract: () => void;
    triggerMelee: () => void;
    triggerRanged: () => void;
    triggerDodge: () => void;
    triggerCapture: () => void;
    triggerSummon: () => void;
    triggerEat: () => void;
    triggerBuildMode: () => void;
    triggerCraftPanel: () => void;
    triggerBasePanel: () => void;
    triggerBuildRotate: () => void;
    triggerBuildPlace: () => void;
    triggerBuildDemolish: () => void;
    selectCompanion: (index: number | null) => void;
    setActionHold: (action: CombatInputAction, held: boolean) => void;
    clear: () => void;
    getState: () => InputState;
}

declare global {
    interface Window {
        __ZAAP_INPUT__?: ZaapInputHelper;
    }
}

interface ButtonInputSlot {
    readonly action: CombatInputAction;
    readonly selector: string;
    readonly keyCodes: readonly string[];
    touchId: number | null;
    mouseActive: boolean;
    pending: boolean;
    suppressNextClick: boolean;
}

const DEADZONE = 0.10;
const AUTO_SPRINT_THRESHOLD = 0.88;
const SPRINT_TAP_MAX_MS = 260;

export class InputManager {
    private canvas: HTMLElement | null;

    // Keyboard state
    private pressedKeys = new Set<string>();

    // Mouse / pointer-lock state
    private isMouseDragging = false;
    private lastMouseX = 0;
    private lastMouseY = 0;
    private lastTouchTimestamp = 0;

    // Multi-touch state tracked strictly by Touch.identifier
    private joystickTouchId: number | null = null;
    private joystickCenterX = 0;
    private joystickCenterY = 0;
    private joystickKnobX = 0;
    private joystickKnobY = 0;
    private joystickRadius = 54;
    private joyMoveX = 0;
    private joyMoveZ = 0;
    private joyMagnitude = 0;

    private cameraTouchId: number | null = null;
    private lastCameraX = 0;
    private lastCameraY = 0;

    private pinchTouchId: number | null = null;
    private lastPinchX = 0;
    private lastPinchY = 0;
    private lastPinchDist = 0;

    private sprintTouchId: number | null = null;
    private sprintTouchStartMs = 0;
    private sprintTouchHeld = false;
    private touchSprintToggled = false;
    private sprintMouseStartMs = 0;
    private sprintMouseActive = false;
    private sprintSuppressNextClick = false;

    // Dedicated action & combat button slots tracked by Touch.identifier
    private readonly actionButtons: Record<CombatInputAction, ButtonInputSlot> = {
        jump: {
            action: 'jump',
            selector: '#btn-jump',
            keyCodes: ['Space'],
            touchId: null,
            mouseActive: false,
            pending: false,
            suppressNextClick: false,
        },
        interact: {
            action: 'interact',
            selector: '#btn-interact',
            keyCodes: ['KeyE'],
            touchId: null,
            mouseActive: false,
            pending: false,
            suppressNextClick: false,
        },
        melee: {
            action: 'melee',
            selector: '#btn-melee',
            keyCodes: ['KeyJ'],
            touchId: null,
            mouseActive: false,
            pending: false,
            suppressNextClick: false,
        },
        ranged: {
            action: 'ranged',
            selector: '#btn-ranged',
            keyCodes: ['KeyK'],
            touchId: null,
            mouseActive: false,
            pending: false,
            suppressNextClick: false,
        },
        dodge: {
            action: 'dodge',
            selector: '#btn-dodge',
            keyCodes: ['KeyQ'],
            touchId: null,
            mouseActive: false,
            pending: false,
            suppressNextClick: false,
        },
        capture: {
            action: 'capture',
            selector: '#btn-capture',
            keyCodes: ['KeyV'],
            touchId: null,
            mouseActive: false,
            pending: false,
            suppressNextClick: false,
        },
        summon: {
            action: 'summon',
            selector: '#btn-summon',
            keyCodes: ['KeyR'],
            touchId: null,
            mouseActive: false,
            pending: false,
            suppressNextClick: false,
        },
        eat: {
            action: 'eat',
            selector: '#btn-eat',
            keyCodes: ['KeyF'],
            touchId: null,
            mouseActive: false,
            pending: false,
            suppressNextClick: false,
        },
        buildMode: {
            action: 'buildMode',
            selector: '#btn-build-mode',
            keyCodes: ['KeyB'],
            touchId: null,
            mouseActive: false,
            pending: false,
            suppressNextClick: false,
        },
        craftPanel: {
            action: 'craftPanel',
            selector: '#btn-craft-panel',
            keyCodes: ['KeyC'],
            touchId: null,
            mouseActive: false,
            pending: false,
            suppressNextClick: false,
        },
        basePanel: {
            action: 'basePanel',
            selector: '#btn-base-panel',
            keyCodes: ['KeyP'],
            touchId: null,
            mouseActive: false,
            pending: false,
            suppressNextClick: false,
        },
        buildRotate: {
            action: 'buildRotate',
            selector: '#btn-build-rotate',
            keyCodes: ['KeyT'],
            touchId: null,
            mouseActive: false,
            pending: false,
            suppressNextClick: false,
        },
        buildPlace: {
            action: 'buildPlace',
            selector: '#btn-build-place',
            keyCodes: [],
            touchId: null,
            mouseActive: false,
            pending: false,
            suppressNextClick: false,
        },
        buildDemolish: {
            action: 'buildDemolish',
            selector: '#btn-build-demolish',
            keyCodes: ['KeyX'],
            touchId: null,
            mouseActive: false,
            pending: false,
            suppressNextClick: false,
        },
    };
    private readonly actionButtonList: readonly ButtonInputSlot[];

    // Frame accumulators
    private pendingLookDeltaX = 0;
    private pendingLookDeltaY = 0;
    private pendingZoomDelta = 0;
    private pendingSelectCompanionIndex: number | null = null;
    private isTouchActive = false;

    // Configurable options
    private autoSprintOnFullTilt = true;

    // Automated browser testing overrides (window.__ZAAP_INPUT__)
    private overrideMove: { x: number; z: number } | null = null;
    private overrideSprint: boolean | null = null;
    private readonly overrideHeldActions = new Set<CombatInputAction>();

    // Bound listeners for cleanup
    private onKeyDownBound: (e: KeyboardEvent) => void;
    private onKeyUpBound: (e: KeyboardEvent) => void;
    private onMouseDownBound: (e: MouseEvent) => void;
    private onMouseMoveBound: (e: MouseEvent) => void;
    private onMouseUpBound: (e: MouseEvent) => void;
    private onClickBound: (e: MouseEvent) => void;
    private onWheelBound: (e: WheelEvent) => void;
    private onTouchStartBound: (e: TouchEvent) => void;
    private onTouchMoveBound: (e: TouchEvent) => void;
    private onTouchEndBound: (e: TouchEvent) => void;
    private onBlurBound: () => void;
    private onContextMenuBound: (e: MouseEvent) => void;

    constructor(canvas: HTMLElement | null = null) {
        this.canvas = canvas ?? document.getElementById('app-canvas');
        this.actionButtonList = Object.values(this.actionButtons);
        this.updateJoystickRadius();

        this.onKeyDownBound = this.handleKeyDown.bind(this);
        this.onKeyUpBound = this.handleKeyUp.bind(this);
        this.onMouseDownBound = this.handleMouseDown.bind(this);
        this.onMouseMoveBound = this.handleMouseMove.bind(this);
        this.onMouseUpBound = this.handleMouseUp.bind(this);
        this.onClickBound = this.handleClick.bind(this);
        this.onWheelBound = this.handleWheel.bind(this);
        this.onTouchStartBound = this.handleTouchStart.bind(this);
        this.onTouchMoveBound = this.handleTouchMove.bind(this);
        this.onTouchEndBound = this.handleTouchEnd.bind(this);
        this.onBlurBound = this.handleBlur.bind(this);
        this.onContextMenuBound = (e: MouseEvent) => {
            if (e.target === this.canvas) {
                e.preventDefault();
            }
        };

        window.addEventListener('keydown', this.onKeyDownBound);
        window.addEventListener('keyup', this.onKeyUpBound);
        window.addEventListener('mousedown', this.onMouseDownBound);
        window.addEventListener('mousemove', this.onMouseMoveBound);
        window.addEventListener('mouseup', this.onMouseUpBound);
        window.addEventListener('click', this.onClickBound);
        window.addEventListener('wheel', this.onWheelBound, { passive: false });
        window.addEventListener('touchstart', this.onTouchStartBound, { passive: false });
        window.addEventListener('touchmove', this.onTouchMoveBound, { passive: false });
        window.addEventListener('touchend', this.onTouchEndBound, { passive: false });
        window.addEventListener('touchcancel', this.onTouchEndBound, { passive: false });
        window.addEventListener('blur', this.onBlurBound);
        window.addEventListener('contextmenu', this.onContextMenuBound);

        this.installTestHelper();
    }

    public setAutoSprintEnabled(enabled: boolean): void {
        this.autoSprintOnFullTilt = enabled;
    }

    public isAutoSprintEnabled(): boolean {
        return this.autoSprintOnFullTilt;
    }

    public resetSprintToggle(): void {
        this.touchSprintToggled = false;
    }

    public triggerSelectCompanion(index: number | null): void {
        this.pendingSelectCompanionIndex = index;
    }

    public triggerAction(action: CombatInputAction): void {
        this.actionButtons[action].pending = true;
    }

    public getJoystickVisualState(): JoystickVisualState {
        const autoSprinting =
            this.joystickTouchId !== null &&
            this.autoSprintOnFullTilt &&
            this.joyMagnitude > AUTO_SPRINT_THRESHOLD;
        return {
            active: this.joystickTouchId !== null,
            centerX: this.joystickCenterX,
            centerY: this.joystickCenterY,
            knobX: this.joystickKnobX,
            knobY: this.joystickKnobY,
            radius: this.joystickRadius,
            magnitude: this.joyMagnitude,
            autoSprinting,
        };
    }

    public getActionButtonStates(): ActionButtonStates {
        const autoSprinting =
            this.joystickTouchId !== null &&
            this.autoSprintOnFullTilt &&
            this.joyMagnitude > AUTO_SPRINT_THRESHOLD;

        return {
            jumpActive: this.isButtonSlotActive(this.actionButtons.jump),
            sprintActive:
                this.sprintTouchHeld ||
                this.sprintMouseActive ||
                this.touchSprintToggled ||
                autoSprinting ||
                this.overrideSprint === true,
            sprintToggled: this.touchSprintToggled,
            interactActive: this.isButtonSlotActive(this.actionButtons.interact),
            meleeActive: this.isButtonSlotActive(this.actionButtons.melee),
            rangedActive: this.isButtonSlotActive(this.actionButtons.ranged),
            dodgeActive: this.isButtonSlotActive(this.actionButtons.dodge),
            captureActive: this.isButtonSlotActive(this.actionButtons.capture),
            summonActive: this.isButtonSlotActive(this.actionButtons.summon),
            eatActive: this.isButtonSlotActive(this.actionButtons.eat),
            buildModeActive: this.isButtonSlotActive(this.actionButtons.buildMode),
            craftPanelActive: this.isButtonSlotActive(this.actionButtons.craftPanel),
            basePanelActive: this.isButtonSlotActive(this.actionButtons.basePanel),
            buildRotateActive: this.isButtonSlotActive(this.actionButtons.buildRotate),
            buildPlaceActive: this.isButtonSlotActive(this.actionButtons.buildPlace),
            buildDemolishActive: this.isButtonSlotActive(this.actionButtons.buildDemolish),
        };
    }

    /**
     * Returns true while the player is actively dragging or pointer-locking
     * the camera so combat auto-aim does not fight manual look input.
     */
    public isCameraDragging(): boolean {
        return (
            this.isMouseDragging ||
            this.cameraTouchId !== null ||
            document.pointerLockElement === this.canvas
        );
    }

    /**
     * Reads current input state WITHOUT resetting per-frame deltas/edge triggers.
     */
    public peekState(): InputState {
        return this.computeState();
    }

    /**
     * Reads current input state for this simulation frame and consumes
     * accumulated look/zoom deltas and one-shot action/combat triggers.
     */
    public sampleFrame(): InputState {
        const state = this.computeState();
        this.pendingLookDeltaX = 0;
        this.pendingLookDeltaY = 0;
        this.pendingZoomDelta = 0;
        this.pendingSelectCompanionIndex = null;
        for (const btn of this.actionButtonList) {
            btn.pending = false;
        }
        return state;
    }

    public dispose(): void {
        window.removeEventListener('keydown', this.onKeyDownBound);
        window.removeEventListener('keyup', this.onKeyUpBound);
        window.removeEventListener('mousedown', this.onMouseDownBound);
        window.removeEventListener('mousemove', this.onMouseMoveBound);
        window.removeEventListener('mouseup', this.onMouseUpBound);
        window.removeEventListener('click', this.onClickBound);
        window.removeEventListener('wheel', this.onWheelBound);
        window.removeEventListener('touchstart', this.onTouchStartBound);
        window.removeEventListener('touchmove', this.onTouchMoveBound);
        window.removeEventListener('touchend', this.onTouchEndBound);
        window.removeEventListener('touchcancel', this.onTouchEndBound);
        window.removeEventListener('blur', this.onBlurBound);
        window.removeEventListener('contextmenu', this.onContextMenuBound);
        if (window.__ZAAP_INPUT__) {
            delete window.__ZAAP_INPUT__;
        }
    }

    private isButtonSlotActive(slot: ButtonInputSlot): boolean {
        if (slot.touchId !== null || slot.mouseActive) {
            return true;
        }
        if (this.overrideHeldActions.has(slot.action)) {
            return true;
        }
        for (const key of slot.keyCodes) {
            if (this.pressedKeys.has(key)) {
                return true;
            }
        }
        return false;
    }

    private findMatchingButtonSlot(target: Element | null): ButtonInputSlot | null {
        if (!target) return null;
        for (const slot of this.actionButtonList) {
            if (target.closest(slot.selector)) {
                return slot;
            }
        }
        return null;
    }

    private computeState(): InputState {
        let moveX = 0;
        let moveZ = 0;
        let moveMagnitude = 0;
        let touchAutoSprint = false;

        if (this.overrideMove !== null) {
            moveX = this.overrideMove.x;
            moveZ = this.overrideMove.z;
            const len = Math.hypot(moveX, moveZ);
            if (len > 1) {
                moveX /= len;
                moveZ /= len;
                moveMagnitude = 1;
            } else {
                moveMagnitude = len;
            }
        } else if (this.joystickTouchId !== null) {
            moveX = this.joyMoveX;
            moveZ = this.joyMoveZ;
            moveMagnitude = this.joyMagnitude;
            if (this.autoSprintOnFullTilt && moveMagnitude > AUTO_SPRINT_THRESHOLD) {
                touchAutoSprint = true;
            }
        } else {
            let kx = 0;
            let kz = 0;
            if (this.pressedKeys.has('KeyA') || this.pressedKeys.has('ArrowLeft')) kx -= 1;
            if (this.pressedKeys.has('KeyD') || this.pressedKeys.has('ArrowRight')) kx += 1;
            if (this.pressedKeys.has('KeyW') || this.pressedKeys.has('ArrowUp')) kz -= 1;
            if (this.pressedKeys.has('KeyS') || this.pressedKeys.has('ArrowDown')) kz += 1;

            const kLen = Math.hypot(kx, kz);
            if (kLen > 0) {
                moveX = kx / kLen;
                moveZ = kz / kLen;
                moveMagnitude = 1;
            }
        }

        const keyboardSprint =
            this.pressedKeys.has('ShiftLeft') || this.pressedKeys.has('ShiftRight');

        const sprintHeld =
            this.overrideSprint !== null
                ? this.overrideSprint
                : keyboardSprint ||
                  this.sprintTouchHeld ||
                  this.sprintMouseActive ||
                  this.touchSprintToggled ||
                  touchAutoSprint;

        return {
            moveX,
            moveZ,
            moveMagnitude,
            lookDeltaX: this.pendingLookDeltaX,
            lookDeltaY: this.pendingLookDeltaY,
            zoomDelta: this.pendingZoomDelta,
            sprintHeld,
            jumpPressed: this.actionButtons.jump.pending,
            interactPressed: this.actionButtons.interact.pending,
            isTouchActive: this.isTouchActive,
            meleePressed: this.actionButtons.melee.pending,
            rangedPressed: this.actionButtons.ranged.pending,
            dodgePressed: this.actionButtons.dodge.pending,
            capturePressed: this.actionButtons.capture.pending,
            summonPressed: this.actionButtons.summon.pending,
            selectCompanionIndex: this.pendingSelectCompanionIndex,
            eatPressed: this.actionButtons.eat.pending,
            buildModePressed: this.actionButtons.buildMode.pending,
            craftPanelPressed: this.actionButtons.craftPanel.pending,
            basePanelPressed: this.actionButtons.basePanel.pending,
            buildRotatePressed: this.actionButtons.buildRotate.pending,
            buildPlacePressed: this.actionButtons.buildPlace.pending,
            buildDemolishPressed: this.actionButtons.buildDemolish.pending,
        };
    }

    private updateJoystickRadius(): void {
        const minDim = Math.min(window.innerWidth || 800, window.innerHeight || 450);
        this.joystickRadius = Math.max(44, Math.min(62, minDim * 0.135));
    }

    private installTestHelper(): void {
        window.__ZAAP_INPUT__ = {
            setMove: (x: number, z: number) => {
                const cx = Math.max(-1, Math.min(1, Number.isFinite(x) ? x : 0));
                const cz = Math.max(-1, Math.min(1, Number.isFinite(z) ? z : 0));
                if (cx === 0 && cz === 0) {
                    this.overrideMove = null;
                } else {
                    this.overrideMove = { x: cx, z: cz };
                }
            },
            triggerJump: () => {
                this.actionButtons.jump.pending = true;
            },
            setSprint: (held: boolean) => {
                this.overrideSprint = held;
            },
            addLookDelta: (dx: number, dy: number) => {
                this.pendingLookDeltaX += dx;
                this.pendingLookDeltaY += dy;
            },
            addZoomDelta: (dz: number) => {
                this.pendingZoomDelta += dz;
            },
            triggerInteract: () => {
                this.actionButtons.interact.pending = true;
            },
            triggerMelee: () => {
                this.actionButtons.melee.pending = true;
            },
            triggerRanged: () => {
                this.actionButtons.ranged.pending = true;
            },
            triggerDodge: () => {
                this.actionButtons.dodge.pending = true;
            },
            triggerCapture: () => {
                this.actionButtons.capture.pending = true;
            },
            triggerSummon: () => {
                this.actionButtons.summon.pending = true;
            },
            triggerEat: () => {
                this.actionButtons.eat.pending = true;
            },
            triggerBuildMode: () => {
                this.actionButtons.buildMode.pending = true;
            },
            triggerCraftPanel: () => {
                this.actionButtons.craftPanel.pending = true;
            },
            triggerBasePanel: () => {
                this.actionButtons.basePanel.pending = true;
            },
            triggerBuildRotate: () => {
                this.actionButtons.buildRotate.pending = true;
            },
            triggerBuildPlace: () => {
                this.actionButtons.buildPlace.pending = true;
            },
            triggerBuildDemolish: () => {
                this.actionButtons.buildDemolish.pending = true;
            },
            selectCompanion: (index: number | null) => {
                this.pendingSelectCompanionIndex = index;
            },
            setActionHold: (action: CombatInputAction, held: boolean) => {
                const slot = this.actionButtons[action];
                if (!slot) return;
                if (held) {
                    if (!this.overrideHeldActions.has(action)) {
                        slot.pending = true;
                    }
                    this.overrideHeldActions.add(action);
                } else {
                    this.overrideHeldActions.delete(action);
                }
            },
            clear: () => {
                this.overrideMove = null;
                this.overrideSprint = null;
                this.overrideHeldActions.clear();
                this.pendingSelectCompanionIndex = null;
                for (const btn of this.actionButtonList) {
                    btn.pending = false;
                }
                this.pendingLookDeltaX = 0;
                this.pendingLookDeltaY = 0;
                this.pendingZoomDelta = 0;
                this.touchSprintToggled = false;
                this.pressedKeys.clear();
            },
            getState: () => this.peekState(),
        };
    }

    private handleKeyDown(e: KeyboardEvent): void {
        const activeTag = (document.activeElement as HTMLElement | null)?.tagName;
        if (activeTag === 'INPUT' || activeTag === 'TEXTAREA' || activeTag === 'SELECT') {
            return;
        }

        if (
            e.code === 'Space' ||
            e.code === 'ArrowUp' ||
            e.code === 'ArrowDown' ||
            e.code === 'ArrowLeft' ||
            e.code === 'ArrowRight'
        ) {
            e.preventDefault();
        }

        this.pressedKeys.add(e.code);

        if (!e.repeat) {
            for (const btn of this.actionButtonList) {
                if (btn.keyCodes.includes(e.code)) {
                    btn.pending = true;
                    return;
                }
            }
            if (e.code === 'Digit1') {
                this.pendingSelectCompanionIndex = 0;
            } else if (e.code === 'Digit2') {
                this.pendingSelectCompanionIndex = 1;
            } else if (e.code === 'Digit3') {
                this.pendingSelectCompanionIndex = 2;
            } else if (e.code === 'Digit4') {
                this.pendingSelectCompanionIndex = 3;
            }
        }
    }

    private handleKeyUp(e: KeyboardEvent): void {
        this.pressedKeys.delete(e.code);
    }

    private isInteractiveHudElement(target: EventTarget | null): boolean {
        if (!(target instanceof Element)) return false;
        return Boolean(
            target.closest(
                '[data-hud-interactive="true"], [data-hud-interactive], #hud-craft-drawer, #hud-base-drawer, #hud-build-dock, #hud-resource-bar, button, input, select, textarea, a, label'
            )
        );
    }

    private handleMouseDown(e: MouseEvent): void {
        // Skip synthetic mouse events closely following touch events
        if (performance.now() - this.lastTouchTimestamp < 500) return;

        const target = e.target instanceof Element ? e.target : null;
        if (target?.closest('#btn-sprint')) {
            this.sprintMouseActive = true;
            this.sprintMouseStartMs = performance.now();
            this.sprintSuppressNextClick = true;
            return;
        }

        const matchedBtn = this.findMatchingButtonSlot(target);
        if (matchedBtn) {
            matchedBtn.mouseActive = true;
            matchedBtn.pending = true;
            matchedBtn.suppressNextClick = true;
            return;
        }

        if (this.isInteractiveHudElement(target)) {
            return;
        }

        // Allow left or right mouse button drag anywhere on canvas/non-HUD area
        if (e.button === 0 || e.button === 2) {
            this.isMouseDragging = true;
            this.lastMouseX = e.clientX;
            this.lastMouseY = e.clientY;
            this.isTouchActive = false;
        }
    }

    private handleMouseMove(e: MouseEvent): void {
        if (performance.now() - this.lastTouchTimestamp < 500) return;

        const pointerLocked =
            this.canvas !== null && document.pointerLockElement === this.canvas;

        if (pointerLocked) {
            this.pendingLookDeltaX += e.movementX || 0;
            this.pendingLookDeltaY += e.movementY || 0;
            return;
        }

        if (!this.isMouseDragging) return;

        const dx =
            typeof e.movementX === 'number' && (e.movementX !== 0 || e.movementY !== 0)
                ? e.movementX
                : e.clientX - this.lastMouseX;
        const dy =
            typeof e.movementY === 'number' && (e.movementX !== 0 || e.movementY !== 0)
                ? e.movementY
                : e.clientY - this.lastMouseY;

        this.lastMouseX = e.clientX;
        this.lastMouseY = e.clientY;

        if (Math.abs(dx) < 200 && Math.abs(dy) < 200) {
            this.pendingLookDeltaX += dx;
            this.pendingLookDeltaY += dy;
        }
    }

    private handleMouseUp(e: MouseEvent): void {
        if (this.sprintMouseActive) {
            if (performance.now() - this.sprintMouseStartMs < SPRINT_TAP_MAX_MS) {
                this.touchSprintToggled = !this.touchSprintToggled;
            }
            this.sprintMouseActive = false;
            window.setTimeout(() => {
                this.sprintSuppressNextClick = false;
            }, 0);
        }

        for (const btn of this.actionButtonList) {
            if (btn.mouseActive) {
                btn.mouseActive = false;
                window.setTimeout(() => {
                    btn.suppressNextClick = false;
                }, 0);
            }
        }

        if (e.button === 0 || e.button === 2) {
            this.isMouseDragging = false;
        }
    }

    private handleClick(e: MouseEvent): void {
        const target = e.target instanceof Element ? e.target : null;
        if (!target) return;

        if (target.closest('#btn-sprint')) {
            if (this.sprintSuppressNextClick) {
                this.sprintSuppressNextClick = false;
                return;
            }
            this.touchSprintToggled = !this.touchSprintToggled;
            return;
        }

        const matchedBtn = this.findMatchingButtonSlot(target);
        if (matchedBtn) {
            if (matchedBtn.suppressNextClick) {
                matchedBtn.suppressNextClick = false;
                return;
            }
            matchedBtn.pending = true;
        }
    }

    private handleWheel(e: WheelEvent): void {
        if (this.isInteractiveHudElement(e.target)) return;
        e.preventDefault();
        // Positive deltaY (scroll down) zooms out (+distance)
        const normalized = Math.sign(e.deltaY) * Math.min(2.0, Math.abs(e.deltaY) * 0.008);
        this.pendingZoomDelta += normalized;
    }

    private handleTouchStart(e: TouchEvent): void {
        this.lastTouchTimestamp = performance.now();
        this.isTouchActive = true;
        this.updateJoystickRadius();

        const halfWidth = (window.innerWidth || 800) * 0.5;
        let shouldPreventDefault = false;

        for (let i = 0; i < e.changedTouches.length; i++) {
            const touch = e.changedTouches[i];
            const target = touch.target instanceof Element ? touch.target : null;

            // 1. Dedicated action & combat buttons take absolute priority by Touch.identifier
            if (target?.closest('#btn-sprint')) {
                shouldPreventDefault = true;
                if (this.sprintTouchId === null) {
                    this.sprintTouchId = touch.identifier;
                    this.sprintTouchStartMs = performance.now();
                    this.sprintTouchHeld = true;
                    this.sprintSuppressNextClick = true;
                }
                continue;
            }

            const matchedBtn = this.findMatchingButtonSlot(target);
            if (matchedBtn) {
                shouldPreventDefault = true;
                if (matchedBtn.touchId === null) {
                    matchedBtn.touchId = touch.identifier;
                    matchedBtn.pending = true;
                    matchedBtn.suppressNextClick = true;
                }
                continue;
            }

            // 2. Joystick zone explicitly claims left-thumb joystick
            if (target?.closest('#joystick-zone')) {
                shouldPreventDefault = true;
                if (this.joystickTouchId === null) {
                    this.beginJoystickTouch(touch);
                }
                continue;
            }

            // 3. Let HUD buttons, sliders, companion chips, and drawers process native clicks/drags
            if (this.isInteractiveHudElement(target)) {
                continue;
            }

            // 4. General playfield touch: left half -> joystick, right half -> camera orbit/pinch
            shouldPreventDefault = true;
            if (touch.clientX < halfWidth && this.joystickTouchId === null) {
                this.beginJoystickTouch(touch);
            } else {
                if (this.cameraTouchId === null) {
                    this.cameraTouchId = touch.identifier;
                    this.lastCameraX = touch.clientX;
                    this.lastCameraY = touch.clientY;
                } else if (this.pinchTouchId === null) {
                    this.pinchTouchId = touch.identifier;
                    this.lastPinchX = touch.clientX;
                    this.lastPinchY = touch.clientY;
                    this.lastPinchDist = Math.hypot(
                        this.lastPinchX - this.lastCameraX,
                        this.lastPinchY - this.lastCameraY
                    );
                }
            }
        }

        if (shouldPreventDefault && e.cancelable) {
            e.preventDefault();
        }
    }

    private beginJoystickTouch(touch: Touch): void {
        this.joystickTouchId = touch.identifier;
        this.joystickCenterX = touch.clientX;
        this.joystickCenterY = touch.clientY;
        this.joystickKnobX = touch.clientX;
        this.joystickKnobY = touch.clientY;
        this.joyMoveX = 0;
        this.joyMoveZ = 0;
        this.joyMagnitude = 0;
    }

    private isDedicatedButtonTouch(touchId: number): boolean {
        if (touchId === this.sprintTouchId) return true;
        for (const btn of this.actionButtonList) {
            if (btn.touchId === touchId) return true;
        }
        return false;
    }

    private handleTouchMove(e: TouchEvent): void {
        this.lastTouchTimestamp = performance.now();
        let handled = false;

        for (let i = 0; i < e.changedTouches.length; i++) {
            const touch = e.changedTouches[i];

            if (touch.identifier === this.joystickTouchId) {
                handled = true;
                this.updateJoystickTouch(touch);
                continue;
            }

            if (this.isDedicatedButtonTouch(touch.identifier)) {
                handled = true;
                continue;
            }

            if (
                touch.identifier === this.cameraTouchId ||
                touch.identifier === this.pinchTouchId
            ) {
                handled = true;
                if (this.pinchTouchId !== null) {
                    if (touch.identifier === this.cameraTouchId) {
                        this.lastCameraX = touch.clientX;
                        this.lastCameraY = touch.clientY;
                    } else {
                        this.lastPinchX = touch.clientX;
                        this.lastPinchY = touch.clientY;
                    }
                    const dist = Math.hypot(
                        this.lastPinchX - this.lastCameraX,
                        this.lastPinchY - this.lastCameraY
                    );
                    if (this.lastPinchDist > 0) {
                        const delta = this.lastPinchDist - dist;
                        this.pendingZoomDelta += delta * 0.015;
                    }
                    this.lastPinchDist = dist;
                } else if (touch.identifier === this.cameraTouchId) {
                    const dx = touch.clientX - this.lastCameraX;
                    const dy = touch.clientY - this.lastCameraY;
                    this.lastCameraX = touch.clientX;
                    this.lastCameraY = touch.clientY;
                    if (Math.abs(dx) < 160 && Math.abs(dy) < 160) {
                        this.pendingLookDeltaX += dx;
                        this.pendingLookDeltaY += dy;
                    }
                }
            }
        }

        if (handled && e.cancelable) {
            e.preventDefault();
        }
    }

    private updateJoystickTouch(touch: Touch): void {
        const dx = touch.clientX - this.joystickCenterX;
        const dy = touch.clientY - this.joystickCenterY;
        const dist = Math.hypot(dx, dy);
        const radius = this.joystickRadius;

        if (dist > radius && dist > 0.0001) {
            this.joystickKnobX = this.joystickCenterX + (dx / dist) * radius;
            this.joystickKnobY = this.joystickCenterY + (dy / dist) * radius;
        } else {
            this.joystickKnobX = touch.clientX;
            this.joystickKnobY = touch.clientY;
        }

        const rawMag = Math.min(1, dist / radius);
        if (rawMag <= DEADZONE || dist <= 0.0001) {
            this.joyMoveX = 0;
            this.joyMoveZ = 0;
            this.joyMagnitude = 0;
        } else {
            const normalizedMag = Math.min(1, (rawMag - DEADZONE) / (1 - DEADZONE));
            const dirX = dx / dist;
            const dirY = dy / dist;
            this.joyMoveX = dirX * normalizedMag;
            this.joyMoveZ = dirY * normalizedMag;
            this.joyMagnitude = normalizedMag;
        }
    }

    private handleTouchEnd(e: TouchEvent): void {
        this.lastTouchTimestamp = performance.now();
        let handled = false;

        for (let i = 0; i < e.changedTouches.length; i++) {
            const touch = e.changedTouches[i];
            const id = touch.identifier;

            if (id === this.joystickTouchId) {
                handled = true;
                this.joystickTouchId = null;
                this.joyMoveX = 0;
                this.joyMoveZ = 0;
                this.joyMagnitude = 0;
            } else if (id === this.cameraTouchId) {
                handled = true;
                if (this.pinchTouchId !== null) {
                    this.cameraTouchId = this.pinchTouchId;
                    this.lastCameraX = this.lastPinchX;
                    this.lastCameraY = this.lastPinchY;
                    this.pinchTouchId = null;
                    this.lastPinchDist = 0;
                } else {
                    this.cameraTouchId = null;
                }
            } else if (id === this.pinchTouchId) {
                handled = true;
                this.pinchTouchId = null;
                this.lastPinchDist = 0;
            } else if (id === this.sprintTouchId) {
                handled = true;
                const heldMs = performance.now() - this.sprintTouchStartMs;
                if (heldMs < SPRINT_TAP_MAX_MS) {
                    this.touchSprintToggled = !this.touchSprintToggled;
                }
                this.sprintTouchHeld = false;
                this.sprintTouchId = null;
                window.setTimeout(() => {
                    this.sprintSuppressNextClick = false;
                }, 0);
            } else {
                for (const btn of this.actionButtonList) {
                    if (id === btn.touchId) {
                        handled = true;
                        btn.touchId = null;
                        window.setTimeout(() => {
                            btn.suppressNextClick = false;
                        }, 0);
                        break;
                    }
                }
            }
        }

        if (handled && e.cancelable) {
            e.preventDefault();
        }
    }

    private handleBlur(): void {
        this.pressedKeys.clear();
        this.isMouseDragging = false;
        this.joystickTouchId = null;
        this.joyMoveX = 0;
        this.joyMoveZ = 0;
        this.joyMagnitude = 0;
        this.cameraTouchId = null;
        this.pinchTouchId = null;
        this.lastPinchDist = 0;
        this.sprintTouchId = null;
        this.sprintTouchHeld = false;
        this.sprintMouseActive = false;
        this.sprintSuppressNextClick = false;
        for (const btn of this.actionButtonList) {
            btn.touchId = null;
            btn.mouseActive = false;
            btn.suppressNextClick = false;
        }
    }
}
