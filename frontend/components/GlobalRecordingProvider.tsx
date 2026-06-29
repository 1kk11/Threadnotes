"use client";

import React, { createContext, useContext, useState, useEffect } from "react";
import { useAzureSpeech } from "@/hooks/useAzureSpeech";

interface GlobalRecordingContextType extends ReturnType<typeof useAzureSpeech> {
  activeMicName: string;
}

const GlobalRecordingContext = createContext<
  GlobalRecordingContextType | undefined
>(undefined);

export function GlobalRecordingProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const speechState = useAzureSpeech();

  const [activeMicName, setActiveMicName] =
    useState<string>("Detecting Mic...");

  useEffect(() => {
    const detectMicrophone = async () => {
      try {
        await navigator.mediaDevices.getUserMedia({ audio: true });
        const devices = await navigator.mediaDevices.enumerateDevices();
        const audioInputs = devices.filter(
          (device) => device.kind === "audioinput",
        );

        if (audioInputs.length > 0) {
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
      }}
    >
      {children}
    </GlobalRecordingContext.Provider>
  );
}

export const useGlobalRecording = () => {
  const context = useContext(GlobalRecordingContext);
  if (context === undefined) {
    throw new Error(
      "useGlobalRecording must be used within a GlobalRecordingProvider",
    );
  }
  return context;
};
