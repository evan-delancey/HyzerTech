/**
 * Disc detection and measurement via frame analysis.
 *
 * Strategy:
 *  - Speed: track disc centroid across frames using frame differencing.
 *    Known camera height (5 ft / 152 cm) + lens FOV lets us convert px/frame → mph.
 *  - Spin: track the leading edge rotation angle between frames → rpm.
 *
 * Camera is assumed to be placed flat on the ground pointing up,
 * 5 feet in front of the thrower. Disc passes over at ~1-3 ft altitude.
 */

export interface ThrowResult {
  speedMph: number;
  spinRpm: number;
}

// Physical constants
const CAMERA_HEIGHT_CM = 152; // 5 feet
const DISC_DIAMETER_CM = 21.2; // standard 175g ultimate/disc golf disc
const FRAME_RATE = 120; // target fps — vision camera high fps mode

/**
 * Horizontal field of view in degrees for common phone cameras.
 * Used to convert pixel displacement to real-world cm.
 */
const H_FOV_DEG = 69;

function degToRad(d: number) {
  return (d * Math.PI) / 180;
}

/**
 * Given image width in pixels, calculate real-world cm per pixel
 * at the disc's approximate altitude above the camera.
 *
 * altitude: how high the disc is above the camera lens in cm.
 */
function cmPerPixel(imageWidthPx: number, altitudeCm: number): number {
  const realWidthCm = 2 * altitudeCm * Math.tan(degToRad(H_FOV_DEG / 2));
  return realWidthCm / imageWidthPx;
}

export interface DiscBlob {
  cx: number; // centroid x in pixels
  cy: number; // centroid y in pixels
  radiusPx: number; // apparent radius in pixels
  edgeAngleDeg: number; // dominant edge angle (for spin tracking)
  frameIndex: number;
  timestampMs: number;
}

/**
 * Estimate disc altitude from its apparent radius.
 * disc real radius = DISC_DIAMETER_CM / 2
 * apparent radius in px = (real radius / real scene width) * image width
 * Rearranging: altitude = (real radius * imageWidthPx) / (radiusPx * tan(hfov/2) * 2)
 */
export function estimateAltitude(
  radiusPx: number,
  imageWidthPx: number
): number {
  const realRadiusCm = DISC_DIAMETER_CM / 2;
  const altitude =
    (realRadiusCm * imageWidthPx) /
    (radiusPx * 2 * Math.tan(degToRad(H_FOV_DEG / 2)));
  return altitude;
}

/**
 * Calculate speed and spin from a sequence of detected disc blobs.
 * Requires at least 3 blobs spanning the full frame crossing.
 */
export function calculateThrowResult(blobs: DiscBlob[]): ThrowResult | null {
  if (blobs.length < 3) return null;

  const imageWidthPx = 1920; // typical high-res frame width

  // --- SPEED ---
  // Use first and last blob to get total horizontal displacement
  const first = blobs[0];
  const last = blobs[blobs.length - 1];
  const dxPx = Math.abs(last.cx - first.cx);
  const dtMs = last.timestampMs - first.timestampMs;
  if (dtMs <= 0) return null;

  // Average altitude from blob radii
  const avgAltitudeCm =
    blobs.reduce((sum, b) => sum + estimateAltitude(b.radiusPx, imageWidthPx), 0) /
    blobs.length;

  const scale = cmPerPixel(imageWidthPx, avgAltitudeCm);
  const distanceCm = dxPx * scale;
  const speedCmPerSec = distanceCm / (dtMs / 1000);
  const speedMph = speedCmPerSec * 0.0223694;

  // --- SPIN ---
  // Track angle change between consecutive frames, sum total rotation
  let totalAngleDeg = 0;
  for (let i = 1; i < blobs.length; i++) {
    let delta = blobs[i].edgeAngleDeg - blobs[i - 1].edgeAngleDeg;
    // Normalize to [-180, 180] to handle wrap-around
    if (delta > 180) delta -= 360;
    if (delta < -180) delta += 360;
    totalAngleDeg += delta;
  }

  const totalTimeSec = dtMs / 1000;
  const rotationsPerSec = Math.abs(totalAngleDeg) / 360 / totalTimeSec;
  const spinRpm = rotationsPerSec * 60;

  return {
    speedMph: Math.round(speedMph * 10) / 10,
    spinRpm: Math.round(spinRpm),
  };
}

/**
 * Simple frame-differencing blob detector.
 * Takes two consecutive raw RGBA frames and returns a DiscBlob if a
 * sufficiently large moving object is found.
 *
 * In production this runs inside a VisionCamera frame processor (JS worklet).
 */
export function detectDiscInDiff(
  diffPixels: Uint8Array,
  width: number,
  height: number,
  frameIndex: number,
  timestampMs: number,
  threshold = 40
): DiscBlob | null {
  let sumX = 0;
  let sumY = 0;
  let count = 0;
  let minX = width;
  let maxX = 0;
  let minY = height;
  let maxY = 0;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const brightness =
        (diffPixels[i] + diffPixels[i + 1] + diffPixels[i + 2]) / 3;
      if (brightness > threshold) {
        sumX += x;
        sumY += y;
        count++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  // Require a minimum blob size to avoid noise
  const minBlobPx = (width * height) / 800;
  if (count < minBlobPx) return null;

  const cx = sumX / count;
  const cy = sumY / count;
  const radiusPx = Math.max(maxX - minX, maxY - minY) / 2;

  // Estimate dominant edge angle from blob bounding box aspect
  const blobWidth = maxX - minX;
  const blobHeight = maxY - minY;
  const edgeAngleDeg = Math.atan2(blobHeight, blobWidth) * (180 / Math.PI);

  return { cx, cy, radiusPx, edgeAngleDeg, frameIndex, timestampMs };
}
