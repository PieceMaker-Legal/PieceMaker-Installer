#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Configuration centralisée du serveur MCP Légifrance (port stdio local)."""

import os
from dotenv import load_dotenv

load_dotenv()

# API PieceMaker — conservée uniquement parce que tools/session_manager.py
# l'importe au chargement du module (compatibilité d'import). Aucun des 8
# outils exposés par ce serveur (Search_*, consulter_decision, Tracking_BODACC)
# n'appelle cette API.
API_BASE_URL = os.getenv('API_BASE_URL', 'https://api.festival-letino-app.com/api')

# Légifrance (PISTE)
# SECURITY: pas de valeur par défaut. Les identifiants précédemment codés en
# dur ici ont été committés dans un dépôt public et sont considérés comme
# compromis — ils ne doivent jamais être réintroduits, même en fallback.
# Si absents, le serveur démarre quand même (initialize/tools/list
# fonctionnent) ; seul un appel d'outil échoue, avec un message clair en
# français, sans requête réseau (voir tools/legifrance_client.py::_get_token).
def _credential(name):
    """
    Lit un identifiant, en traitant comme absent une valeur vide OU une
    substitution non résolue. Claude Code laisse le texte « ${VAR} » tel quel
    quand la variable n'est pas définie et n'a pas de défaut : sans ce filtre,
    la garde « identifiants manquants » ne se déclencherait pas et le serveur
    tenterait de s'authentifier avec une chaîne factice.
    """
    value = (os.getenv(name) or '').strip()
    if not value or value.startswith('${'):
        return None
    return value


LEGIFRANCE_CLIENT_ID = _credential('LEGIFRANCE_CLIENT_ID')
LEGIFRANCE_CLIENT_SECRET = _credential('LEGIFRANCE_CLIENT_SECRET')

# Une application PISTE porte des identifiants DIFFÉRENTS en sandbox et en
# production : l'installateur laisse choisir, le serveur doit viser le même
# environnement, sinon l'authentification échoue en 401 sans raison visible.
# Défaut : production, comme l’environnement configuré par l’installateur.
LEGIFRANCE_ENV = (os.getenv('LEGIFRANCE_ENV') or 'production').strip().lower()
_SANDBOX = LEGIFRANCE_ENV == 'sandbox'

LEGIFRANCE_OAUTH_URL = (
    "https://sandbox-oauth.piste.gouv.fr/api/oauth/token" if _SANDBOX
    else "https://oauth.piste.gouv.fr/api/oauth/token"
)
LEGIFRANCE_API_URL = (
    "https://sandbox-api.piste.gouv.fr/dila/legifrance/lf-engine-app" if _SANDBOX
    else "https://api.piste.gouv.fr/dila/legifrance/lf-engine-app"
)

# BODACC (API publique, sans authentification)
BODACC_API_URL = "https://bodacc-datadila.opendatasoft.com/api/v2/catalog/datasets/annonces-commerciales/records"

# Chemins
TEMPLATES_PATH = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'templates')

# Fonds de recherche Légifrance disponibles
LEGIFRANCE_FONDS = [
    "JURI",       # Jurisprudence
    "CODE_DATE",  # Codes en vigueur
    "CODE_ETAT",  # Codes consolidés
    "CONSTIT",    # Textes constitutionnels
    "CIRC",       # Circulaires
    "KALI",       # Conventions collectives
    "ACCO",       # Accords collectifs
    "CNIL"        # Délibérations CNIL
]
