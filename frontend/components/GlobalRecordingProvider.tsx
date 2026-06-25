"use client";

import React, { createContext, useContext, useState, useEffect } from "react";
import { useAzureSpeech } from "@/hooks/useAzureSpeech"; // Apna original hook import karo

// Interface ko extend kiya mic aur language states ke liye
interface GlobalRecordingContextType extends ReturnType<typeof useAzureSpeech> {
  activeMicName: string;
  detectedLanguage: string;
  setDetectedLanguage: (lang: string) => void;
}

const GlobalRecordingContext = createContext<
  GlobalRecordingContextType | undefined
>(undefined);

export function GlobalRecordingProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  // Original Azure speech hook ko global level par call kar rahe hain
  const speechState = useAzureSpeech();

  const [activeMicName, setActiveMicName] =
    useState<string>("Detecting Mic...");
  const [detectedLanguage, setDetectedLanguage] = useState<string>(
    "Detecting Language...",
  );

  // Mic Detect karne ka Logic
  useEffect(() => {
    const detectMicrophone = async () => {
      try {
        // Permissions maangna zaroori hai devices ka naam read karne ke liye
        await navigator.mediaDevices.getUserMedia({ audio: true });
        const devices = await navigator.mediaDevices.enumerateDevices();
        const audioInputs = devices.filter(
          (device) => device.kind === "audioinput",
        );

        if (audioInputs.length > 0) {
          // Default mic ka label set kar rahe hain (e.g. "Realtek High Definition" ya "AirPods")
          setActiveMicName(audioInputs[0].label || "Default System Mic");
        } else {
          setActiveMicName("No Microphone Found");
        }
      } catch (err) {
        console.error("Mic detection failed:", err);
        setActiveMicName("Microphone Access Denied");
      }
    };

    detectMicrophone();

    // Device change listener (Agar user beech mein eardopes lagata hai toh automatically update ho jayega)
    navigator.mediaDevices.addEventListener("devicechange", detectMicrophone);
    return () => {
      navigator.mediaDevices.removeEventListener(
        "devicechange",
        detectMicrophone,
      );
    };
  }, []);

  return (
    <GlobalRecordingContext.Provider
      value={{
        ...speechState,
        activeMicName,
        detectedLanguage,
        setDetectedLanguage,
      }}
    >
      {children}
    </GlobalRecordingContext.Provider>
  );
}

// Custom hook UI components mein use karne ke liye
export const useGlobalRecording = () => {
  const context = useContext(GlobalRecordingContext);
  if (context === undefined) {
    throw new Error(
      "useGlobalRecording must be used within a GlobalRecordingProvider",
    );
  }
  return context;
};
