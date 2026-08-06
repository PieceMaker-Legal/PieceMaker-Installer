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

Output Structure:
    {output_dir}/
    ├── document1.md
    ├── document1_sensitive_map.json
    ├── document2.md
    ├── document2_sensitive_map.json
    └── ...

Exit Codes:
    0: Success (at least one file fully processed)
    1: Total failure (all files failed conversion)
"""

import sys
import os
import time
import argparse
import subprocess
import json
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

    import select
    import threading

    # Stream stderr in a background thread so we see model loading progress
    def _stream_stderr():
        try:
            for line in proc.stderr:
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


def load_existing_mapping(output_dir: str, document_id: str) -> Optional[Dict]:
    """Load existing mapping_{documentId}.json if it exists.

    This is the SAME file that the server uses (server.cjs line 2146),
    ensuring single source of truth for mappings.

    Args:
        output_dir: Base output directory
        document_id: Document ID for this session

    Returns:
        Existing mapping data or None if file doesn't exist
    """
    # Use the same filename pattern as server.cjs (line 2146)
    mapping_path = Path(output_dir) / f"mapping_{document_id}.json"

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

    return {
        "mapping": mapping,
        "reverse_mapping": reverse_mapping,
        "extracted_data": extracted_data
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
        if code.startswith("PERSONNE_PHYSIQUE_"):
            num = int(code.split("_")[-1])
            code_counters["personnes_physiques"] = max(code_counters["personnes_physiques"], num + 1)
        elif code.startswith("SOCIETE_"):
            num = int(code.split("_")[-1])
            code_counters["societes"] = max(code_counters["societes"], num + 1)
        elif code.startswith("PERSONNE_MORALE_"):
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

    return {
        "mapping": merged_mapping,
        "reverse_mapping": merged_reverse,
        "extracted_data": merged_extracted
    }


def save_mapping(output_dir: str, document_id: str, mapping_data: Dict) -> Path:
    """Save the merged mapping to mapping_{documentId}.json.

    Uses the SAME filename as server.cjs (line 2146), ensuring the
    validated mapping can be read by GET /api/anonymize/mapping/:documentId.

    Args:
        output_dir: Base output directory
        document_id: Document ID for this session
        mapping_data: Complete mapping data structure

    Returns:
        Path to saved file
    """
    # Use the same filename pattern as server.cjs (line 2146)
    mapping_path = Path(output_dir) / f"mapping_{document_id}.json"

    with open(mapping_path, 'w', encoding='utf-8') as f:
        json.dump(mapping_data, f, indent=2, ensure_ascii=False)

    return mapping_path


def cleanup_individual_mappings(json_files: List[str]) -> int:
    """Delete individual _sensitive_map.json files after successful merge.

    Args:
        json_files: List of individual mapping file paths

    Returns:
        Number of files deleted
    """
    deleted_count = 0

    for json_file in json_files:
        try:
            if os.path.exists(json_file):
                os.remove(json_file)
                deleted_count += 1
                print(f"🗑️  Deleted: {Path(json_file).name}")
        except Exception as e:
            print(f"⚠️  Failed to delete {json_file}: {e}", file=sys.stderr)

    return deleted_count


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
        help="Output directory for markdown and JSON files",
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
        help="Document ID for mapping file (default: 'default')",
    )
    parser.add_argument(
        "--mapping-dir",
        default=None,
        help="Directory for mapping_{documentId}.json (default: same as --output)",
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

    print(f"🚀 Starting Convert & Scan Pipeline")
    print(f"   Files: {len(input_files)}")
    print(f"   Output: {args.output}")
    print(f"   Engine: {args.engine}")
    if args.mode:
        print(f"   Mode: {args.mode}")
    if args.lang:
        print(f"   Language: {args.lang}")
    print()

    # Start scanner worker immediately so model loading overlaps with Phase 1.
    scanner_worker = start_scanner_worker()
    print()

    # Phase 1: Convert all files to Markdown
    print("=" * 70)
    print("PHASE 1: CONVERTING DOCUMENTS TO MARKDOWN")
    print("=" * 70)
    print()

    md_files = []
    convert_success_count = 0

    for i, input_file in enumerate(input_files, start=1):
        print_progress("CONVERT", i, len(input_files))
        print(f"📄 [{i}/{len(input_files)}] Converting: {Path(input_file).name}")

        success, md_path = convert_file(
            input_file, args.output, engine=args.engine, mode=args.mode, lang=args.lang
        )

        if success and md_path:
            print(f"   ✅ Markdown generated: {Path(md_path).name}")
            md_files.append(md_path)
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
    print()

    # Phase 2: Scan all Markdown files for PII
    print("=" * 70)
    print("PHASE 2: SCANNING FOR SENSITIVE DATA")
    print("=" * 70)
    print()

    # Wait for the scanner worker to finish loading models.
    worker_ready = wait_for_worker_ready(scanner_worker)

    if not worker_ready:
        print("⚠️  Scanner worker not available, falling back to subprocess-per-file", file=sys.stderr)
    print()

    scan_success_count = 0

    for i, md_file in enumerate(md_files, start=1):
        print_progress("SCAN", i, len(md_files))
        print(f"🔍 [{i}/{len(md_files)}] Scanning: {Path(md_file).name}")

        if worker_ready:
            success = scan_file_via_worker(scanner_worker, md_file, args.output)
        else:
            # Fallback: subprocess per file (old behavior)
            success = scan_file(md_file, args.output)

        if success:
            print(f"   ✅ Sensitive data map generated")
            scan_success_count += 1
        else:
            print(f"   ⚠️  Scan failed, markdown preserved")

        print()

    # Shut down worker
    stop_scanner_worker(scanner_worker)

    print(f"✅ Phase 2 complete: {scan_success_count}/{len(md_files)} files scanned")
    print()

    # Phase 3: Merge & Cleanup (NEW)
    print("=" * 70)
    print("PHASE 3: MERGING INDIVIDUAL MAPPINGS & CLEANUP")
    print("=" * 70)
    print()

    # Find all generated _sensitive_map.json files
    json_files = []
    for md_file in md_files:
        stem = Path(md_file).stem
        json_path = Path(args.output) / f"{stem}_sensitive_map.json"
        if json_path.exists():
            json_files.append(str(json_path))

    if not json_files:
        print("⚠️  No sensitive maps to merge", file=sys.stderr)
        print(f"✅ Pipeline complete: {convert_success_count}/{len(input_files)} files converted")
        print()
        # Exit with success if conversions succeeded
        if convert_success_count > 0:
            return 0
        else:
            return 1

    print(f"📊 Step 1: Reading {len(json_files)} individual mapping(s)...")

    # Read individual mappings
    consolidated = read_individual_mappings(json_files)

    # Convert to anonymization format
    print("🔄 Step 2: Converting to anonymization format...")
    new_mapping_data = convert_to_anonymization_format(consolidated)

    # Load existing mapping (if exists)
    print("📂 Step 3: Loading existing mapping...")
    mapping_dir = args.mapping_dir or args.output
    existing_mapping = load_existing_mapping(mapping_dir, args.document_id)

    # Merge with existing mapping
    print("🔗 Step 4: Merging with existing mapping...")
    final_mapping_data = merge_with_existing_mapping(new_mapping_data, existing_mapping)

    # Save mapping (same file server uses)
    print("💾 Step 5: Saving mapping...")
    mapping_path = save_mapping(mapping_dir, args.document_id, final_mapping_data)

    print(f"✅ Mapping saved to: {mapping_path}")
    print(f"   • Total entities: {len(final_mapping_data['mapping'])} variants")
    print(f"   • Unique codes: {len(final_mapping_data['reverse_mapping'])}")
    print(f"   • Server can read via: GET /api/anonymize/mapping/{args.document_id}")

    # Cleanup individual mappings
    print("🗑️  Step 6: Cleaning up individual mappings...")
    deleted_count = cleanup_individual_mappings(json_files)
    print(f"✅ Deleted {deleted_count} individual mapping file(s)")
    print()

    # Summary
    print("=" * 70)
    print("PIPELINE COMPLETE")
    print("=" * 70)
    print(f"📊 Results:")
    print(f"   • Converted: {convert_success_count}/{len(input_files)} files")
    print(f"   • Scanned: {scan_success_count}/{len(md_files)} files")
    print(f"   • Entities mapped: {len(final_mapping_data['mapping'])} variants")
    print(f"   • Unique entities: {len(final_mapping_data['reverse_mapping'])} codes")
    print(f"📂 Output directory: {args.output}")
    print(f"📋 Mapping file: {mapping_path}")
    print()

    # Exit with success if at least one file was fully processed
    if scan_success_count > 0:
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
