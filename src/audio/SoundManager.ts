/**
 * Lightweight zero-asset procedural WebAudio API SoundManager.
 * Unlocks automatically on first pointer/touch/key gesture and degrades
 * gracefully when WebAudio is unavailable.
 */
export class SoundManager {
    private ctx: AudioContext | null = null;
    private masterGain: GainNode | null = null;
    private noiseBuffer: AudioBuffer | null = null;
    private muted = false;
    private disposed = false;
    private unlocked = false;

    private readonly onGestureBound: () => void;

    constructor(initiallyMuted = false) {
        this.muted = initiallyMuted;
        this.onGestureBound = () => {
            this.unlock();
        };

        if (typeof window !== 'undefined') {
            window.addEventListener('pointerdown', this.onGestureBound, { passive: true });
            window.addEventListener('touchstart', this.onGestureBound, { passive: true });
            window.addEventListener('keydown', this.onGestureBound, { passive: true });
        }
    }

    public setMuted(muted: boolean): void {
        this.muted = Boolean(muted);
        if (this.masterGain && this.ctx) {
            try {
                const target = this.muted ? 0 : 0.42;
                this.masterGain.gain.setTargetAtTime(target, this.ctx.currentTime, 0.015);
            } catch {
                // Ignore AudioContext scheduling issues
            }
        }
    }

    public isMuted(): boolean {
        return this.muted;
    }

    public toggleMuted(): boolean {
        this.setMuted(!this.muted);
        return this.muted;
    }

    public unlock(): boolean {
        if (this.disposed) return false;
        const ctx = this.ensureContext();
        if (!ctx) return false;

        try {
            if (ctx.state === 'suspended') {
                void ctx.resume().catch(() => {});
            }
            if (!this.unlocked) {
                this.unlocked = true;
                this.removeGestureListeners();
            }
            return true;
        } catch {
            return false;
        }
    }

    public playMeleeSwing(comboStep = 1): void {
        const ctx = this.readyContext();
        if (!ctx || !this.masterGain) return;

        const now = ctx.currentTime;
        const stepPitch = comboStep === 3 ? 1.24 : comboStep === 2 ? 1.1 : 1.0;

        // Filtered air whoosh
        this.playNoiseBurst(now, 0.11, 650 * stepPitch, 2100 * stepPitch, 0.22);

        // Crisp tonal blade transient
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(340 * stepPitch, now);
        osc.frequency.exponentialRampToValueAtTime(125 * stepPitch, now + 0.11);

        gain.gain.setValueAtTime(0.001, now);
        gain.gain.linearRampToValueAtTime(0.24, now + 0.012);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.12);

        osc.connect(gain);
        gain.connect(this.masterGain);
        osc.start(now);
        osc.stop(now + 0.13);
    }

    public playHitImpact(heavy = false): void {
        const ctx = this.readyContext();
        if (!ctx || !this.masterGain) return;

        const now = ctx.currentTime;
        const dur = heavy ? 0.22 : 0.13;

        // Punch body thud
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = heavy ? 'sawtooth' : 'triangle';
        osc.frequency.setValueAtTime(heavy ? 160 : 240, now);
        osc.frequency.exponentialRampToValueAtTime(heavy ? 42 : 68, now + dur);

        gain.gain.setValueAtTime(0.001, now);
        gain.gain.linearRampToValueAtTime(heavy ? 0.42 : 0.3, now + 0.006);
        gain.gain.exponentialRampToValueAtTime(0.001, now + dur);

        osc.connect(gain);
        gain.connect(this.masterGain);
        osc.start(now);
        osc.stop(now + dur + 0.01);

        // Crisp slap noise
        this.playNoiseBurst(
            now,
            heavy ? 0.13 : 0.075,
            heavy ? 320 : 620,
            heavy ? 1200 : 2400,
            heavy ? 0.34 : 0.24
        );
    }

    public playRangedCast(): void {
        const ctx = this.readyContext();
        if (!ctx || !this.masterGain) return;

        const now = ctx.currentTime;

        // Shimmering arcane bolt rise + tail
        const oscA = ctx.createOscillator();
        const oscB = ctx.createOscillator();
        const gain = ctx.createGain();

        oscA.type = 'sine';
        oscB.type = 'triangle';
        oscA.frequency.setValueAtTime(520, now);
        oscA.frequency.exponentialRampToValueAtTime(1180, now + 0.08);
        oscA.frequency.exponentialRampToValueAtTime(440, now + 0.22);

        oscB.frequency.setValueAtTime(780, now);
        oscB.frequency.exponentialRampToValueAtTime(1720, now + 0.09);
        oscB.frequency.exponentialRampToValueAtTime(660, now + 0.22);

        gain.gain.setValueAtTime(0.001, now);
        gain.gain.linearRampToValueAtTime(0.24, now + 0.018);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.23);

        oscA.connect(gain);
        oscB.connect(gain);
        gain.connect(this.masterGain);

        oscA.start(now);
        oscB.start(now);
        oscA.stop(now + 0.24);
        oscB.stop(now + 0.24);
    }

    public playDodge(): void {
        const ctx = this.readyContext();
        if (!ctx || !this.masterGain) return;

        const now = ctx.currentTime;
        this.playNoiseBurst(now, 0.16, 420, 2600, 0.26);

        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(280, now);
        osc.frequency.exponentialRampToValueAtTime(560, now + 0.07);
        osc.frequency.exponentialRampToValueAtTime(190, now + 0.17);

        gain.gain.setValueAtTime(0.001, now);
        gain.gain.linearRampToValueAtTime(0.18, now + 0.015);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.18);

        osc.connect(gain);
        gain.connect(this.masterGain);
        osc.start(now);
        osc.stop(now + 0.19);
    }

    public playCaptureThrow(): void {
        const ctx = this.readyContext();
        if (!ctx || !this.masterGain) return;

        const now = ctx.currentTime;
        this.playNoiseBurst(now, 0.1, 900, 2800, 0.16);

        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(380, now);
        osc.frequency.exponentialRampToValueAtTime(920, now + 0.14);

        gain.gain.setValueAtTime(0.001, now);
        gain.gain.linearRampToValueAtTime(0.22, now + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.18);

        osc.connect(gain);
        gain.connect(this.masterGain);
        osc.start(now);
        osc.stop(now + 0.19);
    }

    public playCaptureTick(): void {
        const ctx = this.readyContext();
        if (!ctx || !this.masterGain) return;

        const now = ctx.currentTime;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(640, now);
        osc.frequency.exponentialRampToValueAtTime(420, now + 0.09);

        gain.gain.setValueAtTime(0.001, now);
        gain.gain.linearRampToValueAtTime(0.26, now + 0.008);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.1);

        osc.connect(gain);
        gain.connect(this.masterGain);
        osc.start(now);
        osc.stop(now + 0.11);
    }

    public playCaptureSuccess(): void {
        const ctx = this.readyContext();
        if (!ctx || !this.masterGain) return;

        const now = ctx.currentTime;
        const notes = [523.25, 659.25, 783.99, 1046.5];
        notes.forEach((freq, idx) => {
            const t = now + idx * 0.075;
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = idx === notes.length - 1 ? 'triangle' : 'sine';
            osc.frequency.setValueAtTime(freq, t);

            const dur = idx === notes.length - 1 ? 0.34 : 0.16;
            gain.gain.setValueAtTime(0.001, t);
            gain.gain.linearRampToValueAtTime(0.24, t + 0.015);
            gain.gain.exponentialRampToValueAtTime(0.001, t + dur);

            osc.connect(gain);
            gain.connect(this.masterGain!);
            osc.start(t);
            osc.stop(t + dur + 0.01);
        });
    }

    public playCaptureFail(): void {
        const ctx = this.readyContext();
        if (!ctx || !this.masterGain) return;

        const now = ctx.currentTime;
        const notes = [392.0, 293.66];
        notes.forEach((freq, idx) => {
            const t = now + idx * 0.11;
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = 'sawtooth';
            osc.frequency.setValueAtTime(freq, t);
            osc.frequency.exponentialRampToValueAtTime(freq * 0.82, t + 0.14);

            const filter = ctx.createBiquadFilter();
            filter.type = 'lowpass';
            filter.frequency.setValueAtTime(1100, t);

            gain.gain.setValueAtTime(0.001, t);
            gain.gain.linearRampToValueAtTime(0.18, t + 0.012);
            gain.gain.exponentialRampToValueAtTime(0.001, t + 0.16);

            osc.connect(filter);
            filter.connect(gain);
            gain.connect(this.masterGain!);
            osc.start(t);
            osc.stop(t + 0.17);
        });
    }

    public playSummon(): void {
        const ctx = this.readyContext();
        if (!ctx || !this.masterGain) return;

        const now = ctx.currentTime;
        const freqs = [440, 659.25, 880];
        freqs.forEach((freq, idx) => {
            const t = now + idx * 0.045;
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = 'sine';
            osc.frequency.setValueAtTime(freq, t);
            osc.frequency.exponentialRampToValueAtTime(freq * 1.12, t + 0.2);

            gain.gain.setValueAtTime(0.001, t);
            gain.gain.linearRampToValueAtTime(0.18, t + 0.02);
            gain.gain.exponentialRampToValueAtTime(0.001, t + 0.25);

            osc.connect(gain);
            gain.connect(this.masterGain!);
            osc.start(t);
            osc.stop(t + 0.26);
        });
    }

    public playMonsterCry(species: string): void {
        const ctx = this.readyContext();
        if (!ctx || !this.masterGain) return;

        const now = ctx.currentTime;
        if (species === 'moss_hopper') {
            // Chirpy double spring hop cry
            [0, 0.09].forEach((offset, i) => {
                const t = now + offset;
                const osc = ctx.createOscillator();
                const gain = ctx.createGain();
                osc.type = 'triangle';
                osc.frequency.setValueAtTime(i === 0 ? 520 : 660, t);
                osc.frequency.exponentialRampToValueAtTime(i === 0 ? 780 : 940, t + 0.07);
                gain.gain.setValueAtTime(0.001, t);
                gain.gain.linearRampToValueAtTime(0.2, t + 0.01);
                gain.gain.exponentialRampToValueAtTime(0.001, t + 0.085);
                osc.connect(gain);
                gain.connect(this.masterGain!);
                osc.start(t);
                osc.stop(t + 0.095);
            });
            return;
        }

        if (species === 'aether_wisp') {
            // Ethereal harmonic chime cry
            const osc1 = ctx.createOscillator();
            const osc2 = ctx.createOscillator();
            const gain = ctx.createGain();
            osc1.type = 'sine';
            osc2.type = 'sine';
            osc1.frequency.setValueAtTime(740, now);
            osc1.frequency.exponentialRampToValueAtTime(1120, now + 0.14);
            osc1.frequency.exponentialRampToValueAtTime(880, now + 0.28);
            osc2.frequency.setValueAtTime(1110, now);
            osc2.frequency.exponentialRampToValueAtTime(1680, now + 0.14);
            osc2.frequency.exponentialRampToValueAtTime(1320, now + 0.28);

            gain.gain.setValueAtTime(0.001, now);
            gain.gain.linearRampToValueAtTime(0.18, now + 0.03);
            gain.gain.exponentialRampToValueAtTime(0.001, now + 0.3);

            osc1.connect(gain);
            osc2.connect(gain);
            gain.connect(this.masterGain);
            osc1.start(now);
            osc2.start(now);
            osc1.stop(now + 0.31);
            osc2.stop(now + 0.31);
            return;
        }

        // shale_golem or fallback: low resonant stone rumble
        const osc = ctx.createOscillator();
        const filter = ctx.createBiquadFilter();
        const gain = ctx.createGain();
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(135, now);
        osc.frequency.exponentialRampToValueAtTime(68, now + 0.28);

        filter.type = 'lowpass';
        filter.frequency.setValueAtTime(520, now);
        filter.frequency.exponentialRampToValueAtTime(220, now + 0.28);

        gain.gain.setValueAtTime(0.001, now);
        gain.gain.linearRampToValueAtTime(0.28, now + 0.025);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.3);

        osc.connect(filter);
        filter.connect(gain);
        gain.connect(this.masterGain);
        osc.start(now);
        osc.stop(now + 0.32);
    }

    /** Phase 4: Resource gathering hit SFX per node material. */
    public playGatherHit(kind: 'wood' | 'stone' | 'ore' | 'berry'): void {
        const ctx = this.readyContext();
        if (!ctx || !this.masterGain) return;
        const now = ctx.currentTime;

        if (kind === 'wood') {
            this.playTone(ctx, now, 'triangle', 215, 92, 0.12, 0.24, 900);
            this.playNoiseBurst(now, 0.075, 1100, 320, 0.16);
            return;
        }
        if (kind === 'stone') {
            this.playTone(ctx, now, 'triangle', 520, 210, 0.09, 0.2, 2200);
            this.playNoiseBurst(now, 0.06, 2800, 750, 0.2);
            return;
        }
        if (kind === 'ore') {
            this.playTone(ctx, now, 'sine', 1120, 860, 0.16, 0.17);
            this.playTone(ctx, now + 0.02, 'triangle', 560, 290, 0.1, 0.16, 2600);
            this.playNoiseBurst(now, 0.055, 3400, 1100, 0.16);
            return;
        }
        // berry: soft foliage rustle + crisp pluck
        this.playNoiseBurst(now, 0.1, 1800, 620, 0.12);
        this.playTone(ctx, now + 0.015, 'sine', 420, 560, 0.09, 0.13);
    }

    /** Phase 4: Resource node depleted / harvested reward chime. */
    public playGatherComplete(): void {
        const ctx = this.readyContext();
        if (!ctx || !this.masterGain) return;
        const now = ctx.currentTime;
        this.playTone(ctx, now, 'triangle', 523.25, 523.25, 0.11, 0.16);
        this.playTone(ctx, now + 0.06, 'sine', 659.25, 659.25, 0.12, 0.16);
        this.playTone(ctx, now + 0.12, 'sine', 783.99, 783.99, 0.18, 0.18);
    }

    /** Phase 4: Item/tool/food crafted at base or workbench. */
    public playCraftSuccess(): void {
        const ctx = this.readyContext();
        if (!ctx || !this.masterGain) return;
        const now = ctx.currentTime;
        this.playNoiseBurst(now, 0.05, 1900, 650, 0.13);
        this.playTone(ctx, now, 'triangle', 440, 440, 0.11, 0.16);
        this.playTone(ctx, now + 0.07, 'sine', 554.37, 554.37, 0.12, 0.15);
        this.playTone(ctx, now + 0.14, 'sine', 659.25, 880, 0.22, 0.18);
    }

    /** Phase 4: Modular structure placed on grid. */
    public playBuildPlace(): void {
        const ctx = this.readyContext();
        if (!ctx || !this.masterGain) return;
        const now = ctx.currentTime;
        this.playTone(ctx, now, 'triangle', 168, 74, 0.14, 0.28, 750);
        this.playNoiseBurst(now, 0.08, 1250, 280, 0.18);
        this.playTone(ctx, now + 0.055, 'sine', 392, 523.25, 0.11, 0.14);
    }

    /** Phase 4: Modular structure demolished. */
    public playBuildDemolish(): void {
        const ctx = this.readyContext();
        if (!ctx || !this.masterGain) return;
        const now = ctx.currentTime;
        this.playTone(ctx, now, 'sawtooth', 195, 58, 0.2, 0.2, 680);
        this.playNoiseBurst(now, 0.16, 950, 210, 0.2);
        this.playNoiseBurst(now + 0.07, 0.12, 620, 160, 0.14);
    }

    /** Phase 4: Eating berry / cooked food SFX. */
    public playEatFood(): void {
        const ctx = this.readyContext();
        if (!ctx || !this.masterGain) return;
        const now = ctx.currentTime;
        this.playNoiseBurst(now, 0.05, 1450, 520, 0.12);
        this.playNoiseBurst(now + 0.085, 0.055, 1550, 480, 0.11);
        this.playTone(ctx, now + 0.11, 'sine', 340, 510, 0.16, 0.14);
    }

    /** Phase 4: Base worker delivered gathered/crafted resources. */
    public playWorkerDeliver(): void {
        const ctx = this.readyContext();
        if (!ctx || !this.masterGain) return;
        const now = ctx.currentTime;
        this.playTone(ctx, now, 'sine', 587.33, 587.33, 0.1, 0.13);
        this.playTone(ctx, now + 0.075, 'sine', 880, 880, 0.16, 0.14);
    }

    private playTone(
        ctx: AudioContext,
        startTime: number,
        type: OscillatorType,
        startFreq: number,
        endFreq: number,
        duration: number,
        peakGain: number,
        lowpassFreq?: number
    ): void {
        if (!this.masterGain) return;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = type;
        osc.frequency.setValueAtTime(Math.max(20, startFreq), startTime);
        if (Math.abs(endFreq - startFreq) > 0.5) {
            osc.frequency.exponentialRampToValueAtTime(Math.max(20, endFreq), startTime + duration);
        }

        gain.gain.setValueAtTime(0.001, startTime);
        gain.gain.linearRampToValueAtTime(peakGain, startTime + Math.min(0.02, duration * 0.25));
        gain.gain.exponentialRampToValueAtTime(0.001, startTime + duration);

        if (lowpassFreq && lowpassFreq > 0) {
            const filter = ctx.createBiquadFilter();
            filter.type = 'lowpass';
            filter.frequency.setValueAtTime(lowpassFreq, startTime);
            osc.connect(filter);
            filter.connect(gain);
        } else {
            osc.connect(gain);
        }
        gain.connect(this.masterGain);
        osc.start(startTime);
        osc.stop(startTime + duration + 0.02);
    }

    public dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.removeGestureListeners();
        if (this.ctx) {
            try {
                void this.ctx.close().catch(() => {});
            } catch {
                // Ignore
            }
            this.ctx = null;
        }
        this.masterGain = null;
        this.noiseBuffer = null;
    }

    private removeGestureListeners(): void {
        if (typeof window !== 'undefined') {
            window.removeEventListener('pointerdown', this.onGestureBound);
            window.removeEventListener('touchstart', this.onGestureBound);
            window.removeEventListener('keydown', this.onGestureBound);
        }
    }

    private ensureContext(): AudioContext | null {
        if (this.disposed) return null;
        if (this.ctx) return this.ctx;
        if (typeof window === 'undefined') return null;

        const AudioCtx =
            window.AudioContext ||
            (window as unknown as { webkitAudioContext?: typeof AudioContext })
                .webkitAudioContext;
        if (!AudioCtx) return null;

        try {
            const ctx = new AudioCtx();
            const master = ctx.createGain();
            master.gain.value = this.muted ? 0 : 0.42;
            master.connect(ctx.destination);
            this.ctx = ctx;
            this.masterGain = master;
            return ctx;
        } catch {
            return null;
        }
    }

    private readyContext(): AudioContext | null {
        if (this.muted || this.disposed) return null;
        const ctx = this.ensureContext();
        if (!ctx) return null;
        if (ctx.state === 'suspended') {
            void ctx.resume().catch(() => {});
        }
        return ctx;
    }

    private getNoiseBuffer(ctx: AudioContext): AudioBuffer | null {
        if (this.noiseBuffer) return this.noiseBuffer;
        try {
            const length = Math.max(1, Math.floor(ctx.sampleRate * 0.25));
            const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
            const data = buffer.getChannelData(0);
            for (let i = 0; i < length; i++) {
                data[i] = Math.random() * 2 - 1;
            }
            this.noiseBuffer = buffer;
            return buffer;
        } catch {
            return null;
        }
    }

    private playNoiseBurst(
        startTime: number,
        duration: number,
        startFreq: number,
        endFreq: number,
        peakGain: number
    ): void {
        const ctx = this.ctx;
        if (!ctx || !this.masterGain) return;
        const buffer = this.getNoiseBuffer(ctx);
        if (!buffer) return;

        const src = ctx.createBufferSource();
        src.buffer = buffer;

        const filter = ctx.createBiquadFilter();
        filter.type = 'bandpass';
        filter.Q.value = 1.6;
        filter.frequency.setValueAtTime(startFreq, startTime);
        filter.frequency.exponentialRampToValueAtTime(
            Math.max(80, endFreq),
            startTime + duration
        );

        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0.001, startTime);
        gain.gain.linearRampToValueAtTime(peakGain, startTime + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.001, startTime + duration);

        src.connect(filter);
        filter.connect(gain);
        gain.connect(this.masterGain);

        src.start(startTime);
        src.stop(startTime + duration + 0.01);
    }
}
