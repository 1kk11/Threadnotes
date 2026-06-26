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
      // An AudioContext created without a user-gesture can start "suspended";
      // while suspended NO samples flow to the destination, so MediaRecorder
      // records silence / zero-size chunks. Resume before wiring the graph.
      if (audioCtx.state === "suspended") {
        console.warn("[Recorder] AudioContext suspended — resuming.");
        await audioCtx.resume();
      }
      console.log("[Recorder] AudioContext state:", audioCtx.state);
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

      console.log(
        "[Recorder] mixed (recorded) stream audio tracks:",
        mixedStream.getAudioTracks().length,
      );

      let recordingFilePath: string | null = null;
      if (typeof window !== "undefined" && window.electronAPI?.audioFileCreate) {
        try {
          recordingFilePath = await window.electronAPI.audioFileCreate();
          audioFilePathRef.current = recordingFilePath;
          audioWriteChainRef.current = Promise.resolve();
          console.log(
            "[Recorder] local recording file created at:",
            recordingFilePath,
          );
        } catch (e) {
          console.warn("[Recorder] Failed to create local recording file:", e);
          recordingFilePath = null;
        }
      } else {
        console.warn(
          "[Recorder] electronAPI.audioFileCreate unavailable — running outside Electron? Audio will NOT be saved to disk.",
        );
      }

      // Pin an explicitly-supported container so we don't get a silent
      // "no recorder for default type" failure on some Chromium builds.
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

      // NOTE: this handler is intentionally NOT async. It extends the write
      // chain *synchronously* (reading the blob inside the chained .then) so
      // that the final chunk emitted during recorder.stop() is guaranteed to
      // be queued before finishAndUpload() awaits the chain — closing the
      // end-of-recording flush race.
      recorder.ondataavailable = (e) => {
        recordedChunksLength += 1;
        const size = e.data?.size ?? 0;
        console.log(
          `[Recorder] chunk #${recordedChunksLength} — size: ${size} bytes, blob type: ${
            e.data?.type || "(none)"
          }, recordedChunks length: ${recordedChunksLength}`,
        );
        if (!e.data || size === 0) {
          console.warn(
            "[Recorder] EMPTY chunk — MediaRecorder is not receiving audio from the mic/stream (check AudioContext state & track.muted above).",
          );
          return;
        }
        const localPath = audioFilePathRef.current;
        if (
          !localPath ||
          typeof window === "undefined" ||
          !window.electronAPI?.audioFileAppend
        ) {
          console.warn(
            "[Recorder] Cannot persist chunk — missing path or IPC.",
            { localPath, hasAppendIPC: !!window.electronAPI?.audioFileAppend },
          );
          return;
        }

        const blob = e.data;
        audioWriteChainRef.current = audioWriteChainRef.current
          .then(async () => {
            const arrayBuffer = await blob.arrayBuffer();
            console.log(
              `[Recorder] appending ${arrayBuffer.byteLength} bytes → ${localPath}`,
            );
            await window.electronAPI?.audioFileAppend(localPath, arrayBuffer);
          })
          .catch((error) => {
            console.warn("[Recorder] Audio append failed:", error);
          });
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

    // Stop the recorder and WAIT for its final "stop" event. MediaRecorder
    // flushes a last "dataavailable" (the tail of the recording) synchronously
    // before "stop" fires; because ondataavailable extends the write chain
    // synchronously, awaiting onstop and then the chain guarantees every byte
    // — including that final chunk — is appended before we close the file.
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
      // Safety net: if onstop never fires, don't hang the finish flow.
      setTimeout(done, 4000);
      try {
        recorder.stop();
      } catch (err) {
        console.warn("[Recorder] recorder.stop() threw:", err);
        done();
      }
    });

    // Flush all queued appends (the final chunk is now guaranteed enqueued).
    await audioWriteChainRef.current;
    const audioFilePath = audioFilePathRef.current;
    console.log("[Recorder] finishing — audio file path:", audioFilePath);

    // Playback URL is produced by the remux step below (media:// scheme).
    // We no longer hand the raw .webm (file://) to the player.
    let playbackUrl: string | null = null;

    if (audioFilePath && typeof window !== "undefined" && window.electronAPI?.audioFileClose) {
      try {
        const closed = await window.electronAPI.audioFileClose(audioFilePath);
        console.log("[Recorder] audioFileClose result:", closed);
      } catch (error) {
        console.warn("[Recorder] Failed to close local audio file:", error);
      }
    }

    // Finalize the streaming .webm into a seekable .ogg with valid duration
    // metadata, and serve it over the privileged media:// scheme.
    if (audioFilePath && typeof window !== "undefined" && window.electronAPI?.remuxAudio) {
      try {
        const { mediaUrl } = await window.electronAPI.remuxAudio(audioFilePath);
        playbackUrl = mediaUrl;
        console.log("[Recorder] remux complete — playback URL:", playbackUrl);
      } catch (error) {
        console.warn("[Recorder] Remux failed — playback unavailable:", error);
      }
    }

    let mergedTranscript: any[] = [];

    // Diarization is ACOUSTIC (runs on the recorded audio), so it must fire
    // whenever we have an audio file — independent of whether the live
    // recognizer happened to emit any interim text. Gating on the live
    // transcript was the bug that silently produced empty transcripts.
    if (
      audioFilePath &&
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

    return {
      status: "success",
      audioUrl: playbackUrl,
      merged_transcript: mergedTranscript,
    };
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
