#!/usr/bin/env python3
"""
Warmup script - downloads all required models and validates dependencies.
Run on server startup or manually via CLI.

Usage:
    python warmup.py                    # Run all checks
    python warmup.py --check-only       # Check without downloading
    python warmup.py --models gliner2   # Download specific model only
"""

import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path
from typing import Dict, List, Optional, Callable


# ============================================================================
# CONFIGURATION
# ============================================================================

MODELS_CONFIG = {
    "gliner2": {
        "model_id": "fastino/gliner2-multi-v1",
        "description": "GLiNER2 entity extraction model (205M params)",
        "size_mb": "~400MB",
        "optional": False,
        "type": "huggingface",
    },
    "spacy_fr": {
        "model_id": "fr_core_news_sm",
        "description": "French NLP model for spaCy",
        "size_mb": "~45MB",
        "optional": False,
        "type": "spacy",
    },
    "spacy_en": {
        "model_id": "en_core_web_sm",
        "description": "English NLP model for spaCy",
        "size_mb": "~40MB",
        "optional": False,
        "type": "spacy",
    },
}


# ============================================================================
# LOGGING UTILITIES
# ============================================================================


def log_json(message: str, level: str = "info", **extra):
    """Log with JSON formatting for server parsing"""
    output = {"timestamp": time.time(), "level": level, "message": message}
    output.update(extra)
    print(json.dumps(output), flush=True)


def log_plain(message: str):
    """Log plain text for CLI usage"""
    print(message, flush=True)


# ============================================================================
# MODEL CACHE CHECKING
# ============================================================================


def is_gliner2_cached(model_id: str) -> bool:
    """Check if GLiNER2 model exists in HuggingFace cache"""
    try:
        from huggingface_hub import try_to_load_from_cache

        # Try to load model config to check if cached
        cached_path = try_to_load_from_cache(repo_id=model_id, filename="config.json")
        return cached_path is not None and os.path.exists(cached_path)
    except Exception:
        return False


def is_spacy_cached(model_id: str) -> bool:
    """Check if spaCy model is installed"""
    try:
        import spacy

        try:
            spacy.load(model_id)
            return True
        except OSError:
            return False
    except ImportError:
        return False


def check_model_cached(model_key: str) -> bool:
    """Check if a specific model is cached"""
    config = MODELS_CONFIG.get(model_key)
    if not config:
        return False

    if config["type"] == "huggingface":
        return is_gliner2_cached(config["model_id"])
    elif config["type"] == "spacy":
        return is_spacy_cached(config["model_id"])
    return False


# ============================================================================
# MODEL DOWNLOADING
# ============================================================================


class TQDMRedirector:
    """Custom progress bar that outputs JSON for server consumption"""

    def __init__(self, model_id: str, description: str = ""):
        self.model_id = model_id
        self.description = description
        self.n = 0
        self.total = 0

    def update(self, n: int = 1):
        """Update progress"""
        self.n += n
        if self.total > 0:
            pct = (self.n / self.total) * 100
            log_json(
                f"Downloading {self.model_id}: {pct:.1f}%",
                level="progress",
                model=self.model_id,
                progress=pct,
                downloaded=self.n,
                total=self.total,
            )

    def set_postfix(self, **kwargs):
        pass

    def close(self):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *args):
        pass


def download_gliner2_model(model_id: str, description: str) -> bool:
    """Download GLiNER2 model with progress reporting"""
    try:
        from huggingface_hub import snapshot_download
        import huggingface_hub

        log_json(f"Starting download: {description}", model=model_id, phase="start")
        log_plain(f"📥 Downloading {model_id}...")

        # Custom callback for progress
        def progress_callback(files, downloaded, total, **kwargs):
            if total > 0:
                pct = (downloaded / total) * 100
                log_json(
                    f"Downloading: {pct:.1f}%",
                    level="progress",
                    model=model_id,
                    progress=pct,
                    downloaded=downloaded,
                    total=total,
                )

        # Download with resume support
        snapshot_download(
            model_id,
            local_files_only=False,
            resume_download=True,
            tqdm_class=None,  # We'll handle progress ourselves
        )

        log_json(f"Download complete: {model_id}", model=model_id, phase="complete")
        log_plain(f"✅ Downloaded: {model_id}")
        return True

    except ImportError as e:
        log_json(f"huggingface_hub not installed: {e}", level="error", model=model_id)
        log_plain(f"❌ Missing dependency: huggingface_hub")
        return False
    except Exception as e:
        log_json(f"Failed to download {model_id}: {e}", level="error", model=model_id)
        log_plain(f"❌ Failed: {model_id} - {e}")
        return False


def download_spacy_model(model_id: str, description: str) -> bool:
    """Download spaCy model via CLI"""
    try:
        # Check if spacy is installed
        try:
            import spacy
        except ImportError:
            log_json(
                f"spaCy not installed, skipping {model_id}",
                level="warning",
                model=model_id,
            )
            log_plain(f"⏭️  spaCy not installed, skipping {model_id}")
            return False

        log_json(f"Downloading spaCy model: {model_id}", model=model_id, phase="start")
        log_plain(f"📥 Downloading spaCy model: {model_id}...")

        # Download using subprocess
        result = subprocess.run(
            [sys.executable, "-m", "spacy", "download", model_id],
            capture_output=True,
            text=True,
            check=True,
        )

        log_json(
            f"Downloaded spaCy model: {model_id}", model=model_id, phase="complete"
        )
        log_plain(f"✅ Downloaded spaCy model: {model_id}")
        return True

    except subprocess.CalledProcessError as e:
        log_json(
            f"Failed to download spaCy model {model_id}: {e}",
            level="warning",
            model=model_id,
        )
        log_plain(f"⚠️  spaCy model download failed: {model_id}")
        return False
    except Exception as e:
        log_json(f"Error downloading {model_id}: {e}", level="error", model=model_id)
        log_plain(f"❌ Error: {model_id} - {e}")
        return False


def download_model(model_key: str, force: bool = False) -> bool:
    """Download a specific model by key"""
    config = MODELS_CONFIG.get(model_key)
    if not config:
        log_json(f"Unknown model: {model_key}", level="error")
        return False

    # Check if already cached (unless force)
    if not force and check_model_cached(model_key):
        log_json(
            f"Model {model_key} already cached, skipping",
            model=config["model_id"],
            phase="cached",
        )
        log_plain(f"✅ {model_key} already cached")
        return True

    # Download based on type
    if config["type"] == "huggingface":
        return download_gliner2_model(config["model_id"], config["description"])
    elif config["type"] == "spacy":
        return download_spacy_model(config["model_id"], config["description"])

    return False


# ============================================================================
# DEPENDENCY CHECKS
# ============================================================================


def check_mineru() -> bool:
    """Verify mineru CLI is available"""
    try:
        result = subprocess.run(
            ["mineru", "--version"], capture_output=True, text=True, check=True
        )
        log_json("MinerU CLI available", tool="mineru", available=True)
        log_plain("✅ MinerU CLI available")
        return True
    except (subprocess.CalledProcessError, FileNotFoundError):
        log_json(
            "MinerU CLI not found", tool="mineru", available=False, level="warning"
        )
        log_plain("⚠️  MinerU CLI not found (pip install mineru)")
        return False


def check_python_dependencies() -> Dict[str, bool]:
    """Check if required Python packages are installed"""
    dependencies = {
        "gliner2": False,
        "huggingface_hub": False,
        "spacy": False,
        "markitdown": False,
        "pypdf": False,
    }

    for pkg in dependencies.keys():
        try:
            __import__(pkg.replace("_", ""))
            dependencies[pkg] = True
            log_json(f"Package {pkg} installed", package=pkg, installed=True)
        except ImportError:
            log_json(
                f"Package {pkg} not installed",
                package=pkg,
                installed=False,
                level="warning",
            )

    return dependencies


# ============================================================================
# MAIN ROUTINES
# ============================================================================


def run_warmup(
    models: Optional[List[str]] = None, check_only: bool = False, force: bool = False
) -> Dict[str, bool]:
    """
    Run the warmup routine

    Args:
        models: List of model keys to process (None = all)
        check_only: If True, only check without downloading
        force: If True, re-download even if cached

    Returns:
        Dict with results for each check
    """
    results = {"dependencies": {}, "models": {}, "tools": {}}

    log_json("Starting warmup script", phase="start")
    log_plain("🚀 Starting warmup script...")
    log_plain("")

    # Check dependencies
    log_plain("📦 Checking Python dependencies...")
    results["dependencies"] = check_python_dependencies()
    log_plain("")

    # Determine which models to process
    if models is None:
        models = list(MODELS_CONFIG.keys())

    # Check/download models
    log_plain("📥 Checking/Downloading models...")
    for model_key in models:
        config = MODELS_CONFIG[model_key]

        if check_only:
            # Just check if cached
            cached = check_model_cached(model_key)
            results["models"][model_key] = cached
            status = "✅ cached" if cached else "❌ not cached"
            log_plain(f"  {model_key}: {status}")
        else:
            # Download if needed
            success = download_model(model_key, force=force)
            results["models"][model_key] = success

    log_plain("")

    # Check tools
    log_plain("🔧 Checking external tools...")
    results["tools"]["mineru"] = check_mineru()
    log_plain("")

    # Summary
    critical_ok = results["models"].get("gliner2", False)
    total_models = len(results["models"])
    success_models = sum(1 for v in results["models"].values() if v)

    summary_msg = f"Warmup complete: {success_models}/{total_models} models ready"
    log_json(
        summary_msg,
        phase="complete",
        critical_ready=critical_ok,
        models_ready=success_models,
        total_models=total_models,
    )

    log_plain(f"📊 {summary_msg}")
    if critical_ok:
        log_plain("✅ Critical components ready - GLiNER2 is operational")
    else:
        log_plain("❌ Critical component missing - GLiNER2 will fail")

    return results


def get_status() -> Dict:
    """Get current status without downloading anything"""
    status = {"models": {}, "dependencies": {}, "tools": {}}

    # Check model cache status
    for key in MODELS_CONFIG.keys():
        status["models"][key] = {
            "cached": check_model_cached(key),
            "config": MODELS_CONFIG[key],
        }

    # Check dependencies
    for pkg in ["gliner2", "huggingface_hub", "spacy", "markitdown", "pypdf"]:
        try:
            __import__(pkg.replace("_", ""))
            status["dependencies"][pkg] = True
        except ImportError:
            status["dependencies"][pkg] = False

    # Check mineru
    try:
        subprocess.run(["mineru", "--version"], capture_output=True, check=True)
        status["tools"]["mineru"] = True
    except:
        status["tools"]["mineru"] = False

    # Overall ready status
    status["ready"] = status["models"]["gliner2"]["cached"]

    return status


# ============================================================================
# CLI ENTRY POINT
# ============================================================================


def main():
    parser = argparse.ArgumentParser(
        description="Warmup script - download models and validate dependencies"
    )
    parser.add_argument(
        "--check-only",
        action="store_true",
        help="Only check status without downloading",
    )
    parser.add_argument(
        "--models",
        nargs="+",
        choices=list(MODELS_CONFIG.keys()),
        help="Specific models to download (default: all)",
    )
    parser.add_argument(
        "--force", action="store_true", help="Force re-download even if cached"
    )
    parser.add_argument(
        "--status", action="store_true", help="Output JSON status and exit"
    )
    parser.add_argument(
        "--json-output", action="store_true", help="Output only JSON (no plain text)"
    )

    args = parser.parse_args()

    # Handle status request
    if args.status:
        status = get_status()
        print(json.dumps(status, indent=2))
        sys.exit(0 if status["ready"] else 1)

    # Run warmup
    results = run_warmup(
        models=args.models, check_only=args.check_only, force=args.force
    )

    # Exit code based on critical component
    critical_ok = results["models"].get("gliner2", False)
    sys.exit(0 if critical_ok else 1)


if __name__ == "__main__":
    main()
