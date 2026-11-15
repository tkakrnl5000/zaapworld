import * as pc from 'playcanvas';
import type {
    PerformanceMetrics,
    QualityMode,
    QualitySettings,
    QualityTier,
} from '../types/interfaces';

interface PerformanceMemoryInfo {
    usedJSHeapSize: number;
    totalJSHeapSize: number;
    jsHeapSizeLimit: number;
}

interface PerformanceWithMemory extends Performance {
    memory?: PerformanceMemoryInfo;
}

type QualityPresetValues = Omit<QualitySettings, 'tier' | 'mode'>;

const QUALITY_PRESETS: Record<QualityTier, QualityPresetValues> = {
    low: {
        pixelRatio: 0.65,
        shadowsEnabled: false,
        shadowResolution: 512,
        shadowDistance: 25,
        drawDistance: 75,
        lodBias: 0.7,
        grassInstanceCount: 400,
        bloomSimulate: false,
    },
    medium: {
        pixelRatio: 0.85,
        shadowsEnabled: true,
        shadowResolution: 1024,
        shadowDistance: 45,
        drawDistance: 110,
        lodBias: 1.0,
        grassInstanceCount: 1500,
        bloomSimulate: true,
    },
    high: {
        pixelRatio: 1.0,
        shadowsEnabled: true,
        shadowResolution: 2048,
        shadowDistance: 70,
        drawDistance: 150,
        lodBias: 1.25,
        grassInstanceCount: 3500,
        bloomSimulate: true,
    },
};

const TIER_ORDER: readonly QualityTier[] = ['low', 'medium', 'high'];

const DOWNGRADE_FPS_THRESHOLD = 28;
const DOWNGRADE_DURATION_SEC = 3.5;
const UPGRADE_FPS_THRESHOLD = 55;
const UPGRADE_DURATION_SEC = 8.0;
const STABILIZE_AFTER_CHANGE_SEC = 2.0;
const FRAME_WINDOW_SIZE = 120;

export interface DeviceProfile {
    isMobile: boolean;
    isLowEndGpu: boolean;
    gpuRenderer: string;
    recommendedTier: QualityTier;
}

export class QualityManager {
    private readonly app: pc.Application;
    private directionalLight: pc.Entity | null;
    private mode: QualityMode;
    private activeTier: QualityTier;
    private settings: QualitySettings;
    private readonly deviceProfile: DeviceProfile;

    private readonly frameDurations: number[] = [];
    private visibleInstances = 0;
    private culledObjects = 0;

    private currentFps = 60;
    private currentFrameTimeMs = 16.67;
    private currentMinFps1Pct = 60;

    private lowFpsTimer = 0;
    private highFpsTimer = 0;
    private stabilizeTimer = STABILIZE_AFTER_CHANGE_SEC;

    private readonly listeners = new Set<(settings: QualitySettings) => void>();

    constructor(
        app: pc.Application,
        directionalLight: pc.Entity | null = null,
        initialMode: QualityMode = 'auto'
    ) {
        this.app = app;
        this.directionalLight = directionalLight;
        this.deviceProfile = this.detectDeviceProfile();
        this.mode = initialMode;
        this.activeTier =
            initialMode === 'auto' ? this.deviceProfile.recommendedTier : initialMode;
        this.settings = this.buildSettings(this.activeTier, this.mode);
        this.applySettings();
    }

    public getDeviceProfile(): DeviceProfile {
        return { ...this.deviceProfile };
    }

    public isMobileDevice(): boolean {
        return this.deviceProfile.isMobile;
    }

    public setDirectionalLight(light: pc.Entity | null): void {
        this.directionalLight = light;
        this.applyLightSettings();
    }

    public setMode(mode: QualityMode): QualitySettings {
        this.mode = mode;
        const targetTier = mode === 'auto' ? this.activeTier : mode;
        const tierChanged = targetTier !== this.activeTier;
        this.activeTier = targetTier;
        this.settings = this.buildSettings(this.activeTier, this.mode);
        this.lowFpsTimer = 0;
        this.highFpsTimer = 0;

        if (tierChanged) {
            this.stabilizeTimer = STABILIZE_AFTER_CHANGE_SEC;
        }

        this.applySettings();
        this.notifyListeners();
        return this.getSettings();
    }

    public getSettings(): QualitySettings {
        return { ...this.settings };
    }

    public setRenderStats(visibleInstances: number, culledObjects: number): void {
        this.visibleInstances = Math.max(0, Math.round(visibleInstances));
        this.culledObjects = Math.max(0, Math.round(culledObjects));
    }

    public subscribe(listener: (settings: QualitySettings) => void): () => void {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    public update(
        dt: number,
        visibleInstances?: number,
        culledObjects?: number
    ): QualitySettings {
        if (typeof visibleInstances === 'number') {
            this.visibleInstances = Math.max(0, Math.round(visibleInstances));
        }
        if (typeof culledObjects === 'number') {
            this.culledObjects = Math.max(0, Math.round(culledObjects));
        }

        const clampedDt = Math.min(Math.max(dt, 0.001), 0.5);
        this.recordFrameDuration(clampedDt);

        if (this.stabilizeTimer > 0) {
            this.stabilizeTimer = Math.max(0, this.stabilizeTimer - clampedDt);
            return this.getSettings();
        }

        if (this.mode === 'auto' && this.frameDurations.length >= 20) {
            this.evaluateAutoScaling(clampedDt);
        }

        return this.getSettings();
    }

    public getMetrics(): PerformanceMetrics {
        const memoryMb = this.readHeapMemoryMb();
        return {
            fps: this.roundOneDecimal(this.currentFps),
            frameTimeMs: this.roundOneDecimal(this.currentFrameTimeMs),
            minFps1Pct: this.roundOneDecimal(this.currentMinFps1Pct),
            qualityTier: this.activeTier,
            qualityMode: this.mode,
            visibleInstances: this.visibleInstances,
            culledObjects: this.culledObjects,
            memoryMb,
        };
    }

    private evaluateAutoScaling(dt: number): void {
        const tierIndex = TIER_ORDER.indexOf(this.activeTier);

        if (this.currentFps < DOWNGRADE_FPS_THRESHOLD) {
            this.lowFpsTimer += dt;
            this.highFpsTimer = 0;

            if (this.lowFpsTimer >= DOWNGRADE_DURATION_SEC && tierIndex > 0) {
                this.switchAutoTier(TIER_ORDER[tierIndex - 1]);
            }
            return;
        }

        this.lowFpsTimer = 0;

        if (this.currentFps > UPGRADE_FPS_THRESHOLD) {
            this.highFpsTimer += dt;
            if (this.highFpsTimer >= UPGRADE_DURATION_SEC && tierIndex < TIER_ORDER.length - 1) {
                this.switchAutoTier(TIER_ORDER[tierIndex + 1]);
            }
            return;
        }

        this.highFpsTimer = 0;
    }

    private switchAutoTier(nextTier: QualityTier): void {
        this.activeTier = nextTier;
        this.settings = this.buildSettings(this.activeTier, this.mode);
        this.lowFpsTimer = 0;
        this.highFpsTimer = 0;
        this.stabilizeTimer = STABILIZE_AFTER_CHANGE_SEC;
        this.frameDurations.length = 0;
        this.applySettings();
        this.notifyListeners();
    }

    private recordFrameDuration(dt: number): void {
        this.frameDurations.push(dt);
        if (this.frameDurations.length > FRAME_WINDOW_SIZE) {
            this.frameDurations.shift();
        }

        const recentCount = Math.min(30, this.frameDurations.length);
        let recentSum = 0;
        for (let i = this.frameDurations.length - recentCount; i < this.frameDurations.length; i++) {
            recentSum += this.frameDurations[i];
        }
        const avgDt = recentSum / recentCount;
        this.currentFrameTimeMs = avgDt * 1000;
        this.currentFps = avgDt > 0 ? 1 / avgDt : 60;

        const sortedDesc = [...this.frameDurations].sort((a, b) => b - a);
        const worstCount = Math.max(1, Math.ceil(sortedDesc.length * 0.01));
        let worstSum = 0;
        for (let i = 0; i < worstCount; i++) {
            worstSum += sortedDesc[i];
        }
        const worstAvgDt = worstSum / worstCount;
        this.currentMinFps1Pct = worstAvgDt > 0 ? 1 / worstAvgDt : this.currentFps;
    }

    private buildSettings(tier: QualityTier, mode: QualityMode): QualitySettings {
        return {
            tier,
            mode,
            ...QUALITY_PRESETS[tier],
        };
    }

    private applySettings(): void {
        const device = this.app.graphicsDevice;
        if (device) {
            device.maxPixelRatio = this.settings.pixelRatio;
        }
        this.app.resizeCanvas();
        this.applyLightSettings();
    }

    private applyLightSettings(): void {
        const lightComponent = this.directionalLight?.light;
        if (!lightComponent) {
            return;
        }
        lightComponent.castShadows = this.settings.shadowsEnabled;
        lightComponent.shadowResolution = this.settings.shadowResolution;
        lightComponent.shadowDistance = this.settings.shadowDistance;
    }

    private notifyListeners(): void {
        const snapshot = this.getSettings();
        for (const listener of this.listeners) {
            listener(snapshot);
        }
    }

    private readHeapMemoryMb(): number | null {
        if (typeof performance === 'undefined') {
            return null;
        }
        const mem = (performance as PerformanceWithMemory).memory;
        if (!mem || typeof mem.usedJSHeapSize !== 'number') {
            return null;
        }
        return this.roundOneDecimal(mem.usedJSHeapSize / (1024 * 1024));
    }

    private detectDeviceProfile(): DeviceProfile {
        const nav = typeof navigator !== 'undefined' ? navigator : undefined;
        const ua = nav?.userAgent ?? '';
        const touchPoints = nav?.maxTouchPoints ?? 0;
        const minScreenDim =
            typeof window !== 'undefined'
                ? Math.min(window.screen?.width ?? 1920, window.screen?.height ?? 1080)
                : 1920;

        const uaMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(ua);
        const touchTabletOrPhone = touchPoints > 1 && minScreenDim <= 1024;
        const isMobile = uaMobile || touchTabletOrPhone;

        const gpuRenderer = this.detectGpuRenderer();
        const lowerGpu = gpuRenderer.toLowerCase();
        const isSoftwareOrLowGpu =
            lowerGpu.includes('swiftshader') ||
            lowerGpu.includes('llvmpipe') ||
            lowerGpu.includes('adreno (tm) 5') ||
            lowerGpu.includes('mali-g5') ||
            lowerGpu.includes('mali-t');

        const deviceMemory = (nav as (Navigator & { deviceMemory?: number }) | undefined)?.deviceMemory;
        const hardwareConcurrency = nav?.hardwareConcurrency;
        const constrainedHardware =
            (typeof deviceMemory === 'number' && deviceMemory <= 2) ||
            (typeof hardwareConcurrency === 'number' && hardwareConcurrency <= 2);

        const isLowEndGpu = isSoftwareOrLowGpu || constrainedHardware;

        let recommendedTier: QualityTier = 'high';
        if (isMobile && isLowEndGpu) {
            recommendedTier = 'low';
        } else if (isMobile || isSoftwareOrLowGpu) {
            recommendedTier = 'medium';
        }

        return {
            isMobile,
            isLowEndGpu,
            gpuRenderer,
            recommendedTier,
        };
    }

    private detectGpuRenderer(): string {
        try {
            const device = this.app.graphicsDevice as unknown as {
                gl?: WebGLRenderingContext | WebGL2RenderingContext;
            };
            const gl = device?.gl;
            if (!gl) {
                return 'unknown';
            }
            const debugExt = gl.getExtension('WEBGL_debug_renderer_info');
            if (debugExt) {
                const unmasked = gl.getParameter(debugExt.UNMASKED_RENDERER_WEBGL);
                if (typeof unmasked === 'string' && unmasked.length > 0) {
                    return unmasked;
                }
            }
            const fallback = gl.getParameter(gl.RENDERER);
            return typeof fallback === 'string' ? fallback : 'unknown';
        } catch {
            return 'unknown';
        }
    }

    private roundOneDecimal(value: number): number {
        return Math.round(value * 10) / 10;
    }
}
