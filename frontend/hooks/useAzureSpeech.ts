import { useCallback, useRef } from "react";
import * as SpeechSDK from "microsoft-cognitiveservices-speech-sdk";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";
const SPEECH_LANG = process.env.NEXT_PUBLIC_SPEECH_LANG || "en-US";

const TOKEN_REFRESH_MS = 8 * 60 * 1000;

type UseAzureSpeechProps = {
  /** Optional override for the app JWT. Defaults to localStorage "token". */
  getAuthToken?: () => string | null;
  /** Growing in-progress hypothesis (typewriter effect). */
  onPartial?: (text: string) => void;
  /** A committed/finalized phrase. */
  onFinal?: (text: string) => void;
  onError?: (message: string) => void;
};

export function useAzureSpeech({
  getAuthToken,
  onPartial,
  onFinal,
  onError,
}: UseAzureSpeechProps) {
  const recognizerRef = useRef<SpeechSDK.SpeechRecognizer | null>(null);
  const renewTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const isPausedRef = useRef<boolean>(false);

  const recognizerDeadRef = useRef<boolean>(false);
  const reconnectingRef = useRef<boolean>(false);
  const finishingRef = useRef<boolean>(false);
  const reconnectRef = useRef<null | (() => Promise<boolean>)>(null);

  const readJwt = useCallback((): string | null => {
    if (getAuthToken) return getAuthToken();
    if (typeof window === "undefined") return null;
    return localStorage.getItem("token");
  }, [getAuthToken]);

  const fetchAzureToken = useCallback(async (): Promise<{
    token: string;
    region: string;
  }> => {
    const jwt = readJwt();
    if (!jwt) {
      throw new Error("Not authenticated — no app token in localStorage.");
    }
    const res = await fetch(`${API_URL}/azure/token`, {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    if (!res.ok) {
      throw new Error(
        res.status === 401
          ? "Azure token request unauthorized (401) — your login session likely expired; sign in again."
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
        onError?.("Token renewal failed (will retry)");
      }
    }, TOKEN_REFRESH_MS);
  }, [fetchAzureToken, onError]);

  const initRecognizer = useCallback(
    (token: string, region: string): SpeechSDK.SpeechRecognizer => {
      const speechConfig = SpeechSDK.SpeechConfig.fromAuthorizationToken(
        token,
        region,
      );
      speechConfig.speechRecognitionLanguage = SPEECH_LANG;

      const audioConfig = SpeechSDK.AudioConfig.fromStreamInput(
        streamRef.current as MediaStream,
      );
      const recognizer = new SpeechSDK.SpeechRecognizer(speechConfig, audioConfig);

      recognizer.recognizing = (_s: any, e: any) => {
        if (e.result.text) onPartial?.(e.result.text);
      };
      recognizer.recognized = (_s: any, e: any) => {
        if (
          e.result.reason === SpeechSDK.ResultReason.RecognizedSpeech &&
          e.result.text
        ) {
          onFinal?.(e.result.text);
        }
      };
      recognizer.canceled = (_s: any, e: any) => {
        recognizerDeadRef.current = true;
        if (e.reason === SpeechSDK.CancellationReason.Error) {
          onError?.(e.errorDetails || "Recognition canceled");
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
    [onPartial, onFinal, onError],
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
      onError?.(`Live reconnect failed (recording continues): ${e?.message || e}`);
      return false;
    } finally {
      reconnectingRef.current = false;
    }
  }, [fetchAzureToken, initRecognizer, startRenewalLoop, onError]);

  reconnectRef.current = reconnect;

  const start = useCallback(async (): Promise<boolean> => {
    try {
      finishingRef.current = false;

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      isPausedRef.current = false;

      chunksRef.current = [];
      const recorder = new MediaRecorder(stream);
      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
      };
      mediaRecorderRef.current = recorder;
      recorder.start(1000);

      const { token, region } = await fetchAzureToken();
      const recognizer = initRecognizer(token, region);
      recognizer.startContinuousRecognitionAsync(
        () => startRenewalLoop(),
        (err) => onError?.(String(err)),
      );
      return true;
    } catch (e: any) {
      onError?.(e?.message || "Failed to start live transcription");
      return false;
    }
  }, [fetchAzureToken, initRecognizer, startRenewalLoop, onError]);

  const pause = useCallback(() => {
    isPausedRef.current = true;
    streamRef.current?.getAudioTracks().forEach((t) => {
      t.enabled = false;
    });
    if (mediaRecorderRef.current?.state === "recording") {
      mediaRecorderRef.current.pause();
    }
  }, []);

  const resume = useCallback(async () => {
    isPausedRef.current = false;
    streamRef.current?.getAudioTracks().forEach((t) => {
      t.enabled = true;
    });
    if (mediaRecorderRef.current?.state === "paused") {
      mediaRecorderRef.current.resume();
    }
    if (recognizerDeadRef.current || !recognizerRef.current) {
      await reconnect();
    }
  }, [reconnect]);

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

    const blob: Blob = await new Promise((resolve) => {
      const mr = mediaRecorderRef.current;
      if (!mr) return resolve(new Blob());
      mr.onstop = () =>
        resolve(new Blob(chunksRef.current, { type: mr.mimeType || "audio/webm" }));
      if (mr.state !== "inactive") mr.stop();
      mr.stream.getTracks().forEach((t) => t.stop());
    });
    mediaRecorderRef.current = null;
    streamRef.current = null;

    const audioUrl = blob.size > 0 ? URL.createObjectURL(blob) : null;

    const jwt = readJwt();
    const form = new FormData();
    form.append("file", blob, "recording.webm");
    const res = await fetch(`${API_URL}/diarize/stream`, {
      method: "POST",
      headers: jwt ? { Authorization: `Bearer ${jwt}` } : {},
      body: form,
    });
    const result = await res.json();
    return { ...result, audioUrl };
  }, [readJwt]);

  const cancel = useCallback(() => {
    finishingRef.current = true;
    if (renewTimerRef.current) {
      clearInterval(renewTimerRef.current);
      renewTimerRef.current = null;
    }
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
        mr.stream.getTracks().forEach((t) => t.stop());
      } catch {}
      mediaRecorderRef.current = null;
    }
    streamRef.current = null;
    isPausedRef.current = false;
    recognizerDeadRef.current = false;
    chunksRef.current = [];
  }, []);

  return { start, pause, resume, finishAndUpload, cancel };
}
