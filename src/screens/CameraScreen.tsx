import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  StyleSheet,
  View,
  Text,
  TouchableOpacity,
  Animated,
  Platform,
} from 'react-native';
import {
  Camera,
  useCameraDevice,
  useCameraPermission,
  useCameraFormat,
} from 'react-native-vision-camera';
import * as Speech from 'expo-speech';
import * as Haptics from 'expo-haptics';
import { colors } from '../lib/theme';
import { saveThrow } from '../lib/db';
import { calculateThrowResult, DiscBlob } from '../lib/discDetector';

type Phase = 'idle' | 'ready' | 'detecting' | 'result';

interface Result {
  speedMph: number;
  spinRpm: number;
}

export default function CameraScreen() {
  const device = useCameraDevice('back');
  // Pick the highest FPS format available on this device (120fps if supported, else max)
  const format = useCameraFormat(device, [
    { fps: 120 },
    { fps: 60 },
  ]);
  const { hasPermission, requestPermission } = useCameraPermission();
  const [phase, setPhase] = useState<Phase>('idle');
  const [result, setResult] = useState<Result | null>(null);
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const blobsRef = useRef<DiscBlob[]>([]);
  const detectingRef = useRef(false);
  const resultTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!hasPermission) requestPermission();
  }, [hasPermission, requestPermission]);

  // Pulse animation for the "ready" ring
  useEffect(() => {
    if (phase === 'ready') {
      Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, {
            toValue: 1.15,
            duration: 700,
            useNativeDriver: true,
          }),
          Animated.timing(pulseAnim, {
            toValue: 1,
            duration: 700,
            useNativeDriver: true,
          }),
        ])
      ).start();
    } else {
      pulseAnim.setValue(1);
    }
  }, [phase, pulseAnim]);

  const handleThrowDetected = useCallback((blobs: DiscBlob[]) => {
    const throwResult = calculateThrowResult(blobs);
    if (!throwResult) return;

    setResult(throwResult);
    setPhase('result');
    saveThrow(throwResult.speedMph, throwResult.spinRpm);

    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

    Speech.speak(
      `${throwResult.speedMph} miles per hour. ${throwResult.spinRpm} RPM.`,
      { rate: 0.95, pitch: 1.0 }
    );

    // Return to ready after 4 seconds
    resultTimeoutRef.current = setTimeout(() => {
      blobsRef.current = [];
      detectingRef.current = false;
      setPhase('ready');
    }, 4000);
  }, []);

  // Frame processor placeholder — will be wired to disc detection logic
  // once react-native-worklets-core is fully configured in the native build.
  const frameProcessor = undefined;

  // Simulated detection trigger for development/testing
  // In production, the frame processor calls this when a disc is detected.
  const simulateThrow = useCallback(() => {
    if (phase !== 'ready') return;
    setPhase('detecting');
    detectingRef.current = true;

    // Simulate blobs arriving over ~200ms (disc crossing at 60mph)
    const fakeBlobs: DiscBlob[] = Array.from({ length: 8 }, (_, i) => ({
      cx: 200 + i * 200,
      cy: 540 + Math.random() * 20 - 10,
      radiusPx: 90 + Math.random() * 10,
      edgeAngleDeg: i * 45 + Math.random() * 15,
      frameIndex: i,
      timestampMs: Date.now() + i * 25,
    }));

    setTimeout(() => {
      handleThrowDetected(fakeBlobs);
    }, 220);
  }, [phase, handleThrowDetected]);

  const startReady = () => {
    blobsRef.current = [];
    detectingRef.current = false;
    if (resultTimeoutRef.current) clearTimeout(resultTimeoutRef.current);
    setResult(null);
    setPhase('ready');
  };

  const stopReady = () => {
    detectingRef.current = false;
    setPhase('idle');
  };

  if (!hasPermission) {
    return (
      <View style={styles.center}>
        <Text style={styles.permText}>Camera permission required.</Text>
        <TouchableOpacity style={styles.btn} onPress={requestPermission}>
          <Text style={styles.btnText}>Grant Permission</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (!device) {
    return (
      <View style={styles.center}>
        <Text style={styles.permText}>No camera found.</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Camera
        style={StyleSheet.absoluteFill}
        device={device}
        isActive={phase === 'ready' || phase === 'detecting'}
        format={format}
        fps={format?.maxFps ?? 30}
        photo={false}
        video={false}
        audio={false}
      />

      {/* Overlay */}
      <View style={styles.overlay}>
        {/* Header */}
        <View style={styles.header}>
          <Text style={styles.appName}>
            HYZER<Text style={{ color: colors.cyan }}>TECH</Text>
          </Text>
        </View>

        {/* Center content */}
        <View style={styles.center}>
          {phase === 'idle' && (
            <View style={styles.idleBox}>
              <Text style={styles.instruction}>
                Place your phone camera-up on the ground, 5 feet in front of
                where you throw.
              </Text>
              <TouchableOpacity style={styles.startBtn} onPress={startReady}>
                <Text style={styles.startBtnText}>START</Text>
              </TouchableOpacity>
            </View>
          )}

          {phase === 'ready' && (
            <View style={styles.readyBox}>
              <Animated.View
                style={[
                  styles.pulseRing,
                  { transform: [{ scale: pulseAnim }] },
                ]}
              />
              <Text style={styles.readyText}>READY</Text>
              <Text style={styles.readySubText}>Throw the disc over the camera</Text>
              {/* DEV: tap to simulate — remove before release */}
              <TouchableOpacity style={styles.simBtn} onPress={simulateThrow}>
                <Text style={styles.simBtnText}>Simulate Throw (dev)</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.stopBtn} onPress={stopReady}>
                <Text style={styles.stopBtnText}>STOP</Text>
              </TouchableOpacity>
            </View>
          )}

          {phase === 'detecting' && (
            <View style={styles.detectingBox}>
              <Text style={styles.detectingText}>MEASURING...</Text>
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
  header: {
    paddingTop: 56,
    paddingHorizontal: 24,
    alignItems: 'center',
  },
  appName: {
    fontSize: 22,
    fontWeight: '900',
    letterSpacing: 4,
    color: colors.white,
  },
  permText: { color: colors.white, fontSize: 16, marginBottom: 20, textAlign: 'center', paddingHorizontal: 32 },
  btn: { backgroundColor: colors.cyan, borderRadius: 12, paddingHorizontal: 32, paddingVertical: 14 },
  btnText: { color: colors.bg, fontWeight: '700', fontSize: 16 },

  // Idle
  idleBox: { alignItems: 'center', paddingHorizontal: 32 },
  instruction: {
    color: colors.white,
    fontSize: 18,
    textAlign: 'center',
    lineHeight: 26,
    marginBottom: 40,
  },
  startBtn: {
    backgroundColor: colors.cyan,
    borderRadius: 50,
    paddingHorizontal: 60,
    paddingVertical: 18,
  },
  startBtnText: { color: colors.bg, fontSize: 20, fontWeight: '900', letterSpacing: 3 },

  // Ready
  readyBox: { alignItems: 'center' },
  pulseRing: {
    width: 160,
    height: 160,
    borderRadius: 80,
    borderWidth: 3,
    borderColor: colors.cyan,
    marginBottom: -80,
    opacity: 0.5,
  },
  readyText: {
    color: colors.cyan,
    fontSize: 36,
    fontWeight: '900',
    letterSpacing: 6,
    marginBottom: 8,
  },
  readySubText: { color: colors.gray, fontSize: 14, marginBottom: 40 },
  simBtn: {
    borderWidth: 1,
    borderColor: colors.grayDark,
    borderRadius: 8,
    paddingHorizontal: 20,
    paddingVertical: 10,
    marginBottom: 16,
  },
  simBtnText: { color: colors.gray, fontSize: 13 },
  stopBtn: {
    borderWidth: 1,
    borderColor: colors.red,
    borderRadius: 8,
    paddingHorizontal: 32,
    paddingVertical: 12,
  },
  stopBtnText: { color: colors.red, fontWeight: '700', letterSpacing: 2 },

  // Detecting
  detectingBox: { alignItems: 'center' },
  detectingText: { color: colors.cyanLight, fontSize: 28, fontWeight: '900', letterSpacing: 4 },

  // Result
  resultBox: {
    alignItems: 'center',
    backgroundColor: colors.bgCard,
    borderRadius: 24,
    paddingVertical: 36,
    paddingHorizontal: 60,
    borderWidth: 1,
    borderColor: colors.cyan,
  },
  resultLabel: { color: colors.gray, fontSize: 13, letterSpacing: 4, marginBottom: 4 },
  resultValue: { color: colors.cyanLight, fontSize: 64, fontWeight: '900', lineHeight: 70 },
  resultUnit: { color: colors.cyan, fontSize: 18, letterSpacing: 2, marginBottom: 8 },
  divider: { width: 80, height: 1, backgroundColor: colors.grayDark, marginVertical: 20 },
});
