#!/usr/bin/env python3
"""
Convert & Scan Pipeline — orchestrates document conversion and PII scanning.

This script chains smart_converter.py (conversion to Markdown) and
presidio-gliner.py (PII scanning) for batch processing of multiple documents.

Usage:
    python3 convert_and_scan_pipeline.py <file1> [file2 ...] -o <output_dir> [options]

Options:
    -o, --output DIR       Output directory for all generated files
    --engine ENGINE        Conversion engine: auto|markitdown|mineru (default: auto)
    --mode MODE           MinerU mode: pipeline|hybrid|vlm (default: pipeline)
    --lang CODE           OCR language code for MinerU (default: auto)

Progress Format:
    PROGRESS:CONVERT:percentage:current:total    (Phase 1: Converting documents)
    PROGRESS:SCAN:percentage:current:total       (Phase 2: Scanning for PII)

Persistent Output Structure:
    {output_dir}/
    ├── document1.md
    ├── document2.md
    ├── mapping_default.json
    └── .piecemaker/anonymization-state.json

The per-document sensitive maps are transient scanner payloads. They are
created in a private temporary directory, merged into mapping_default.json,
then removed automatically.

Exit Codes:
    0: Success (at least one file fully processed)
    1: No file could be fully converted and scanned
"""

import sys
import os
import time
import argparse
import subprocess
import json
import hashlib
import tempfile
import unicodedata
import re
from pathlib import Path
from typing import List, Optional, Tuple, Dict, Set


def print_progress(phase: str, current: int, total: int) -> None:
    """Print standardized progress message.

    Args:
        phase: 'CONVERT' or 'SCAN'
        current: Current file index (1-based)
        total: Total number of files
    """
    percentage = int((current / total) * 100)
    print(f"PROGRESS:{phase}:{percentage}:{current}:{total}", flush=True)


def start_scanner_worker() -> Optional[subprocess.Popen]:
    """Start the long-lived scanner worker subprocess.

    The worker loads GLiNER2 + spaCy models once and stays alive to process
    multiple files via a JSON-line stdin/stdout protocol.  Launch this at the
    start of the pipeline so model loading overlaps with Phase 1 (conversion).

    Returns:
        Worker subprocess handle, or None if the launch failed.
    """
    script_dir = Path(__file__).parent
    worker_script = script_dir / "presidio-gliner" / "scanner_worker.py"

    if not worker_script.exists():
        print(f"⚠️  scanner_worker.py not found at {worker_script}", file=sys.stderr)
        return None

    try:
        proc = subprocess.Popen(
            [sys.executable, str(worker_script)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,  # Line buffered
        )
        print(f"🔄 Scanner worker starting in background (PID {proc.pid})...")
        return proc
    except Exception as e:
        print(f"⚠️  Failed to start scanner worker: {e}", file=sys.stderr)
        return None


def wait_for_worker_ready(proc: Optional[subprocess.Popen], timeout: int = 300) -> bool:
    """Wait for the scanner worker to print READY on stdout.

    While waiting, streams stderr output (model loading progress) in real-time.

    Args:
        proc: Worker subprocess
        timeout: Max seconds to wait

    Returns:
        True if worker is ready, False on failure/timeout.
    """
    if proc is None:
        return False

    import re
    import select
    import threading

    _chunk_re = re.compile(r"^PROGRESS:CHUNKS:\d+:\d+:\d+")

    # Stream stderr in a background thread so we see model loading progress. The
    # thread lives for the whole process, so it also carries the worker's per-chunk
    # progress during a scan. A CHUNKS line is re-emitted CLEAN on stdout: the Node
    # parent only reads stdout and requires a leading "PROGRESS:", so the "[worker]"
    # prefix otherwise hid it and the admin bar stayed frozen on a long file. Only
    # lines matching the strict pattern reach stdout — never arbitrary worker stderr,
    # which can carry document text under PIECEMAKER_DEBUG_ENTITIES.
    def _stream_stderr():
        try:
            for line in proc.stderr:
                stripped = line.strip()
                if _chunk_re.match(stripped):
                    print(stripped, flush=True)
                else:
                    print(f"  [worker] {line}", end="", flush=True)
        except (ValueError, OSError):
            pass  # Pipe closed

    stderr_thread = threading.Thread(target=_stream_stderr, daemon=True)
    stderr_thread.start()

    start = time.time()
    while time.time() - start < timeout:
        if proc.poll() is not None:
            print(f"⚠️  Scanner worker exited prematurely (exit {proc.returncode})", file=sys.stderr)
            return False

        # Non-blocking read from stdout
        try:
            os.set_blocking(proc.stdout.fileno(), False)
            line = proc.stdout.readline()
            os.set_blocking(proc.stdout.fileno(), True)
        except (IOError, OSError):
            line = ""

        if line.strip() == "READY":
            print("✅ Scanner worker ready (models loaded)")
            return True

        if not line:
            time.sleep(0.1)

    # Timeout
    print("⚠️  Scanner worker timed out waiting for READY", file=sys.stderr)
    proc.kill()
    return False


def scan_file_via_worker(proc: subprocess.Popen, md_file: str, output_dir: str) -> bool:
    """Send a scan command to the worker and wait for the result.

    Args:
        proc: Worker subprocess
        md_file: Path to markdown file
        output_dir: Directory for output JSON

    Returns:
        True if scan succeeded, False otherwise.
    """
    cmd = json.dumps({"cmd": "scan", "md_file": md_file, "output_dir": output_dir})
    try:
        proc.stdin.write(cmd + "\n")
        proc.stdin.flush()
    except (BrokenPipeError, OSError) as e:
        print(f"⚠️  Failed to send command to worker: {e}", file=sys.stderr)
        return False

    # Read the JSON-line response (blocking)
    try:
        response_line = proc.stdout.readline()
    except (IOError, OSError) as e:
        print(f"⚠️  Failed to read response from worker: {e}", file=sys.stderr)
        return False

    if not response_line:
        print("⚠️  Worker closed stdout unexpectedly", file=sys.stderr)
        return False

    try:
        response = json.loads(response_line.strip())
    except json.JSONDecodeError as e:
        print(f"⚠️  Invalid JSON from worker: {response_line.strip()}", file=sys.stderr)
        return False

    if response.get("status") == "ok":
        return True
    else:
        print(f"⚠️  Worker scan error: {response.get('message', 'unknown')}", file=sys.stderr)
        return False


def stop_scanner_worker(proc: Optional[subprocess.Popen]) -> None:
    """Gracefully stop the scanner worker."""
    if proc is None or proc.poll() is not None:
        return

    try:
        proc.stdin.write(json.dumps({"cmd": "quit"}) + "\n")
        proc.stdin.flush()
        proc.wait(timeout=10)
    except Exception:
        proc.kill()


def convert_file(
    input_file: str,
    output_dir: str,
    engine: Optional[str] = None,
    mode: Optional[str] = None,
    lang: Optional[str] = None,
) -> Tuple[bool, Optional[str]]:
    """Run smart_converter.py subprocess to convert a file to Markdown with real-time output streaming.

    Args:
        input_file: Path to input document
        output_dir: Directory for output markdown
        engine: Conversion engine (auto/markitdown/mineru)
        mode: MinerU mode (pipeline/hybrid/vlm)
        lang: OCR language code

    Returns:
        (success, md_path): Tuple of success flag and path to generated .md file
    """
    script_dir = Path(__file__).parent
    converter_script = script_dir / "smart_converter.py"

    if not converter_script.exists():
        print(f"❌ smart_converter.py not found at {converter_script}", file=sys.stderr)
        return False, None

    # Build command
    cmd = [sys.executable, str(converter_script), input_file, "-o", output_dir]

    if engine:
        cmd.extend(["--engine", engine])
    if mode:
        cmd.extend(["--mode", mode])
    if lang:
        cmd.extend(["--lang", lang])

    try:
        # Run converter with real-time output streaming
        process = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,  # Line buffered
        )

        # Stream output in real-time
        os.set_blocking(process.stdout.fileno(), False)
        os.set_blocking(process.stderr.fileno(), False)

        return_code = None
        while return_code is None:
            # Check if process has finished
            return_code = process.poll()

            # Read available output without blocking
            try:
                # Read stdout
                while True:
                    line = process.stdout.readline()
                    if not line:
                        break
                    print(line, end="", flush=True)

                # Read stderr
                while True:
                    line = process.stderr.readline()
                    if not line:
                        break
                    print(line, end="", file=sys.stderr, flush=True)

            except (IOError, OSError):
                pass

            # Small delay to prevent CPU spinning
            if return_code is None:
                time.sleep(0.01)

        # Ensure we read any remaining output
        try:
            remaining_stdout, remaining_stderr = process.communicate(timeout=1)
            if remaining_stdout:
                print(remaining_stdout, end="", flush=True)
            if remaining_stderr:
                print(remaining_stderr, end="", file=sys.stderr, flush=True)
        except subprocess.TimeoutExpired:
            pass

        if return_code != 0:
            print(f"⚠️  Conversion failed with exit code {return_code}", file=sys.stderr)
            return False, None

        # Determine generated .md file path
        input_stem = Path(input_file).stem
        md_path = Path(output_dir) / f"{input_stem}.md"

        if not md_path.exists():
            print(f"⚠️  Expected output file not found: {md_path}", file=sys.stderr)
            return False, None

        return True, str(md_path)

    except subprocess.TimeoutExpired:
        print(f"❌ Conversion timeout (>10 minutes): {input_file}", file=sys.stderr)
        return False, None
    except Exception as e:
        print(f"❌ Conversion error: {e}", file=sys.stderr)
        return False, None


def scan_file(md_file: str, output_dir: str) -> bool:
    """Run presidio-gliner.py subprocess to scan Markdown for PII with real-time output streaming.

    Args:
        md_file: Path to markdown file
        output_dir: Directory for output JSON

    Returns:
        success: True if scan succeeded
    """
    script_dir = Path(__file__).parent
    scanner_script = script_dir / "presidio-gliner" / "presidio-gliner.py"

    if not scanner_script.exists():
        print(f"❌ presidio-gliner.py not found at {scanner_script}", file=sys.stderr)
        return False

    # Build command
    cmd = [sys.executable, str(scanner_script), md_file, "-o", output_dir]

    try:
        # Run scanner with real-time output streaming
        process = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,  # Line buffered
        )

        # Stream output in real-time
        os.set_blocking(process.stdout.fileno(), False)
        os.set_blocking(process.stderr.fileno(), False)

        return_code = None
        while return_code is None:
            # Check if process has finished
            return_code = process.poll()

            # Read available output without blocking
            try:
                # Read stdout
                while True:
                    line = process.stdout.readline()
                    if not line:
                        break
                    print(line, end="", flush=True)

                # Read stderr
                while True:
                    line = process.stderr.readline()
                    if not line:
                        break
                    print(line, end="", file=sys.stderr, flush=True)

            except (IOError, OSError):
                pass

            # Small delay to prevent CPU spinning
            if return_code is None:
                time.sleep(0.01)

        # Ensure we read any remaining output
        try:
            remaining_stdout, remaining_stderr = process.communicate(timeout=1)
            if remaining_stdout:
                print(remaining_stdout, end="", flush=True)
            if remaining_stderr:
                print(remaining_stderr, end="", file=sys.stderr, flush=True)
        except subprocess.TimeoutExpired:
            pass

        if return_code != 0:
            print(f"⚠️  Scan failed with exit code {return_code}", file=sys.stderr)
            return False

        # Verify JSON output was created
        md_stem = Path(md_file).stem
        json_path = Path(output_dir) / f"{md_stem}_sensitive_map.json"

        if not json_path.exists():
            print(f"⚠️  Expected JSON output not found: {json_path}", file=sys.stderr)
            return False

        return True

    except subprocess.TimeoutExpired:
        print(f"❌ Scan timeout (>10 minutes): {md_file}", file=sys.stderr)
        return False
    except Exception as e:
        print(f"❌ Scan error: {e}", file=sys.stderr)
        return False


def load_existing_mapping(mapping_path: Path) -> Optional[Dict]:
    """Load the case/document mapping file if it exists.

    This is the SAME file that the server uses (server.cjs line 2146),
    ensuring single source of truth for mappings.

    Args:
        mapping_path: Full path to mapping_default.json (or an explicit target)

    Returns:
        Existing mapping data or None if file doesn't exist
    """
    if not mapping_path.exists():
        print("ℹ️  No existing mapping found, will create new one")
        return None

    try:
        with open(mapping_path, 'r', encoding='utf-8') as f:
            data = json.load(f)
        print(f"✅ Loaded existing mapping: {len(data.get('mapping', {}))} entries")
        return data
    except Exception as e:
        print(f"⚠️  Error loading existing mapping: {e}", file=sys.stderr)
        return None


def read_individual_mappings(json_files: List[str]) -> Dict:
    """Read and consolidate multiple individual _sensitive_map.json files.

    Args:
        json_files: List of paths to individual sensitive map files

    Returns:
        Consolidated entities dictionary
    """
    consolidated = {
        "entities": {},
        "summary": {
            "total_entities_found": 0,
            "entity_types": set(),
            "source_files": []
        }
    }

    for json_file in json_files:
        if not os.path.exists(json_file):
            print(f"⚠️  Sensitive map not found: {json_file}", file=sys.stderr)
            continue

        with open(json_file, 'r', encoding='utf-8') as f:
            data = json.load(f)

        # Merge entities by type
        for entity_type, entities in data.get("entities", {}).items():
            if entity_type not in consolidated["entities"]:
                consolidated["entities"][entity_type] = []
            consolidated["entities"][entity_type].extend(entities)

        # Update summary
        consolidated["summary"]["source_files"].append(data.get("source_file", json_file))
        consolidated["summary"]["entity_types"].update(data.get("summary", {}).get("entity_types", []))

    # Convert set to list for JSON serialization
    consolidated["summary"]["entity_types"] = sorted(list(consolidated["summary"]["entity_types"]))
    consolidated["summary"]["total_entities_found"] = sum(
        len(entities) for entities in consolidated["entities"].values()
    )

    return consolidated


def normalize_name(text: str) -> str:
    """Normalize a name for comparison purposes.

    Removes diacritics, converts to lowercase, removes honorifics/titles,
    and normalizes whitespace.

    Args:
        text: Name to normalize

    Returns:
        Normalized name string (for comparison only)
    """
    # Remove diacritics (é → e, à → a, etc.)
    nfkd_form = unicodedata.normalize('NFKD', text)
    text_no_accents = ''.join([c for c in nfkd_form if not unicodedata.combining(c)])

    # Convert to lowercase
    text_lower = text_no_accents.lower()

    # Remove honorifics/titles (French and English)
    # Matches: Mr., Mrs., Ms., Dr., M., Mme., Maître, etc.
    # Important: "m." and "me." must have the dot to avoid matching "martin" or "marie"
    honorifics_pattern = r'\b(mr\.?|mrs\.?|ms\.?|dr\.?|prof\.?|m\.|mme\.?|mlle\.?|maitre)\s*'
    text_no_titles = re.sub(honorifics_pattern, '', text_lower, flags=re.IGNORECASE)

    # Normalize whitespace (multiple spaces/newlines → single space)
    text_normalized = ' '.join(text_no_titles.split())

    return text_normalized.strip()


def are_names_similar(name1: str, norm1: str, name2: str, norm2: str) -> bool:
    """Check if two names refer to the same person.

    Uses multiple matching strategies:
    - Exact match after normalization
    - Substring match (one contains the other, min 3 chars)
    - Token-based match (all tokens of shorter name appear in longer)

    Args:
        name1: First name (original)
        norm1: First name (normalized)
        name2: Second name (original)
        norm2: Second name (normalized)

    Returns:
        True if names are similar enough to be considered the same person
    """
    # Exact match after normalization
    if norm1 == norm2:
        return True

    # Substring match (one contains the other, min 3 chars)
    min_length = min(len(norm1), len(norm2))
    if min_length >= 3:
        if norm1 in norm2 or norm2 in norm1:
            return True

    # Token-based match: all tokens of shorter name appear in longer
    tokens1 = set(norm1.split())
    tokens2 = set(norm2.split())

    if not tokens1 or not tokens2:
        return False

    # Check if all tokens of shorter set appear in longer set
    shorter_tokens = tokens1 if len(tokens1) <= len(tokens2) else tokens2
    longer_tokens = tokens2 if len(tokens1) <= len(tokens2) else tokens1

    if shorter_tokens and shorter_tokens.issubset(longer_tokens):
        return True

    return False


def consolidate_duplicate_entities(entities: List[Dict]) -> List[Dict]:
    """Consolidate duplicate entities into single entries with variants.

    Groups entities by similarity (exact duplicates and variations like
    "Mr. Gilly" vs "Bernard Gilly"), choosing the longest variant as
    canonical and storing all unique variants.

    Args:
        entities: List of entity dictionaries with 'text', 'score', etc.

    Returns:
        Deduplicated entity list with consolidated variants
    """
    if not entities:
        return []

    # Pre-compute normalized forms
    entities_with_norm = [
        {**entity, '_normalized': normalize_name(entity['text'])}
        for entity in entities
    ]

    # Group similar entities
    groups = []
    used_indices = set()

    for i, entity1 in enumerate(entities_with_norm):
        if i in used_indices:
            continue

        # Start a new group with this entity
        group = [entity1]
        used_indices.add(i)

        # Find all similar entities
        for j, entity2 in enumerate(entities_with_norm):
            if j in used_indices:
                continue

            if are_names_similar(
                entity1['text'], entity1['_normalized'],
                entity2['text'], entity2['_normalized']
            ):
                group.append(entity2)
                used_indices.add(j)

        groups.append(group)

    # Consolidate each group
    consolidated = []

    for group in groups:
        # Choose longest variant as canonical text
        canonical = max(group, key=lambda e: len(e['text']))

        # Get highest score
        best_score = max(e.get('score', 0.0) for e in group)

        # Collect all unique variants (remove duplicates while preserving order)
        all_variants = [e['text'] for e in group]
        unique_variants = list(dict.fromkeys(all_variants))  # Preserves order, removes duplicates

        # Create consolidated entry
        consolidated_entity = {
            'text': canonical['text'],
            'score': best_score,
            'recognizer': canonical.get('recognizer', 'unknown'),
            'variants': unique_variants
        }

        consolidated.append(consolidated_entity)

    return consolidated


def is_known_city_or_country(text: str) -> bool:
    """Check if text matches known city or country names.

    Args:
        text: Text to check

    Returns:
        True if text is a known city or country name
    """
    known_locations = {
        'paris', 'lyon', 'marseille', 'toulouse', 'nice', 'nantes',
        'bordeaux', 'lille', 'rennes', 'strasbourg', 'montpellier',
        'reims', 'le havre', 'saint-étienne', 'toulon', 'grenoble',
        'dijon', 'angers', 'nîmes', 'villeurbanne', 'clermont-ferrand',
        'aix-en-provence', 'brest', 'limoges', 'tours', 'amiens',
        'perpignan', 'metz', 'besançon', 'orléans', 'rouen',
        'bruxelles', 'genève', 'lausanne', 'luxembourg',
        'france', 'belgique', 'suisse', 'luxembourg'
    }
    return text.strip().lower() in known_locations


def is_city_or_country_only(text: str) -> bool:
    """Check if text is only a city or country name (no street number).

    Args:
        text: Address text to check

    Returns:
        True if text appears to be only a city/country (no street address)
    """
    # No digits = likely just city/country
    if not re.search(r'\d', text):
        # Check against known cities/countries
        return is_known_city_or_country(text)
    return False


def parse_address(address_text: str) -> Dict:
    """Parse address into street, city, postal, country components.

    Supports French and basic international patterns (Belgium, Switzerland, Luxembourg).

    Args:
        address_text: Full address string

    Returns:
        Dictionary with parsing results:
        {
            "success": bool,              # True if parsing succeeded
            "is_city_only": bool,         # True if only city/country (no street)
            "street_part": Optional[str], # Street to anonymize
            "postal_code": Optional[str],
            "city": Optional[str],
            "country": Optional[str],
            "anonymization_strategy": "none" | "partial" | "full"
        }
    """
    # Check if it's ONLY a city/country name (no street number)
    if is_city_or_country_only(address_text):
        # Extract city name (simple approach for known cities)
        city_name = address_text.strip()
        return {
            "success": True,
            "is_city_only": True,
            "street_part": None,
            "postal_code": None,
            "city": city_name,
            "country": None,
            "anonymization_strategy": "none"  # Keep visible
        }

    # French address pattern
    # Pattern: [Number] [Type] [Name], [Postal] [City], [Country]
    # Examples:
    #   "123 Rue de Rivoli, 75001 Paris, France"
    #   "11 rue Heinrich, Lyon"
    #   "20 Bis rue de la Princesse"
    french_pattern = re.compile(
        r'''
        # Street number (required): 123, 20 Bis, 11 ter
        (?P<street_number>\d+(?:\s*(?:[Bb]is|[Tt]er|[Qq]uater|[AaBb]))?)
        \s+

        # Street type: rue, avenue, boulevard, etc.
        (?P<street_type>
            (?:[Rr]ue|[Aa]venue|[Aa]v|[Bb]oulevard|[Bb]d|[Pp]lace|[Pp]l|
               [Cc]hemin|[Aa]llée|[Ii]mpasse|[Pp]assage|[Qq]uai|[Cc]ours|
               [Rr]oute|[Vv]oie|[Ss]quare)
        )
        \s+

        # Street name: everything until postal/city marker (greedy until comma or end)
        (?P<street_name>
            (?:[Dd]e\s+|[Ll]a\s+|[Ll]'\s*|[Dd]u\s+|[Dd]es\s+)?  # Articles
            [A-ZÀ-Ÿa-zà-ÿ0-9\s'-]+  # Name (greedy - captures until comma or end)
        )
        (?=,|\s*$|\s+\d{5})  # Lookahead: stop at comma, end of string, or postal code

        # Optional: Postal code + City OR just City
        (?:
            ,?\s*
            (?:
                # Option 1: Postal code + City
                (?P<postal_code>\d{5})
                \s+
                (?P<city>[A-ZÀ-Ÿ][A-ZÀ-Ÿa-zà-ÿ-]+(?:\s+[A-ZÀ-Ÿa-zà-ÿ-]+)*)
                |
                # Option 2: Just City (no postal code)
                (?P<city_only>[A-ZÀ-Ÿ][A-ZÀ-Ÿa-zà-ÿ-]+(?:\s+[A-ZÀ-Ÿa-zà-ÿ-]+)*)
            )
        )?

        # Optional: Country
        (?:
            ,?\s*
            (?P<country>France|Belgique|Suisse|Luxembourg)
        )?
        ''',
        re.VERBOSE
    )

    # Belgian pattern: "Rue de la Loi 123, 1000 Bruxelles, Belgique"
    belgian_pattern = re.compile(
        r'''
        ^  # Must start at beginning (prevents matching after French number)
        # Street type + name first (Belgian style)
        (?P<street_type>
            (?:[Rr]ue|[Aa]venue|[Bb]oulevard|[Pp]lace|[Cc]haussée)
        )
        \s+
        (?P<street_name>
            (?:[Dd]e\s+|[Ll]a\s+|[Dd]u\s+|[Dd]es\s+)?
            [A-ZÀ-Ÿa-zà-ÿ0-9\s'-]+  # Greedy
        )
        \s+
        # Street number at the end
        (?P<street_number>\d+(?:\s*(?:[Bb]is|[A-Za-z])?)?)
        (?=,|\s*$)  # Lookahead: stop at comma or end

        # Optional: Postal code + City
        (?:
            ,?\s*
            (?P<postal_code>\d{4})
            \s+
            (?P<city>[A-ZÀ-Ÿ][A-ZÀ-Ÿa-zà-ÿ-]+(?:\s+[A-ZÀ-Ÿa-zà-ÿ-]+)*)
        )?

        # Optional: Country
        (?:
            ,?\s*
            (?P<country>Belgique|Belgium)
        )?
        ''',
        re.VERBOSE
    )

    # Swiss pattern: "Rue du Rhône 50, 1204 Genève, Suisse"
    swiss_pattern = re.compile(
        r'''
        ^  # Must start at beginning
        # Street type + name first
        (?P<street_type>
            (?:[Rr]ue|[Aa]venue|[Cc]hemin|[Pp]lace)
        )
        \s+
        (?P<street_name>
            (?:[Dd]e\s+|[Ll]a\s+|[Dd]u\s+|[Dd]es\s+)?
            [A-ZÀ-Ÿa-zà-ÿ0-9\s'-]+  # Greedy
        )
        \s+
        # Street number
        (?P<street_number>\d+(?:\s*[A-Za-z])?)
        (?=,|\s*$)  # Lookahead: stop at comma or end

        # Optional: Postal code + City
        (?:
            ,?\s*
            (?P<postal_code>\d{4})
            \s+
            (?P<city>[A-ZÀ-Ÿ][A-ZÀ-Ÿa-zà-ÿ-]+(?:\s+[A-ZÀ-Ÿa-zà-ÿ-]+)*)
        )?

        # Optional: Country
        (?:
            ,?\s*
            (?P<country>Suisse|Switzerland)
        )?
        ''',
        re.VERBOSE
    )

    # Luxembourg pattern: "Avenue de la Liberté 10, L-1931 Luxembourg"
    luxembourg_pattern = re.compile(
        r'''
        ^  # Must start at beginning
        # Street type + name first
        (?P<street_type>
            (?:[Aa]venue|[Rr]ue|[Bb]oulevard|[Pp]lace)
        )
        \s+
        (?P<street_name>
            (?:[Dd]e\s+|[Ll]a\s+|[Dd]u\s+|[Dd]es\s+)?
            [A-ZÀ-Ÿa-zà-ÿ0-9\s'-]+  # Greedy
        )
        \s+
        # Street number
        (?P<street_number>\d+(?:\s*[A-Za-z])?)
        (?=,|\s*$)  # Lookahead: stop at comma or end

        # Optional: Postal code + City
        (?:
            ,?\s*
            (?P<postal_code>L-\d{4})
            \s+
            (?P<city>[A-ZÀ-Ÿ][A-ZÀ-Ÿa-zà-ÿ-]+(?:\s+[A-ZÀ-Ÿa-zà-ÿ-]+)*)
        )?

        # Optional: Country
        (?:
            ,?\s*
            (?P<country>Luxembourg)
        )?
        ''',
        re.VERBOSE
    )

    # Smart pattern ordering based on distinguishing features
    # This prevents Belgian pattern from matching Swiss/Luxembourg addresses
    pattern_configs = []

    # Check for distinguishing features to prioritize patterns
    if 'L-' in address_text and re.search(r'L-\d{4}', address_text):
        # Luxembourg postal code detected
        pattern_configs = [
            (luxembourg_pattern, 'luxembourg'),
            (belgian_pattern, 'belgian'),
            (swiss_pattern, 'swiss'),
            (french_pattern, 'french')
        ]
    elif 'Suisse' in address_text or 'Switzerland' in address_text:
        # Swiss country detected
        pattern_configs = [
            (swiss_pattern, 'swiss'),
            (belgian_pattern, 'belgian'),
            (luxembourg_pattern, 'luxembourg'),
            (french_pattern, 'french')
        ]
    elif 'Belgique' in address_text or 'Belgium' in address_text:
        # Belgian country detected
        pattern_configs = [
            (belgian_pattern, 'belgian'),
            (swiss_pattern, 'swiss'),
            (luxembourg_pattern, 'luxembourg'),
            (french_pattern, 'french')
        ]
    else:
        # Default order: Belgian/Swiss/Luxembourg first (number at end), then French (number first)
        pattern_configs = [
            (belgian_pattern, 'belgian'),
            (swiss_pattern, 'swiss'),
            (luxembourg_pattern, 'luxembourg'),
            (french_pattern, 'french')
        ]

    for pattern, pattern_type in pattern_configs:
        match = pattern.search(address_text)
        if match and match.group('street_number'):
            # SUCCESS: Partial anonymization
            groups = match.groupdict()

            # Build street part (what gets anonymized)
            # Belgian/Swiss/Luxembourg: street_type + street_name + number
            # French: number + street_type + street_name
            if pattern_type in ('belgian', 'swiss', 'luxembourg'):
                # Number at the end
                street_components = []
                if groups.get('street_type'):
                    street_components.append(groups['street_type'])
                if groups.get('street_name'):
                    street_components.append(groups['street_name'].strip())
                if groups.get('street_number'):
                    street_components.append(groups['street_number'])
            else:
                # French: Number at the beginning
                street_components = []
                if groups.get('street_number'):
                    street_components.append(groups['street_number'])
                if groups.get('street_type'):
                    street_components.append(groups['street_type'])
                if groups.get('street_name'):
                    street_components.append(groups['street_name'].strip())

            street_part = ' '.join(street_components)

            # Handle French pattern's city_only capture group
            city = groups.get('city') or groups.get('city_only')

            return {
                "success": True,
                "is_city_only": False,
                "street_part": street_part,
                "postal_code": groups.get('postal_code'),
                "city": city,
                "country": groups.get('country'),
                "anonymization_strategy": "partial"
            }

    # FAILURE: Full anonymization (safest - prevents accidental exposure)
    return {
        "success": False,
        "is_city_only": False,
        "street_part": address_text,
        "postal_code": None,
        "city": None,
        "country": None,
        "anonymization_strategy": "full"
    }


def convert_to_anonymization_format(consolidated_entities: Dict) -> Dict:
    """Convert consolidated entities to anonymization mapping format.

    Expected output format matches what showMappingValidation() expects:
    {
        mapping: { "original_text": "CODE_01", ... },
        reverse_mapping: { "CODE_01": ["original_text"], ... },
        extracted_data: {
            personnes_physiques: { "CODE_01": {...}, ... },
            societes: { "CODE_02": {...}, ... },
            adresses: { "CODE_03": {...}, ... },
            siren: { "CODE_04": {...}, ... }
        }
    }
    """
    mapping = {}
    reverse_mapping = {}
    # Texts deliberately left readable (city-only locations, the non-street part
    # of a partially anonymised address). They go to `ignored` so that the admin
    # rebuild (originals-pipeline.cjs) does not code them back from the raw scan.
    left_visible: List[str] = []
    extracted_data = {
        "personnes_physiques": {},
        "societes": {},
        "adresses": {},
        "siren": {},
        "autres": {}  # For emails, phones, etc.
    }

    # Entity type to category mapping
    # ORGANIZATION_* variants (e.g. ORGANIZATION_SA, ORGANIZATION_GMBH) are handled
    # by the startswith fallback below — no need to enumerate every legal form here.
    category_map = {
        "PERSON": "personnes_physiques",
        "ORGANIZATION": "societes",
        "LOCATION": "adresses",
        "EMAIL": "autres",
        "PHONE": "autres",
        "CREDIT_CARD": "autres",
        "IBAN": "autres",
        "IP_ADDRESS": "autres",
        "URL": "autres",
    }

    # Code counters per category
    counters = {
        "personnes_physiques": 1,
        "societes": 1,
        "adresses": 1,
        "siren": 1,
        "autres": 1
    }

    # Track seen entities to avoid duplicates across files
    seen_entities = {}  # text -> code

    # Consolidate PERSON entities to remove duplicates
    for entity_type in consolidated_entities.get("entities", {}).keys():
        if entity_type == "PERSON":
            consolidated_entities["entities"][entity_type] = consolidate_duplicate_entities(
                consolidated_entities["entities"][entity_type]
            )

    for entity_type, entities in consolidated_entities.get("entities", {}).items():
        # Scalable fallback: ORGANIZATION_SA, ORGANIZATION_GMBH, etc. → societes
        category = category_map.get(entity_type) or (
            "societes" if entity_type.startswith("ORGANIZATION_") else "autres"
        )

        for entity in entities:
            text = entity["text"]
            text_lower = text.lower()

            # Skip if already processed
            if text_lower in seen_entities:
                mapping[text] = seen_entities[text_lower]
                continue

            # Generate code based on category
            if category == "personnes_physiques":
                code = f"PERSONNE_PHYSIQUE_{counters[category]:02d}"
            elif category == "societes":
                if entity_type.startswith("ORGANIZATION_"):
                    form = entity_type.split("_", 1)[1]   # e.g. SA, GMBH, LLC
                    code = f"SOCIETE_{form}_{counters[category]:02d}"
                else:
                    code = f"PERSONNE_MORALE_{counters[category]:02d}"
            elif category == "adresses":
                code = f"ADRESSE_{counters[category]:02d}"
            elif category == "siren":
                code = f"SIREN_{counters[category]:02d}"
            else:
                code = f"{entity_type}_{counters[category]:02d}"

            counters[category] += 1

            # Get variants from entity (pre-consolidated for PERSON entities)
            variants = entity.get("variants", [text])

            # Store mappings for all variants (no lowercase duplicates)
            for variant in variants:
                mapping[variant] = code

            reverse_mapping[code] = [text]  # Principal value (array for consistency)
            seen_entities[text_lower] = code

            # Store in extracted_data
            extracted_data[category][code] = {
                "original": text,
                "code": code,
                "variants": variants,
                "score": entity.get("score", 1.0),
                "recognizer": entity.get("recognizer", "unknown")
            }

            # Parse addresses for partial anonymization
            if category == "adresses":
                parsed_result = parse_address(text)
                extracted_data[category][code]["parsed"] = parsed_result

                # If city-only, don't add to mapping (no anonymization needed)
                if parsed_result.get("is_city_only"):
                    # Remove from mapping - city names stay visible
                    for variant in variants:
                        mapping.pop(variant, None)
                    left_visible.extend(variants)
                    reverse_mapping.pop(code, None)
                    del extracted_data[category][code]
                    counters[category] -= 1  # Revert counter
                elif parsed_result.get("anonymization_strategy") == "partial":
                    # Update mapping to only anonymize street part
                    # Remove full address from mapping
                    for variant in variants:
                        mapping.pop(variant, None)
                    # Add only street part to mapping
                    street_part = parsed_result.get("street_part")
                    if street_part:
                        mapping[street_part] = code
                        # Update variants to only include street part
                        extracted_data[category][code]["variants"] = [street_part]
                        reverse_mapping[code] = [street_part]
                        left_visible.extend(v for v in variants if v != street_part)

    return {
        "mapping": mapping,
        "reverse_mapping": reverse_mapping,
        "extracted_data": extracted_data,
        **({"ignored": list(dict.fromkeys(left_visible))} if left_visible else {}),
    }


def merge_with_existing_mapping(new_mapping: Dict, existing_mapping: Optional[Dict]) -> Dict:
    """Merge new mapping with existing mapping, avoiding duplicates.

    Args:
        new_mapping: Newly generated mapping from current batch
        existing_mapping: Existing mapping data (or None)

    Returns:
        Merged mapping data
    """
    if not existing_mapping:
        return new_mapping

    # `ignored` is written by the admin editor (originals-pipeline.cjs): entities
    # the lawyer removed by hand are false positives and must not come back.
    ignored = [str(text).strip() for text in existing_mapping.get('ignored', []) if str(text).strip()]
    ignored_lower = {text.lower() for text in ignored}
    left_visible: List[str] = []

    merged_mapping = {**existing_mapping.get('mapping', {})}
    merged_reverse = {**existing_mapping.get('reverse_mapping', {})}
    merged_extracted = {
        "personnes_physiques": {**existing_mapping.get('extracted_data', {}).get('personnes_physiques', {})},
        "societes": {**existing_mapping.get('extracted_data', {}).get('societes', {})},
        "adresses": {**existing_mapping.get('extracted_data', {}).get('adresses', {})},
        "siren": {**existing_mapping.get('extracted_data', {}).get('siren', {})},
        "autres": {**existing_mapping.get('extracted_data', {}).get('autres', {})}
    }

    # Track seen entities to avoid duplicates
    seen_entities_lower = {k.lower(): v for k, v in merged_mapping.items()}

    # Find highest existing code numbers per category
    code_counters = {
        "personnes_physiques": 1,
        "societes": 1,
        "adresses": 1,
        "siren": 1,
        "autres": 1
    }

    for code in merged_reverse.keys():
        if "PERSONNE_PHYSIQUE_" in code or code.startswith("DIRIGEANT_"):
            num = int(code.split("_")[-1])
            code_counters["personnes_physiques"] = max(code_counters["personnes_physiques"], num + 1)
        elif code.startswith("SOCIETE_"):
            num = int(code.split("_")[-1])
            code_counters["societes"] = max(code_counters["societes"], num + 1)
        elif "PERSONNE_MORALE_" in code:
            num = int(code.split("_")[-1])
            code_counters["societes"] = max(code_counters["societes"], num + 1)
        elif code.startswith("ADRESSE_"):
            num = int(code.split("_")[-1])
            code_counters["adresses"] = max(code_counters["adresses"], num + 1)
        elif code.startswith("SIREN_"):
            num = int(code.split("_")[-1])
            code_counters["siren"] = max(code_counters["siren"], num + 1)

    # Merge new entries
    for text, code in new_mapping.get('mapping', {}).items():
        text_lower = text.lower()

        # Skip if already exists (use existing code)
        if text_lower in seen_entities_lower:
            continue

        # Skip entities the lawyer discarded from the mapping
        if text_lower in ignored_lower:
            continue

        # Determine category
        category = None
        for cat_key in merged_extracted.keys():
            if code in new_mapping.get('extracted_data', {}).get(cat_key, {}):
                category = cat_key
                break

        if not category:
            category = "autres"

        # Generate new code with incremented counter
        if category == "personnes_physiques":
            new_code = f"PERSONNE_PHYSIQUE_{code_counters[category]:02d}"
        elif category == "societes":
            # Preserve legal form suffix from original code (e.g. SOCIETE_SA_01 → SOCIETE_SA_02)
            parts = code.split("_")
            if len(parts) == 3 and parts[0] == "SOCIETE":
                form = parts[1]  # e.g. SA, GMBH, LLC
                new_code = f"SOCIETE_{form}_{code_counters[category]:02d}"
            else:
                new_code = f"PERSONNE_MORALE_{code_counters[category]:02d}"
        elif category == "adresses":
            new_code = f"ADRESSE_{code_counters[category]:02d}"
        elif category == "siren":
            new_code = f"SIREN_{code_counters[category]:02d}"
        else:
            # Extract entity type from new code
            entity_type = code.split("_")[0] if "_" in code else "AUTRE"
            new_code = f"{entity_type}_{code_counters[category]:02d}"

        code_counters[category] += 1

        # Get variants from existing entry
        old_entry = new_mapping.get('extracted_data', {}).get(category, {}).get(code, {})
        variants = old_entry.get("variants", [text])

        # Add all variants to merged structures (no lowercase duplicates)
        for variant in variants:
            merged_mapping[variant] = new_code

        seen_entities_lower[text_lower] = new_code

        # Update reverse mapping
        original = new_mapping.get('reverse_mapping', {}).get(code, [text])[0]
        merged_reverse[new_code] = [original]

        # Update extracted_data
        merged_extracted[category][new_code] = {
            "original": original,
            "code": new_code,
            "variants": variants,
            "score": old_entry.get("score", 1.0),
            "recognizer": old_entry.get("recognizer", "unknown")
        }

        # Parse addresses for partial anonymization (same logic as convert_to_anonymization_format)
        if category == "adresses":
            parsed_result = parse_address(original)
            merged_extracted[category][new_code]["parsed"] = parsed_result

            # If city-only, don't add to mapping (no anonymization needed)
            if parsed_result.get("is_city_only"):
                # Remove from merged structures
                for variant in variants:
                    merged_mapping.pop(variant, None)
                left_visible.extend(variants)
                merged_reverse.pop(new_code, None)
                del merged_extracted[category][new_code]
                # Don't increment counter since we're removing this entry
            elif parsed_result.get("anonymization_strategy") == "partial":
                # Update mapping to only anonymize street part
                # Remove full address from mapping
                for variant in variants:
                    merged_mapping.pop(variant, None)
                # Add only street part to mapping
                street_part = parsed_result.get("street_part")
                if street_part:
                    merged_mapping[street_part] = new_code
                    # Update variants to only include street part
                    merged_extracted[category][new_code]["variants"] = [street_part]
                    merged_reverse[new_code] = [street_part]
                    left_visible.extend(v for v in variants if v != street_part)

    merged_ignored = list(dict.fromkeys(
        ignored + [str(text).strip() for text in new_mapping.get('ignored', []) if str(text).strip()] + left_visible
    ))
    return {
        "mapping": merged_mapping,
        "reverse_mapping": merged_reverse,
        "extracted_data": merged_extracted,
        "informations_dossier": existing_mapping.get("informations_dossier", {}),
        **({"ignored": merged_ignored} if merged_ignored else {}),
    }


def save_mapping(mapping_path: Path, mapping_data: Dict) -> Path:
    """Save the merged mapping to the case/document mapping file.

    Uses the SAME file as server.cjs (line 2146), ensuring the validated
    mapping can be read by GET /api/anonymize/mapping/:documentId.

    Args:
        mapping_path: Full path to the mapping file to write
        mapping_data: Complete mapping data structure

    Returns:
        Path to saved file
    """
    payload = {
        **mapping_data,
        "mapping": dict(sorted(
            mapping_data.get("mapping", {}).items(),
            key=lambda item: (-len(item[0]), item[0].casefold()),
        )),
    }
    mapping_path.parent.mkdir(parents=True, exist_ok=True)
    temporary = mapping_path.with_name(f"{mapping_path.name}.piecemaker-{os.getpid()}.tmp")
    with open(temporary, 'w', encoding='utf-8') as f:
        json.dump(payload, f, indent=2, ensure_ascii=False)
        f.write("\n")
    os.chmod(temporary, 0o600)
    os.replace(temporary, mapping_path)

    return mapping_path


def load_anonymization_state(state_path: Path) -> Dict:
    """Load the non-sensitive per-file processing manifest."""
    try:
        with open(state_path, "r", encoding="utf-8") as state_file:
            raw = json.load(state_file)
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        raw = {}
    source_files = raw.get("files", {}) if isinstance(raw, dict) else {}
    files = {}
    if isinstance(source_files, dict):
        for key, entry in source_files.items():
            if not isinstance(entry, dict):
                continue
            if "size" in entry and "mtimeMs" in entry:
                legacy = {
                    "size": entry["size"],
                    "mtimeMs": entry["mtimeMs"],
                    **({"updatedAt": entry["scannedAt"]} if entry.get("scannedAt") else {}),
                }
                files[key] = {"converted": legacy, "scanned": legacy}
            else:
                files[key] = {
                    phase: value for phase, value in entry.items()
                    if phase in ("converted", "scanned") and isinstance(value, dict)
                }
    return {"version": 1, "files": files}


def anonymization_state_key(source_file: str, case_root: str) -> Optional[str]:
    """Hash source identity so the manifest itself contains no filename."""
    source = Path(source_file).resolve()
    try:
        identity = source.relative_to(Path(case_root).resolve()).as_posix()
    except ValueError:
        # Standalone CLI use can place outputs outside the input tree. Hashing
        # the absolute identity preserves --skip-existing without persisting it.
        identity = f"absolute:{source.as_posix()}"
    # Match the Node side (anonymization-state.cjs): an accented filename must
    # hash identically whether it reaches us as NFC or NFD, or the document-index
    # join drops it. Normalise to NFC on both sides, independent of the OS.
    identity = unicodedata.normalize("NFC", identity)
    return hashlib.sha256(identity.encode("utf-8")).hexdigest()


def source_fingerprint(source_file: str) -> Dict:
    stat = os.stat(source_file)
    return {"size": stat.st_size, "mtimeMs": stat.st_mtime_ns // 1_000_000}


def source_state_entry(state: Dict, source_file: str, case_root: str) -> Optional[Dict]:
    key = anonymization_state_key(source_file, case_root)
    return state.get("files", {}).get(key) if key else None


def source_is_processed(state: Dict, source_file: str, case_root: str, phase: str) -> bool:
    entry = source_state_entry(state, source_file, case_root)
    if not isinstance(entry, dict):
        return False
    phase_entry = entry.get(phase)
    # Backward compatibility with the first, flat state format.
    if not isinstance(phase_entry, dict):
        phase_entry = entry if "size" in entry and "mtimeMs" in entry else None
    if not phase_entry:
        return False
    fingerprint = source_fingerprint(source_file)
    return phase_entry.get("size") == fingerprint["size"] and phase_entry.get("mtimeMs") == fingerprint["mtimeMs"]


def source_is_converted(state: Dict, source_file: str, case_root: str) -> bool:
    return source_is_processed(state, source_file, case_root, "converted")


def source_is_anonymized(state: Dict, source_file: str, case_root: str) -> bool:
    return source_is_processed(state, source_file, case_root, "scanned")


def update_processing_state(state_path: Path, case_root: str, source_files: List[str], phase: str) -> None:
    """Atomically add successful conversions/scans without paths or entities."""
    if not source_files:
        return
    state = load_anonymization_state(state_path)
    updated_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    for source_file in source_files:
        key = anonymization_state_key(source_file, case_root)
        if not key:
            continue
        fingerprint = {**source_fingerprint(source_file), "updatedAt": updated_at}
        entry = state["files"].get(key, {})
        entry[phase] = fingerprint
        if phase == "scanned":
            entry["converted"] = fingerprint
        state["files"][key] = entry
    state_path.parent.mkdir(parents=True, exist_ok=True)
    temporary = state_path.with_name(f"{state_path.name}.piecemaker-{os.getpid()}.tmp")
    with open(temporary, "w", encoding="utf-8") as state_file:
        json.dump(state, state_file, indent=2, ensure_ascii=False)
        state_file.write("\n")
    os.chmod(temporary, 0o600)
    os.replace(temporary, state_path)


def update_anonymization_state(state_path: Path, case_root: str, source_files: List[str]) -> None:
    update_processing_state(state_path, case_root, source_files, "scanned")


# ---------------------------------------------------------------------------
# Per-document index — chronology / nature / entity attribution
# ---------------------------------------------------------------------------
# The individual sensitive maps are the only place that knows which entities and
# which document_meta belong to a given file; they are deleted right after the
# merge, so the attribution has to be captured here. The persistent index keys
# each document by the SAME hash the scan-state manifest uses (a filename can
# carry a client's name), and stores only entity CODES plus the non-PII
# nature/date/juridiction. It is never a source of clear PII on disk.

def load_document_index(index_path: Path) -> Dict:
    try:
        with open(index_path, "r", encoding="utf-8") as handle:
            raw = json.load(handle)
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        raw = {}
    documents = raw.get("documents", {}) if isinstance(raw, dict) else {}
    return {"version": 1, "documents": documents if isinstance(documents, dict) else {}}


def _mapping_code_lookup(final_mapping_data: Dict) -> Dict[str, str]:
    """Case-insensitive {variant -> code}, longest variant first so a short name
    that is a substring of a stored variant does not shadow the longer code."""
    lookup: Dict[str, str] = {}
    items = sorted(
        final_mapping_data.get("mapping", {}).items(),
        key=lambda kv: len(kv[0]),
        reverse=True,
    )
    for variant, code in items:
        key = str(variant).strip().lower()
        if key:
            lookup.setdefault(key, code)
    return lookup


# Legal-form / generic tokens shared by company names and court names alike —
# excluded from the sensitive set so a real "Tribunal de commerce" is not scrubbed
# because some mapped company is a "... SA".
_FREE_TEXT_STOPWORDS = frozenset({
    "sarl", "sasu", "société", "societe", "compagnie", "groupe", "group",
    "holding", "association", "syndicat", "france",
})


def _sensitive_tokens(final_mapping_data: Dict) -> Set[str]:
    """Distinctive tokens (>=4 chars) of every mapped entity.

    Used to scrub free-text metadata (the juridiction): GLiNER's extract_json
    "juridiction" head routinely mis-captures a litigant's name as the court, and
    that name must never reach the non-PII index. Any free-text field sharing a
    token with a mapped entity is dropped rather than stored in clear.
    """
    tokens: Set[str] = set()
    for variant in final_mapping_data.get("mapping", {}):
        for token in re.findall(r"[a-zà-ÿ0-9]{4,}", str(variant).lower()):
            if token not in _FREE_TEXT_STOPWORDS:
                tokens.add(token)
    return tokens


def _scrub_free_text(value, sensitive_tokens: Set[str]) -> Optional[str]:
    """Return the text, or None if it carries any mapped-entity token (PII)."""
    if not value:
        return None
    text = str(value).strip()
    if not text:
        return None
    found = set(re.findall(r"[a-zà-ÿ0-9]{4,}", text.lower()))
    # Noise-only extraction ("SA", "n/a", "RCS") carries no court name — drop it.
    if not found:
        return None
    if found & sensitive_tokens:
        return None
    return text


def _codes_for_entities(entities: Dict, code_lookup: Dict[str, str]) -> List[str]:
    codes: Set[str] = set()
    for entity_list in (entities or {}).values():
        if not isinstance(entity_list, list):
            continue
        for entity in entity_list:
            text = entity.get("text") if isinstance(entity, dict) else None
            if not text:
                continue
            code = code_lookup.get(str(text).strip().lower())
            if code:
                codes.add(code)
    return sorted(codes)


def write_document_index(
    index_path: Path,
    case_root: str,
    scan_records: List[Dict],
    final_mapping_data: Dict,
) -> int:
    """Merge this run's scanned documents into <case>/.piecemaker/document-index.json.

    Returns the number of document entries written/updated.
    """
    if not scan_records:
        return 0
    code_lookup = _mapping_code_lookup(final_mapping_data)
    sensitive_tokens = _sensitive_tokens(final_mapping_data)
    index = load_document_index(index_path)
    updated_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    written = 0
    for record in scan_records:
        source = record.get("source")
        if not source:
            continue
        # The payload fields are captured in-memory before the transient scan
        # workspace is cleaned; fall back to re-reading json_path for standalone
        # callers (and tests) that pass the file directly.
        if "entities" in record or "document_meta" in record:
            entities = record.get("entities") or {}
            meta = record.get("document_meta") or {}
        else:
            try:
                with open(record.get("json_path"), "r", encoding="utf-8") as handle:
                    data = json.load(handle)
            except (FileNotFoundError, json.JSONDecodeError, OSError, TypeError):
                continue
            entities = data.get("entities") or {}
            meta = data.get("document_meta") or {}
        key = anonymization_state_key(source, case_root)
        if not key:
            continue
        index["documents"][key] = {
            "nature": meta.get("nature"),
            "nature_confidence": meta.get("nature_confidence"),
            "doc_date": meta.get("doc_date"),
            "doc_date_iso": meta.get("doc_date_iso"),
            "juridiction": _scrub_free_text(meta.get("juridiction"), sensitive_tokens),
            "codes": _codes_for_entities(entities, code_lookup),
            "updatedAt": updated_at,
        }
        written += 1
    if not written:
        return 0
    index_path.parent.mkdir(parents=True, exist_ok=True)
    temporary = index_path.with_name(f"{index_path.name}.piecemaker-{os.getpid()}.tmp")
    with open(temporary, "w", encoding="utf-8") as handle:
        json.dump(index, handle, indent=2, ensure_ascii=False)
        handle.write("\n")
    os.chmod(temporary, 0o600)
    os.replace(temporary, index_path)
    return written


def main():
    """Main pipeline orchestration."""
    parser = argparse.ArgumentParser(
        description="Convert documents to Markdown and scan for sensitive data",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )

    parser.add_argument(
        "files", nargs="+", help="Input files to process (PDF, DOCX, images, etc.)"
    )
    parser.add_argument(
        "-o",
        "--output",
        required=True,
        help="Output directory for Markdown files and mapping_default.json",
    )
    parser.add_argument(
        "--engine",
        choices=["auto", "markitdown", "mineru"],
        default="auto",
        help="Conversion engine (default: auto)",
    )
    parser.add_argument(
        "--mode",
        choices=["pipeline", "hybrid", "vlm"],
        help="MinerU processing mode (only used if engine=mineru)",
    )
    parser.add_argument("--lang", help="OCR language code (only used if engine=mineru)")
    parser.add_argument(
        "--document-id",
        default="default",
        help=argparse.SUPPRESS,
    )
    parser.add_argument(
        "--mapping-dir",
        default=None,
        help="Directory for mapping_default.json (default: same as --output)",
    )
    parser.add_argument(
        "--mapping-file",
        default=None,
        help="Exact mapping file to read and rewrite (overrides --mapping-dir)",
    )
    parser.add_argument(
        "--state-file",
        default=None,
        help="Technical scan-state manifest (default: <output>/.piecemaker/anonymization-state.json)",
    )
    parser.add_argument(
        "--case-root",
        default=None,
        help=(
            "Legal-case root used to key the scan-state manifest. Defaults to "
            "--output for standalone CLI use; the admin pipeline passes the case "
            "directory so state keys match even when --output is a subfolder."
        ),
    )
    parser.add_argument(
        "--skip-existing",
        action="store_true",
        help="Reuse existing Markdown and scans whose source fingerprint is unchanged",
    )
    args = parser.parse_args()

    # Validate input files
    input_files = []
    for f in args.files:
        if not os.path.exists(f):
            print(f"⚠️  File not found: {f}", file=sys.stderr)
        else:
            input_files.append(f)

    if not input_files:
        print("❌ No valid input files provided", file=sys.stderr)
        return 1

    # Ensure output directory exists
    os.makedirs(args.output, exist_ok=True)
    mapping_target = (
        Path(args.mapping_file)
        if args.mapping_file
        else Path(args.mapping_dir or args.output) / "mapping_default.json"
    )
    state_target = Path(args.state_file) if args.state_file else Path(args.output) / ".piecemaker" / "anonymization-state.json"
    # Base pour les clés du manifeste : le dossier juridique, découplé de --output
    # (désormais un sous-dossier). Les sources vivent sous le dossier, pas sous la
    # sortie ; sans ce découplage leur clé ne correspondrait plus à celle du Node.
    state_case_root = args.case_root or args.output
    anonymization_state = load_anonymization_state(state_target)

    print(f"🚀 Starting Convert & Scan Pipeline")
    print(f"   Files: {len(input_files)}")
    print(f"   Output: {args.output}")
    print(f"   Engine: {args.engine}")
    if args.mode:
        print(f"   Mode: {args.mode}")
    if args.lang:
        print(f"   Language: {args.lang}")
    print()

    # What is left to do, decided before anything runs: the scanner worker loads
    # ~400MB of GLiNER2 + spaCy weights, so it must only start when at least one
    # file actually needs a PII scan.
    def markdown_path(input_file: str) -> Path:
        return Path(args.output) / f"{Path(input_file).stem}.md"

    scan_needed = any(
        not (args.skip_existing and source_is_anonymized(anonymization_state, f, state_case_root))
        for f in input_files
    )

    # Start scanner worker immediately so model loading overlaps with Phase 1.
    if scan_needed:
        scanner_worker = start_scanner_worker()
    else:
        scanner_worker = None
        print("✅ Every PII scan is already up to date — GLiNER not started")
    print()

    # Phase 1: Convert all files to Markdown
    print("=" * 70)
    print("PHASE 1: CONVERTING DOCUMENTS TO MARKDOWN")
    print("=" * 70)
    print()

    md_files = []
    md_sources = {}
    converted_sources = []
    convert_success_count = 0

    for i, input_file in enumerate(input_files, start=1):
        print_progress("CONVERT", i, len(input_files))
        existing_md = markdown_path(input_file)

        state_entry = source_state_entry(anonymization_state, input_file, state_case_root)
        reusable_markdown = existing_md.exists() and (
            state_entry is None
            or source_is_converted(anonymization_state, input_file, state_case_root)
        )
        if args.skip_existing and reusable_markdown:
            print(f"📄 [{i}/{len(input_files)}] Already converted, reusing: {existing_md.name}")
            md_files.append(str(existing_md))
            md_sources[str(existing_md)] = input_file
            converted_sources.append(input_file)
            convert_success_count += 1
            print()
            continue

        print(f"📄 [{i}/{len(input_files)}] Converting: {Path(input_file).name}")

        success, md_path = convert_file(
            input_file, args.output, engine=args.engine, mode=args.mode, lang=args.lang
        )

        if success and md_path:
            print(f"   ✅ Markdown generated: {Path(md_path).name}")
            md_files.append(md_path)
            md_sources[md_path] = input_file
            converted_sources.append(input_file)
            convert_success_count += 1
        else:
            print(f"   ❌ Conversion failed, skipping...")

        print()

    if not md_files:
        print("❌ All conversions failed — pipeline aborted", file=sys.stderr)
        return 1

    print(
        f"✅ Phase 1 complete: {convert_success_count}/{len(input_files)} files converted"
    )
    update_processing_state(state_target, state_case_root, converted_sources, "converted")
    print()

    # Phase 2: Scan all Markdown files for PII
    print("=" * 70)
    print("PHASE 2: SCANNING FOR SENSITIVE DATA")
    print("=" * 70)
    print()

    pending_scans = [
        md_file
        for md_file in md_files
        if not (
            args.skip_existing
            and source_is_anonymized(anonymization_state, md_sources[md_file], state_case_root)
        )
    ]
    skipped_scans = len(md_files) - len(pending_scans)
    if skipped_scans:
        print(f"⏭️  {skipped_scans} file(s) already scanned, left untouched")

    # Wait for the scanner worker to finish loading models.
    worker_ready = wait_for_worker_ready(scanner_worker) if pending_scans else False

    if pending_scans and not worker_ready:
        print("⚠️  Scanner worker not available, falling back to subprocess-per-file", file=sys.stderr)
    print()

    scan_success_count = 0
    successful_scan_sources = []
    json_files = []
    # Keeps each scanned document's payload tied to its source so the per-document
    # index can attribute entity codes and metadata after the merge (the payloads
    # are deleted with the workspace below).
    scan_records: List[Dict] = []
    # Raw detections contain PII. They live only in a private OS temporary
    # directory and disappear after consolidation, including on exceptions.
    scan_workspace = tempfile.TemporaryDirectory(prefix="piecemaker-scans-")
    scan_output_dir = scan_workspace.name

    for i, md_file in enumerate(pending_scans, start=1):
        print_progress("SCAN", i, len(pending_scans))
        print(f"🔍 [{i}/{len(pending_scans)}] Scanning: {Path(md_file).name}")

        if worker_ready:
            success = scan_file_via_worker(scanner_worker, md_file, scan_output_dir)
        else:
            # Fallback: subprocess per file (old behavior)
            success = scan_file(md_file, scan_output_dir)

        if success:
            json_path = Path(scan_output_dir) / f"{Path(md_file).stem}_sensitive_map.json"
            if not json_path.exists():
                print(f"   ⚠️  Scanner reported success without a payload", file=sys.stderr)
                continue
            print(f"   ✅ Sensitive entities collected")
            scan_success_count += 1
            successful_scan_sources.append(md_sources[md_file])
            json_files.append(str(json_path))
            scan_records.append({"source": md_sources[md_file], "json_path": str(json_path)})
        else:
            print(f"   ⚠️  Scan failed, markdown preserved")

        print()

    # Shut down worker
    stop_scanner_worker(scanner_worker)

    print(f"✅ Phase 2 complete: {scan_success_count}/{len(pending_scans)} files scanned")
    print()

    # Phase 3: Merge the transient detections into the one persistent mapping.
    print("=" * 70)
    print("PHASE 3: UPDATING THE CASE MAPPING")
    print("=" * 70)
    print()

    if not json_files:
        scan_workspace.cleanup()
        if not pending_scans:
            print("✅ No new scan to merge; mapping and processing state are already up to date")
            return 0
        print("⚠️  No successful PII scan to merge", file=sys.stderr)
        print(f"✅ Pipeline complete: {convert_success_count}/{len(input_files)} files converted")
        print()
        return 1

    print(f"📊 Step 1: Reading {len(json_files)} individual mapping(s)...")

    # Read individual mappings
    consolidated = read_individual_mappings(json_files)
    # Capture each document's entities + metadata in memory before the transient
    # scan workspace is deleted, so the per-document index can be built once the
    # final mapping (and therefore the codes) is known further down.
    for record in scan_records:
        try:
            with open(record["json_path"], "r", encoding="utf-8") as handle:
                payload = json.load(handle)
            record["entities"] = payload.get("entities") or {}
            record["document_meta"] = payload.get("document_meta") or {}
        except (FileNotFoundError, json.JSONDecodeError, OSError, KeyError):
            record["entities"] = {}
            record["document_meta"] = {}
    scan_workspace.cleanup()

    # Convert to anonymization format
    print("🔄 Step 2: Converting to anonymization format...")
    new_mapping_data = convert_to_anonymization_format(consolidated)

    # Load existing mapping (if exists)
    print("📂 Step 3: Loading existing mapping...")
    existing_mapping = load_existing_mapping(mapping_target)

    # Merge with existing mapping
    print("🔗 Step 4: Merging with existing mapping...")
    final_mapping_data = merge_with_existing_mapping(new_mapping_data, existing_mapping)

    # Save mapping (same file server uses)
    print("💾 Step 5: Saving mapping...")
    mapping_path = save_mapping(mapping_target, final_mapping_data)
    update_anonymization_state(state_target, state_case_root, successful_scan_sources)

    # Per-document index (chronology / nature / entity codes) lives next to the
    # scan-state manifest, keyed by the same hash so a filename is never stored.
    index_path = state_target.parent / "document-index.json"
    try:
        indexed = write_document_index(index_path, state_case_root, scan_records, final_mapping_data)
        if indexed:
            print(f"🗂️  Document index updated: {indexed} document(s)")
    except Exception as exc:  # noqa: BLE001
        print(f"⚠️  Document index update skipped: {exc}", file=sys.stderr)

    print(f"✅ Mapping saved to: {mapping_path}")
    print(f"   • Total entities: {len(final_mapping_data['mapping'])} variants")
    print(f"   • Unique codes: {len(final_mapping_data['reverse_mapping'])}")
    print(f"🧹 Step 6: Removed {len(json_files)} transient sensitive payload(s)")
    print()

    # Summary
    print("=" * 70)
    print("PIPELINE COMPLETE")
    print("=" * 70)
    print(f"📊 Results:")
    print(f"   • Converted: {convert_success_count}/{len(input_files)} files")
    print(f"   • Scanned: {scan_success_count}/{len(pending_scans)} files")
    print(f"   • Entities mapped: {len(final_mapping_data['mapping'])} variants")
    print(f"   • Unique entities: {len(final_mapping_data['reverse_mapping'])} codes")
    print(f"📂 Output directory: {args.output}")
    print(f"📋 Mapping file: {mapping_path}")
    print()

    # Exit with success if at least one file was fully processed
    if scan_success_count > 0 or not pending_scans:
        return 0
    elif convert_success_count > 0:
        print(
            "⚠️  Warning: All scans failed, but markdown files are available",
            file=sys.stderr,
        )
        return 0
    else:
        return 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print("\n🛑 Pipeline cancelled by user", file=sys.stderr)
        sys.exit(130)
    except Exception as e:
        print(f"\n❌ Unexpected error: {e}", file=sys.stderr)
        import traceback

        traceback.print_exc()
        sys.exit(1)
