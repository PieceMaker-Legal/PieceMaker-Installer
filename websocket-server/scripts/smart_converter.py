#!/usr/bin/env python3
"""
Smart Document Converter — Auto-routes to markitdown or MinerU

Automatically detects whether a document needs OCR (MinerU) or can be
processed with fast text extraction (markitdown).

Detection strategy:
- Images (JPG, PNG, etc.) → MinerU (OCR required)
- Scanned PDFs (no text layer) → MinerU (OCR required)
- Text-layer PDFs → markitdown (fast extraction)
- Office docs (DOCX, PPTX, XLSX) → markitdown (native support)

Usage:
    python3 smart_converter.py input.pdf -o output_dir [--engine auto|markitdown|mineru]
    python3 smart_converter.py input.docx -o output_dir
    python3 smart_converter.py image.jpg -o output_dir --mode hybrid --lang latin
"""

import re
import sys
import argparse
import subprocess
from pathlib import Path

# ---------------------------------------------------------------------------
# Markdown whitespace normalisation
# ---------------------------------------------------------------------------
# Both converters reproduce the *visual* line breaks of the source PDF: a sentence
# wrapped over two lines becomes "Board\nof  Directors", and justified text becomes
# "Heights  Capital" with a double space.
#
# Downstream this is not cosmetic. Entity spans are stored as raw substrings, and
# anonymisation matches them with an escaped regex — so an entity carrying a hard
# line break only matches where that exact whitespace run occurs, i.e. nowhere else
# in the document. Measured on GENSIGHT_URD: 277 entities (217 ORGANIZATION,
# 41 PERSON, 19 LOCATION) were in that state, and 24% of all "distinct" entities were
# the same entity split across several whitespace spellings.
#
# Normalising here rather than in the scanner keeps the offsets in
# *_sensitive_map.json consistent with the .md everyone downstream reads.

# Line starts that begin a new logical block and must never be folded into the
# previous line: headings, list bullets, ordered items, quotes, tables, fences, rules.
_BLOCK_START_RE = re.compile(
    r"^\s*(?:#{1,6}\s|[-*+]\s|\d+[.)]\s|>|\||```|~~~|---+\s*$|===+\s*$)"
)
_FENCE_RE = re.compile(r"^\s*(?:```|~~~)")

# Lines that must stay on their own line and can never absorb a wrapped continuation:
# a heading, a table row, a fence or a horizontal rule. A list item, by contrast, does
# absorb its own continuation lines — that is how a wrapped bullet is written.
_NO_CONTINUATION_RE = re.compile(
    r"^\s*(?:#{1,6}\s|\||```|~~~|---+\s*$|===+\s*$|>)"
)

# Non-breaking / exotic spaces that must become ordinary spaces, and zero-width
# characters that must disappear entirely.
_ODD_SPACES = str.maketrans({
    " ": " ",  # NBSP
    " ": " ",  # narrow NBSP
    " ": " ",  # figure space
    " ": " ",  # thin space
    " ": " ",
    " ": " ",
    "​": "",   # zero-width space
    "﻿": "",   # BOM
})


def normalize_markdown_whitespace(text: str) -> str:
    """Collapse conversion artefacts while preserving Markdown structure.

    Folds soft-wrapped lines back into their paragraph and collapses runs of spaces,
    but leaves blank lines (paragraph breaks), headings, lists, block quotes, tables
    and fenced code blocks alone.
    """
    text = text.translate(_ODD_SPACES).replace("\r\n", "\n").replace("\r", "\n")

    out_lines = []
    in_fence = False

    for raw_line in text.split("\n"):
        if _FENCE_RE.match(raw_line):
            in_fence = not in_fence
            out_lines.append(raw_line)
            continue

        if in_fence:
            # Code blocks are content, not layout — never touch them.
            out_lines.append(raw_line)
            continue

        line = re.sub(r"[ \t]+", " ", raw_line).strip()

        if not line:
            out_lines.append("")
            continue

        # A table row or any other block opener starts its own line.
        if _BLOCK_START_RE.match(raw_line):
            out_lines.append(line)
            continue

        # Otherwise fold into the previous line — a paragraph or a list item that this
        # line is the wrapped continuation of.
        if (
            out_lines
            and out_lines[-1]
            and not _NO_CONTINUATION_RE.match(out_lines[-1])
        ):
            out_lines[-1] = f"{out_lines[-1]} {line}"
        else:
            out_lines.append(line)

    # Never leave more than one blank line in a row.
    normalized = re.sub(r"\n{3,}", "\n\n", "\n".join(out_lines))
    return normalized.strip() + "\n"


def normalize_markdown_file(md_path: Path) -> bool:
    """Rewrite *md_path* in place if normalisation changes anything."""
    try:
        original = md_path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as exc:
        print(f"⚠️  Could not normalise {md_path}: {exc}", file=sys.stderr)
        return False

    normalized = normalize_markdown_whitespace(original)
    if normalized == original:
        return False

    md_path.write_text(normalized, encoding="utf-8")
    print(f"🧹 Normalised whitespace in {md_path.name}", file=sys.stderr)
    return True

# Try importing optional dependencies
try:
    import pypdf as PyPDF2  # pypdf is the actively maintained fork
    HAS_PYPDF2 = True
except ImportError:
    HAS_PYPDF2 = False
    print("⚠️  pypdf not installed — PDF inspection will use fallback", file=sys.stderr)

try:
    from markitdown import MarkItDown
    HAS_MARKITDOWN = True
except ImportError:
    HAS_MARKITDOWN = False
    print("⚠️  Markitdown not installed — all files will route to MinerU", file=sys.stderr)


def pdf_has_text_layer(pdf_path):
    """Check if PDF has extractable text using pypdf.

    Returns:
        bool: True if text layer found, False if scanned/no text
    """
    if not HAS_PYPDF2:
        return False  # Conservative fallback — assume scanned

    try:
        with open(pdf_path, 'rb') as f:
            reader = PyPDF2.PdfReader(f)

            # Check first 3 pages for text content
            pages_to_check = min(3, len(reader.pages))
            for i in range(pages_to_check):
                text = reader.pages[i].extract_text()
                # Require at least 50 chars to avoid false positives
                if text and len(text.strip()) > 50:
                    return True

            return False  # No substantial text found

    except Exception as e:
        print(f"⚠️  PDF inspection error: {e}", file=sys.stderr)
        return False  # Assume scanned if inspection fails


def inspect_file(file_path):
    """Determine best conversion engine based on file inspection.

    Returns:
        tuple: (engine_name, reason_message)
    """
    ext = Path(file_path).suffix.lower()

    # Images always need OCR → MinerU
    if ext in ['.jpg', '.jpeg', '.png', '.tiff', '.tif', '.bmp', '.gif']:
        return 'mineru', 'Image file requires OCR'

    # Office docs have native text → markitdown
    if ext in ['.docx', '.pptx', '.xlsx', '.xls', '.doc', '.ppt']:
        if not HAS_MARKITDOWN:
            return 'mineru', 'Markitdown unavailable — using MinerU'
        return 'markitdown', 'Office document with native text'

    # PDFs need text layer inspection
    if ext == '.pdf':
        if not HAS_MARKITDOWN:
            return 'mineru', 'Markitdown unavailable — using MinerU'

        if pdf_has_text_layer(file_path):
            return 'markitdown', 'PDF has extractable text layer'
        else:
            return 'mineru', 'Scanned PDF requires OCR (no text layer)'

    # HTML, TXT, etc. — try markitdown
    if ext in ['.html', '.htm', '.txt', '.md', '.csv']:
        if not HAS_MARKITDOWN:
            return 'mineru', 'Markitdown unavailable — using MinerU'
        return 'markitdown', f'Text-based format ({ext})'

    # Default to markitdown (handles many formats)
    if HAS_MARKITDOWN:
        return 'markitdown', f'Attempting text extraction for {ext}'
    else:
        return 'mineru', 'Unknown format — using MinerU as fallback'


def run_markitdown(file_path, output_dir):
    """Run markitdown conversion.

    Args:
        file_path: Path to input file
        output_dir: Directory to save output markdown
    """
    if not HAS_MARKITDOWN:
        raise ImportError("Markitdown not installed. Run: pip install markitdown[all]")

    print(f"🚀 Using markitdown...", file=sys.stderr)

    try:
        md = MarkItDown()
        result = md.convert(file_path)

        # Save to output directory
        output_file = Path(output_dir) / f"{Path(file_path).stem}.md"
        output_file.parent.mkdir(parents=True, exist_ok=True)

        # Converting a .md in place would rewrite the source document. The conversion
        # output is a derived artefact; the input is not ours to modify.
        if output_file.resolve() == Path(file_path).resolve():
            raise ValueError(
                f"Refusing to overwrite the input document: {file_path}. "
                "Choose an output directory different from the source."
            )

        content = normalize_markdown_whitespace(result.text_content)
        output_file.write_text(content, encoding='utf-8')

        print(f"✅ Converted to {output_file}", file=sys.stderr)
        print(f"📊 Output length: {len(content)} characters", file=sys.stderr)

    except Exception as e:
        print(f"❌ Markitdown conversion failed: {e}", file=sys.stderr)
        raise


def run_mineru(file_path, output_dir, mode=None, lang=None):
    """Route to MinerU script.

    Args:
        file_path: Path to input file
        output_dir: Directory to save output
        mode: MinerU mode (pipeline/hybrid/vlm)
        lang: OCR language code
    """
    mineru_script = Path(__file__).parent / 'mineru_improved_1.py'

    if not mineru_script.exists():
        raise FileNotFoundError(f"MinerU script not found: {mineru_script}")

    print(f"🚀 Using MinerU...", file=sys.stderr)

    # Snapshot the directory so normalisation afterwards only touches the Markdown
    # this run produced — never a pre-existing file that happens to sit in the same
    # output directory.
    before = {
        p: p.stat().st_mtime_ns
        for p in Path(output_dir).rglob("*.md")
        if p.is_file()
    }

    # Build command
    args = [sys.executable, str(mineru_script), file_path, '-o', output_dir]
    if mode:
        args.extend(['--mode', mode])
    if lang:
        args.extend(['--lang', lang])

    # Run MinerU (output streams directly to stderr)
    result = subprocess.run(args, check=False)

    if result.returncode != 0:
        print(f"❌ MinerU failed with exit code {result.returncode}", file=sys.stderr)
        sys.exit(result.returncode)

    # MinerU writes its Markdown itself, so normalise afterwards rather than inline —
    # but only the files it just wrote.
    for md_path in Path(output_dir).rglob("*.md"):
        if not md_path.is_file():
            continue
        if before.get(md_path) == md_path.stat().st_mtime_ns:
            continue  # untouched by this run — leave it alone
        normalize_markdown_file(md_path)


def main():
    parser = argparse.ArgumentParser(
        description='Smart Document Converter — auto-routes to markitdown or MinerU'
    )
    parser.add_argument('file', help='Input file to convert')
    parser.add_argument('-o', '--output', required=True, help='Output directory')
    parser.add_argument('--engine', choices=['auto', 'markitdown', 'mineru'],
                        default='auto', help='Conversion engine (default: auto)')
    parser.add_argument('--mode', help='MinerU mode (pipeline/hybrid/vlm)')
    parser.add_argument('--lang', help='OCR language code for MinerU')

    args = parser.parse_args()

    # Validate input file
    file_path = Path(args.file)
    if not file_path.exists():
        print(f"❌ File not found: {file_path}", file=sys.stderr)
        sys.exit(1)

    # Create output directory
    output_dir = Path(args.output)
    output_dir.mkdir(parents=True, exist_ok=True)

    # Determine engine
    if args.engine == 'auto':
        engine, reason = inspect_file(file_path)
        print(f"🔍 Auto-detection: {reason}", file=sys.stderr)
    elif args.engine == 'markitdown':
        engine = 'markitdown'
        print(f"⚡ Force using markitdown (user override)", file=sys.stderr)
    else:  # mineru
        engine = 'mineru'
        print(f"🔬 Force using MinerU (user override)", file=sys.stderr)

    # Route to appropriate engine
    try:
        if engine == 'markitdown':
            run_markitdown(file_path, output_dir)
        else:  # mineru
            run_mineru(file_path, output_dir, args.mode, args.lang)
    except Exception as e:
        print(f"❌ Conversion failed: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
