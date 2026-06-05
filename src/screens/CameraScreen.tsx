import React, { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, View, Text, TouchableOpacity, Animated, Platform } from 'react-native';
import {
  Camera,
  useCameraDevice,
  useCameraPermission,
  useCameraFormat,
  useFrameProcessor,
} from 'react-native-vision-camera';
import { useRunOnJS } from 'react-native-worklets-core';
import * as Speech from 'expo-speech';
import * as Haptics from 'expo-haptics';
import { colors } from '../lib/theme';
import { saveThrow } from '../lib/db';

const APP_VERSION = '0.0.8';

let workletsAvailable = false;
try {
  require('react-native-worklets-core');
  workletsAvailable = true;
} catch {
  workletsAvailable = false;
}

type Phase = 'idle' | 'ready' | 'result';
interface Result { speedMph: number; spinRpm: number; }
interface DebugInfo {
  brightness: number; baseline: number; fps: number;
  bufLen: number; frameW: number; frameH: number; workletsOk: boolean;
}

const DISC_DIAMETER_CM = 21.2;
const CAMERA_HEIGHT_CM = 152;
const H_FOV_DEG = 69;
const DROP_THRESHOLD = 25;
const MAX_DARK_FRAMES = 45;

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
  // Prefer high-res high-fps — specify minimum dimensions to avoid tiny formats
  const format = useCameraFormat(device, [
    { videoWidth: 1920, videoHeight: 1080, fps: 120 },
    { videoWidth: 1920, videoHeight: 1080, fps: 60 },
    { videoWidth: 1280, videoHeight: 720, fps: 60 },
    { videoWidth: 1280, videoHeight: 720, fps: 30 },
  ]);
  const { hasPermission, requestPermission } = useCameraPermission();

  const [phase, setPhase] = useState<Phase>('idle');
  const [result, setResult] = useState<Result | null>(null);
  const [debug, setDebug] = useState<DebugInfo>({
    brightness: 0, baseline: 0, fps: 0,
    bufLen: 0, frameW: 0, frameH: 0, workletsOk: workletsAvailable,
  });
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const resultTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Plain refs — worklets-core can access these via JSI closure
  const isReady = useRef(false);
  const baseline = useRef(-1);
  const calibCount = useRef(0);
  const darkCount = useRef(0);
  const inEvent = useRef(false);
  const angleDelta = useRef(0);
  const lastAngle = useRef(-1);

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

  // useRunOnJS: creates worklet-callable functions that hop back to JS thread
  const updateDebug = useRunOnJS((
    brightness: number, base: number, fps: number,
    bufLen: number, fw: number, fh: number
  ) => {
    setDebug({
      brightness: Math.round(brightness),
      baseline: Math.round(base),
      fps,
      bufLen,
      frameW: fw,
      frameH: fh,
      workletsOk: true,
    });
  }, []);

  const onDisc = useRunOnJS((darkFrames: number, angle: number, fps: number) => {
    if (!isReady.current) return;
    isReady.current = false;

    const mph = calcSpeedMph(darkFrames, fps);
    const rpm = calcSpinRpm(angle, darkFrames, fps);

    if (mph < 3 || mph > 130) {
      isReady.current = true;
      return;
    }

    setResult({ speedMph: mph, spinRpm: rpm });
    setPhase('result');
    saveThrow(mph, rpm);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    Speech.speak(`${mph} miles per hour. ${rpm} R P M.`, { rate: 0.9 });

    resultTimeoutRef.current = setTimeout(() => {
      baseline.current = -1;
      calibCount.current = 0;
      darkCount.current = 0;
      inEvent.current = false;
      setPhase('ready');
      isReady.current = true;
    }, 4000);
  }, []);

  const frameProcessor = useFrameProcessor((frame) => {
    'worklet';

    const w = frame.width;
    const h = frame.height;
    const fps = format?.maxFps ?? 30;

    // Always report frame dimensions first so debug shows something
    if (!isReady.current) {
      if (w > 0) {
        // Pass negative bufLen to signal "not ready yet but frame is valid"
        updateDebug(0, 0, fps, frame.isValid ? -2 : -3, w, h);
      }
      return;
    }

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
        updateDebug(0, baseline.current, fps, 0, w, h);
        return;
      }

      // Determine pixel format from buffer size
      // YUV_420: bufLen ≈ w*h*1.5  →  Y plane is 1 byte/px
      // BGRA:    bufLen ≈ w*h*4    →  4 bytes/px
      const isYUV = bufLen < w * h * 2;
      const yStride = isYUV ? Math.round(bufLen / (h * 1.5)) : w * 4;

      const top = Math.floor(h * 0.4);
      const bot = Math.floor(h * 0.6);

      for (let y = top; y < bot; y += 2) {
        for (let x = 0; x < w; x += 8) {
          let lum: number;
          if (isYUV) {
            const idx = y * yStride + x;
            if (idx >= bufLen) continue;
            lum = pixels[idx];
          } else {
            // BGRA (iOS rgb mode) or RGBA
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
      updateDebug(-1, baseline.current, fps, -1, w, h);
      return;
    }

    if (count === 0) return;
    const avg = brightness / count;

    // ── Calibration ──────────────────────────────────────────────────────────
    if (baseline.current < 0 || calibCount.current < 40) {
      if (calibCount.current === 0) {
        baseline.current = avg;
      } else {
        baseline.current = (baseline.current * calibCount.current + avg) / (calibCount.current + 1);
      }
      calibCount.current = calibCount.current + 1;
      updateDebug(avg, baseline.current, fps, bufLen, w, h);
      return;
    }

    // ── Detection ─────────────────────────────────────────────────────────────
    updateDebug(avg, baseline.current, fps, bufLen, w, h);

    const isDark = avg < baseline.current - DROP_THRESHOLD;

    if (isDark) {
      if (!inEvent.current) {
        inEvent.current = true;
        darkCount.current = 0;
        angleDelta.current = 0;
        lastAngle.current = -1;
      }
      darkCount.current = darkCount.current + 1;

      if (rightX > leftX) {
        const cx = (leftX + rightX) / 2;
        const angle = (cx / w) * 180;
        if (lastAngle.current >= 0) {
          let d = angle - lastAngle.current;
          if (d > 90) d -= 180;
          if (d < -90) d += 180;
          angleDelta.current = angleDelta.current + d;
        }
        lastAngle.current = angle;
      }

      if (darkCount.current > MAX_DARK_FRAMES) {
        inEvent.current = false;
        darkCount.current = 0;
        baseline.current = -1;
        calibCount.current = 0;
      }
    } else if (inEvent.current) {
      if (darkCount.current >= 1) {
        onDisc(darkCount.current, angleDelta.current, fps);
      }
      inEvent.current = false;
      darkCount.current = 0;
    }
  }, [isReady, baseline, calibCount, darkCount, inEvent, angleDelta, lastAngle, format, onDisc, updateDebug]);

  const startReady = () => {
    baseline.current = -1;
    calibCount.current = 0;
    darkCount.current = 0;
    inEvent.current = false;
    if (resultTimeoutRef.current) clearTimeout(resultTimeoutRef.current);
    setResult(null);
    setPhase('ready');
    isReady.current = true;
  };

  const stopReady = () => {
    isReady.current = false;
    setPhase('idle');
  };

  const simulateThrow = useCallback(() => {
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
  if (!device) return <View style={styles.permBox}><Text style={styles.permText}>No camera found.</Text></View>;

  return (
    <View style={styles.container}>
      <Camera
        style={StyleSheet.absoluteFill}
        device={device}
        isActive={phase === 'ready'}
        format={format}
        fps={format?.maxFps ?? 30}
        frameProcessor={workletsAvailable ? frameProcessor : undefined}
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
                <Text style={styles.debugRow}>
                  Worklets: <Text style={{ color: debug.workletsOk ? colors.green : colors.red }}>
                    {debug.workletsOk ? '✓ active' : '✗ unavailable'}
                  </Text>
                </Text>
                <Text style={styles.debugRow}>Frame: <Text style={styles.debugVal}>{debug.frameW}×{debug.frameH}</Text></Text>
                <Text style={styles.debugRow}>
                  Buffer: <Text style={styles.debugVal}>
                    {debug.bufLen === 0 ? 'EMPTY ⚠️'
                      : debug.bufLen === -1 ? 'EXCEPTION ⚠️'
                      : debug.bufLen === -2 ? 'not started'
                      : debug.bufLen === -3 ? 'invalid frame'
                      : `${debug.bufLen} bytes ✓`}
                  </Text>
                </Text>
                <Text style={styles.debugRow}>Brightness: <Text style={styles.debugVal}>{debug.brightness}</Text></Text>
                <Text style={styles.debugRow}>Baseline: <Text style={styles.debugVal}>{debug.baseline}</Text></Text>
                <Text style={styles.debugRow}>FPS: <Text style={styles.debugVal}>{debug.fps}</Text></Text>
                <Text style={[styles.debugRow, { color: colors.gray, marginTop: 4, fontSize: 11 }]}>
                  {debug.bufLen <= 0
                    ? 'No pixel data — check pixelFormat'
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
