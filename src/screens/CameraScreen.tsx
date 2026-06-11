import React, { useEffect, useRef, useState } from 'react';
import { StyleSheet, View, Text, TouchableOpacity, Animated } from 'react-native';
import {
  Camera,
  useCameraDevice,
  useCameraFormat,
  useCameraPermission,
  useFrameProcessor,
} from 'react-native-vision-camera';
import { useRunOnJS, useSharedValue } from 'react-native-worklets-core';
import { VolumeManager } from 'react-native-volume-manager';
import * as Speech from 'expo-speech';
import * as Haptics from 'expo-haptics';
import { colors } from '../lib/theme';
import { saveThrow } from '../lib/db';

const APP_VERSION = '0.3.3';

// The worklet runtime persists `global` between frames. worklets-core's babel
// plugin treats `global` as a runtime global (not captured) — unlike
// `globalThis`, which gets captured and would deep-copy the host JS global
// graph into the worklet (stack overflow). Declare it for TypeScript.
declare const global: any;

// ── Physics ──────────────────────────────────────────────────────────────────
const DISC_DIAMETER_CM = 21.2;
const CAMERA_HEIGHT_CM = 152; // 5 ft — assumed disc altitude above the lens
const H_FOV_DEG = 69;
// Spin is not optically measurable at this resolution/blur yet; estimate from
// speed using the typical disc-golf backhand ratio (~15–20 rpm per mph).
const RPM_PER_MPH = 17;

// ── Detection grid ───────────────────────────────────────────────────────────
// The frame is sampled on a fixed 96×72 lattice (≈7k pixels, constant cost at
// any camera resolution) grouped into 12×9 cells of 8×8 samples each. Each
// cell keeps its own running brightness baseline, so a small disc that darkens
// just one cell triggers even though the whole-frame average barely moves.
const GRID_X = 12;
const GRID_Y = 9;
const CELLS = GRID_X * GRID_Y;
const SAMP_X = 96;
const SAMP_Y = 72;
const CALIB_FRAMES = 15;      // frames to settle baselines after arming
// High sensitivity: false triggers (leaves, bugs) are acceptable — the user
// knows when they actually threw. Missing a real throw is the failure mode.
const CELL_DIP_ABS = 4;       // min absolute luminance dip vs cell baseline
const CELL_DIP_FRAC = 0.04;   // min relative dip (4% under cell baseline)
const PREV_DIP_ABS = 5;       // min absolute dip vs the SAME cell last frame
const PREV_DIP_FRAC = 0.05;   // min relative dip vs last frame (transients)
const EVENT_MAX_FRAMES = 90;  // longer than this = shadow/person, not a disc
const EVENT_MAX_GAP = 3;      // frames of "no dark cells" allowed mid-event

type Phase = 'idle' | 'ready' | 'result';
interface Result { speedMph: number; spinRpm: number; }
interface DebugInfo {
  brightness: number; baseline: number; fps: number;
  bufLen: number; frameW: number; frameH: number; bpr: number;
  darkCells: number; calib: number;
}

export default function CameraScreen() {
  const device = useCameraDevice('back');
  // Resolution first (the old fps-only filter picked a pixelated 192×144
  // stream), then the highest frame rate available at that resolution.
  const format = useCameraFormat(device, [
    { videoResolution: { width: 1280, height: 720 } },
    { fps: 120 },
    { fps: 60 },
  ]);
  // Cap at 120fps — beyond that the per-frame buffer copies get expensive.
  const targetFps = Math.min(format?.maxFps ?? 30, 120);
  const { hasPermission, requestPermission } = useCameraPermission();

  const [phase, setPhase] = useState<Phase>('idle');
  const [result, setResult] = useState<Result | null>(null);
  const [debug, setDebug] = useState<DebugInfo>({
    brightness: 0, baseline: 0, fps: 0, bufLen: -2,
    frameW: 0, frameH: 0, bpr: 0, darkCells: 0, calib: 0,
  });
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const resultTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Shared values cross the JS <-> camera-thread boundary.
  const isReadyRef = useSharedValue(false);
  // Bumping the epoch makes the worklet rebuild its grid state + recalibrate.
  const epochRef = useSharedValue(0);

  useEffect(() => { if (!hasPermission) requestPermission(); }, [hasPermission, requestPermission]);

  useEffect(() => {
    if (phase === 'ready') {
      Animated.loop(Animated.sequence([
        Animated.timing(pulseAnim, { toValue: 1.15, duration: 700, useNativeDriver: true }),
        Animated.timing(pulseAnim, { toValue: 1, duration: 700, useNativeDriver: true }),
      ])).start();
    } else {
      pulseAnim.setValue(1);
    }
  }, [phase, pulseAnim]);

  const updateDebug = useRunOnJS((
    brightness: number, base: number, fps: number, bufLen: number,
    fw: number, fh: number, bpr: number, darkCells: number, calib: number
  ) => {
    setDebug({
      brightness: Math.round(brightness), baseline: Math.round(base), fps,
      bufLen, frameW: fw, frameH: fh, bpr, darkCells, calib,
    });
  }, []);

  // Called from the worklet when a disc event completes.
  // Speed = centroid displacement (px) converted to cm at the assumed
  // altitude, divided by elapsed time.
  const onDisc = useRunOnJS((
    frames: number, firstCx: number, firstCy: number,
    lastCx: number, lastCy: number, dtMs: number, w: number, fps: number
  ) => {
    if (!isReadyRef.value) return;

    const hFovRad = (H_FOV_DEG * Math.PI) / 180;
    const sceneWidthCm = 2 * CAMERA_HEIGHT_CM * Math.tan(hFovRad / 2);
    const cmPerPx = sceneWidthCm / w;

    let mph: number;
    if (frames >= 2) {
      const dx = lastCx - firstCx;
      const dy = lastCy - firstCy;
      const dispPx = Math.sqrt(dx * dx + dy * dy);
      // Stationary darkening (person leaning over, shadow) — not a disc.
      if (dispPx < w * 0.03) return;
      // Use frame timestamps when sane, else fall back to frame count / fps.
      const elapsedMs = dtMs > 1 && dtMs < 5000 ? dtMs : ((frames - 1) / fps) * 1000;
      if (elapsedMs <= 0) return;
      const speedCmPerSec = (dispPx * cmPerPx) / (elapsedMs / 1000);
      mph = speedCmPerSec * 0.0223694;
    } else {
      // Single-frame streak: disc crossed in under one frame interval.
      // Lower-bound estimate: it traveled at least its own diameter.
      mph = DISC_DIAMETER_CM * fps * 0.0223694;
    }

    mph = Math.round(mph * 10) / 10;
    if (mph < 3 || mph > 130) return; // out of plausible range — ignore

    const rpm = Math.round((mph * RPM_PER_MPH) / 10) * 10;

    isReadyRef.value = false;
    setResult({ speedMph: mph, spinRpm: rpm });
    setPhase('result');
    saveThrow(mph, rpm);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    Speech.speak(`${mph} miles per hour. ${rpm} R P M.`, { rate: 0.9 });

    resultTimeoutRef.current = setTimeout(() => {
      epochRef.value = epochRef.value + 1; // recalibrate for next throw
      setPhase('ready');
      isReadyRef.value = true;
    }, 4000);
  }, []);

  // ── Frame processor ─────────────────────────────────────────────────────────
  // Grid-cell detection: per-cell baselines + dark-cell centroid tracking.
  // State lives on the worklet runtime's `global` so it persists across frames
  // without crossing threads; epochRef bumps force a rebuild.
  const frameProcessor = useFrameProcessor((frame) => {
    'worklet';
    const g = global;
    if (g.__ht === undefined || g.__htEpoch !== epochRef.value) {
      g.__ht = {
        base: new Array(CELLS).fill(-1),
        prev: new Array(CELLS).fill(-1),
        calib: 0,
        inEvent: false, frames: 0, gap: 0,
        firstCx: 0, firstCy: 0, lastCx: 0, lastCy: 0,
        firstTs: 0, lastTs: 0,
        tick: 0,
      };
      g.__htEpoch = epochRef.value;
    }
    const S = g.__ht;
    S.tick++;

    const w = frame.width;
    const h = frame.height;
    const bpr = frame.bytesPerRow;
    const fps = targetFps;

    if (!isReadyRef.value) {
      if (S.tick % 30 === 0) updateDebug(0, 0, fps, -2, w, h, bpr, 0, 0);
      return;
    }

    (frame as any).incrementRefCount();
    let bufLen = 0;
    const sums = new Array(CELLS).fill(0);

    try {
      const buf = frame.toArrayBuffer();
      const pixels = new Uint8Array(buf);
      bufLen = pixels.length;
      if (bufLen === 0) {
        (frame as any).decrementRefCount();
        if (S.tick % 30 === 0) updateDebug(0, 0, fps, 0, w, h, bpr, 0, S.calib);
        return;
      }

      const isYUV = bufLen < w * h * 2;
      const yStride = isYUV ? (bpr > 0 ? bpr : w) : w * 4;

      // Fixed 96×72 sampling lattice → constant ~7k reads per frame.
      for (let sy = 0; sy < SAMP_Y; sy++) {
        const y = ((sy + 0.5) * h / SAMP_Y) | 0;
        const cellRow = (sy >> 3) * GRID_X; // 8 sample-rows per cell row
        const rowBase = isYUV ? y * yStride : y * w * 4;
        for (let sx = 0; sx < SAMP_X; sx++) {
          const x = ((sx + 0.5) * w / SAMP_X) | 0;
          let lum: number;
          if (isYUV) {
            const idx = rowBase + x;
            if (idx >= bufLen) continue;
            lum = pixels[idx];
          } else {
            const idx = rowBase + x * 4;
            if (idx + 2 >= bufLen) continue;
            lum = (pixels[idx + 2] * 77 + pixels[idx + 1] * 150 + pixels[idx] * 29) >> 8;
          }
          sums[cellRow + (sx >> 3)] += lum;
        }
      }
    } catch {
      (frame as any).decrementRefCount();
      if (S.tick % 30 === 0) updateDebug(-1, 0, fps, -1, w, h, bpr, 0, S.calib);
      return;
    }
    (frame as any).decrementRefCount();

    // ── Per-cell dark test + baseline maintenance ─────────────────────────────
    let darkCells = 0;
    let dipSum = 0, cxSum = 0, cySum = 0;
    let lumTotal = 0, baseTotal = 0, baseCount = 0;

    for (let c = 0; c < CELLS; c++) {
      const avg = sums[c] >> 6; // 64 samples per cell
      lumTotal += avg;
      const p = S.prev[c];
      S.prev[c] = avg;
      const b = S.base[c];
      if (b < 0) { S.base[c] = avg; continue; }
      baseTotal += b; baseCount++;

      // Dark vs the cell's own slow baseline, OR a sudden dip vs the same
      // cell one frame ago — the latter catches fast transients even when
      // the baseline has drifted (clouds, auto-exposure).
      const dip = b - avg;
      const dipPrev = p >= 0 ? p - avg : 0;
      const isDark = S.calib >= CALIB_FRAMES && (
        (dip > CELL_DIP_ABS && dip > b * CELL_DIP_FRAC) ||
        (dipPrev > PREV_DIP_ABS && dipPrev > p * PREV_DIP_FRAC)
      );

      if (isDark) {
        darkCells++;
        const px = ((c % GRID_X) + 0.5) * (w / GRID_X);
        const py = (((c / GRID_X) | 0) + 0.5) * (h / GRID_Y);
        const wgt = Math.max(dip, dipPrev, 1); // always positive weight
        dipSum += wgt; cxSum += px * wgt; cySum += py * wgt;
      } else {
        // Adapt baseline only from non-dark cells so the disc/shadow never
        // pollutes it. Faster alpha during calibration.
        S.base[c] = S.calib < CALIB_FRAMES ? b * 0.7 + avg * 0.3 : b * 0.95 + avg * 0.05;
      }
    }
    if (S.calib < CALIB_FRAMES) S.calib++;

    const avgLum = lumTotal / CELLS;
    const avgBase = baseCount > 0 ? baseTotal / baseCount : 0;
    if (S.tick % 6 === 0 || darkCells > 0) {
      updateDebug(avgLum, avgBase, fps, bufLen, w, h, bpr, darkCells, S.calib);
    }

    // ── Event tracking: follow the dark-cluster centroid across frames ───────
    const ts = frame.timestamp;
    if (darkCells > 0 && S.calib >= CALIB_FRAMES) {
      const cx = cxSum / dipSum;
      const cy = cySum / dipSum;
      if (!S.inEvent) {
        S.inEvent = true; S.frames = 1; S.gap = 0;
        S.firstCx = cx; S.firstCy = cy; S.firstTs = ts;
      } else {
        S.frames++;
        S.gap = 0;
      }
      S.lastCx = cx; S.lastCy = cy; S.lastTs = ts;

      if (S.frames > EVENT_MAX_FRAMES) {
        // Parked shadow/person — abort and rebuild baselines.
        S.inEvent = false; S.frames = 0;
        for (let c = 0; c < CELLS; c++) S.base[c] = -1;
        S.calib = 0;
      }
    } else if (S.inEvent) {
      S.gap++;
      if (S.gap > EVENT_MAX_GAP) {
        const frames = S.frames;
        S.inEvent = false; S.frames = 0; S.gap = 0;
        // timestamp units vary across platforms — onDisc sanity-checks dtMs
        const dtMs = S.lastTs - S.firstTs;
        onDisc(frames, S.firstCx, S.firstCy, S.lastCx, S.lastCy, dtMs, w, fps);
      }
    }
  }, [isReadyRef, epochRef, targetFps, onDisc, updateDebug]);

  const startReady = () => {
    if (resultTimeoutRef.current) clearTimeout(resultTimeoutRef.current);
    epochRef.value = epochRef.value + 1; // rebuild grid state + recalibrate
    setResult(null);
    setPhase('ready');
    isReadyRef.value = true;
  };

  // Volume-up arms the detector (the only way to arm — no on-screen button).
  const lastVolRef = useRef(0.5);
  useEffect(() => {
    let sub: { remove: () => void } | undefined;
    VolumeManager.showNativeVolumeUI({ enabled: false });
    VolumeManager.setVolume(0.5).catch(() => {});
    lastVolRef.current = 0.5;

    sub = VolumeManager.addVolumeListener((result) => {
      const v = result.volume;
      if (v > lastVolRef.current + 0.005) {
        startReady();
        Speech.speak('Ready to throw', { rate: 0.95 });
      }
      lastVolRef.current = v;
      if (v > 0.85 || v < 0.15) {
        VolumeManager.setVolume(0.5).catch(() => {});
        lastVolRef.current = 0.5;
      }
    });
    return () => sub?.remove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!hasPermission) {
    return (
      <View style={styles.permBox}>
        <Text style={styles.permText}>Camera permission required.</Text>
        <TouchableOpacity style={styles.btn} onPress={requestPermission}>
          <Text style={styles.btnText}>Grant Permission</Text>
        </TouchableOpacity>
      </View>
    );
  }
  if (!device) return <View style={styles.permBox}><Text style={styles.permText}>No camera found.</Text></View>;

  return (
    <View style={styles.container}>
      <Camera
        style={StyleSheet.absoluteFill}
        device={device}
        isActive={phase === 'ready'}
        format={format}
        fps={targetFps}
        frameProcessor={frameProcessor}
        pixelFormat="yuv"
        photo={false}
        video={false}
        audio={false}
      />

      <View style={styles.overlay}>
        <View style={styles.header}>
          <Text style={styles.appName}>HYZER<Text style={{ color: colors.cyan }}>TECH</Text></Text>
        </View>

        <View style={styles.center}>
          {phase === 'idle' && (
            <View style={styles.idleBox}>
              <Text style={styles.instruction}>
                Place your phone camera-up on the ground, 5 feet in front of where you throw.
              </Text>
              <View style={styles.volPrompt}>
                <Text style={styles.volPromptText}>Press the</Text>
                <Text style={styles.volPromptKey}>VOLUME&nbsp;UP</Text>
                <Text style={styles.volPromptText}>button to start</Text>
              </View>
            </View>
          )}

          {phase === 'ready' && (
            <View style={styles.readyBox}>
              <Animated.View style={[styles.pulseRing, { transform: [{ scale: pulseAnim }] }]} />
              <Text style={styles.readyText}>READY</Text>
              <Text style={styles.readySubText}>Throw the disc over the camera</Text>

              <View style={styles.debugBox}>
                <Text style={styles.debugTitle}>SENSOR DEBUG  v{APP_VERSION}</Text>
                <Text style={styles.debugRow}>Frame: <Text style={styles.debugVal}>{debug.frameW}×{debug.frameH}</Text></Text>
                <Text style={styles.debugRow}>
                  Buffer: <Text style={styles.debugVal}>
                    {debug.bufLen === 0 ? 'EMPTY ⚠️'
                      : debug.bufLen === -1 ? 'EXCEPTION ⚠️'
                      : debug.bufLen === -2 ? 'waiting...'
                      : `${debug.bufLen} bytes ✓`}
                  </Text>
                </Text>
                <Text style={styles.debugRow}>Brightness: <Text style={styles.debugVal}>{debug.brightness}</Text></Text>
                <Text style={styles.debugRow}>Baseline: <Text style={styles.debugVal}>{debug.baseline}</Text></Text>
                <Text style={styles.debugRow}>Dark cells: <Text style={styles.debugVal}>{debug.darkCells}</Text></Text>
                <Text style={styles.debugRow}>FPS: <Text style={styles.debugVal}>{debug.fps}</Text></Text>
                <Text style={[styles.debugRow, { color: colors.gray, marginTop: 4, fontSize: 11 }]}>
                  {debug.bufLen <= 0 ? 'No pixel data yet'
                    : debug.calib < CALIB_FRAMES ? 'Calibrating...'
                    : debug.darkCells > 0 ? '⚫ OBJECT DETECTED'
                    : 'Watching for disc'}
                </Text>
              </View>

              <Text style={styles.volHint}>Press Volume Up again to re-arm</Text>
            </View>
          )}

          {phase === 'result' && result && (
            <View style={styles.resultBox}>
              <Text style={styles.resultLabel}>SPEED</Text>
              <Text style={styles.resultValue}>{result.speedMph}</Text>
              <Text style={styles.resultUnit}>mph</Text>
              <View style={styles.divider} />
              <Text style={styles.resultLabel}>SPIN</Text>
              <Text style={styles.resultValue}>{result.spinRpm}</Text>
              <Text style={styles.resultUnit}>rpm (est)</Text>
            </View>
          )}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  overlay: { flex: 1, justifyContent: 'space-between' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  permBox: { flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center' },
  header: { paddingTop: 56, paddingHorizontal: 24, alignItems: 'center' },
  appName: { fontSize: 22, fontWeight: '900', letterSpacing: 4, color: colors.white },
  permText: { color: colors.white, fontSize: 16, marginBottom: 20, textAlign: 'center', paddingHorizontal: 32 },
  btn: { backgroundColor: colors.cyan, borderRadius: 12, paddingHorizontal: 32, paddingVertical: 14 },
  btnText: { color: colors.bg, fontWeight: '700', fontSize: 16 },
  idleBox: { alignItems: 'center', paddingHorizontal: 32 },
  instruction: { color: colors.white, fontSize: 18, textAlign: 'center', lineHeight: 26, marginBottom: 40 },
  volPrompt: { alignItems: 'center' },
  volPromptText: { color: colors.gray, fontSize: 15, marginVertical: 2 },
  volPromptKey: { color: colors.cyan, fontSize: 26, fontWeight: '900', letterSpacing: 2, marginVertical: 6 },
  volHint: { color: colors.gray, fontSize: 12, marginTop: 8 },
  readyBox: { alignItems: 'center', width: '100%', paddingHorizontal: 20 },
  pulseRing: { width: 120, height: 120, borderRadius: 60, borderWidth: 3, borderColor: colors.cyan, marginBottom: -60, opacity: 0.5 },
  readyText: { color: colors.cyan, fontSize: 36, fontWeight: '900', letterSpacing: 6, marginBottom: 4 },
  readySubText: { color: colors.gray, fontSize: 13, marginBottom: 12 },
  debugBox: { backgroundColor: colors.bgCard, borderRadius: 12, padding: 14, borderWidth: 1, borderColor: colors.grayDark, width: '100%', marginBottom: 14 },
  debugTitle: { color: colors.cyan, fontSize: 10, letterSpacing: 3, marginBottom: 8, fontWeight: '700' },
  debugRow: { color: colors.white, fontSize: 13, fontFamily: 'Courier New', marginBottom: 2 },
  debugVal: { color: colors.cyanLight, fontWeight: '700' },
  resultBox: { alignItems: 'center', backgroundColor: colors.bgCard, borderRadius: 24, paddingVertical: 36, paddingHorizontal: 60, borderWidth: 1, borderColor: colors.cyan },
  resultLabel: { color: colors.gray, fontSize: 13, letterSpacing: 4, marginBottom: 4 },
  resultValue: { color: colors.cyanLight, fontSize: 64, fontWeight: '900', lineHeight: 70 },
  resultUnit: { color: colors.cyan, fontSize: 18, letterSpacing: 2, marginBottom: 8 },
  divider: { width: 80, height: 1, backgroundColor: colors.grayDark, marginVertical: 20 },
});
