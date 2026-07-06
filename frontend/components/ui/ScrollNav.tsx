"use client";
import { useEffect, useState, type RefObject } from "react";
import { ChevronUp, ChevronDown } from "lucide-react";

export default function ScrollNav({
  targetRef,
}: {
  targetRef: RefObject<HTMLElement | null>;
}) {
  const [showUp, setShowUp] = useState(false);
  const [showDown, setShowDown] = useState(false);

  useEffect(() => {
    const el = targetRef.current;
    if (!el) return;
    const update = () => {
      const overflow = el.scrollHeight - el.clientHeight > 24;
      setShowUp(overflow && el.scrollTop > 24);
      setShowDown(
        overflow && el.scrollTop < el.scrollHeight - el.clientHeight - 24,
      );
    };
    update();
    el.addEventListener("scroll", update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", update);
      ro.disconnect();
    };
  }, [targetRef]);

  const scroll = (dir: "up" | "down") => {
    const el = targetRef.current;
    if (!el) return;
    el.scrollTo({
      top: dir === "up" ? 0 : el.scrollHeight,
      behavior: "smooth",
    });
  };

  if (!showUp && !showDown) return null;

  return (
    <div className="pointer-events-none absolute bottom-4 right-4 z-20 flex flex-col gap-2">
      {showUp && (
        <button
          type="button"
          onClick={() => scroll("up")}
          aria-label="Scroll to top"
          className="pointer-events-auto flex h-9 w-9 items-center justify-center rounded-full bg-[#2FB5AA] text-white shadow-lg transition-transform hover:scale-105 active:scale-95"
        >
          <ChevronUp className="h-5 w-5" />
        </button>
      )}
      {showDown && (
        <button
          type="button"
          onClick={() => scroll("down")}
          aria-label="Scroll to bottom"
          className="pointer-events-auto flex h-9 w-9 items-center justify-center rounded-full bg-[#2FB5AA] text-white shadow-lg transition-transform hover:scale-105 active:scale-95"
        >
          <ChevronDown className="h-5 w-5" />
        </button>
      )}
    </div>
  );
}
