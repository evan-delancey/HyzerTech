import React, { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, View, Text, TouchableOpacity, Animated, Platform } from 'react-native';

const APP_VERSION = '0.0.5'; // bump this each push so you know what's running
import {
  Camera,
  useCameraDevice,
  useCameraPermission,
  useCameraFormat,
  useFrameProcessor,
} from 'react-native-vision-camera';
import { runOnJS } from 'react-native-reanimated';
import * as Speech from 'expo-speech';
import * as Haptics from 'expo-haptics';
import { colors } from '../lib/theme';
import { saveThrow } from '../lib/db';

// Check if worklets-core is compiled into this native binary
let workletsAvailable = false;
try {
  require('react-native-worklets-core');
  workletsAvailable = true;
} catch {
  workletsAvailable = false;
}

type Phase = 'idle' | 'ready' | 'result';

interface Result { speedMph: number; spinRpm: number; }
interface DebugInfo { brightness: number; baseline: number; fps: number; workletsOk: boolean; bufLen: number; frameW: number; frameH: number; }

// ── Physics ──────────────────────────────────────────────────────────────────
const DISC_DIAMETER_CM = 21.2;
const CAMERA_HEIGHT_CM = 152; // 5 feet
const H_FOV_DEG = 69;
const DROP_THRESHOLD = 25;   // brightness units drop needed to detect disc
const MIN_DARK_FRAMES = 1;   // even 1 frame counts — disc is fast!
const MAX_DARK_FRAMES = 45;  // more than this = shadow, not disc

function speedMph(darkFrames: number, fps: number): number {
  const durationSec = Math.max(darkFrames, 1) / fps;
  const hFovRad = (H_FOV_DEG * Math.PI) / 180;
  const sceneWidthCm = 2 * CAMERA_HEIGHT_CM * Math.tan(hFovRad / 2);
  // disc travels its own diameter across the sensor
  const speedCmPerSec = DISC_DIAMETER_CM / durationSec;
  return Math.round(speedCmPerSec * 0.0223694 * 10) / 10;
}

function spinRpm(angleDelta: number, darkFrames: number, fps: number): number {
  const durationSec = Math.max(darkFrames, 1) / fps;
  return Math.round(Math.abs(angleDelta) / 360 / durationSec * 60);
}

export default function CameraScreen() {
  const device = useCameraDevice('back');
  const format = useCameraFormat(device, [{ fps: 120 }, { fps: 60 }, { fps: 30 }]);
  const { hasPermission, requestPermission } = useCameraPermission();

  const [phase, setPhase] = useState<Phase>('idle');
  const [result, setResult] = useState<Result | null>(null);
  const [debug, setDebug] = useState<DebugInfo>({ brightness: 0, baseline: 0, fps: 0, workletsOk: workletsAvailable, bufLen: 0, frameW: 0, frameH: 0 });
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const resultTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Refs shared with frame processor worklet
  const isReadyRef = useRef(false);
  const baselineRef = useRef(-1);
  const calibCountRef = useRef(0);
  const darkCountRef = useRef(0);
  const inEventRef = useRef(false);
  const angleDeltaRef = useRef(0);
  const lastAngleRef = useRef<number | null>(null);

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

  // Update debug display (called from worklet via runOnJS)
  const updateDebug = useCallback((brightness: number, baseline: number, fps: number, bufLen: number, frameW: number, frameH: number) => {
    setDebug({ brightness: Math.round(brightness), baseline: Math.round(baseline), fps, workletsOk: true, bufLen, frameW, frameH });
  }, []);

  // Called from worklet when disc event is complete
  const onDisc = useCallback((darkFrames: number, angleDelta: number, fps: number) => {
    if (!isReadyRef.current) return;
    isReadyRef.current = false;

    const mph = speedMph(darkFrames, fps);
    const rpm = spinRpm(angleDelta, darkFrames, fps);

    // Sanity check
    if (mph < 3 || mph > 130) {
      // Out of range — reset and wait for next throw
      isReadyRef.current = true;
      return;
    }

    setResult({ speedMph: mph, spinRpm: rpm });
    setPhase('result');
    saveThrow(mph, rpm);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    Speech.speak(`${mph} miles per hour. ${rpm} R P M.`, { rate: 0.9 });

    resultTimeoutRef.current = setTimeout(() => {
      baselineRef.current = -1;
      calibCountRef.current = 0;
      darkCountRef.current = 0;
      inEventRef.current = false;
      setPhase('ready');
      isReadyRef.current = true;
    }, 4000);
  }, []);

  // ── Frame processor ─────────────────────────────────────────────────────────
  // Samples brightness from the center strip of each camera frame.
  // Android frames are YUV_420_888: Y (luminance) plane is first, 1 byte/pixel.
  // iOS frames may be BGRA: luminance = 0.299R + 0.587G + 0.114B.
  const frameProcessor = useFrameProcessor((frame) => {
    'worklet';
    if (!isReadyRef.current) return;

    const w = frame.width;
    const h = frame.height;
    const fps = format?.maxFps ?? 30;

    let brightness = 0;
    let count = 0;
    let leftX = w;
    let rightX = 0;
    let bufLen = 0;

    try {
      const buf = frame.toArrayBuffer();
      const pixels = new Uint8Array(buf);
      bufLen = pixels.length;

      if (bufLen === 0) {
        // Buffer is empty — can't process this frame
        runOnJS(updateDebug)(0, baselineRef.current, format?.maxFps ?? 0, 0, w, h);
        return;
      }

      // Detect pixel format from buffer size:
      // YUV_420_888 (Android) → bufLen ≈ w*h*1.5
      // BGRA/RGB    (iOS)     → bufLen ≈ w*h*4
      const isYUV = bufLen < w * h * 2;

      // Sample the center 20% horizontal strip
      const top = Math.floor(h * 0.4);
      const bot = Math.floor(h * 0.6);
      const step = 6;
      // Account for row padding on Android YUV
      const yStride = isYUV ? Math.round(bufLen / (h * 1.5)) : w * 4;

      for (let y = top; y < bot; y += 2) {
        for (let x = 0; x < w; x += step) {
          let lum: number;
          if (isYUV) {
            // Android YUV: Y plane first, 1 byte per pixel
            const idx = y * yStride + x;
            if (idx >= bufLen) continue;
            lum = pixels[idx];
          } else {
            // iOS BGRA: 4 bytes per pixel → B=0, G=1, R=2, A=3
            const idx = (y * w + x) * 4;
            if (idx + 2 >= bufLen) continue;
            lum = pixels[idx + 2] * 0.299 + pixels[idx + 1] * 0.587 + pixels[idx] * 0.114;
          }
          brightness += lum;
          count++;
          if (lum < 60) {
            if (x < leftX) leftX = x;
            if (x > rightX) rightX = x;
          }
        }
      }
    } catch {
      runOnJS(updateDebug)(-1, -1, 0, -1, w, h);
      return; // frame.toArrayBuffer() failed
    }

    if (count === 0) return;
    const avg = brightness / count;

    // ── Calibration: build baseline over first 40 frames ──────────────────────
    if (baselineRef.current < 0 || calibCountRef.current < 40) {
      if (calibCountRef.current === 0) {
        baselineRef.current = avg;
      } else {
        baselineRef.current = (baselineRef.current * calibCountRef.current + avg) / (calibCountRef.current + 1);
      }
      calibCountRef.current++;
      runOnJS(updateDebug)(avg, baselineRef.current, fps, bufLen, w, h);
      return;
    }

    // Update debug display every 10 frames to avoid flooding
    if (darkCountRef.current === 0) {
      runOnJS(updateDebug)(avg, baselineRef.current, fps, bufLen, w, h);
    }

    const isDark = avg < baselineRef.current - DROP_THRESHOLD;

    if (isDark) {
      if (!inEventRef.current) {
        inEventRef.current = true;
        darkCountRef.current = 0;
        angleDeltaRef.current = 0;
        lastAngleRef.current = null;
      }
      darkCountRef.current++;

      // Track edge angle for spin estimation
      if (rightX > leftX) {
        const centerX = (leftX + rightX) / 2;
        const angle = (centerX / w) * 180; // map x position to angle proxy
        if (lastAngleRef.current !== null) {
          let d = angle - lastAngleRef.current;
          if (d > 90) d -= 180;
          if (d < -90) d += 180;
          angleDeltaRef.current += d;
        }
        lastAngleRef.current = angle;
      }

      // Too many dark frames = shadow or obstruction, not a disc
      if (darkCountRef.current > MAX_DARK_FRAMES) {
        inEventRef.current = false;
        darkCountRef.current = 0;
        baselineRef.current = -1;
        calibCountRef.current = 0;
      }
    } else if (inEventRef.current) {
      if (darkCountRef.current >= MIN_DARK_FRAMES) {
        // Disc passed! Fire result.
        runOnJS(onDisc)(darkCountRef.current, angleDeltaRef.current, fps);
      }
      inEventRef.current = false;
      darkCountRef.current = 0;
    }
  }, [isReadyRef, format, onDisc, updateDebug]);

  const startReady = () => {
    baselineRef.current = -1;
    calibCountRef.current = 0;
    darkCountRef.current = 0;
    inEventRef.current = false;
    if (resultTimeoutRef.current) clearTimeout(resultTimeoutRef.current);
    setResult(null);
    setPhase('ready');
    isReadyRef.current = true;
  };

  const stopReady = () => {
    isReadyRef.current = false;
    setPhase('idle');
  };

  const simulateThrow = useCallback(() => {
    if (!isReadyRef.current) return;
    onDisc(3, 180, format?.maxFps ?? 30);
  }, [onDisc, format]);

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

  if (!device) {
    return <View style={styles.permBox}><Text style={styles.permText}>No camera found.</Text></View>;
  }

  return (
    <View style={styles.container}>
      <Camera
        style={StyleSheet.absoluteFill}
        device={device}
        isActive={phase === 'ready'}
        format={format}
        fps={format?.maxFps ?? 30}
        frameProcessor={workletsAvailable ? frameProcessor : undefined}
        pixelFormat={Platform.OS === 'ios' ? 'rgb' : 'yuv'}
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

              {/* Debug panel — shows live brightness readings */}
              <View style={styles.debugBox}>
                <Text style={styles.debugTitle}>SENSOR DEBUG  v{APP_VERSION}</Text>
                <Text style={styles.debugRow}>
                  Worklets: <Text style={{ color: debug.workletsOk ? colors.green : colors.red }}>
                    {debug.workletsOk ? '✓ active' : '✗ not available'}
                  </Text>
                </Text>
                <Text style={styles.debugRow}>Frame: <Text style={styles.debugVal}>{debug.frameW}×{debug.frameH}</Text></Text>
                <Text style={styles.debugRow}>Buffer: <Text style={styles.debugVal}>{debug.bufLen === 0 ? 'EMPTY ⚠️' : debug.bufLen === -1 ? 'ERROR ⚠️' : debug.bufLen}</Text></Text>
                <Text style={styles.debugRow}>Brightness: <Text style={styles.debugVal}>{debug.brightness}</Text></Text>
                <Text style={styles.debugRow}>Baseline:   <Text style={styles.debugVal}>{debug.baseline}</Text></Text>
                <Text style={styles.debugRow}>FPS: <Text style={styles.debugVal}>{debug.fps}</Text></Text>
                <Text style={[styles.debugRow, { color: colors.gray, marginTop: 4, fontSize: 11 }]}>
                  {debug.bufLen <= 0 ? 'Buffer empty — toArrayBuffer() issue' :
                   debug.baseline > 0 && debug.brightness > 0
                    ? `Drop: ${debug.baseline - debug.brightness} (need ${DROP_THRESHOLD}+)`
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
  readyBox: { alignItems: 'center', width: '100%', paddingHorizontal: 24 },
  pulseRing: { width: 120, height: 120, borderRadius: 60, borderWidth: 3, borderColor: colors.cyan, marginBottom: -60, opacity: 0.5 },
  readyText: { color: colors.cyan, fontSize: 36, fontWeight: '900', letterSpacing: 6, marginBottom: 4 },
  readySubText: { color: colors.gray, fontSize: 13, marginBottom: 16 },
  debugBox: {
    backgroundColor: colors.bgCard, borderRadius: 12, padding: 14,
    borderWidth: 1, borderColor: colors.grayDark, width: '100%', marginBottom: 16,
  },
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
