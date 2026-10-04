"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Camera, CameraOff, CircleAlert, LoaderCircle } from "lucide-react";
import { HAND_CONNECTIONS } from "@/lib/features";
import { createTracker, type HandFrame, type Tracker } from "@/lib/handTracker";

export type CameraStatus =
  "idle" | "requesting" | "loading-model" | "running" | "denied" | "unsupported" | "error";

type Props = {
  /** called once per processed video frame with the detected hand, or null if none */
  onFrame?: (frame: HandFrame | null) => void;
  /** optional overlay (e.g. hold-to-confirm ring) rendered above the video */
  children?: React.ReactNode;
  className?: string;
  /**
   * Start the camera without waiting for the button, as soon as this is true (e.g. once the tool is on screen).
   * If permission was denied before, the denied state is shown as usual.
   */
  autoStart?: boolean;
};

/** The accent token, read from CSS so the skeleton follows light/dark mode. */
function readAccent(): string {
  if (typeof window === "undefined") return "#0f766e";
  return getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#0f766e";
}

function drawSkeleton(ctx: CanvasRenderingContext2D, frame: HandFrame | null, color: string) {
  const { width: w, height: h } = ctx.canvas;
  ctx.clearRect(0, 0, w, h);
  if (!frame) return;
  const pts = frame.landmarks;
  const lw = Math.max(2, w / 200);
  ctx.globalAlpha = 0.7;
  ctx.lineWidth = lw;
  ctx.lineCap = "round";
  ctx.strokeStyle = color;
  ctx.beginPath();
  for (const [a, b] of HAND_CONNECTIONS) {
    ctx.moveTo(pts[a].x * w, pts[a].y * h);
    ctx.lineTo(pts[b].x * w, pts[b].y * h);
  }
  ctx.stroke();
  ctx.fillStyle = color;
  for (const p of pts) {
    ctx.beginPath();
    ctx.arc(p.x * w, p.y * h, lw * 1.4, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

const ICON = { size: 20, strokeWidth: 1.5, "aria-hidden": true } as const;

export default function CameraView({ onFrame, children, className = "", autoStart = false }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const trackerRef = useRef<Tracker | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number>(0);
  const onFrameRef = useRef(onFrame);
  const accentRef = useRef("#0f766e");
  const [status, setStatus] = useState<CameraStatus>("idle");
  const [errorMsg, setErrorMsg] = useState("");
  const [handVisible, setHandVisible] = useState(false);
  const [info, setInfo] = useState({ delegate: "", fps: 0 });

  useEffect(() => {
    onFrameRef.current = onFrame;
  }, [onFrame]);

  useEffect(() => {
    accentRef.current = readAccent();
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () => (accentRef.current = readAccent());
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  const stop = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    trackerRef.current?.close();
    trackerRef.current = null;
  }, []);

  useEffect(() => stop, [stop]);

  const start = useCallback(async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      setStatus("unsupported");
      return;
    }
    cancelAnimationFrame(rafRef.current);
    streamRef.current?.getTracks().forEach((t) => t.stop());
    setStatus("requesting");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } },
        audio: false,
      });
      streamRef.current = stream;
      const video = videoRef.current!;
      video.srcObject = stream;
      await video.play();
    } catch (err) {
      const name = (err as DOMException)?.name;
      setStatus(name === "NotAllowedError" || name === "SecurityError" ? "denied" : "error");
      setErrorMsg(String((err as Error)?.message ?? err));
      return;
    }

    setStatus("loading-model");
    try {
      trackerRef.current = trackerRef.current ?? (await createTracker(1));
    } catch (err) {
      setStatus("error");
      setErrorMsg(`Hand tracking failed to load: ${String((err as Error)?.message ?? err)}`);
      return;
    }
    setStatus("running");

    const video = videoRef.current!;
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext("2d")!;
    let lastVideoTime = -1;
    let frames = 0;
    let fpsT0 = performance.now();
    let lastVisible = false;

    const loop = () => {
      rafRef.current = requestAnimationFrame(loop);
      const tracker = trackerRef.current;
      if (!tracker || video.readyState < 2 || video.currentTime === lastVideoTime) return;
      lastVideoTime = video.currentTime;
      if (canvas.width !== video.videoWidth) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
      }
      const now = performance.now();
      const hands = tracker.detect(video, now);
      const frame = hands[0] ?? null;
      drawSkeleton(ctx, frame, accentRef.current);
      onFrameRef.current?.(frame);

      const visible = frame !== null;
      if (visible !== lastVisible) {
        lastVisible = visible;
        setHandVisible(visible);
      }
      frames++;
      if (now - fpsT0 > 1000) {
        setInfo({ delegate: tracker.delegate, fps: Math.round((frames * 1000) / (now - fpsT0)) });
        frames = 0;
        fpsT0 = now;
      }
    };
    loop();
  }, []);

  const autoStarted = useRef(false);
  useEffect(() => {
    if (!autoStart || autoStarted.current) return;
    autoStarted.current = true;
    void start();
  }, [autoStart, start]);

  return (
    <div
      className={`relative w-full overflow-hidden rounded-card border border-border bg-surface-2 ${className}`}
    >
      {/* Video and overlay are mirrored together for a natural selfie view. Recognition uses raw frames. */}
      <video
        ref={videoRef}
        playsInline
        muted
        className="block aspect-[4/3] w-full -scale-x-100 object-cover"
        aria-label="Your camera (stays on this device)"
      />
      <canvas
        ref={canvasRef}
        className="pointer-events-none absolute inset-0 h-full w-full -scale-x-100 object-cover"
      />

      {status === "running" && (
        <div className="absolute bottom-3 left-3" title={`${info.delegate || "…"}, ${info.fps} fps`}>
          <span className={`chip ${handVisible ? "text-text" : "text-muted"}`} role="status">
            <span
              aria-hidden
              className={`h-2 w-2 rounded-full ${handVisible ? "bg-accent" : "bg-border"}`}
            />
            {handVisible ? "Hand in view" : "No hand in view"}
          </span>
        </div>
      )}

      {status === "running" && children}

      {status !== "running" && (
        <div
          className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center"
          role="status"
        >
          {status === "idle" && (
            <>
              <Camera {...ICON} className="text-muted" />
              <p className="text-base">Camera is off.</p>
              <button onClick={start} className="btn btn-secondary">
                Start camera
              </button>
            </>
          )}
          {status === "requesting" && (
            <>
              <Camera {...ICON} className="text-muted" />
              <p className="text-base">Waiting for camera permission…</p>
            </>
          )}
          {status === "loading-model" && (
            <>
              <LoaderCircle {...ICON} className="animate-spin text-muted" />
              <p className="text-base">Loading hand tracking…</p>
            </>
          )}
          {status === "denied" && (
            <>
              <CameraOff {...ICON} className="text-muted" />
              <p className="max-w-xs text-base">
                Camera access is blocked. Allow it in your browser&apos;s site settings.
              </p>
              <button onClick={start} className="btn btn-secondary">
                Try again
              </button>
            </>
          )}
          {status === "unsupported" && (
            <>
              <CameraOff {...ICON} className="text-muted" />
              <p className="max-w-xs text-base">
                This browser can&apos;t use the camera here. Use a recent Chrome, Edge or Safari.
              </p>
            </>
          )}
          {status === "error" && (
            <>
              <CircleAlert {...ICON} className="text-danger" />
              <p className="max-w-xs text-base" title={errorMsg}>
                The camera couldn&apos;t start. Try again.
              </p>
              <button onClick={start} className="btn btn-secondary">
                Try again
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
