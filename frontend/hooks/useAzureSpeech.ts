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
  const isDisconnectedRef = useRef<boolean>(false);
  const consecutiveFailuresRef = useRef<number>(0);
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
          isDisconnectedRef.current = true;
          consecutiveFailuresRef.current += 1;
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
      isDisconnectedRef.current = false;
      consecutiveFailuresRef.current = 0;
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

          if (isDisconnectedRef.current && average >= 10 && !reconnectingRef.current && !finishingRef.current) {
            isDisconnectedRef.current = false; // Prevent multiple overlapping reconnects
            const delay = Math.min(2000 * Math.pow(2, Math.max(0, consecutiveFailuresRef.current - 1)), 15000);
            setTimeout(() => {
              void reconnectRef.current?.();
            }, delay);
          }
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

  const finishRecording = useCallback(
    async (onProgress?: (p: number) => void): Promise<any> => {
      finishingRef.current = true;
      if (renewTimerRef.current) {
        clearInterval(renewTimerRef.current);
        renewTimerRef.current = null;
      }
      onProgress?.(0.1);

      // Stop the Azure recognizer — but never let it hang the finish. If neither
      // the success nor error callback fires, a 4s race unblocks us.
      await Promise.race([
        new Promise<void>((resolve) => {
          const r = recognizerRef.current;
          if (!r) return resolve();
          r.stopContinuousRecognitionAsync(
            () => {
              try {
                r.close();
              } catch {}
              resolve();
            },
            () => resolve(),
          );
        }),
        new Promise<void>((resolve) => setTimeout(resolve, 4000)),
      ]);
      recognizerRef.current = null;
      onProgress?.(0.25);

      await new Promise<void>((resolve) => {
        const recorder = mediaRecorderRef.current;
        if (!recorder || recorder.state === "inactive") return resolve();
        let settled = false;
        const done = () => {
          if (settled) return;
          settled = true;
          resolve();
        };
        recorder.onstop = done;
        setTimeout(done, 4000);
        try {
          recorder.stop();
        } catch {
          done();
        }
      });
      onProgress?.(0.3);

      let audioFilePath: string | null = null;
      const recordedChunks = recordedChunksRef.current;
      const recordedBlob =
        recordedChunks.length > 0
          ? new Blob(recordedChunks, {
              type: mediaRecorderRef.current?.mimeType || "audio/webm",
            })
          : null;

      // INSTANT, reliable playback URL from the recorded blob — no ffmpeg on the
      // critical path (remux was the flaky/slow step that made audio late/absent).
      const playbackUrl =
        recordedBlob && recordedBlob.size > 0
          ? URL.createObjectURL(recordedBlob)
          : null;

      // Write the raw file to disk in chunks so the finishing bar reflects REAL
      // bytes written (the genuinely slow part for long meetings) — 30% → 95%.
      if (
        recordedBlob &&
        recordedBlob.size > 0 &&
        typeof window !== "undefined" &&
        window.electronAPI?.audioFileCreate
      ) {
        try {
          audioFilePath = await window.electronAPI.audioFileCreate();
          const arrayBuffer = await recordedBlob.arrayBuffer();
          const total = arrayBuffer.byteLength;
          const CHUNK = 4 * 1024 * 1024;
          let offset = 0;
          while (offset < total) {
            const end = Math.min(offset + CHUNK, total);
            await window.electronAPI.audioFileAppend(
              audioFilePath,
              arrayBuffer.slice(offset, end),
            );
            offset = end;
            onProgress?.(0.3 + 0.65 * (offset / total));
          }
          await window.electronAPI.audioFileClose(audioFilePath);
          audioFilePathRef.current = audioFilePath;
        } catch {
          audioFilePath = null;
        }
      }
      onProgress?.(1);

      cleanupStreams();
      mediaRecorderRef.current = null;

      return {
        status: "success",
        audioUrl: playbackUrl,
        audioFilePath,
      };
    },
    [cleanupStreams],
  );

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
