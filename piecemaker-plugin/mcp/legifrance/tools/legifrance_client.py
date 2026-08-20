##/tools/legifrance_client.py 
#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Client API Légifrance via PISTE - Version corrigée avec logs"""

import requests
import json
import sys
from datetime import datetime, timedelta
from typing import Dict, List, Optional, Any
from config.settings import (
    LEGIFRANCE_CLIENT_ID,
    LEGIFRANCE_CLIENT_SECRET,
    LEGIFRANCE_DEBUG,
    LEGIFRANCE_OAUTH_URL,
    LEGIFRANCE_API_URL
)

class LegifranceClient:
    """Client pour l'API Légifrance"""
    
    def __init__(self):
        self.client_id = LEGIFRANCE_CLIENT_ID
        self.client_secret = LEGIFRANCE_CLIENT_SECRET
        self.access_token = None
        self.token_expires_at = None
    
    def _get_token(self) -> str:
        """Obtient ou renouvelle le token OAuth2"""
        # Ported behaviour (not present upstream): fail fast with a clear French
        # message and NO network call when credentials are absent, instead of
        # letting requests.post() attempt an OAuth call that will always 401.
        # This lets the stdio server start and answer initialize/tools/list
        # even without credentials configured; only tool calls are affected.
        if not self.client_id or not self.client_secret:
            raise Exception(
                "Identifiants Légifrance manquants (LEGIFRANCE_CLIENT_ID / LEGIFRANCE_CLIENT_SECRET absents). "
                "Créez une application PISTE, souscrivez à l'API Légifrance, puis fournissez ces variables "
                "dans l'environnement du serveur ou dans son fichier .env local."
            )

        if self.access_token and self.token_expires_at:
            if datetime.now() < self.token_expires_at - timedelta(minutes=5):
                return self.access_token
        
        try:
            response = requests.post(
                LEGIFRANCE_OAUTH_URL,
                headers={"Content-Type": "application/x-www-form-urlencoded"},
                data={
                    "grant_type": "client_credentials",
                    "client_id": self.client_id,
                    "client_secret": self.client_secret,
                    "scope": "openid"
                },
                timeout=30
            )
            
            response.raise_for_status()
            
            token_data = response.json()
            self.access_token = token_data["access_token"]
            self.token_expires_at = datetime.now() + timedelta(seconds=token_data.get("expires_in", 3600))
            
            return self.access_token
            
        except requests.exceptions.RequestException as e:
            raise Exception(f"Erreur lors de l'obtention du token: {str(e)}")
            
    def _request(self, endpoint: str, payload: Dict) -> Dict:
        """Effectue une requête à l'API"""
        token = self._get_token()
        url = f"{LEGIFRANCE_API_URL}{endpoint}"

        # ===== LOGS DÉTAILLÉS =====
        # Ported to stderr (stdio MCP transport reserves stdout for JSON-RPC only)
        if LEGIFRANCE_DEBUG:
            print("\n" + "="*80, file=sys.stderr)
            print("DEBUG LEGIFRANCE REQUEST", file=sys.stderr)
            print("="*80, file=sys.stderr)
            print(f"URL: {url}", file=sys.stderr)
            print(f"\nPayload complet:\n{json.dumps(payload, indent=2, ensure_ascii=False)}", file=sys.stderr)
            print("="*80 + "\n", file=sys.stderr)
        # ==========================
        
        try:
            response = requests.post(
                url,
                headers={
                    "Authorization": f"Bearer {token}",
                    "Content-Type": "application/json",
                    "Accept": "application/json"
                },
                json=payload,
                timeout=30
            )
            
            # ===== LOG RÉPONSE =====
            if LEGIFRANCE_DEBUG:
                print(f"\n{'='*80}", file=sys.stderr)
                print(f"RESPONSE STATUS: {response.status_code}", file=sys.stderr)
                print(f"{'='*80}", file=sys.stderr)

                if response.status_code >= 400:
                    print(f"\n⚠️ ERREUR API:\n{response.text}\n", file=sys.stderr)
                else:
                    response_data = response.json()
                    print(f"\nTotal résultats: {response_data.get('totalResultNumber', 0)}", file=sys.stderr)
                    print(f"Résultats retournés: {len(response_data.get('results', []))}", file=sys.stderr)

                print(f"{'='*80}\n", file=sys.stderr)
            # =======================
            
            response.raise_for_status()
            result = response.json()
            return result
        
        except requests.exceptions.RequestException as e:
            raise Exception(f"Erreur lors de la requête API: {str(e)}")

    def search_with_criteres(self, fond: str, criteres: List[Dict[str, Any]],
                             operateur: str = "ET", filtres: Optional[List[Dict]] = None,
                             type_champ: str = "ALL", page_number: int = 1, page_size: int = 10,
                             sort: str = "PERTINENCE", second_sort: str = "ID",
                             type_pagination: str = "DEFAUT") -> Dict[str, Any]:
        """
        Recherche avec critères pré-parsés (depuis query_parser).

        Args:
            criteres: Liste de critères déjà formatés par le parser
                     [{"valeur": "mot", "operateur": "ET", "typeRecherche": "...", "proximite": 10}, ...]
        """
        payload = {
            "fond": fond,
            "sort": sort,
            "secondSort": second_sort,
            "typePagination": type_pagination,
            "recherche": {
                "pageNumber": page_number,
                "pageSize": min(page_size, 100),
                "operateur": operateur,
                "fromAdvancedRecherche": False,
                "champs": [
                    {
                        "criteres": criteres,
                        "operateur": operateur,
                        "typeChamp": type_champ
                    }
                ]
            }
        }

        # Gestion des filtres
        if filtres:
            payload["recherche"]["filtres"] = filtres

        return self._request("/search", payload)

    def search(self, fond: str, query: str, filtres: Optional[List[Dict]] = None,
            date_debut: Optional[str] = None, date_fin: Optional[str] = None,
            page_number: int = 1, page_size: int = 10,
            type_recherche: str = "UN_DES_MOTS",
            type_champ: str = "ALL",
            sort: str = "PERTINENCE",
            second_sort: str = "ID",
            type_pagination: str = "DEFAUT",
            proximite: Optional[int] = 10,  # ✅ Optional
            operateur: str = "OU") -> Dict[str, Any]:
        """
        Recherche dans Légifrance (ancienne méthode - maintenue pour compatibilité)

        Args:
            proximite: Distance max en mots. None = pas de contrainte
        """

        payload = {
            "fond": fond,
            "sort": sort,
            "secondSort": second_sort,
            "typePagination": type_pagination,
            "recherche": {
                "pageNumber": page_number,
                "pageSize": min(page_size, 100),
                "operateur": operateur,
                "fromAdvancedRecherche": False
            }
        }

        # Construction des champs de recherche
        if query:
            mots = query.strip().split()

            criteres = []
            for mot in mots:
                critere = {
                    "operateur": operateur,
                    "typeRecherche": type_recherche,
                    "valeur": mot
                }
                # ✅ N'ajouter proximite que si définie
                if proximite is not None:
                    critere["proximite"] = proximite

                criteres.append(critere)

            payload["recherche"]["champs"] = [
                {
                    "criteres": criteres,
                    "operateur": operateur,
                    "typeChamp": type_champ
                }
            ]

        # Gestion des filtres
        if filtres:
            payload["recherche"]["filtres"] = filtres
        elif date_debut or date_fin:
            date_filter = {
                "facette": "DATE_DECISION",
                "dates": {}
            }
            if date_debut:
                date_filter["dates"]["start"] = date_debut
            if date_fin:
                date_filter["dates"]["end"] = date_fin
            payload["recherche"]["filtres"] = [date_filter]

        return self._request("/search", payload)

    def search_code(self, query: str, filtres: Optional[List[Dict]] = None,
                    type_champ: str = "ALL",
                    type_recherche: str = "UN_DES_MOTS",
                    operateur: str = "ET",
                    page_number: int = 1,
                    page_size: int = 10,
                    sort: str = "PERTINENCE") -> Dict[str, Any]:
        """
        Recherche spécifique dans les codes juridiques (CODE_DATE)
        
        Args:
            query: Texte à rechercher
            filtres: Liste de filtres (facettes)
            type_champ: ALL, NUM_ARTICLE, ARTICLE, TITLE, TABLE
            type_recherche: UN_DES_MOTS, EXACTE, TOUS_LES_MOTS_DANS_UN_CHAMP
            operateur: ET ou OU
            page_number: Numéro de page
            page_size: Nombre de résultats par page
            sort: PERTINENCE, DATE_DESC, DATE_ASC
        
        Returns:
            Dict contenant les résultats de la recherche
        """
        
        # Construction du payload selon la doc API CODE_DATE
        payload = {
            "fond": "CODE_DATE",
            "recherche": {
                "pageNumber": page_number,
                "pageSize": min(page_size, 100),
                "operateur": operateur,  # ✅ Au niveau recherche
                "sort": sort,
                "typePagination": "ARTICLE",  # ✅ Obligatoire pour CODE_DATE
                "champs": [],
                "filtres": filtres or []
            }
        }
        
        # Construction des champs de recherche
        if query:
            mots = query.strip().split()
            
            # Un critère par mot
            criteres = []
            for mot in mots:
                critere = {
                    "typeRecherche": type_recherche,
                    "valeur": mot,
                    "operateur": operateur  # ✅ Dans chaque critère
                }
                criteres.append(critere)
            
            # Un seul champ contenant tous les critères
            payload["recherche"]["champs"] = [{
                "typeChamp": type_champ,
                "operateur": operateur,  # ✅ Au niveau champ
                "criteres": criteres
            }]
        
        return self._request("/search", payload)
    
    def get_decision_text(self, text_id: str) -> Dict[str, Any]:
        """
        Récupère le texte intégral d'une décision de jurisprudence
        
        Args:
            text_id: Identifiant de la décision (ex: "JURITEXT000006949246")
        
        Returns:
            Dict contenant le texte complet de la décision
        """
        # Nettoyer l'ID si nécessaire (enlever espaces)
        text_id = text_id.strip()
        
        payload = {
            "textId": text_id
        }
        
        return self._request("/consult/juri", payload)
    
    def get_article(self, article_id: str) -> Dict[str, Any]:
        """
        Récupère le contenu complet d'un article de code
        
        Args:
            article_id: Identifiant de l'article (ex: "LEGIARTI000033219357")
        
        Returns:
            Dict contenant le contenu complet de l'article
        """
        article_id = article_id.strip()
        
        payload = {
            "id": article_id
        }
        
        return self._request("/consult/getArticle", payload)
    
# Instance globale
legifrance_client = LegifranceClient()
