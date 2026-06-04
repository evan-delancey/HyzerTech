import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  StyleSheet,
  View,
  Text,
  TouchableOpacity,
  Animated,
} from 'react-native';
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

type Phase = 'idle' | 'ready' | 'detecting' | 'result';

interface Result {
  speedMph: number;
  spinRpm: number;
}

// ─── Detection constants ───────────────────────────────────────────────────
// How much brightness must drop (0-255) to count as a disc detection event
const BRIGHTNESS_DROP_THRESHOLD = 40;
// Minimum number of consecutive dark frames to confirm a disc (not noise)
const MIN_DARK_FRAMES = 2;
// Maximum frames a disc event can span (avoids false positives from shadows)
const MAX_DISC_FRAMES = 60;
// Known disc diameter in cm (standard 175g disc golf disc)
const DISC_DIAMETER_CM = 21.2;
// Camera height off ground in cm (5 feet)
const CAMERA_HEIGHT_CM = 152;
// Approximate horizontal FOV in degrees for most phone cameras
const H_FOV_DEG = 69;

function estimateSpeedMph(
  darkFrameCount: number,
  fps: number,
  imageWidthPx: number,
  discRadiusPx: number
): number {
  // Time the disc spent over the camera (in seconds)
  const durationSec = darkFrameCount / fps;

  // Real-world width of the scene at the disc's estimated altitude
  const altitudeCm = CAMERA_HEIGHT_CM; // simplification — disc is at ~ground level relative to camera
  const hFovRad = (H_FOV_DEG * Math.PI) / 180;
  const sceneWidthCm = 2 * altitudeCm * Math.tan(hFovRad / 2);
  const cmPerPx = sceneWidthCm / imageWidthPx;

  // Estimated disc diameter in pixels at this altitude
  const discDiamPx = discRadiusPx * 2;
  const discDiamCm = discDiamPx * cmPerPx;

  // Use actual disc size if detection seems reasonable, otherwise use known size
  const travelDistCm =
    discDiamCm > 5 && discDiamCm < 60 ? discDiamCm : DISC_DIAMETER_CM;

  const speedCmPerSec = travelDistCm / durationSec;
  return Math.round(speedCmPerSec * 0.0223694 * 10) / 10;
}

function estimateSpinRpm(
  angleDeltaDeg: number,
  darkFrameCount: number,
  fps: number
): number {
  const durationSec = darkFrameCount / fps;
  const rotationsPerSec = Math.abs(angleDeltaDeg) / 360 / durationSec;
  return Math.round(rotationsPerSec * 60);
}

export default function CameraScreen() {
  const device = useCameraDevice('back');
  const format = useCameraFormat(device, [{ fps: 120 }, { fps: 60 }, { fps: 30 }]);
  const { hasPermission, requestPermission } = useCameraPermission();

  const [phase, setPhase] = useState<Phase>('idle');
  const [result, setResult] = useState<Result | null>(null);
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const resultTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isReadyRef = useRef(false);

  // Detection state (shared with worklet via refs)
  const baselineBrightness = useRef<number>(-1);
  const darkFrameCount = useRef(0);
  const totalAngleDelta = useRef(0);
  const lastAngle = useRef<number | null>(null);
  const maxDiscRadius = useRef(0);
  const frameWidth = useRef(1920);
  const calibrationFrames = useRef(0);
  const inDiscEvent = useRef(false);

  useEffect(() => {
    if (!hasPermission) requestPermission();
  }, [hasPermission, requestPermission]);

  // Pulse animation
  useEffect(() => {
    if (phase === 'ready') {
      Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, { toValue: 1.15, duration: 700, useNativeDriver: true }),
          Animated.timing(pulseAnim, { toValue: 1, duration: 700, useNativeDriver: true }),
        ])
      ).start();
    } else {
      pulseAnim.setValue(1);
    }
  }, [phase, pulseAnim]);

  // Called from frame processor when a disc event is complete
  const onDiscEvent = useCallback(
    (darkFrames: number, angleDelta: number, discRadius: number, fps: number, imgWidth: number) => {
      if (phase !== 'ready' && phase !== 'detecting') return;

      const speedMph = estimateSpeedMph(darkFrames, fps, imgWidth, discRadius);
      const spinRpm = estimateSpinRpm(angleDelta, darkFrames, fps);

      // Sanity check — a disc golf throw is 20-100mph, spin 200-1500rpm
      if (speedMph < 5 || speedMph > 120) return;

      setResult({ speedMph, spinRpm });
      setPhase('result');
      saveThrow(speedMph, spinRpm);
      isReadyRef.current = false;

      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      Speech.speak(
        `${speedMph} miles per hour. ${spinRpm > 0 ? spinRpm + ' RPM.' : ''}`,
        { rate: 0.95, pitch: 1.0 }
      );

      resultTimeoutRef.current = setTimeout(() => {
        baselineBrightness.current = -1;
        calibrationFrames.current = 0;
        darkFrameCount.current = 0;
        inDiscEvent.current = false;
        setPhase('ready');
        isReadyRef.current = true;
      }, 4000);
    },
    [phase]
  );

  // ─── Frame processor ───────────────────────────────────────────────────────
  // Runs on every camera frame at full frame rate.
  // Algorithm:
  //   1. Calibrate: average brightness of first 30 frames = baseline (open sky/ceiling)
  //   2. Each frame: sample center horizontal strip brightness
  //   3. If brightness drops > threshold → disc is over camera → dark frame
  //   4. Track consecutive dark frames + edge angle change (for spin)
  //   5. When dark frames end → disc has passed → report result
  const frameProcessor = useFrameProcessor(
    (frame) => {
      'worklet';
      if (!isReadyRef.current) return;

      const width = frame.width;
      const height = frame.height;

      // Sample a horizontal strip through the center (10% of height)
      const stripTop = Math.floor(height * 0.45);
      const stripBot = Math.floor(height * 0.55);
      const step = 8; // sample every 8th pixel for speed

      let brightness = 0;
      let count = 0;
      let leftEdgeX = width;
      let rightEdgeX = 0;

      try {
        // Access raw pixel data
        const buffer = frame.toArrayBuffer();
        const pixels = new Uint8Array(buffer);

        for (let y = stripTop; y < stripBot; y += 2) {
          for (let x = 0; x < width; x += step) {
            const i = (y * width + x) * 4; // RGBA
            const lum = pixels[i] * 0.299 + pixels[i + 1] * 0.587 + pixels[i + 2] * 0.114;
            brightness += lum;
            count++;

            // Track dark pixels to find disc edges (for radius estimation)
            if (lum < 80) {
              if (x < leftEdgeX) leftEdgeX = x;
              if (x > rightEdgeX) rightEdgeX = x;
            }
          }
        }
      } catch {
        // frame.toArrayBuffer() not available — skip this frame
        return;
      }

      if (count === 0) return;
      const avgBrightness = brightness / count;
      frameWidth.current = width;

      // ── Phase 1: Calibration ──────────────────────────────────────────────
      if (baselineBrightness.current < 0) {
        // Running average of first 30 frames to set baseline
        if (calibrationFrames.current === 0) {
          baselineBrightness.current = avgBrightness;
        } else {
          baselineBrightness.current =
            (baselineBrightness.current * calibrationFrames.current + avgBrightness) /
            (calibrationFrames.current + 1);
        }
        calibrationFrames.current++;
        if (calibrationFrames.current < 30) return; // still calibrating
      }

      const isDark = avgBrightness < baselineBrightness.current - BRIGHTNESS_DROP_THRESHOLD;

      // ── Phase 2: Disc detection ───────────────────────────────────────────
      if (isDark) {
        if (!inDiscEvent.current) {
          inDiscEvent.current = true;
          darkFrameCount.current = 0;
          totalAngleDelta.current = 0;
          lastAngle.current = null;
          maxDiscRadius.current = 0;
        }

        darkFrameCount.current++;

        // Track disc radius from edge positions
        if (rightEdgeX > leftEdgeX) {
          const radius = (rightEdgeX - leftEdgeX) / 2;
          if (radius > maxDiscRadius.current) maxDiscRadius.current = radius;

          // Estimate edge angle (for spin) from blob shape
          if (lastAngle.current !== null) {
            // Centroid x shift gives us horizontal motion + spin angle proxy
            const centerX = (leftEdgeX + rightEdgeX) / 2;
            const angle = Math.atan2(stripBot - stripTop, centerX) * (180 / Math.PI);
            let delta = angle - lastAngle.current;
            if (delta > 180) delta -= 360;
            if (delta < -180) delta += 360;
            totalAngleDelta.current += delta;
            lastAngle.current = angle;
          } else {
            const centerX = (leftEdgeX + rightEdgeX) / 2;
            lastAngle.current = Math.atan2(stripBot - stripTop, centerX) * (180 / Math.PI);
          }
        }

        // Safety: if disc event goes on too long it's probably a shadow, not a disc
        if (darkFrameCount.current > MAX_DISC_FRAMES) {
          inDiscEvent.current = false;
          darkFrameCount.current = 0;
          baselineBrightness.current = -1; // force recalibration
          calibrationFrames.current = 0;
        }
      } else if (inDiscEvent.current && darkFrameCount.current >= MIN_DARK_FRAMES) {
        // Disc has passed! Report results.
        inDiscEvent.current = false;
        const fps = format?.maxFps ?? 30;
        runOnJS(onDiscEvent)(
          darkFrameCount.current,
          totalAngleDelta.current,
          maxDiscRadius.current,
          fps,
          width
        );
      } else {
        // Brief dark blip (noise) — reset
        inDiscEvent.current = false;
        darkFrameCount.current = 0;
      }
    },
    [isReadyRef, format, onDiscEvent]
  );

  const startReady = () => {
    baselineBrightness.current = -1;
    calibrationFrames.current = 0;
    darkFrameCount.current = 0;
    inDiscEvent.current = false;
    if (resultTimeoutRef.current) clearTimeout(resultTimeoutRef.current);
    setResult(null);
    setPhase('ready');
    isReadyRef.current = true;
  };

  const stopReady = () => {
    isReadyRef.current = false;
    setPhase('idle');
  };

  // Dev-only simulated throw
  const simulateThrow = useCallback(() => {
    if (phase !== 'ready') return;
    runOnJS(onDiscEvent)(8, 180, 90, format?.maxFps ?? 30, 1920);
  }, [phase, onDiscEvent, format]);

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
    return (
      <View style={styles.permBox}>
        <Text style={styles.permText}>No camera found.</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Camera
        ref={undefined}
        style={StyleSheet.absoluteFill}
        device={device}
        isActive={phase === 'ready' || phase === 'detecting'}
        format={format}
        fps={format?.maxFps ?? 30}
        frameProcessor={frameProcessor}
        photo={false}
        video={false}
        audio={false}
      />

      <View style={styles.overlay}>
        <View style={styles.header}>
          <Text style={styles.appName}>
            HYZER<Text style={{ color: colors.cyan }}>TECH</Text>
          </Text>
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

          {(phase === 'ready' || phase === 'detecting') && (
            <View style={styles.readyBox}>
              <Animated.View
                style={[styles.pulseRing, { transform: [{ scale: pulseAnim }] }]}
              />
              <Text style={styles.readyText}>
                {phase === 'detecting' ? 'MEASURING...' : 'READY'}
              </Text>
              <Text style={styles.readySubText}>
                {phase === 'detecting'
                  ? 'Disc detected!'
                  : 'Throw the disc over the camera'}
              </Text>
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
  readyBox: { alignItems: 'center' },
  pulseRing: {
    width: 160, height: 160, borderRadius: 80,
    borderWidth: 3, borderColor: colors.cyan,
    marginBottom: -80, opacity: 0.5,
  },
  readyText: { color: colors.cyan, fontSize: 36, fontWeight: '900', letterSpacing: 6, marginBottom: 8 },
  readySubText: { color: colors.gray, fontSize: 14, marginBottom: 40 },
  simBtn: {
    borderWidth: 1, borderColor: colors.grayDark, borderRadius: 8,
    paddingHorizontal: 20, paddingVertical: 10, marginBottom: 16,
  },
  simBtnText: { color: colors.gray, fontSize: 13 },
  stopBtn: { borderWidth: 1, borderColor: colors.red, borderRadius: 8, paddingHorizontal: 32, paddingVertical: 12 },
  stopBtnText: { color: colors.red, fontWeight: '700', letterSpacing: 2 },
  resultBox: {
    alignItems: 'center', backgroundColor: colors.bgCard,
    borderRadius: 24, paddingVertical: 36, paddingHorizontal: 60,
    borderWidth: 1, borderColor: colors.cyan,
  },
  resultLabel: { color: colors.gray, fontSize: 13, letterSpacing: 4, marginBottom: 4 },
  resultValue: { color: colors.cyanLight, fontSize: 64, fontWeight: '900', lineHeight: 70 },
  resultUnit: { color: colors.cyan, fontSize: 18, letterSpacing: 2, marginBottom: 8 },
  divider: { width: 80, height: 1, backgroundColor: colors.grayDark, marginVertical: 20 },
});
