// ThreadNotes — "Thick Client" live transcription hook (REFERENCE BOILERPLATE).
//
// The browser talks DIRECTLY to Azure Speech using a short-lived token minted by
// the thin server. Robustness features:
//   • Silent 8-min token renewal (hot-swap authorizationToken, no restart).
//   • Pause/resume by muting the owned mic track (connection stays open).
//   • RECONNECT GUARD: if Azure drops the session (e.g. idle timeout during a
//     long pause), the recognizer is rebuilt seamlessly on the SAME stream with
//     a fresh token — recorded audio (MediaRecorder/chunks) and already-committed
//     segments are never lost.
//
// To use:
//   1. cd frontend && npm i microsoft-cognitiveservices-speech-sdk
//   2. Move this file into frontend/hooks/.
//   3. Enable the backend routes from thick_client.py.
//
// NOTE: unverified by build until the package is installed (it imports the SDK).

import { useCallback, useRef } from "react";
import * as SpeechSDK from "microsoft-cognitiveservices-speech-sdk";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";
const SPEECH_LANG = process.env.NEXT_PUBLIC_SPEECH_LANG || "en-US";

// Tokens live ~10 min; refresh at 8 min for a 2-min safety margin.
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
  // One shared mic stream feeds BOTH the SDK (via fromStreamInput) and the
  // MediaRecorder. Owning it ourselves is what makes pause + reconnect possible.
  const streamRef = useRef<MediaStream | null>(null);
  const isPausedRef = useRef<boolean>(false);

  // Reconnect bookkeeping.
  const recognizerDeadRef = useRef<boolean>(false); // Azure dropped the session
  const reconnectingRef = useRef<boolean>(false); // collapse concurrent attempts
  const finishingRef = useRef<boolean>(false); // suppress reconnect during teardown
  // Late-bound reference to reconnect() so the canceled handler (created earlier)
  // can call it without a temporal-dead-zone cycle.
  const reconnectRef = useRef<null | (() => Promise<boolean>)>(null);

  // Retrieve the app JWT the same way the rest of the app does — localStorage
  // "token" (set by the login flow) — unless the caller passes an override.
  const readJwt = useCallback((): string | null => {
    if (getAuthToken) return getAuthToken();
    if (typeof window === "undefined") return null;
    return localStorage.getItem("token");
  }, [getAuthToken]);

  // --- Fetch a fresh Azure token from the thin server. ---
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

  // --- SILENT TOKEN RENEWAL ---
  // Hot-swaps the recognizer's token in place. This is the SDK-sanctioned way to
  // extend a live session — it does NOT restart recognition. Left running across
  // pauses so the token is always fresh, including right before a reconnect.
  const startRenewalLoop = useCallback(() => {
    if (renewTimerRef.current) clearInterval(renewTimerRef.current);
    renewTimerRef.current = setInterval(async () => {
      try {
        const { token } = await fetchAzureToken();
        if (recognizerRef.current && !recognizerDeadRef.current) {
          recognizerRef.current.authorizationToken = token;
          console.log("🔑 Azure token silently renewed");
        }
      } catch (e: any) {
        console.warn("Token renewal failed, will retry next tick:", e?.message);
        onError?.("Token renewal failed (will retry)");
      }
    }, TOKEN_REFRESH_MS);
  }, [fetchAzureToken, onError]);

  // --- Build + wire a recognizer on the CURRENT shared stream. ---
  const initRecognizer = useCallback(
    (token: string, region: string): SpeechSDK.SpeechRecognizer => {
      const speechConfig = SpeechSDK.SpeechConfig.fromAuthorizationToken(
        token,
        region,
      );
      speechConfig.speechRecognitionLanguage = SPEECH_LANG;

      // Feed OUR stream (not fromDefaultMicrophoneInput) so pause can mute the
      // track and reconnect can reattach to the same mic.
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
        // Azure ended the session (idle timeout, network, etc.). Mark dead.
        recognizerDeadRef.current = true;
        if (e.reason === SpeechSDK.CancellationReason.Error) {
          onError?.(e.errorDetails || "Recognition canceled");
        }
        // Self-heal immediately if we're ACTIVELY recording. If paused, we defer
        // the rebuild to resume() (no point holding a socket open over silence).
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

  // --- RECONNECT: rebuild a dead recognizer on the SAME stream + fresh token.
  // MediaRecorder/chunks and committed segments are untouched, so nothing is
  // lost; only the SpeechRecognizer is replaced. ---
  const reconnect = useCallback(async (): Promise<boolean> => {
    if (reconnectingRef.current) return false; // already in flight
    if (!streamRef.current || finishingRef.current) return false;
    reconnectingRef.current = true;
    try {
      // Best-effort dispose of the old (dead) recognizer.
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

      // Fresh token + recognizer, then start continuous recognition.
      const { token, region } = await fetchAzureToken();
      const recognizer = initRecognizer(token, region);
      await new Promise<void>((resolve, reject) => {
        recognizer.startContinuousRecognitionAsync(
          () => resolve(),
          (err) => reject(err),
        );
      });

      startRenewalLoop(); // ensure renewal is armed for the new recognizer
      console.log("🔄 Azure recognizer reconnected seamlessly");
      return true;
    } catch (e: any) {
      // Reconnect failed — live transcription is down, but the local recording
      // keeps rolling, so the FINAL diarized pass still captures everything.
      onError?.(`Live reconnect failed (recording continues): ${e?.message || e}`);
      return false;
    } finally {
      reconnectingRef.current = false;
    }
  }, [fetchAzureToken, initRecognizer, startRenewalLoop, onError]);

  // Late-bind so initRecognizer's canceled handler can reach reconnect().
  reconnectRef.current = reconnect;

  const start = useCallback(async (): Promise<boolean> => {
    try {
      finishingRef.current = false;

      // 1) Capture the mic ONCE; the same stream feeds both the recorder and
      //    the SDK. Owning the stream enables pause + reconnect.
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

      // 2) Live transcription straight to Azure via the short-lived token.
      const { token, region } = await fetchAzureToken();
      const recognizer = initRecognizer(token, region);
      recognizer.startContinuousRecognitionAsync(
        () => startRenewalLoop(), // arm renewal only once recognition is live
        (err) => onError?.(String(err)),
      );
      return true;
    } catch (e: any) {
      onError?.(e?.message || "Failed to start live transcription");
      return false;
    }
  }, [fetchAzureToken, initRecognizer, startRenewalLoop, onError]);

  // --- PAUSE: halt recognition WITHOUT tearing down the session. ---
  // Mute the mic track (digital silence) instead of stopContinuousRecognition,
  // so the recognizer's WebSocket stays open. The renewal interval is left
  // running so the token stays valid across a long pause.
  const pause = useCallback(() => {
    isPausedRef.current = true;
    streamRef.current?.getAudioTracks().forEach((t) => {
      t.enabled = false;
    });
    if (mediaRecorderRef.current?.state === "recording") {
      mediaRecorderRef.current.pause();
    }
  }, []);

  // --- RESUME: re-enable the track; if Azure dropped the socket during the
  // pause (idle timeout), rebuild the recognizer first — seamlessly. ---
  const resume = useCallback(async () => {
    isPausedRef.current = false;
    streamRef.current?.getAudioTracks().forEach((t) => {
      t.enabled = true;
    });
    if (mediaRecorderRef.current?.state === "paused") {
      mediaRecorderRef.current.resume();
    }
    // Dead or missing recognizer -> stand up a fresh one before audio flows.
    if (recognizerDeadRef.current || !recognizerRef.current) {
      await reconnect();
    }
  }, [reconnect]);

  // --- Stop live recognition, finalize the recording, and stream it to the
  //     thin server for the authoritative diarized + word-aligned pass. ---
  const finishAndUpload = useCallback(async (): Promise<any> => {
    finishingRef.current = true; // block any reconnect during teardown
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

    // Local URL for the playback <audio> element. Caller should
    // URL.revokeObjectURL(audioUrl) when the playback view is torn down.
    const audioUrl = blob.size > 0 ? URL.createObjectURL(blob) : null;

    const jwt = readJwt();
    const form = new FormData();
    form.append("file", blob, "recording.webm");
    const res = await fetch(`${API_URL}/diarize/stream`, {
      method: "POST",
      headers: jwt ? { Authorization: `Bearer ${jwt}` } : {},
      body: form,
    });
    const result = await res.json(); // { status, id, segments: [...] }
    return { ...result, audioUrl }; // segments + local audio for karaoke playback
  }, [readJwt]);

  // --- Hard stop with no upload (e.g. New Conversation). ---
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
