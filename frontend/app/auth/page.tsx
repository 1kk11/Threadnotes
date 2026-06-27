"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import InfoModal from "@/components/ui/InfoModal";
import { getValidToken } from "@/lib/auth";

export default function AuthPage() {
  const [authMode, setAuthMode] = useState<"login" | "signup" | "forgot">(
    "login",
  );
  const [forgotStep, setForgotStep] = useState(1);

  const [isEmailVerified, setIsEmailVerified] = useState(false);
  const [signupOtpSent, setSignupOtpSent] = useState(false);
  const [signupOtp, setSignupOtp] = useState("");

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [otp, setOtp] = useState("");

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [info, setInfo] = useState<{ title: string; message: string } | null>(
    null,
  );
  const router = useRouter();

  const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

  useEffect(() => {
    if (getValidToken()) router.replace("/");
  }, [router]);

  const handleSendSignupOtp = async () => {
    if (!email) {
      setError("Please enter your email first.");
      return;
    }
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`${API_URL}/send-signup-otp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const data = await res.json();
      if (!res.ok)
        throw new Error(data.detail || "Failed to send verification OTP");
      setSignupOtpSent(true);
      setInfo({
        title: "OTP Sent",
        message: "A verification OTP has been sent to your email.",
      });
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleVerifySignupOtp = async () => {
    if (!signupOtp || signupOtp.length < 6) return;
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`${API_URL}/verify-signup-otp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, otp: signupOtp }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "Invalid verification OTP");
      setIsEmailVerified(true);
      setInfo({
        title: "Email Verified",
        message: "Your email is verified. You can now set your password.",
      });
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError("");

    try {
      if (authMode === "signup") {
        if (!isEmailVerified) {
          throw new Error(
            "Please verify your email before creating an account.",
          );
        }
        const res = await fetch(`${API_URL}/signup`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, email, password }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail || "Signup failed");

        setInfo({
          title: "Account Created",
          message:
            "Your account was created successfully. Please log in to continue.",
        });
        setAuthMode("login");
        setPassword("");
        setName("");
        setIsEmailVerified(false);
        setSignupOtpSent(false);
      } else if (authMode === "forgot") {
        if (forgotStep === 1) {
          const res = await fetch(`${API_URL}/forgot-password`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email }),
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.detail || "Failed to send OTP");

          setForgotStep(2);
          setInfo({
            title: "OTP Sent",
            message: "A password reset OTP has been sent to your email.",
          });
        } else {
          if (password !== confirmPassword)
            throw new Error("Passwords do not match");

          const res = await fetch(`${API_URL}/reset-password`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email, otp, new_password: password }),
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.detail || "Reset failed");

          setInfo({
            title: "Password Reset",
            message:
              "Your password has been reset. Please log in with your new password.",
          });
          setAuthMode("login");
          setForgotStep(1);
          setPassword("");
          setConfirmPassword("");
          setOtp("");
        }
      } else {
        const res = await fetch(`${API_URL}/login`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, password }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail || "Authentication failed");

        localStorage.setItem("token", data.access_token);
        if (data.name) localStorage.setItem("userName", data.name);
        router.push("/");
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex h-[100dvh] overflow-y-auto bg-slate-50 lg:bg-white">
      <div className="hidden lg:flex w-1/2 bg-gradient-to-br from-indigo-600 to-indigo-800 items-center justify-center p-12 text-white relative overflow-hidden">
        <div className="absolute top-[-10%] left-[-10%] w-96 h-96 bg-indigo-500 rounded-full mix-blend-multiply filter blur-3xl opacity-50 animate-pulse"></div>
        <div
          className="absolute bottom-[-10%] right-[-10%] w-96 h-96 bg-indigo-400 rounded-full mix-blend-multiply filter blur-3xl opacity-50 animate-pulse"
          style={{ animationDelay: "2s" }}
        ></div>

        <div className="max-w-md relative z-10">
          <div className="w-16 h-16 bg-white/10 rounded-2xl flex items-center justify-center mb-8 backdrop-blur-sm border border-white/20">
            <svg
              className="w-8 h-8 text-white"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z"
              />
            </svg>
          </div>
          <h1 className="text-5xl font-black mb-6 tracking-tight">
            ThreadNotes AI
          </h1>
          <p className="text-xl text-indigo-100 leading-relaxed font-medium">
            Capture, transcribe, and summarize your meetings in real time with
            cutting-edge AI intelligence.
          </p>
        </div>
      </div>

      <div className="w-full lg:w-1/2 flex flex-col items-center justify-center p-6 sm:p-12 min-h-screen lg:min-h-0 bg-white shadow-[0_-20px_40px_-20px_rgba(0,0,0,0.05)] lg:shadow-none rounded-t-[2.5rem] lg:rounded-none mt-4 lg:mt-0">
        <div className="w-full max-w-sm my-auto lg:my-0">
          <div className="lg:hidden mb-10 flex items-center gap-3">
            <div className="w-12 h-12 bg-indigo-600 rounded-2xl flex items-center justify-center shadow-lg shadow-indigo-600/30 shrink-0">
              <svg
                className="w-6 h-6 text-white"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z"
                />
              </svg>
            </div>
            <div>
              <h1 className="text-2xl font-black text-slate-900 tracking-tight leading-none">
                ThreadNotes<span className="text-indigo-600">.</span>
              </h1>
              <p className="text-[10px] text-slate-500 mt-1 font-bold uppercase tracking-widest">
                Intelligence Engine
              </p>
            </div>
          </div>

          <div className="mb-8">
            <h2 className="text-3xl font-black text-slate-900 tracking-tight">
              {authMode === "login" && "Welcome back"}
              {authMode === "signup" && "Create an account"}
              {authMode === "forgot" && "Reset Password"}
            </h2>
            <p className="text-sm text-slate-500 mt-2 font-medium">
              {authMode === "forgot"
                ? forgotStep === 1
                  ? "Enter your email to receive an OTP."
                  : "Enter the OTP and your new password."
                : "Enter your credentials to access your workspace."}
            </p>
          </div>

          {error && (
            <div className="bg-red-50 text-red-600 p-4 rounded-xl text-sm mb-6 border border-red-100 font-medium flex items-center gap-2">
              <svg
                className="w-5 h-5 shrink-0"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                />
              </svg>
              {error}
            </div>
          )}

          <form onSubmit={handleAuth} className="space-y-5">
            {authMode === "signup" && (
              <div>
                <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider mb-2">
                  Full Name
                </label>
                <input
                  type="text"
                  className="w-full px-4 py-3.5 bg-slate-50 border border-slate-200 rounded-xl text-sm font-medium text-slate-900 focus:bg-white focus:ring-4 focus:ring-indigo-500/10 focus:border-indigo-500 outline-none transition-all placeholder:text-slate-400"
                  placeholder="e.g. Shaurya Kumar"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                />
              </div>
            )}

            <div>
              <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider mb-2">
                Work Email
              </label>
              <div className="flex gap-2">
                <input
                  type="email"
                  className="w-full px-4 py-3.5 bg-slate-50 border border-slate-200 rounded-xl text-sm font-medium text-slate-900 focus:bg-white focus:ring-4 focus:ring-indigo-500/10 focus:border-indigo-500 outline-none transition-all placeholder:text-slate-400 disabled:opacity-50 disabled:bg-slate-100"
                  placeholder="shaurya@example.com"
                  value={email}
                  onChange={(e) => {
                    setEmail(e.target.value);
                    if (authMode === "signup") {
                      setIsEmailVerified(false);
                      setSignupOtpSent(false);
                    }
                  }}
                  required
                  disabled={
                    (authMode === "forgot" && forgotStep === 2) ||
                    (authMode === "signup" && isEmailVerified)
                  }
                />

                {authMode === "signup" && !isEmailVerified && (
                  <button
                    type="button"
                    onClick={handleSendSignupOtp}
                    disabled={loading || !email}
                    className="px-5 py-3.5 bg-indigo-50 text-indigo-700 font-bold rounded-xl text-sm border border-indigo-100 hover:bg-indigo-100 hover:border-indigo-200 disabled:opacity-50 whitespace-nowrap transition-all shadow-sm"
                  >
                    {signupOtpSent ? "Resend" : "Verify"}
                  </button>
                )}
              </div>
            </div>

            {authMode === "signup" && signupOtpSent && !isEmailVerified && (
              <div className="animate-in fade-in slide-in-from-top-2 duration-300">
                <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider mb-2">
                  Verification OTP
                </label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    className="w-full px-4 py-3.5 bg-indigo-50/50 border border-indigo-200 rounded-xl text-sm font-bold text-indigo-900 focus:bg-white focus:ring-4 focus:ring-indigo-500/10 focus:border-indigo-500 outline-none transition-all tracking-[0.2em]"
                    placeholder="123456"
                    value={signupOtp}
                    onChange={(e) => setSignupOtp(e.target.value)}
                    required
                    maxLength={6}
                  />
                  <button
                    type="button"
                    onClick={handleVerifySignupOtp}
                    disabled={loading || signupOtp.length < 6}
                    className="px-6 py-3.5 bg-indigo-600 text-white font-bold rounded-xl text-sm hover:bg-indigo-700 disabled:opacity-50 transition-all shadow-md shadow-indigo-600/20"
                  >
                    Confirm
                  </button>
                </div>
              </div>
            )}

            {authMode === "forgot" && forgotStep === 2 && (
              <div className="animate-in fade-in slide-in-from-top-2 duration-300">
                <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider mb-2">
                  6-Digit Reset OTP
                </label>
                <input
                  type="text"
                  className="w-full px-4 py-3.5 bg-indigo-50/50 border border-indigo-200 rounded-xl text-sm font-bold text-indigo-900 focus:bg-white focus:ring-4 focus:ring-indigo-500/10 focus:border-indigo-500 outline-none transition-all tracking-[0.2em]"
                  placeholder="123456"
                  value={otp}
                  onChange={(e) => setOtp(e.target.value)}
                  required
                  maxLength={6}
                />
              </div>
            )}

            {(authMode !== "forgot" ||
              (authMode === "forgot" && forgotStep === 2)) && (
              <div>
                <div className="flex justify-between items-end mb-2">
                  <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider">
                    {authMode === "forgot" ? "New Password" : "Password"}
                  </label>
                  {authMode === "login" && (
                    <button
                      type="button"
                      onClick={() => {
                        setAuthMode("forgot");
                        setForgotStep(1);
                        setError("");
                      }}
                      className="text-xs text-indigo-600 font-bold hover:text-indigo-700 transition-colors"
                    >
                      Forgot password?
                    </button>
                  )}
                </div>
                <input
                  type="password"
                  className={`w-full px-4 py-3.5 border rounded-xl text-sm font-medium focus:ring-4 focus:ring-indigo-500/10 focus:border-indigo-500 outline-none transition-all ${
                    authMode === "signup" && !isEmailVerified
                      ? "bg-slate-100 border-slate-200 text-slate-400 cursor-not-allowed opacity-60"
                      : "bg-slate-50 border-slate-200 text-slate-900 focus:bg-white"
                  }`}
                  placeholder={
                    authMode === "signup" && !isEmailVerified
                      ? "Verify email to unlock"
                      : "••••••••"
                  }
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  disabled={authMode === "signup" && !isEmailVerified}
                />
              </div>
            )}

            {authMode === "forgot" && forgotStep === 2 && (
              <div className="animate-in fade-in slide-in-from-top-2 duration-300">
                <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider mb-2">
                  Confirm New Password
                </label>
                <input
                  type="password"
                  className="w-full px-4 py-3.5 bg-slate-50 border border-slate-200 rounded-xl text-sm font-medium text-slate-900 focus:bg-white focus:ring-4 focus:ring-indigo-500/10 focus:border-indigo-500 outline-none transition-all placeholder:text-slate-400"
                  placeholder="••••••••"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  required
                />
              </div>
            )}

            <button
              type="submit"
              disabled={loading || (authMode === "signup" && !isEmailVerified)}
              className="w-full py-4 mt-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl text-[15px] font-bold shadow-xl shadow-indigo-600/20 transition-all active:scale-[0.98] disabled:bg-slate-300 disabled:shadow-none disabled:text-slate-500 disabled:cursor-not-allowed"
            >
              {loading
                ? "Processing..."
                : authMode === "login"
                  ? "Login to Dashboard"
                  : authMode === "signup"
                    ? "Create My Account"
                    : forgotStep === 1
                      ? "Send Reset OTP"
                      : "Reset Password"}
            </button>
          </form>

          <div className="mt-8 text-center text-sm text-slate-600 font-medium">
            {authMode === "forgot" ? (
              <button
                type="button"
                onClick={() => {
                  setAuthMode("login");
                  setError("");
                }}
                className="text-indigo-600 font-bold hover:text-indigo-700 transition-colors"
              >
                ← Back to Sign In
              </button>
            ) : (
              <div className="flex items-center justify-center gap-1.5">
                <span>
                  {authMode === "login"
                    ? "Don't have an account?"
                    : "Already have an account?"}
                </span>
                <button
                  type="button"
                  onClick={() => {
                    setAuthMode(authMode === "login" ? "signup" : "login");
                    setError("");
                    setIsEmailVerified(false);
                    setSignupOtpSent(false);
                    setSignupOtp("");
                  }}
                  className="text-indigo-600 font-bold hover:text-indigo-700 transition-colors"
                >
                  {authMode === "login" ? "Sign up" : "Sign in"}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      <InfoModal
        open={!!info}
        title={info?.title || ""}
        message={info?.message || ""}
        onClose={() => setInfo(null)}
      />
    </div>
  );
}
