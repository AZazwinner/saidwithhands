"use client";

import type { HandLandmarker } from "@mediapipe/tasks-vision";
import { realHandFromMediaPipe, type Hand, type Landmark } from "./features";

export type Delegate = "GPU" | "CPU";

export type HandFrame = {
  /** performance.now() timestamp in ms */
  t: number;
  /** raw image-space landmarks (un-mirrored camera frame), 0..1 */
  landmarks: Landmark[];
  /** metric 3D landmarks (meters, hand-centered) */
  world: Landmark[];
  /** video width / height, to make image-space angles isotropic */
  aspect: number;
  /** signer's real hand */
  hand: Hand;
  /** handedness confidence */
  score: number;
};

export type Tracker = {
  delegate: Delegate;
  detect: (video: HTMLVideoElement, t: number) => HandFrame[];
  close: () => void;
};

const WASM_BASE = "/mediapipe/wasm";
const MODEL_PATH = "/models/hand_landmarker.task";

async function create(delegate: Delegate, numHands: number): Promise<HandLandmarker> {
  const { FilesetResolver, HandLandmarker } = await import("@mediapipe/tasks-vision");
  const fileset = await FilesetResolver.forVisionTasks(WASM_BASE);
  return HandLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: MODEL_PATH, delegate },
    runningMode: "VIDEO",
    numHands,
    minHandDetectionConfidence: 0.5,
    minHandPresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
  });
}

/**
 * HandLandmarker in VIDEO mode. Tries the GPU delegate first and falls back to CPU, both at
 * creation time and if the GPU path throws on the first detections (some mobile GPUs do).
 */
export async function createTracker(numHands = 1): Promise<Tracker> {
  let delegate: Delegate = "GPU";
  let lm: HandLandmarker;
  try {
    lm = await create("GPU", numHands);
  } catch (err) {
    console.warn("[tracker] GPU delegate failed, using CPU", err);
    delegate = "CPU";
    lm = await create("CPU", numHands);
  }

  let lastT = -1;
  let switching = false;

  const tracker: Tracker = {
    delegate,
    detect(video, t) {
      if (switching) return [];
      // VIDEO mode requires strictly increasing timestamps.
      const ts = t <= lastT ? lastT + 1 : t;
      lastT = ts;
      try {
        const res = lm.detectForVideo(video, ts);
        const aspect = video.videoHeight ? video.videoWidth / video.videoHeight : 4 / 3;
        return res.landmarks.map((lms, i) => {
          const cat = res.handedness[i]?.[0];
          return {
            t,
            landmarks: lms.map((p) => ({ x: p.x, y: p.y, z: p.z })),
            world: (res.worldLandmarks[i] ?? lms).map((p) => ({ x: p.x, y: p.y, z: p.z })),
            aspect,
            hand: realHandFromMediaPipe(cat?.categoryName ?? "Right", false),
            score: cat?.score ?? 0,
          };
        });
      } catch (err) {
        if (tracker.delegate === "GPU") {
          console.warn("[tracker] GPU detect failed, switching to CPU", err);
          switching = true;
          lm.close();
          create("CPU", numHands)
            .then((cpu) => {
              lm = cpu;
              tracker.delegate = "CPU";
              lastT = -1;
            })
            .finally(() => {
              switching = false;
            });
          return [];
        }
        throw err;
      }
    },
    close() {
      lm.close();
    },
  };
  return tracker;
}
