import React, { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, View, Text, TouchableOpacity, Animated, Platform } from 'react-native';
import {
  Camera,
  useCameraDevice,
  useCameraFormat,
  useCameraPermission,
  useFrameProcessor,
} from 'react-native-vision-camera';
import { useRunOnJS, useSharedValue } from 'react-native-worklets-core';
import * as Speech from 'expo-speech';
import * as Haptics from 'expo-haptics';
import { VolumeManager } from 'react-native-volume-manager';
import { colors } from '../lib/theme';
import { saveThrow } from '../lib/db';

const APP_VERSION = '0.2.1';

type Phase = 'idle' | 'ready' | 'result';
interface Result { speedMph: number; spinRpm: number; }
interface DebugInfo {
  brightness: number; baseline: number; fps: number;
  bufLen: number; frameW: number; frameH: number; bpr: number;
}

const DISC_DIAMETER_CM = 21.2;
const CAMERA_HEIGHT_CM = 152;
const H_FOV_DEG = 69;
// Sensitivity tuning — a disc 5ft up only dims a small patch of sky briefly.
const DROP_THRESHOLD = 8;        // avg brightness drop (whole-frame) — lowered
const DARK_PX_DROP = 30;         // a pixel this much darker than baseline = "dark"
const DARK_FRAC_THRESHOLD = 0.008; // ~0.8% of sampled pixels dark = disc cluster
const MAX_DARK_FRAMES = 60;

function calcSpeedMph(darkFrames: number, fps: number): number {
  const durationSec = Math.max(darkFrames, 1) / fps;
  const hFovRad = (H_FOV_DEG * Math.PI) / 180;
  const sceneWidthCm = 2 * CAMERA_HEIGHT_CM * Math.tan(hFovRad / 2);
  const speedCmPerSec = DISC_DIAMETER_CM / durationSec;
  return Math.round(speedCmPerSec * 0.0223694 * 10) / 10;
}

function calcSpinRpm(angleDelta: number, darkFrames: number, fps: number): number {
  const durationSec = Math.max(darkFrames, 1) / fps;
  return Math.round(Math.abs(angleDelta) / 360 / durationSec * 60);
}

export default function CameraScreen() {
  const device = useCameraDevice('back');
  const format = useCameraFormat(device, [{ fps: 120 }, { fps: 60 }, { fps: 30 }]);
  const { hasPermission, requestPermission } = useCameraPermission();

  const [phase, setPhase] = useState<Phase>('idle');
  const [result, setResult] = useState<Result | null>(null);
  const [debug, setDebug] = useState<DebugInfo>({ brightness: 0, baseline: 0, fps: 0, bufLen: 0, frameW: 0, frameH: 0, bpr: 0 });
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const resultTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Shared values — these DO cross the JS<->camera-thread boundary.
  // (Plain useRef does NOT: the worklet captures a frozen copy.)
  const isReadyRef = useSharedValue(false);
  const baselineRef = useSharedValue(-1);
  const calibCountRef = useSharedValue(0);
  const darkCountRef = useSharedValue(0);
  const inEventRef = useSharedValue(false);
  const angleDeltaRef = useSharedValue(0);
  const lastAngleRef = useSharedValue(-1);

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

  // useRunOnJS: worklets-core hook that creates worklet-callable JS callbacks
  const updateDebug = useRunOnJS((
    brightness: number, base: number, fps: number,
    bufLen: number, fw: number, fh: number, bpr: number
  ) => {
    setDebug({ brightness: Math.round(brightness), baseline: Math.round(base), fps, bufLen, frameW: fw, frameH: fh, bpr });
  }, []);

  const onDisc = useRunOnJS((darkFrames: number, angle: number, fps: number) => {
    if (!isReadyRef.value) return;
    isReadyRef.value = false;

    const mph = calcSpeedMph(darkFrames, fps);
    const rpm = calcSpinRpm(angle, darkFrames, fps);

    if (mph < 3 || mph > 130) { isReadyRef.value = true; return; }

    setResult({ speedMph: mph, spinRpm: rpm });
    setPhase('result');
    saveThrow(mph, rpm);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    Speech.speak(`${mph} miles per hour. ${rpm} R P M.`, { rate: 0.9 });

    resultTimeoutRef.current = setTimeout(() => {
      baselineRef.value = -1;
      calibCountRef.value = 0;
      darkCountRef.value = 0;
      inEventRef.value = false;
      setPhase('ready');
      isReadyRef.value = true;
    }, 4000);
  }, []);

  // ── Frame processor ──────────────────────────────────────────────────────────
  // KEY FIX: call frame.incrementRefCount() before toArrayBuffer() to prevent
  // the frame buffer from being released before our worklet accesses it.
  // This fixes the empty buffer issue in vision camera v4 + worklets-core.
  const frameProcessor = useFrameProcessor((frame) => {
    'worklet';

    const w = frame.width;
    const h = frame.height;
    const bpr = frame.bytesPerRow;
    const fps = format?.maxFps ?? 30;

    if (!isReadyRef.value) {
      updateDebug(0, 0, fps, -2, w, h, bpr);
      return;
    }

    // Retain frame so buffer isn't released before toArrayBuffer() executes
    (frame as any).incrementRefCount();

    let brightness = 0;
    let count = 0;
    let darkPx = 0;
    let leftX = w;
    let rightX = 0;
    let bufLen = 0;

    // Per-pixel "dark" cutoff relative to the calibrated bright baseline.
    // During calibration baseline is -1, so use a low cutoff (won't matter yet).
    const darkCutoff = baselineRef.value > 0 ? baselineRef.value - DARK_PX_DROP : -1;

    try {
      const buf = frame.toArrayBuffer();
      const pixels = new Uint8Array(buf);
      bufLen = pixels.length;

      if (bufLen === 0) {
        (frame as any).decrementRefCount();
        updateDebug(0, baselineRef.value, fps, 0, w, h, bpr);
        return;
      }

      // YUV_420: bufLen ≈ w*h*1.5 | BGRA: bufLen ≈ w*h*4
      const isYUV = bufLen < w * h * 2;
      const yStride = isYUV ? (bpr > 0 ? bpr : w) : w * 4;

      // Sample almost the whole frame (disc can cross anywhere), fine step.
      const top = Math.floor(h * 0.1);
      const bot = Math.floor(h * 0.9);

      for (let y = top; y < bot; y += 4) {
        for (let x = 0; x < w; x += 6) {
          let lum: number;
          if (isYUV) {
            const idx = y * yStride + x;
            if (idx >= bufLen) continue;
            lum = pixels[idx];
          } else {
            const idx = (y * w + x) * 4;
            if (idx + 2 >= bufLen) continue;
            lum = pixels[idx + 2] * 0.299 + pixels[idx + 1] * 0.587 + pixels[idx] * 0.114;
          }
          brightness += lum;
          count++;
          // Count pixels that are notably darker than the bright baseline → disc
          if (darkCutoff > 0 && lum < darkCutoff) {
            darkPx++;
            if (x < leftX) leftX = x;
            if (x > rightX) rightX = x;
          }
        }
      }
    } catch {
      (frame as any).decrementRefCount();
      updateDebug(-1, baselineRef.value, fps, -1, w, h, bpr);
      return;
    }

    // Release frame retain now that we have the data
    (frame as any).decrementRefCount();

    if (count === 0) return;
    const avg = brightness / count;
    const darkFrac = darkPx / count;

    // Calibration
    if (baselineRef.value < 0 || calibCountRef.value < 40) {
      baselineRef.value = calibCountRef.value === 0
        ? avg
        : (baselineRef.value * calibCountRef.value + avg) / (calibCountRef.value + 1);
      calibCountRef.value = calibCountRef.value + 1;
      updateDebug(avg, baselineRef.value, fps, bufLen, w, h, bpr);
      return;
    }

    updateDebug(avg, baselineRef.value, fps, bufLen, w, h, bpr);

    // Sensitive trigger: EITHER overall dimming OR a localized dark cluster
    // (a small disc high above only darkens a few % of pixels for 1-2 frames).
    const isDark =
      avg < baselineRef.value - DROP_THRESHOLD ||
      darkFrac > DARK_FRAC_THRESHOLD;

    if (isDark) {
      if (!inEventRef.value) {
        inEventRef.value = true;
        darkCountRef.value = 0;
        angleDeltaRef.value = 0;
        lastAngleRef.value = -1;
      }
      darkCountRef.value = darkCountRef.value + 1;

      if (rightX > leftX) {
        const cx = (leftX + rightX) / 2;
        const angle = (cx / w) * 180;
        if (lastAngleRef.value >= 0) {
          let d = angle - lastAngleRef.value;
          if (d > 90) d -= 180;
          if (d < -90) d += 180;
          angleDeltaRef.value = angleDeltaRef.value + d;
        }
        lastAngleRef.value = angle;
      }

      if (darkCountRef.value > MAX_DARK_FRAMES) {
        inEventRef.value = false;
        darkCountRef.value = 0;
        baselineRef.value = -1;
        calibCountRef.value = 0;
      }
    } else if (inEventRef.value) {
      if (darkCountRef.value >= 1) {
        onDisc(darkCountRef.value, angleDeltaRef.value, fps);
      }
      inEventRef.value = false;
      darkCountRef.value = 0;
    }
  }, [format, updateDebug, onDisc]);

  const startReady = () => {
    baselineRef.value = -1;
    calibCountRef.value = 0;
    darkCountRef.value = 0;
    inEventRef.value = false;
    if (resultTimeoutRef.current) clearTimeout(resultTimeoutRef.current);
    setResult(null);
    setPhase('ready');
    isReadyRef.value = true;
  };

  const stopReady = () => { isReadyRef.value = false; setPhase('idle'); };

  const simulateThrow = useCallback(() => {
    onDisc(3, 180, format?.maxFps ?? 30);
  }, [onDisc, format]);

  // Press the volume-up button to arm → announce "ready to throw".
  // We hide the native volume HUD and keep volume mid-range so there's always
  // headroom for an "up" press to register as a volume change event.
  const lastVolRef = useRef(0.5);
  useEffect(() => {
    let sub: { remove: () => void } | undefined;
    VolumeManager.showNativeVolumeUI({ enabled: false });
    VolumeManager.setVolume(0.5).catch(() => {});
    lastVolRef.current = 0.5;

    sub = VolumeManager.addVolumeListener((result) => {
      const v = result.volume;
      if (v > lastVolRef.current + 0.005) {
        // Volume went up → treat as the "arm" button press
        startReady();
        Speech.speak('Ready to throw', { rate: 0.95 });
      }
      lastVolRef.current = v;
      // Reset toward mid so repeated up-presses keep firing (and never max out)
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
        fps={format?.maxFps ?? 30}
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
              <Text style={styles.instruction}>Place your phone camera-up on the ground, 5 feet in front of where you throw.</Text>
              <TouchableOpacity style={styles.startBtn} onPress={startReady}>
                <Text style={styles.startBtnText}>START</Text>
              </TouchableOpacity>
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
                <Text style={styles.debugRow}>BytesPerRow: <Text style={styles.debugVal}>{debug.bpr}</Text></Text>
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
                <Text style={styles.debugRow}>FPS: <Text style={styles.debugVal}>{debug.fps}</Text></Text>
                <Text style={[styles.debugRow, { color: colors.gray, marginTop: 4, fontSize: 11 }]}>
                  {debug.bufLen <= 0
                    ? 'No pixel data yet'
                    : debug.baseline > 0
                    ? `Drop: ${debug.baseline - debug.brightness} (trigger at ${DROP_THRESHOLD}+)`
                    : 'Calibrating...'}
                </Text>
              </View>

              <TouchableOpacity style={styles.simBtn} onPress={simulateThrow}>
                <Text style={styles.simBtnText}>Simulate Throw (dev)</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.stopBtn} onPress={stopReady}>
                <Text style={styles.stopBtnText}>STOP</Text>
              </TouchableOpacity>
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
              <Text style={styles.resultUnit}>rpm</Text>
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
  startBtn: { backgroundColor: colors.cyan, borderRadius: 50, paddingHorizontal: 60, paddingVertical: 18 },
  startBtnText: { color: colors.bg, fontSize: 20, fontWeight: '900', letterSpacing: 3 },
  readyBox: { alignItems: 'center', width: '100%', paddingHorizontal: 20 },
  pulseRing: { width: 120, height: 120, borderRadius: 60, borderWidth: 3, borderColor: colors.cyan, marginBottom: -60, opacity: 0.5 },
  readyText: { color: colors.cyan, fontSize: 36, fontWeight: '900', letterSpacing: 6, marginBottom: 4 },
  readySubText: { color: colors.gray, fontSize: 13, marginBottom: 12 },
  debugBox: { backgroundColor: colors.bgCard, borderRadius: 12, padding: 14, borderWidth: 1, borderColor: colors.grayDark, width: '100%', marginBottom: 14 },
  debugTitle: { color: colors.cyan, fontSize: 10, letterSpacing: 3, marginBottom: 8, fontWeight: '700' },
  debugRow: { color: colors.white, fontSize: 13, fontFamily: 'Courier New', marginBottom: 2 },
  debugVal: { color: colors.cyanLight, fontWeight: '700' },
  simBtn: { borderWidth: 1, borderColor: colors.grayDark, borderRadius: 8, paddingHorizontal: 20, paddingVertical: 10, marginBottom: 12 },
  simBtnText: { color: colors.gray, fontSize: 13 },
  stopBtn: { borderWidth: 1, borderColor: colors.red, borderRadius: 8, paddingHorizontal: 32, paddingVertical: 12 },
  stopBtnText: { color: colors.red, fontWeight: '700', letterSpacing: 2 },
  resultBox: { alignItems: 'center', backgroundColor: colors.bgCard, borderRadius: 24, paddingVertical: 36, paddingHorizontal: 60, borderWidth: 1, borderColor: colors.cyan },
  resultLabel: { color: colors.gray, fontSize: 13, letterSpacing: 4, marginBottom: 4 },
  resultValue: { color: colors.cyanLight, fontSize: 64, fontWeight: '900', lineHeight: 70 },
  resultUnit: { color: colors.cyan, fontSize: 18, letterSpacing: 2, marginBottom: 8 },
  divider: { width: 80, height: 1, backgroundColor: colors.grayDark, marginVertical: 20 },
});
