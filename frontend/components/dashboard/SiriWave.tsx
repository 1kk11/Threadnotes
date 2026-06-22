"use client";
import { useRef, useEffect } from "react";

// High-density "AI vortex": ~50 ultra-thin polar loops sharing one saturated
// gradient, glowing via a unified shadow. It ALWAYS animates — gently breathing
// when idle, livelier (faster + bigger waves) while recording, and reactive to
// real mic loudness if an `audioLevel` (0..1) is supplied.
interface SiriWaveProps {
  isRecording: boolean;
  isPaused: boolean;
  /** Optional live mic loudness 0..1. If omitted, "active" drives full motion. */
  audioLevel?: number;
}

const LINES = 50;
const POINTS = 220;
const INNER_R = 0.66; // keeps the centre hollow for the timer
const OUTER_R = 1.0;

const clamp01 = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n);

export default function SiriWave({
  isRecording,
  isPaused,
  audioLevel,
}: SiriWaveProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef<number | null>(null);
  const phaseRef = useRef(0); // ever-incrementing time
  const levelRef = useRef(0); // smoothed activity/loudness 0..1

  // Latest audioLevel without restarting the animation loop.
  const audioLevelRef = useRef<number | null>(null);
  audioLevelRef.current = typeof audioLevel === "number" ? audioLevel : null;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let dpr = window.devicePixelRatio || 1;
    let W = 0;
    let H = 0;

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      dpr = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.round(rect.width * dpr));
      canvas.height = Math.max(1, Math.round(rect.height * dpr));
      W = canvas.width;
      H = canvas.height;
    };
    resize();
    window.addEventListener("resize", resize);

    const render = () => {
      ctx.clearRect(0, 0, W, H); // transparent — clear every frame

      const active = isRecording && !isPaused;
      // Target activity: real loudness if provided, else full when active, 0 idle.
      const target = active
        ? audioLevelRef.current != null
          ? clamp01(audioLevelRef.current)
          : 1
        : 0;
      // Ease toward target so speed/amplitude changes are smooth, not jumpy.
      levelRef.current += (target - levelRef.current) * 0.08;
      const level = levelRef.current;

      // Never fully freezes: idle drifts at ~0.005, ramps up to ~0.025 when loud.
      const speed = 0.005 + level * 0.02;
      phaseRef.current += speed;
      const phase = phaseRef.current;

      const cx = W / 2;
      const cy = H / 2;
      const maxR = (Math.min(W, H) / 2) * 0.86;

      const ampScale = 0.6 + level * 0.95; // low base "breathe" -> big when speaking
      const intensity = 0.78 + 0.22 * level;

      // One global gradient shared by every line (deep violet -> vibrant cyan).
      const grad = ctx.createLinearGradient(0, 0, W, H);
      grad.addColorStop(0, "#6d28d9");
      grad.addColorStop(0.55, "#7c3aed");
      grad.addColorStop(1, "#06b6d4");

      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.strokeStyle = grad;
      ctx.lineWidth = 1.3 * dpr;
      ctx.globalAlpha = intensity * 0.25;
      ctx.shadowBlur = 22 * dpr;
      ctx.shadowColor = "rgba(139, 92, 246, 0.6)";

      for (let i = 0; i < LINES; i++) {
        const f = i / (LINES - 1);
        const baseR = INNER_R + (OUTER_R - INNER_R) * f;
        const amp = (0.05 + 0.07 * f) * ampScale;
        const freq = 5 + (i % 3);
        const linePhase = phase * 0.8 + i * 0.2; // continuous ripple/sweep
        const rot = i * 0.045 + phase * 0.25; // continuous vortex twist

        ctx.beginPath();
        for (let j = 0; j <= POINTS; j++) {
          const t = (j / POINTS) * Math.PI * 2;
          const rr = maxR * (baseR + amp * Math.sin(freq * t + linePhase));
          const ang = t + rot;
          const x = cx + rr * Math.cos(ang);
          const y = cy + rr * Math.sin(ang);
          if (j === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.closePath();
        ctx.stroke();
      }

      ctx.globalAlpha = 1;
      ctx.shadowBlur = 0;
      rafRef.current = requestAnimationFrame(render);
    };
    render();

    return () => {
      window.removeEventListener("resize", resize);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [isRecording, isPaused]);

  return <canvas ref={canvasRef} className="h-full w-full" />;
}
