"""
Cache du mapping central avec rechargement a chaud.

Lit ~/.piecemaker/central-mapping.json (ou le chemin configure) et recharge
automatiquement quand le fichier change (verification mtime a chaque requete).
"""

import json
import logging
import os
import time
from typing import Dict, List, Optional

logger = logging.getLogger('piecemaker_pii.mapping')

DEFAULT_PATH = os.path.join(os.path.expanduser('~'), '.piecemaker', 'central-mapping.json')
RELOAD_INTERVAL = 2.0  # secondes entre deux verifications mtime


class MappingCache:
    """Cache thread-safe du mapping central avec hot-reload."""

    def __init__(self, path: Optional[str] = None):
        self.path = path or os.environ.get('PIECEMAKER_MAPPING_PATH', DEFAULT_PATH)
        self.mapping: Dict[str, str] = {}
        self.reverse_mapping: Dict[str, List[str]] = {}
        self._mtime: float = 0
        self._last_check: float = 0
        self._load()

    def _load(self) -> bool:
        self._last_check = time.monotonic()
        try:
            with open(self.path, 'r', encoding='utf-8') as f:
                raw = f.read().lstrip('﻿')
            doc = json.loads(raw)
        except FileNotFoundError:
            logger.warning('Mapping introuvable : %s', self.path)
            self.mapping = {}
            self.reverse_mapping = {}
            self._mtime = 0
            return False
        except (json.JSONDecodeError, OSError) as e:
            logger.error('Erreur lecture mapping : %s — %s', self.path, e)
            self.mapping = {}
            self.reverse_mapping = {}
            self._mtime = 0
            return False

        mapping = {}
        reverse = {}

        raw_mapping = doc.get('mapping') or {}
        for entity, code in raw_mapping.items():
            entity = str(entity).strip()
            code = str(code).strip()
            if entity and code:
                mapping[entity] = code

        raw_reverse = doc.get('reverse_mapping') or {}
        for code, variants in raw_reverse.items():
            code = str(code).strip()
            if not code:
                continue
            if isinstance(variants, list):
                cleaned = [str(v).strip() for v in variants if str(v).strip()]
            else:
                cleaned = [str(variants).strip()] if str(variants).strip() else []
            if cleaned:
                reverse[code] = cleaned

        # Reconstruire le reverse a partir du forward si absent
        for entity, code in mapping.items():
            if code not in reverse:
                reverse[code] = [entity]
            elif entity not in reverse[code]:
                reverse[code].append(entity)

        self.mapping = mapping
        self.reverse_mapping = reverse
        try:
            self._mtime = os.path.getmtime(self.path)
        except OSError:
            self._mtime = 0
        logger.info('Mapping charge : %d entites, %d codes — %s',
                     len(mapping), len(reverse), self.path)
        return True

    def refresh_if_needed(self) -> None:
        """Verifie le mtime et recharge si le fichier a change."""
        now = time.monotonic()
        if now - self._last_check < RELOAD_INTERVAL:
            return
        self._last_check = now
        try:
            current_mtime = os.path.getmtime(self.path)
        except OSError:
            if self.mapping or self.reverse_mapping:
                logger.warning('Mapping supprime, vidage du cache : %s', self.path)
                self.mapping = {}
                self.reverse_mapping = {}
                self._mtime = 0
            return
        if current_mtime != self._mtime:
            logger.info('Mapping modifie, rechargement...')
            self._load()

    @property
    def entity_count(self) -> int:
        return len(self.mapping)

    @property
    def code_count(self) -> int:
        return len(self.reverse_mapping)
