import { useCallback, useRef, useState } from "react";
import * as SpeechSDK from "microsoft-cognitiveservices-speech-sdk";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

const TOKEN_REFRESH_MS = 8 * 60 * 1000;

type UseAzureSpeechProps = {
  getAuthToken?: () => string | null;
  onPartial?: (text: string) => void;
  onFinal?: (text: string) => void;
  onError?: (message: string) => void;
};

type AzureTranscriptItem = {
  text: string;
  start: number;
  end: number;
};

export function useAzureSpeech(initialProps?: UseAzureSpeechProps) {
  const callbacksRef = useRef({
    onPartial: initialProps?.onPartial,
    onFinal: initialProps?.onFinal,
    onError: initialProps?.onError,
  });

  const setCallbacks = useCallback(
    (cbs: {
      onPartial?: (text: string) => void;
      onFinal?: (text: string) => void;
      onError?: (message: string) => void;
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
  const azureTranscriptRef = useRef<AzureTranscriptItem[]>([]);
  const audioFilePathRef = useRef<string | null>(null);
  const audioWriteChainRef = useRef<Promise<void>>(Promise.resolve());
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

  const readJwt = useCallback((): string | null => {
    if (initialProps?.getAuthToken) return initialProps.getAuthToken();
    if (typeof window === "undefined") return null;
    return localStorage.getItem("token");
  }, [initialProps]);

  const DIARIZE_URL = `${API_URL}/diarize/stream`;

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

  const normalizeAzureResultTimestamps = (result: any) => {
    const rawStart = Number(result.offset ?? result.result?.offset ?? 0);
    const rawDuration = Number(result.duration ?? result.result?.duration ?? 0);
    const isTicks = rawStart > 100000 || rawDuration > 100000;
    const start = isTicks ? rawStart / 10000000 : rawStart;
    const duration = isTicks ? rawDuration / 10000000 : rawDuration;

    return {
      start: Math.max(0, start),
      end: Math.max(0, start + duration),
    };
  };

  const initRecognizer = useCallback(
    (token: string, region: string): SpeechSDK.SpeechRecognizer => {
      const speechConfig = SpeechSDK.SpeechConfig.fromAuthorizationToken(
        token,
        region,
      );

      const autoDetectSourceLanguageConfig =
        SpeechSDK.AutoDetectSourceLanguageConfig.fromLanguages([
          "en-US",
          "hi-IN",
        ]);

      const audioConfig = SpeechSDK.AudioConfig.fromStreamInput(
        streamRef.current as MediaStream,
      );

      const recognizer = SpeechSDK.SpeechRecognizer.FromConfig(
        speechConfig,
        autoDetectSourceLanguageConfig,
        audioConfig,
      );

      recognizer.recognizing = (_s: any, e: any) => {
        if (e.result.text) callbacksRef.current.onPartial?.(e.result.text);
      };

      recognizer.recognized = (_s: any, e: any) => {
        if (
          e.result.reason === SpeechSDK.ResultReason.RecognizedSpeech &&
          e.result.text
        ) {
          const lang = e.result.properties.getProperty(
            (SpeechSDK.PropertyId as any)
              .SpeechServiceConnection_AutoDetectSourceLanguageResult,
          );
          if (lang) {
            setDetectedLanguage(lang.startsWith("hi") ? "Hindi" : "English");
          }

          const { start, end } = normalizeAzureResultTimestamps(e.result);
          azureTranscriptRef.current.push({
            text: e.result.text,
            start,
            end,
          });

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

      const micStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
      });
      micStreamRef.current = micStream;

      if (micStream.getAudioTracks().length > 0) {
        setMicLabel(
          micStream.getAudioTracks()[0].label || "Default Microphone",
        );
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
      const destination = audioCtx.createMediaStreamDestination();

      const micSource = audioCtx.createMediaStreamSource(micStream);
      micSource.connect(destination);

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
      const bufferLength = analyser.frequencyBinCount;
      const dataArray = new Uint8Array(bufferLength);

      if (qualityIntervalRef.current) clearInterval(qualityIntervalRef.current);
      qualityIntervalRef.current = setInterval(() => {
        if (!isPausedRef.current && analyser) {
          analyser.getByteFrequencyData(dataArray);
          let sum = 0;
          for (let i = 0; i < bufferLength; i++) sum += dataArray[i];
          const average = sum / bufferLength;

          if (average < 10) setAudioQuality("Low (Speak Louder)");
          else if (average < 50) setAudioQuality("Medium");
          else setAudioQuality("Good");
        }
      }, 1000);

      const mixedStream = destination.stream;
      streamRef.current = mixedStream;
      isPausedRef.current = false;
      azureTranscriptRef.current = [];

      let recordingFilePath: string | null = null;
      if (typeof window !== "undefined" && window.electronAPI?.audioFileCreate) {
        try {
          recordingFilePath = await window.electronAPI.audioFileCreate();
          audioFilePathRef.current = recordingFilePath;
          audioWriteChainRef.current = Promise.resolve();
        } catch (e) {
          console.warn("Failed to create local recording file:", e);
          recordingFilePath = null;
        }
      }

      const recorder = new MediaRecorder(mixedStream);
      recorder.ondataavailable = async (e) => {
        if (!e.data || e.data.size === 0) return;
        const localPath = audioFilePathRef.current;
        if (!localPath || typeof window === "undefined" || !window.electronAPI?.audioFileAppend) return;

        const arrayBuffer = await e.data.arrayBuffer();
        audioWriteChainRef.current = audioWriteChainRef.current
          .then(async () => {
            await window.electronAPI?.audioFileAppend(localPath, arrayBuffer);
          })
          .catch((error) => {
            console.warn("Audio append failed:", error);
          });
      };
      mediaRecorderRef.current = recorder;
      recorder.start(1000);

      const { token, region } = await fetchAzureToken();
      const recognizer = initRecognizer(token, region);
      recognizer.startContinuousRecognitionAsync(
        () => startRenewalLoop(),
        (err) => callbacksRef.current.onError?.(String(err)),
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
  }, []);

  const finishAndUpload = useCallback(async (): Promise<any> => {
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

    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      try {
        mediaRecorderRef.current.stop();
      } catch {
      }
    }

    await audioWriteChainRef.current;
    const audioFilePath = audioFilePathRef.current;
    if (audioFilePath && typeof window !== "undefined" && window.electronAPI?.audioFileClose) {
      try {
        await window.electronAPI.audioFileClose(audioFilePath);
      } catch (error) {
        console.warn("Failed to close local audio file:", error);
      }
    }

    let mergedTranscript: any[] = [];

    if (
      audioFilePath &&
      azureTranscriptRef.current.length > 0 &&
      typeof window !== "undefined" &&
      window.electronAPI?.audioCompressAndRead
    ) {
      const jwt = readJwt();
      const { chunks, segmentSeconds, mimeType } =
        await window.electronAPI.audioCompressAndRead(audioFilePath);

      const stitched: any[] = [];
      for (let i = 0; i < chunks.length; i++) {
        const { buffer, name } = chunks[i];
        callbacksRef.current.onPartial?.(
          chunks.length > 1
            ? `Diarizing part ${i + 1} of ${chunks.length}...`
            : "Diarizing transcript...",
        );

        const form = new FormData();
        form.append("file", new Blob([buffer], { type: mimeType }), name);

        const response = await fetch(DIARIZE_URL, {
          method: "POST",
          headers: jwt ? { Authorization: `Bearer ${jwt}` } : undefined,
          body: form,
        });

        const result = await response.json();
        if (!response.ok || result.status === "error") {
          throw new Error(
            result.detail || result.message ||
              `Vault diarization failed on part ${i + 1}: ${response.status}`,
          );
        }

        const offset = i * segmentSeconds;
        const segs = Array.isArray(result.merged_transcript)
          ? result.merged_transcript
          : Array.isArray(result.segments)
            ? result.segments
            : [];
        for (const s of segs) {
          stitched.push({
            ...s,
            start: (Number(s.start) || 0) + offset,
            end: (Number(s.end) || 0) + offset,
            words: Array.isArray(s.words)
              ? s.words.map((w: any) => ({
                  ...w,
                  start: (Number(w.start) || 0) + offset,
                  end: (Number(w.end) || 0) + offset,
                }))
              : s.words,
          });
        }
      }

      mergedTranscript = stitched;
    }

    cleanupStreams();
    mediaRecorderRef.current = null;
    audioFilePathRef.current = null;
    azureTranscriptRef.current = [];

    const audioUrl = audioFilePath ? `file://${audioFilePath}` : null;
    return { status: "success", audioUrl, merged_transcript: mergedTranscript };
  }, [cleanupStreams, readJwt, DIARIZE_URL]);

  const cancel = useCallback(() => {
    finishingRef.current = true;
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

    azureTranscriptRef.current = [];
    cleanupStreams();
    isPausedRef.current = false;
    recognizerDeadRef.current = false;
    audioWriteChainRef.current = Promise.resolve();
  }, [cleanupStreams]);

  return {
    start,
    pause,
    resume,
    finishAndUpload,
    cancel,
    micLabel,
    detectedLanguage,
    audioQuality,
    setCallbacks,
  };
}
