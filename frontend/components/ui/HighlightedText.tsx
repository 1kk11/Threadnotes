"use client";
import { Fragment, type ReactNode } from "react";

export function highlightRanges(
  text: string,
  phrases: string[],
): Array<[number, number]> {
  const rs: Array<[number, number]> = [];
  for (const p of phrases) {
    const phrase = p.trim();
    if (!phrase) continue;
    let idx = text.indexOf(phrase);
    while (idx !== -1) {
      rs.push([idx, idx + phrase.length]);
      idx = text.indexOf(phrase, idx + phrase.length);
    }
  }
  rs.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const [s, e] of rs) {
    const last = merged[merged.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else merged.push([s, e]);
  }
  return merged;
}

export default function HighlightedText({
  text,
  phrases,
  enabled,
}: {
  text: string;
  phrases: string[];
  enabled: boolean;
}) {
  if (!enabled || phrases.length === 0) return <>{text}</>;
  const rs = highlightRanges(text, phrases);
  if (rs.length === 0) return <>{text}</>;

  const out: ReactNode[] = [];
  let cursor = 0;
  rs.forEach(([s, e], i) => {
    if (s > cursor) {
      out.push(<Fragment key={`t${i}`}>{text.slice(cursor, s)}</Fragment>);
    }
    out.push(
      <mark
        key={`m${i}`}
        className="rounded bg-amber-200/70 px-0.5 text-slate-800"
      >
        {text.slice(s, e)}
      </mark>,
    );
    cursor = e;
  });
  if (cursor < text.length) {
    out.push(<Fragment key="tend">{text.slice(cursor)}</Fragment>);
  }
  return <>{out}</>;
}
