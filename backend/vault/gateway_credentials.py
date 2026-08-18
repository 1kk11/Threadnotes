"""Resolve provider secrets from the AI Gateway, with .env as the fallback."""
from __future__ import annotations
import logging, os
import httpx

log = logging.getLogger("gateway")

DEFAULT_BASE_URL = "https://ai-gateway-platform-cex4.onrender.com"

GATEWAY_TOKEN    = os.getenv("DXAI_API_KEY", "").strip()
GATEWAY_BASE_URL = (os.getenv("DXAI_BASE_URL") or DEFAULT_BASE_URL).rstrip("/")
GATEWAY_PROVIDERS = [p.strip() for p in
                     os.getenv("GATEWAY_PROVIDERS", "").split(",") if p.strip()]
# Render's free tier cold-starts in ~30s; a 10s timeout reads as "gateway is down".
GATEWAY_TIMEOUT  = float(os.getenv("GATEWAY_TIMEOUT", "60"))

_secrets: dict[str, str] = {}
_loaded = False


def _fetch_provider(client: httpx.Client, provider: str) -> dict[str, str]:
    """Fetch one provider's credentials. Returns {} on any failure."""
    try:
        resp = client.get(f"/gateway/credentials/{provider}")
    except httpx.RequestError as exc:
        log.warning("GATEWAY %-18s unreachable: %s", provider, exc)
        return {}
    if resp.status_code != 200:
        log.warning("GATEWAY %-18s HTTP %s: %s",
                    provider, resp.status_code, resp.text[:200])
        return {}
    try:
        creds = resp.json().get("credentials") or {}
    except ValueError:
        log.warning("GATEWAY %-18s returned a non-JSON body", provider)
        return {}
    log.info("GATEWAY %-18s OK: %s", provider, ", ".join(sorted(creds)) or "(empty)")
    return {str(k): str(v) for k, v in creds.items()}


def load() -> dict[str, str]:
    """Fetch every configured provider once and merge the results."""
    global _loaded
    if _loaded:
        return _secrets
    _loaded = True

    if not GATEWAY_TOKEN:
        log.info("GATEWAY disabled (no DXAI_API_KEY) - using .env values")
        return _secrets
    if not GATEWAY_PROVIDERS:
        log.warning("GATEWAY DXAI_API_KEY is set but GATEWAY_PROVIDERS is empty")
        return _secrets

    log.info("GATEWAY fetching %d provider(s) from %s",
             len(GATEWAY_PROVIDERS), GATEWAY_BASE_URL)
    with httpx.Client(base_url=GATEWAY_BASE_URL,
                      headers={"Authorization": f"Bearer {GATEWAY_TOKEN}"},
                      timeout=GATEWAY_TIMEOUT) as client:
        for provider in GATEWAY_PROVIDERS:
            for name, value in _fetch_provider(client, provider).items():
                if name in _secrets and _secrets[name] != value:
                    log.warning("GATEWAY %r supplied by multiple providers; keeping first", name)
                    continue
                _secrets[name] = value

    log.info("GATEWAY resolved %d secret(s)", len(_secrets))
    return _secrets


def secret(name: str, default: str = "") -> str:
    """Drop-in replacement for os.getenv: gateway first, then .env."""
    load()
    value = _secrets.get(name)
    if not value:
        value = os.getenv(name, default)
    return value if value is not None else default


def source_of(name: str) -> str:
    """Diagnostics only - never returns the value itself."""
    load()
    if _secrets.get(name):
        return "gateway"
    return ".env" if os.getenv(name) else "missing"
