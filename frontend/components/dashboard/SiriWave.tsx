"use client";
import { useRef, useEffect } from "react";

interface SiriWaveProps {
  isRecording: boolean;
  isPaused: boolean;
  audioLevel?: number;
}

const LINES = 50;
const POINTS = 220;
const INNER_R = 0.66;
const OUTER_R = 1.0;

const clamp01 = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n);

export default function SiriWave({
  isRecording,
  isPaused,
  audioLevel,
}: SiriWaveProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef<number | null>(null);
  const phaseRef = useRef(0);
  const levelRef = useRef(0);

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
      ctx.clearRect(0, 0, W, H);

      const active = isRecording && !isPaused;
      const target = active
        ? audioLevelRef.current != null
          ? clamp01(audioLevelRef.current)
          : 1
        : 0;
      levelRef.current += (target - levelRef.current) * 0.08;
      const level = levelRef.current;

      const speed = 0.005 + level * 0.02;
      phaseRef.current += speed;
      const phase = phaseRef.current;

      const cx = W / 2;
      const cy = H / 2;
      const maxR = (Math.min(W, H) / 2) * 0.86;

      const ampScale = 0.6 + level * 0.95;
      const intensity = 0.78 + 0.22 * level;

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
        const linePhase = phase * 0.8 + i * 0.2;
        const rot = i * 0.045 + phase * 0.25;

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
