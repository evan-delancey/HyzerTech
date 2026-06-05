/**
 * CameraScreen — disc detection using expo-camera rapid snapshots.
 *
 * Strategy:
 *  - Show live camera feed via CameraView (expo-camera)
 *  - Every 80ms, take a 1%-quality snapshot and read its base64 data
 *  - Measure average byte value of base64 data as a brightness proxy
 *    (brighter/uniform sky → shorter JPEG → different byte signature than disc)
 *  - Detect when signature drops significantly → disc flew over camera
 *  - Use timing of the dark period to estimate speed
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, View, Text, TouchableOpacity, Animated } from 'react-native';
import { CameraView, CameraType, useCameraPermissions } from 'expo-camera';
import * as FileSystem from 'expo-file-system';
import * as Speech from 'expo-speech';
import * as Haptics from 'expo-haptics';
import { colors } from '../lib/theme';
import { saveThrow } from '../lib/db';

const APP_VERSION = '0.1.3';

// ── Physics constants ──────────────────────────────────────────────────────────
const DISC_DIAMETER_CM = 21.2;
const CAMERA_HEIGHT_CM = 152;   // 5 feet
const H_FOV_DEG = 69;
const POLL_INTERVAL_MS = 80;    // ~12fps polling
const CALIB_FRAMES = 20;        // frames to establish baseline brightness
const DROP_THRESHOLD = 4;       // brightness drop needed to trigger (0-100 scale)
const MIN_DARK_MS = 20;         // minimum dark period to count as a disc (not noise)
const MAX_DARK_MS = 3000;       // maximum — anything longer is a shadow/hand

function calcSpeedMph(durationMs: number): number {
  const durationSec = Math.max(durationMs, 1) / 1000;
  const hFovRad = (H_FOV_DEG * Math.PI) / 180;
  const sceneWidthCm = 2 * CAMERA_HEIGHT_CM * Math.tan(hFovRad / 2);
  const speedCmPerSec = DISC_DIAMETER_CM / durationSec;
  return Math.round(speedCmPerSec * 0.0223694 * 10) / 10;
}

/** Sample base64 JPEG data to estimate image brightness (0–100 scale). */
function base64Brightness(b64: string): number {
  // Sample characters from the middle of the base64 string.
  // Brighter images tend to have higher average base64 character codes
  // because bright JPEG DCT coefficients produce larger byte values.
  let sum = 0;
  const start = Math.floor(b64.length * 0.2);
  const end = Math.floor(b64.length * 0.8);
  const step = Math.max(1, Math.floor((end - start) / 200));
  let count = 0;
  for (let i = start; i < end; i += step) {
    sum += b64.charCodeAt(i);
    count++;
  }
  // Normalise to 0–100
  return count > 0 ? (sum / count / 128) * 50 : 50;
}

type Phase = 'idle' | 'ready' | 'result';
interface Result { speedMph: number; }
interface DebugInfo { brightness: number; baseline: number; drop: number; fps: number; status: string; }

export default function CameraScreen() {
  const [permission, requestPermission] = useCameraPermissions();
  const [phase, setPhase] = useState<Phase>('idle');
  const [result, setResult] = useState<Result | null>(null);
  const [debug, setDebug] = useState<DebugInfo>({ brightness: 0, baseline: 0, drop: 0, fps: 0, status: 'idle' });
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const cameraRef = useRef<CameraView>(null);

  // Detection state
  const runningRef = useRef(false);
  const baselineRef = useRef(-1);
  const calibCountRef = useRef(0);
  const darkStartRef = useRef<number | null>(null);
  const lastPollRef = useRef<number>(0);
  const pollCountRef = useRef(0);
  const fpsStartRef = useRef<number>(Date.now());
  const resultTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  const handleDiscDetected = useCallback((durationMs: number) => {
    runningRef.current = false;
    const mph = calcSpeedMph(durationMs);

    if (mph < 3 || mph > 130) {
      // Out of range — reset baseline and continue
      baselineRef.current = -1;
      calibCountRef.current = 0;
      runningRef.current = true;
      return;
    }

    setResult({ speedMph: mph });
    setPhase('result');
    saveThrow(mph, 0); // spin not measurable via snapshots
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    Speech.speak(`${mph} miles per hour.`, { rate: 0.9 });

    resultTimeoutRef.current = setTimeout(() => {
      baselineRef.current = -1;
      calibCountRef.current = 0;
      darkStartRef.current = null;
      runningRef.current = true;
      setPhase('ready');
    }, 4000);
  }, []);

  // ── Detection loop ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (phase !== 'ready') return;
    runningRef.current = true;

    const poll = async () => {
      if (!runningRef.current) return;

      try {
        const photo = await cameraRef.current?.takePictureAsync({
          quality: 0.01,      // 1% quality for speed
          skipProcessing: true,
          base64: true,
        });

        if (photo?.base64 && runningRef.current) {
          const now = Date.now();
          const brightness = base64Brightness(photo.base64);

          // FPS tracking
          pollCountRef.current++;
          const elapsed = (now - fpsStartRef.current) / 1000;
          const fps = elapsed > 0 ? Math.round(pollCountRef.current / elapsed) : 0;

          // Calibration phase
          if (baselineRef.current < 0 || calibCountRef.current < CALIB_FRAMES) {
            baselineRef.current = calibCountRef.current === 0
              ? brightness
              : (baselineRef.current * calibCountRef.current + brightness) / (calibCountRef.current + 1);
            calibCountRef.current++;
            setDebug({ brightness, baseline: baselineRef.current, drop: 0, fps, status: `Calibrating ${calibCountRef.current}/${CALIB_FRAMES}` });
          } else {
            const drop = baselineRef.current - brightness;
            const isDark = drop > DROP_THRESHOLD;
            setDebug({ brightness, baseline: baselineRef.current, drop: Math.round(drop * 10) / 10, fps, status: isDark ? '⚫ DISC DETECTED' : 'Waiting...' });

            if (isDark) {
              if (!darkStartRef.current) {
                darkStartRef.current = now;
              } else if (now - darkStartRef.current > MAX_DARK_MS) {
                // Too long — shadow or hand, not disc. Reset.
                darkStartRef.current = null;
                baselineRef.current = -1;
                calibCountRef.current = 0;
              }
            } else if (darkStartRef.current) {
              // Bright again — disc has passed
              const durationMs = now - darkStartRef.current;
              darkStartRef.current = null;
              if (durationMs >= MIN_DARK_MS) {
                handleDiscDetected(durationMs);
                return;
              }
            }
          }

          // Clean up the temp file
          if (photo.uri) {
            FileSystem.deleteAsync(photo.uri, { idempotent: true }).catch(() => {});
          }
        }
      } catch {
        // Camera not ready yet — skip this frame
      }

      if (runningRef.current) {
        setTimeout(poll, POLL_INTERVAL_MS);
      }
    };

    // Small delay to let camera warm up
    setTimeout(poll, 500);

    return () => { runningRef.current = false; };
  }, [phase, handleDiscDetected]);

  const startReady = () => {
    baselineRef.current = -1;
    calibCountRef.current = 0;
    darkStartRef.current = null;
    pollCountRef.current = 0;
    fpsStartRef.current = Date.now();
    if (resultTimeoutRef.current) clearTimeout(resultTimeoutRef.current);
    setResult(null);
    setPhase('ready');
  };

  const stopReady = () => {
    runningRef.current = false;
    setPhase('idle');
  };

  const simulateThrow = () => handleDiscDetected(120); // simulate 120ms disc passage

  if (!permission) return <View style={styles.permBox} />;
  if (!permission.granted) {
    return (
      <View style={styles.permBox}>
        <Text style={styles.permText}>Camera permission required.</Text>
        <TouchableOpacity style={styles.btn} onPress={requestPermission}>
          <Text style={styles.btnText}>Grant Permission</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {phase === 'ready' && (
        <CameraView
          ref={cameraRef}
          style={StyleSheet.absoluteFill}
          facing={'back' as CameraType}
        />
      )}

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
                <Text style={styles.debugRow}>Status: <Text style={[styles.debugVal, { color: debug.status.includes('DISC') ? colors.green : colors.cyanLight }]}>{debug.status}</Text></Text>
                <Text style={styles.debugRow}>Brightness: <Text style={styles.debugVal}>{debug.brightness.toFixed(1)}</Text></Text>
                <Text style={styles.debugRow}>Baseline:   <Text style={styles.debugVal}>{debug.baseline.toFixed(1)}</Text></Text>
                <Text style={styles.debugRow}>Drop:       <Text style={styles.debugVal}>{debug.drop} (trigger at {DROP_THRESHOLD}+)</Text></Text>
                <Text style={styles.debugRow}>FPS: <Text style={styles.debugVal}>{debug.fps}</Text></Text>
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
              <Text style={[styles.resultLabel, { marginTop: 16, fontSize: 11 }]}>
                Spin measurement coming in a future update
              </Text>
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
});
