"use client";

import React, {
  createContext,
  useContext,
  useState,
  useRef,
  useEffect,
} from "react";

// Context ki types define kar rahe hain
interface AudioContextType {
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  currentAudioUrl: string | null;
  playAudio: (url: string) => void;
  pauseAudio: () => void;
  togglePlayPause: () => void;
  seekAudio: (time: number) => void;
  stopAudio: () => void;
}

const GlobalAudioContext = createContext<AudioContextType | undefined>(
  undefined,
);

export function GlobalAudioProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  // Yeh ref humesha audio zinda rakhega, chahe page change ho jaye
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [currentAudioUrl, setCurrentAudioUrl] = useState<string | null>(null);

  useEffect(() => {
    // Sirf client side par audio object banayenge (Next.js SSR error se bachne ke liye)
    audioRef.current = new Audio();

    const handleTimeUpdate = () =>
      setCurrentTime(audioRef.current?.currentTime || 0);
    const handleLoadedMetadata = () =>
      setDuration(audioRef.current?.duration || 0);
    const handleEnded = () => setIsPlaying(false);
    const handlePlay = () => setIsPlaying(true);
    const handlePause = () => setIsPlaying(false);

    const audio = audioRef.current;
    audio.addEventListener("timeupdate", handleTimeUpdate);
    audio.addEventListener("loadedmetadata", handleLoadedMetadata);
    audio.addEventListener("ended", handleEnded);
    audio.addEventListener("play", handlePlay);
    audio.addEventListener("pause", handlePause);

    // Cleanup function
    return () => {
      audio.removeEventListener("timeupdate", handleTimeUpdate);
      audio.removeEventListener("loadedmetadata", handleLoadedMetadata);
      audio.removeEventListener("ended", handleEnded);
      audio.removeEventListener("play", handlePlay);
      audio.removeEventListener("pause", handlePause);
      audio.pause();
      audio.src = "";
    };
  }, []);

  const playAudio = (url: string) => {
    if (!audioRef.current) return;

    // Agar naya audio hai, toh URL update karo
    if (currentAudioUrl !== url) {
      audioRef.current.src = url;
      setCurrentAudioUrl(url);
      audioRef.current.load();
    }
    audioRef.current.play().catch((e) => console.error("Playback failed:", e));
  };

  const pauseAudio = () => {
    if (!audioRef.current) return;
    audioRef.current.pause();
  };

  const togglePlayPause = () => {
    if (isPlaying) {
      pauseAudio();
    } else if (currentAudioUrl) {
      playAudio(currentAudioUrl);
    }
  };

  const seekAudio = (time: number) => {
    if (!audioRef.current) return;
    audioRef.current.currentTime = time;
    setCurrentTime(time);
  };

  const stopAudio = () => {
    if (!audioRef.current) return;
    audioRef.current.pause();
    audioRef.current.currentTime = 0;
    setCurrentAudioUrl(null);
    setIsPlaying(false);
  };

  return (
    <GlobalAudioContext.Provider
      value={{
        isPlaying,
        currentTime,
        duration,
        currentAudioUrl,
        playAudio,
        pauseAudio,
        togglePlayPause,
        seekAudio,
        stopAudio,
      }}
    >
      {children}
    </GlobalAudioContext.Provider>
  );
}

// Custom hook isko baaki components mein easily use karne ke liye
export const useGlobalAudio = () => {
  const context = useContext(GlobalAudioContext);
  if (context === undefined) {
    throw new Error("useGlobalAudio must be used within a GlobalAudioProvider");
  }
  return context;
};
