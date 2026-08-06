#!/usr/bin/env python3
"""
MinerU PDF Parser - Direct PDF Processing
Supports both pipeline (direct PDF) and VLM/hybrid (image-based) modes
"""

import argparse
import json
import subprocess
import sys
from pathlib import Path

def parse_with_pipeline(pdf_path, output_dir, lang=None):
    """
    Parse PDF using pipeline backend (direct PDF processing, no image conversion needed)
    
    Args:
        pdf_path: Path to PDF file
        output_dir: Output directory
        lang: OCR language (None for default, 'ch' for Chinese, 'en' for English, etc.)
    """
    print(f"📄 Parsing with PIPELINE backend (direct PDF processing)")
    print(f"   Input: {pdf_path}")
    if lang:
        print(f"   Language: {lang}")
    print(f"\n{'='*60}")
    print("Processing... (this may take several minutes for scanned PDFs)")
    print(f"{'='*60}\n")
    
    # Build mineru command
    cmd = [
        'mineru',
        '-p', str(pdf_path),
        '-o', str(output_dir),
        '-b', 'pipeline'
    ]
    
    # Add language parameter if specified
    if lang:
        cmd.extend(['--lang', lang])
    
    # Execute mineru command with real-time output
    try:
        # Don't capture output - let it stream to console so user sees progress
        result = subprocess.run(cmd, check=True)
        return True
    except subprocess.CalledProcessError as e:
        print(f"\n❌ Error running mineru: {e}")
        return False
    except KeyboardInterrupt:
        print(f"\n\n⚠️  Interrupted by user (Ctrl+C)")
        print("Processing was stopped before completion.")
        return False


def parse_with_vlm(pdf_path, output_dir, backend='hybrid-auto-engine'):
    """
    Parse PDF using VLM/hybrid backend (MinerU2.5 model, higher accuracy)
    
    Args:
        pdf_path: Path to PDF file
        output_dir: Output directory  
        backend: 'vlm-auto-engine' or 'hybrid-auto-engine' (hybrid combines pipeline + vlm for best results)
    """
    backend_display = backend.replace('-auto-engine', '').upper()
    print(f"🤖 Parsing with {backend_display} backend (MinerU2.5 model)")
    print(f"   Input: {pdf_path}")
    print(f"   Backend: {backend}")
    print(f"\n{'='*60}")
    print("Processing... (this may take several minutes)")
    print(f"{'='*60}\n")
    
    # Build mineru command
    cmd = [
        'mineru',
        '-p', str(pdf_path),
        '-o', str(output_dir),
        '-b', backend
    ]
    
    # Execute mineru command with real-time output
    try:
        # Don't capture output - let it stream to console so user sees progress
        result = subprocess.run(cmd, check=True)
        return True
    except subprocess.CalledProcessError as e:
        print(f"\n❌ Error running mineru: {e}")
        return False
    except KeyboardInterrupt:
        print(f"\n\n⚠️  Interrupted by user (Ctrl+C)")
        print("Processing was stopped before completion.")
        return False


def main():
    parser = argparse.ArgumentParser(
        description="Parse PDF with MinerU (pipeline, vlm, or hybrid mode)",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Default: Pipeline mode (fast, direct PDF processing, auto-detects language)
  python mineru_improved.py document.pdf
  
  # Pipeline mode with specific language
  python mineru_improved.py document.pdf --lang en
  python mineru_improved.py document.pdf --lang ch
  
  # VLM mode with MinerU2.5 model (higher accuracy)
  python mineru_improved.py document.pdf --mode vlm
  
  # Hybrid mode (best of both: pipeline + vlm) - RECOMMENDED
  python mineru_improved.py document.pdf --mode hybrid
  
  # Hybrid with specific language for OCR
  python mineru_improved.py document.pdf --mode hybrid --lang ch
  
  # Custom output directory
  python mineru_improved.py document.pdf -o ./my_output

Valid Languages:
  ch          - Chinese (default for most documents)
  ch_server   - Chinese with better handwriting support (PPOCRv5)
  ch_lite     - Chinese lightweight model
  en          - English
  korean      - Korean
  japan       - Japanese
  chinese_cht - Traditional Chinese
  ta          - Tamil
  te          - Telugu
  ka          - Kannada
  th          - Thai
  el          - Greek
  latin       - Latin-based languages (Portuguese, Spanish, French, etc.)
  arabic      - Arabic
  east_slavic - East Slavic languages
  cyrillic    - Cyrillic script languages
  devanagari  - Devanagari script languages
        """
    )
    
    parser.add_argument('pdf_file', help='PDF file to process')
    
    parser.add_argument(
        '-o', '--output',
        default='./mineru_output',
        help='Output directory (default: ./mineru_output)'
    )
    
    parser.add_argument(
        '--mode',
        choices=['pipeline', 'vlm', 'hybrid'],
        default='pipeline',
        help='Parsing mode: pipeline (fast), vlm (high accuracy), or hybrid (best, default for VLM)'
    )
    
    parser.add_argument(
        '--lang',
        choices=['ch', 'ch_server', 'ch_lite', 'en', 'korean', 'japan', 'chinese_cht', 
                 'ta', 'te', 'ka', 'th', 'el', 'latin', 'arabic', 'east_slavic', 
                 'cyrillic', 'devanagari'],
        default=None,
        help='OCR language (optional, default: auto-detect). Only for pipeline/hybrid modes.'
    )
    
    args = parser.parse_args()
    
    pdf_path = Path(args.pdf_file)
    if not pdf_path.exists():
        print(f"❌ Error: File not found: {pdf_path}")
        return 1
    
    output_dir = Path(args.output)
    output_dir.mkdir(parents=True, exist_ok=True)
    
    print(f"\n{'='*60}")
    print(f"MinerU PDF Parser")
    print(f"{'='*60}\n")
    
    # Map user-friendly mode names to actual backend names
    backend_map = {
        'pipeline': 'pipeline',
        'vlm': 'vlm-auto-engine',
        'hybrid': 'hybrid-auto-engine'
    }
    
    success = False
    if args.mode == 'pipeline':
        success = parse_with_pipeline(pdf_path, output_dir, args.lang)
    else:
        if args.lang:
            print(f"⚠️  Note: --lang parameter only applies to pipeline mode (hybrid uses it automatically)")
        backend = backend_map[args.mode]
        success = parse_with_vlm(pdf_path, output_dir, backend=backend)
    
    print(f"\n{'='*60}")
    if success:
        print("✅ Processing complete!")
        print(f"Output saved to: {output_dir}")
    else:
        print("❌ Processing failed!")
        return 1
    print(f"{'='*60}\n")
    
    return 0


if __name__ == "__main__":
    sys.exit(main())
