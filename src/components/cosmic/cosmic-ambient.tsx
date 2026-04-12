"use client";

import { useMemo } from "react";

import { cn } from "@/lib/utils";

/** Deterministic float in [0, 1) from star index + salt — matches SSR and client. */
function starHash01(index: number, salt: number): number {
  let h = Math.imul(index * 31 + salt, 2654435761) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 2246822519) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 3266489917) >>> 0;
  return h / 0xffffffff;
}

/**
 * Fixed cosmic backdrop: gradient nebula + twinkling stars + slow parallax drift.
 * Pointer-events none; content should sit in a higher z-index wrapper.
 */
export function CosmicAmbient({ className }: { className?: string }) {
  const stars = useMemo(
    () =>
      Array.from({ length: 140 }, (_, i) => ({
        id: i,
        x: starHash01(i, 0x11) * 100,
        y: starHash01(i, 0x22) * 100,
        s: starHash01(i, 0x33) * 2.2 + 0.4,
        d: starHash01(i, 0x44) * 3 + 2,
        delay: starHash01(i, 0x55) * 5,
      })),
    [],
  );

  return (
    <div
      className={cn(
        "cosmic-ambient pointer-events-none fixed inset-0 z-0 overflow-hidden",
        className,
      )}
      aria-hidden
    >
      <div className="cosmic-ambient__gradient absolute inset-0" />
      <div className="cosmic-ambient__grid absolute inset-0 opacity-[0.07]" />
      <div className="cosmic-ambient__drift absolute inset-[-20%] opacity-40">
        <div className="cosmic-ambient__blob cosmic-ambient__blob--a absolute rounded-full blur-3xl" />
        <div className="cosmic-ambient__blob cosmic-ambient__blob--b absolute rounded-full blur-3xl" />
      </div>
      {stars.map((st) => (
        <span
          key={st.id}
          className="cosmic-star absolute rounded-full bg-white"
          style={{
            left: `${st.x}%`,
            top: `${st.y}%`,
            width: `${st.s}px`,
            height: `${st.s}px`,
            animationDuration: `${st.d}s`,
            animationDelay: `${st.delay}s`,
          }}
        />
      ))}
    </div>
  );
}
