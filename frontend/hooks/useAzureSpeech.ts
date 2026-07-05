import { useCallback, useRef, useState } from "react";
import * as SpeechSDK from "microsoft-cognitiveservices-speech-sdk";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

const TOKEN_REFRESH_MS = 8 * 60 * 1000;

type UseAzureSpeechProps = {
  getAuthToken?: () => string | null;
  onPartial?: (text: string) => void;
  onFinal?: (text: string) => void;
  onError?: (message: string) => void;
  onProgress?: (done: number, total: number) => void;
};

export function useAzureSpeech(initialProps?: UseAzureSpeechProps) {
  const callbacksRef = useRef({
    onPartial: initialProps?.onPartial,
    onFinal: initialProps?.onFinal,
    onError: initialProps?.onError,
    onProgress: initialProps?.onProgress,
  });

  const setCallbacks = useCallback(
    (cbs: {
      onPartial?: (text: string) => void;
      onFinal?: (text: string) => void;
      onError?: (message: string) => void;
      onProgress?: (done: number, total: number) => void;
    }) => {
      callbacksRef.current = { ...callbacksRef.current, ...cbs };
    },
    [],
  );

  const [micLabel, setMicLabel] = useState<string>("Default Microphone");
  const [detectedLanguage, setDetectedLanguage] = useState<string>("English");
  const [audioQuality, setAudioQuality] = useState<string>("Medium");

  const recognizerRef = useRef<SpeechSDK.SpeechRecognizer | null>(null);
  const renewTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioFilePathRef = useRef<string | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);
  const qualityIntervalRef = useRef<ReturnType<typeof setInterval> | null>(
    null,
  );

  const streamRef = useRef<MediaStream | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const systemStreamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);

  const isPausedRef = useRef<boolean>(false);
  const recognizerDeadRef = useRef<boolean>(false);
  const reconnectingRef = useRef<boolean>(false);
  const finishingRef = useRef<boolean>(false);
  const reconnectRef = useRef<null | (() => Promise<boolean>)>(null);
  const diarizeAbortRef = useRef<AbortController | null>(null);
  const seenLangsRef = useRef<Set<string>>(new Set());
  const destinationRef = useRef<MediaStreamAudioDestinationNode | null>(null);
  const micSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const deviceSwitchRef = useRef<null | (() => void)>(null);
  const deviceSwitchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );

  const readJwt = useCallback((): string | null => {
    if (initialProps?.getAuthToken) return initialProps.getAuthToken();
    if (typeof window === "undefined") return null;
    return localStorage.getItem("token");
  }, [initialProps]);

  const fetchAzureToken = useCallback(async (): Promise<{
    token: string;
    region: string;
  }> => {
    const jwt = readJwt();
    if (!jwt)
      throw new Error("Not authenticated — no app token in localStorage.");
    const res = await fetch(`${API_URL}/azure/token`, {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    if (!res.ok) {
      throw new Error(
        res.status === 401
          ? "Azure token request unauthorized (401) — your login session likely expired."
          : `Token fetch failed: ${res.status}`,
      );
    }
    return res.json();
  }, [readJwt]);

  const startRenewalLoop = useCallback(() => {
    if (renewTimerRef.current) clearInterval(renewTimerRef.current);
    renewTimerRef.current = setInterval(async () => {
      try {
        const { token } = await fetchAzureToken();
        if (recognizerRef.current && !recognizerDeadRef.current) {
          recognizerRef.current.authorizationToken = token;
        }
      } catch {
        callbacksRef.current.onError?.("Token renewal failed (will retry)");
      }
    }, TOKEN_REFRESH_MS);
  }, [fetchAzureToken]);

  const initRecognizer = useCallback(
    (token: string, region: string): SpeechSDK.SpeechRecognizer => {
      const speechConfig = SpeechSDK.SpeechConfig.fromAuthorizationToken(
        token,
        region,
      );

      speechConfig.setProperty(
        SpeechSDK.PropertyId.SpeechServiceConnection_LanguageIdMode,
        "Continuous",
      );

      // English only: US English + Indian English. No Hindi/other languages —
      // everything is transcribed as English.
      const autoDetectSourceLanguageConfig =
        SpeechSDK.AutoDetectSourceLanguageConfig.fromLanguages([
          "en-US",
          "en-IN",
        ]);

      const audioConfig = SpeechSDK.AudioConfig.fromStreamInput(
        streamRef.current as MediaStream,
      );

      const recognizer = SpeechSDK.SpeechRecognizer.FromConfig(
        speechConfig,
        autoDetectSourceLanguageConfig,
        audioConfig,
      );

      const updateDetectedLanguage = (result: any) => {
        let lang = "";
        try {
          lang =
            SpeechSDK.AutoDetectSourceLanguageResult.fromResult(result)
              ?.language || "";
        } catch {}
        if (!lang) {
          lang =
            result.properties?.getProperty(
              (SpeechSDK.PropertyId as any)
                .SpeechServiceConnection_AutoDetectSourceLanguageResult,
            ) || "";
        }
        if (!lang) return;
        // English-only now: show the variant (US / Indian), default English.
        const l = lang.toLowerCase();
        setDetectedLanguage(
          l.startsWith("en-in")
            ? "Indian English"
            : l.startsWith("en-us")
              ? "US English"
              : "English",
        );
      };

      recognizer.recognizing = (_s: any, e: any) => {
        if (e.result.text) {
          updateDetectedLanguage(e.result);
          callbacksRef.current.onPartial?.(e.result.text);
        }
      };

      recognizer.recognized = (_s: any, e: any) => {
        if (
          e.result.reason === SpeechSDK.ResultReason.RecognizedSpeech &&
          e.result.text
        ) {
          updateDetectedLanguage(e.result);
          callbacksRef.current.onFinal?.(e.result.text);
        }
      };

      recognizer.canceled = (_s: any, e: any) => {
        recognizerDeadRef.current = true;
        if (e.reason === SpeechSDK.CancellationReason.Error) {
          callbacksRef.current.onError?.(
            e.errorDetails || "Recognition canceled",
          );
        }
        if (!isPausedRef.current && !finishingRef.current) {
          void reconnectRef.current?.();
        }
      };

      recognizer.sessionStopped = () => {
        recognizerDeadRef.current = true;
      };

      recognizerRef.current = recognizer;
      recognizerDeadRef.current = false;
      return recognizer;
    },
    [],
  );

  const reconnect = useCallback(async (): Promise<boolean> => {
    if (reconnectingRef.current) return false;
    if (!streamRef.current || finishingRef.current) return false;
    reconnectingRef.current = true;
    try {
      const old = recognizerRef.current;
      recognizerRef.current = null;
      if (old) {
        try {
          old.stopContinuousRecognitionAsync(
            () => old.close(),
            () => old.close(),
          );
        } catch {
          try {
            old.close();
          } catch {}
        }
      }

      const { token, region } = await fetchAzureToken();
      const recognizer = initRecognizer(token, region);
      await new Promise<void>((resolve, reject) => {
        recognizer.startContinuousRecognitionAsync(
          () => resolve(),
          (err) => reject(err),
        );
      });

      startRenewalLoop();
      return true;
    } catch (e: any) {
      callbacksRef.current.onError?.(
        `Live reconnect failed: ${e?.message || e}`,
      );
      return false;
    } finally {
      reconnectingRef.current = false;
    }
  }, [fetchAzureToken, initRecognizer, startRenewalLoop]);

  reconnectRef.current = reconnect;

  const start = useCallback(async (): Promise<boolean> => {
    try {
      finishingRef.current = false;
      seenLangsRef.current = new Set();
      setDetectedLanguage("Detecting");

      const micStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
      });
      micStreamRef.current = micStream;

      const micTracks = micStream.getAudioTracks();
      console.log(
        "[Recorder] getUserMedia mic tracks:",
        micTracks.length,
        micTracks.map((t) => ({
          label: t.label,
          enabled: t.enabled,
          muted: t.muted,
          readyState: t.readyState,
        })),
      );

      if (micTracks.length > 0) {
        setMicLabel(micTracks[0].label || "Default Microphone");
      }

      let systemStream: MediaStream | null = null;
      try {
        if (
          typeof window !== "undefined" &&
          (window as any).electronAPI &&
          (window as any).electronAPI.getDesktopSourceId
        ) {
          const sourceId = await (
            window as any
          ).electronAPI.getDesktopSourceId();
          systemStream = await navigator.mediaDevices.getUserMedia({
            audio: { mandatory: { chromeMediaSource: "desktop" } } as any,
            video: {
              mandatory: {
                chromeMediaSource: "desktop",
                chromeMediaSourceId: sourceId,
              },
            } as any,
          });
        } else {
          systemStream = await navigator.mediaDevices.getDisplayMedia({
            video: true,
            audio: true,
          });
        }
        systemStreamRef.current = systemStream;
      } catch (err) {
        console.warn("System audio capture skipped.", err);
      }

      const AudioContextClass =
        window.AudioContext || (window as any).webkitAudioContext;
      const audioCtx = new AudioContextClass();
      audioCtxRef.current = audioCtx;
      if (audioCtx.state === "suspended") {
        console.warn("[Recorder] AudioContext suspended — resuming.");
        await audioCtx.resume();
      }
      console.log("[Recorder] AudioContext state:", audioCtx.state);
      const destination = audioCtx.createMediaStreamDestination();
      destinationRef.current = destination;

      const micSource = audioCtx.createMediaStreamSource(micStream);
      micSource.connect(destination);
      micSourceRef.current = micSource;

      if (systemStream && systemStream.getAudioTracks().length > 0) {
        const systemSource = audioCtx.createMediaStreamSource(systemStream);
        systemSource.connect(destination);
        systemStream.getVideoTracks().forEach((t) => t.stop());
      } else if (systemStream) {
        systemStream.getTracks().forEach((t) => t.stop());
      }

      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      micSource.connect(analyser);
      analyserRef.current = analyser;
      const bufferLength = analyser.frequencyBinCount;
      const dataArray = new Uint8Array(bufferLength);

      if (qualityIntervalRef.current) clearInterval(qualityIntervalRef.current);
      qualityIntervalRef.current = setInterval(() => {
        if (!isPausedRef.current && analyserRef.current) {
          analyserRef.current.getByteFrequencyData(dataArray);
          let sum = 0;
          for (let i = 0; i < bufferLength; i++) sum += dataArray[i];
          const average = sum / bufferLength;

          if (average < 8) setAudioQuality("Bad");
          else if (average < 30) setAudioQuality("Medium");
          else if (average < 70) setAudioQuality("Good");
          else setAudioQuality("Excellent");
        }
      }, 1000);

      const mixedStream = destination.stream;
      streamRef.current = mixedStream;
      isPausedRef.current = false;

      console.log(
        "[Recorder] mixed (recorded) stream audio tracks:",
        mixedStream.getAudioTracks().length,
      );

      recordedChunksRef.current = [];
      audioFilePathRef.current = null;

      const PREFERRED_TYPES = [
        "audio/webm;codecs=opus",
        "audio/webm",
        "audio/ogg;codecs=opus",
      ];
      const mimeType =
        PREFERRED_TYPES.find((t) => MediaRecorder.isTypeSupported(t)) || "";
      const recorder = mimeType
        ? new MediaRecorder(mixedStream, { mimeType })
        : new MediaRecorder(mixedStream);
      console.log(
        "[Recorder] MediaRecorder created. requested:",
        mimeType || "(browser default)",
        "| actual mimeType:",
        recorder.mimeType,
      );

      let recordedChunksLength = 0;
      recorder.onstart = () =>
        console.log("[Recorder] onstart — state:", recorder.state);
      recorder.onerror = (ev) =>
        console.error("[Recorder] MediaRecorder error event:", ev);

      recorder.ondataavailable = (e) => {
        const size = e.data?.size ?? 0;
        if (e.data && size > 0) {
          recordedChunksRef.current.push(e.data);
        }
        recordedChunksLength += 1;
        console.log(
          `[Recorder] chunk #${recordedChunksLength} — size: ${size} bytes, type: ${
            e.data?.type || "(none)"
          } (buffered: ${recordedChunksRef.current.length})`,
        );
      };
      mediaRecorderRef.current = recorder;
      recorder.start(1000);
      console.log(
        "[Recorder] recorder.start(1000) invoked — state:",
        recorder.state,
      );

      const { token, region } = await fetchAzureToken();
      const recognizer = initRecognizer(token, region);
      recognizer.startContinuousRecognitionAsync(
        () => startRenewalLoop(),
        (err) => callbacksRef.current.onError?.(String(err)),
      );

      const handleDeviceChange = () => {
        if (deviceSwitchTimerRef.current) {
          clearTimeout(deviceSwitchTimerRef.current);
        }
        deviceSwitchTimerRef.current = setTimeout(async () => {
          if (finishingRef.current || isPausedRef.current) return;
          const ctx = audioCtxRef.current;
          const dest = destinationRef.current;
          if (!ctx || !dest || ctx.state === "closed") return;
          try {
            const newStream = await navigator.mediaDevices.getUserMedia({
              audio: true,
            });
            const newLabel = newStream.getAudioTracks()[0]?.label;
            const oldLabel = micStreamRef.current?.getAudioTracks()[0]?.label;
            if (newLabel && oldLabel && newLabel === oldLabel) {
              newStream.getTracks().forEach((t) => t.stop());
              return;
            }
            const newSource = ctx.createMediaStreamSource(newStream);
            newSource.connect(dest);
            if (analyserRef.current) newSource.connect(analyserRef.current);
            try {
              micSourceRef.current?.disconnect();
            } catch {}
            micStreamRef.current?.getTracks().forEach((t) => t.stop());
            micSourceRef.current = newSource;
            micStreamRef.current = newStream;
            if (newLabel) setMicLabel(newLabel);
            console.log("[Recorder] mic device hot-swapped →", newLabel);
          } catch (err) {
            console.warn(
              "[Recorder] device switch failed — keeping current mic:",
              err,
            );
          }
        }, 400);
      };
      deviceSwitchRef.current = handleDeviceChange;
      navigator.mediaDevices.addEventListener(
        "devicechange",
        handleDeviceChange,
      );

      return true;
    } catch (e: any) {
      callbacksRef.current.onError?.(e?.message || "Failed to start");
      return false;
    }
  }, [fetchAzureToken, initRecognizer, startRenewalLoop]);

  const pause = useCallback(() => {
    isPausedRef.current = true;
    micStreamRef.current?.getAudioTracks().forEach((t) => (t.enabled = false));
    systemStreamRef.current
      ?.getAudioTracks()
      .forEach((t) => (t.enabled = false));
    if (mediaRecorderRef.current?.state === "recording") {
      mediaRecorderRef.current.pause();
    }
    setAudioQuality("Paused");
  }, []);

  const resume = useCallback(async () => {
    isPausedRef.current = false;
    micStreamRef.current?.getAudioTracks().forEach((t) => (t.enabled = true));
    systemStreamRef.current
      ?.getAudioTracks()
      .forEach((t) => (t.enabled = true));
    if (mediaRecorderRef.current?.state === "paused") {
      mediaRecorderRef.current.resume();
    }
    if (recognizerDeadRef.current || !recognizerRef.current) {
      await reconnect();
    }
  }, [reconnect]);

  const cleanupStreams = useCallback(() => {
    if (qualityIntervalRef.current) clearInterval(qualityIntervalRef.current);
    if (deviceSwitchRef.current) {
      navigator.mediaDevices.removeEventListener(
        "devicechange",
        deviceSwitchRef.current,
      );
      deviceSwitchRef.current = null;
    }
    if (deviceSwitchTimerRef.current) {
      clearTimeout(deviceSwitchTimerRef.current);
      deviceSwitchTimerRef.current = null;
    }
    micStreamRef.current?.getTracks().forEach((t) => t.stop());
    systemStreamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current?.getTracks().forEach((t) => t.stop());

    if (audioCtxRef.current && audioCtxRef.current.state !== "closed") {
      audioCtxRef.current.close().catch(() => {});
    }

    micStreamRef.current = null;
    systemStreamRef.current = null;
    streamRef.current = null;
    audioCtxRef.current = null;
    destinationRef.current = null;
    micSourceRef.current = null;
    analyserRef.current = null;
  }, []);

  // Stop the recognizer + recorder, write the recording to disk and remux it to
  // a playable URL. Does NOT diarize — diarization is now triggered on demand
  // (via diarizeAudioFile on the returned audioFilePath).
  const finishRecording = useCallback(async (): Promise<any> => {
    finishingRef.current = true;
    if (renewTimerRef.current) {
      clearInterval(renewTimerRef.current);
      renewTimerRef.current = null;
    }

    await new Promise<void>((resolve) => {
      const r = recognizerRef.current;
      if (!r) return resolve();
      r.stopContinuousRecognitionAsync(
        () => {
          r.close();
          resolve();
        },
        () => resolve(),
      );
    });
    recognizerRef.current = null;

    await new Promise<void>((resolve) => {
      const recorder = mediaRecorderRef.current;
      if (!recorder || recorder.state === "inactive") return resolve();
      console.log(
        "[Recorder] stopping MediaRecorder — state before stop:",
        recorder.state,
      );
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        console.log("[Recorder] MediaRecorder onstop fired.");
        resolve();
      };
      recorder.onstop = done;
      setTimeout(done, 4000);
      try {
        recorder.stop();
      } catch (err) {
        console.warn("[Recorder] recorder.stop() threw:", err);
        done();
      }
    });

    let audioFilePath: string | null = null;
    const recordedChunks = recordedChunksRef.current;
    const recordedBlob =
      recordedChunks.length > 0
        ? new Blob(recordedChunks, {
            type: mediaRecorderRef.current?.mimeType || "audio/webm",
          })
        : null;
    console.log(
      `[Recorder] finishing — buffered chunks: ${recordedChunks.length}, blob size: ${
        recordedBlob?.size ?? 0
      } bytes`,
    );

    let playbackUrl: string | null = null;

    if (
      recordedBlob &&
      recordedBlob.size > 0 &&
      typeof window !== "undefined" &&
      window.electronAPI?.audioFileCreate
    ) {
      try {
        audioFilePath = await window.electronAPI.audioFileCreate();
        const arrayBuffer = await recordedBlob.arrayBuffer();
        await window.electronAPI.audioFileAppend(audioFilePath, arrayBuffer);
        await window.electronAPI.audioFileClose(audioFilePath);
        audioFilePathRef.current = audioFilePath;
        console.log(
          `[Recorder] wrote complete recording (${arrayBuffer.byteLength} bytes) → ${audioFilePath}`,
        );
      } catch (error) {
        console.warn("[Recorder] Failed to write recording file:", error);
        audioFilePath = null;
      }
    } else {
      console.warn(
        "[Recorder] No audio captured — nothing to save or diarize.",
      );
    }

    if (audioFilePath && typeof window !== "undefined" && window.electronAPI?.remuxAudio) {
      try {
        const { mediaUrl } = await window.electronAPI.remuxAudio(audioFilePath);
        playbackUrl = mediaUrl;
        console.log("[Recorder] remux complete — playback URL:", playbackUrl);
      } catch (error) {
        console.warn("[Recorder] Remux failed — playback unavailable:", error);
      }
    }

    cleanupStreams();
    mediaRecorderRef.current = null;
    // Keep audioFilePathRef so diarization can run later on the same finalized
    // audio. It's reset on the next start()/cancel().

    return {
      status: "success",
      audioUrl: playbackUrl,
      audioFilePath,
    };
  }, [cleanupStreams]);

  const getRecordingFilePath = useCallback(
    () => audioFilePathRef.current,
    [],
  );

  const cancel = useCallback(() => {
    finishingRef.current = true;
    if (diarizeAbortRef.current) {
      try {
        diarizeAbortRef.current.abort();
      } catch {}
      diarizeAbortRef.current = null;
    }
    if (renewTimerRef.current) clearInterval(renewTimerRef.current);
    const r = recognizerRef.current;
    if (r) {
      try {
        r.stopContinuousRecognitionAsync(
          () => r.close(),
          () => r.close(),
        );
      } catch {}
      recognizerRef.current = null;
    }
    const mr = mediaRecorderRef.current;
    if (mr) {
      try {
        if (mr.state !== "inactive") mr.stop();
      } catch {}
      mediaRecorderRef.current = null;
    }

    if (audioFilePathRef.current && typeof window !== "undefined" && window.electronAPI?.audioFileClose) {
      void window.electronAPI.audioFileClose(audioFilePathRef.current).catch(() => {});
      audioFilePathRef.current = null;
    }

    cleanupStreams();
    isPausedRef.current = false;
    recognizerDeadRef.current = false;
    recordedChunksRef.current = [];
  }, [cleanupStreams]);

  return {
    start,
    pause,
    resume,
    finishRecording,
    getRecordingFilePath,
    cancel,
    micLabel,
    detectedLanguage,
    audioQuality,
    setCallbacks,
  };
}
