function decodeJwt(token: string): Record<string, unknown> | null {
  try {
    const payload = token.split(".")[1];
    if (!payload) return null;
    const json = decodeURIComponent(
      atob(payload.replace(/-/g, "+").replace(/_/g, "/"))
        .split("")
        .map((c) => "%" + c.charCodeAt(0).toString(16).padStart(2, "0"))
        .join(""),
    );
    return JSON.parse(json);
  } catch {
    return null;
  }
}

export function getValidToken(): string | null {
  if (typeof window === "undefined") return null;
  const token = localStorage.getItem("token");
  if (!token) return null;
  const claims = decodeJwt(token);
  if (!claims) return null;
  if (typeof claims.exp === "number" && claims.exp * 1000 <= Date.now()) {
    return null;
  }
  return token;
}

export function getUserName(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem("userName");
}

export function clearSession(): void {
  if (typeof window === "undefined") return;
  localStorage.removeItem("token");
  localStorage.removeItem("userName");
}
