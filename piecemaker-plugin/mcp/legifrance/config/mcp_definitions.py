#/config/mcp_definitions.py 
#! MCP SERVEUR LOCAL
"""Définition des outils MCP disponibles"""

MCP_TOOLS = [
{
    "name": "Brainstorming",
    "description": "Agent qui génère lui-même sa tasklist complète et l'exécute rigoureusement étape par étape avec raisonnement structuré",
    "version": "2.1",
    "temperature": 0.1,
    "max_tokens": 8000,
    "tags": ["autonome", "reasoning", "tasklist", "juridique", "ultra-rigoureux"],
    "inputSchema": {
        "type": "object",
        "properties": {},
        "required": []
    },
    "instructions": [
        "Tu es un agent juridique français autonome, méthodique et ultra-rigoureux.",
        "Tu respectes À LA LETTRE le processus en 5 étapes ci-dessous à CHAQUE message utilisateur, sans aucune exception.",
        "PROCESSUS OBLIGATOIRE",
        "1. Balise <thinking>, tu fais EXACTEMENT dans cet ordre :",
        "   A. Reformulation de ce que veut l'utilisateur (en 1 phrase max)",
        "   B. Inventaire EXHAUSTIF de tous les outils dont tu disposes (nom + description courte en 1 ligne)",
        "   C. Génération d'une tasklist numérotée, réaliste, complète et ordonnée logiquement",
        "      • Chaque tâche indique si elle nécessite un tool et lequel",
        "      • Tu décides toi-même de l'ordre optimal (ex: 1. charger dossier → 2. extraire faits → 3. recherche code → 4. jurisprudence → 5. synthèse)",
        "      • Tu anticipes TOUTES les étapes nécessaires pour répondre à 100 %",
        "   D. Tu confirmes que tu vas maintenant exécuter cette tasklist dans l'ordre exact",
        "2. Tu fermes </thinking>",
        "3. Tu exécutes la tasklist PUBLIQUEMENT, étape par étape :",
        "   • Tu affiches **Étape 1/7**, **Étape 2/7**, etc.",
        "   • Tu appelles les tools au bon moment (search_file, read_file, recherche_code, etc.)",
        "   • Tu montres clairement le résultat de chaque tool",
        "4. À la toute fin UNIQUEMENT, après avoir terminé toute la tasklist, tu donnes la réponse finale claire, structurée et professionnelle à l'utilisateur.",
        "",
        "RÈGLES ABSOLUES :",
        "- Tu ne réponds JAMAIS directement à l'utilisateur sans avoir fait tout le <thinking> + tasklist.",
        "- Tu ne sautes jamais l'étape de création de la tasklist.",
        "- Tu ne mélanges jamais exécution et réponse finale.",
        "- Si une étape échoue ou manque d'info, tu l'indiques clairement et tu ajustes la tasklist si besoin.",
        "",
        "Outils disponibles (tu dois tous les lister dans l'étape B) :",
        "- search_file(query: str) → recherche le contenu du dossier dans les fichiers JSON (suggéré : compilation_dossier.json)",
        "- read_file(path: str) → lit le fichier json",
        "Recherche dans l'API Legifrance, base de données légale (code > jurisprudence) :",
        "- recherche_code(query ou article)",
        "- consulter_article(code, article)",
        "- recherche_jurisprudence(query, code=None, date_min=None)",
        "- consulter_decision(id_decision)",
        "- tracking_bodacc(siren)",
        "- deep_search(query) → recherche web externe"
    ],
    "examples": [
        {
        "user": "Mon salarié conteste son licenciement pour faute grave, dossier 2025-078",
        "assistant": "<thinking>\nA. Résumé : Analyse contestation licenciement faute grave, dossier 2025-078\nB. Outils : search_file, read_file, recherche_code, consulter_article, recherche_jurisprudence, consulter_decision, tracking_bodacc\nC. Tasklist :\n   1. Charger le dossier via search_file + read_file\n   2. Extraire faits + motifs licenciement\n   3. Identifier articles Code du travail (L1234-1, L1234-5, L1234-9, L1232-1)\n   4. Consulter chaque article + vérifier vigueur\n   5. Recherche jurisprudence 2020–2025 sur faute grave\n   6. Consulter 5 arrêts clés\n   7. Vérifier SIREN entreprise via tracking_bodacc\n   8. Synthèse complète\nD. J'exécute maintenant cette tasklist dans l'ordre\n</thinking>\n\n**Étape 1/8** – Chargement du dossier..."
        }
    ]
    },
# ============================================================================
    # OUTILS RECHERCHE JURISPRUDENCE - VERSION OPTIMISÉE
    # ============================================================================
    {
        "name": "Search_Cour_Cassation",
        "description": "Recherche ciblée dans la jurisprudence de la COUR DE CASSATION avec parsing intelligent de la query.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": """Mots-clés avec opérateurs logiques et recherche par article visé.

SYNTAXE SUPPORTÉE:
1. Mots simples: "faute grave licenciement" → cherche les 3 mots (ET automatique)
2. Opérateur ET: "faute" ET "employeur" → les 2 mots obligatoires
3. Opérateur OU: "faute" OU "employeur" → au moins un des 2 mots
4. Expression exacte: "faute de l'employeur" → phrase exacte (avec guillemets)
5. Référence article: "L. 1235-3" ou "L1235-3" → décisions citant cet article (normalisé automatiquement)
6. Mixte: "faute grave" ET "L. 1235-3" → combine mots-clés et article
7. Multiple: FAUTE ET Employeur ET LICENCIEMENT → les 3 mots obligatoires

EXEMPLES CONCRETS:
✅ "faute grave licenciement" → mots-clés simples
✅ "faute" ET "employeur" → opérateur ET
✅ "L. 1235-3" → article du Code du travail (indemnité licenciement)
✅ "L. 1235-3" ET "faute grave" → article + contexte
✅ "L. 1234-1" OU "L. 1234-5" → plusieurs articles
✅ "clause de non-concurrence" → expression exacte
✅ "L.2262-14" → article conventions collectives (point facultatif)

NOTE: Les références d'articles (L.1234-1, R.1234-2, D.1234-3) sont automatiquement normalisées.
Le système parse automatiquement et optimise la requête."""
                },
                "matiere": {
                    "type": "string",
                    "enum": ["TOUTES", "CIVIL", "COMMERCIAL", "PENAL", "SOCIAL"],
                    "default": "TOUTES",
                    "description": "Matière juridique: CIVIL (contrats, famille, immobilier), COMMERCIAL (sociétés), PENAL (criminel), SOCIAL (travail)"
                },
                "CASSATION_TYPE_PUBLICATION_BULLETIN": {
                    "type": "string",
                    "enum": ["TOUS", "PUBLIE", "INEDIT"],
                    "default": "TOUS",
                    "description": "PUBLIE = arrêts de principe uniquement"
                },
                "CASSATION_NATURE_DECISION": {
                    "type": "array",
                    "items": {
                        "type": "string",
                        "enum": ["CASSATION", "REJET", "CASSATION_PARTIELLE", "TOUS"]
                    },
                    "default": ["TOUS"]
                },
                "date_debut": {
                    "type": "string",
                    "description": "Date début YYYY-MM-DD (défaut: 5 ans en arrière)"
                },
                "date_fin": {
                    "type": "string",
                    "description": "Date fin YYYY-MM-DD (défaut: aujourd'hui)"
                },
                "page_size": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 100,
                    "default": 10
                },
                "page_number": {
                    "type": "integer",
                    "minimum": 1,
                    "default": 1
                }
            },
            "required": ["query"]
        }
    },
    {
        "name": "Search_Cour_Appel",
        "description": "Recherche dans la jurisprudence des COURS D'APPEL avec parsing intelligent. Volume important: bien cibler avec ville + dates.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": """Mots-clés avec opérateurs logiques et recherche par article visé.

Syntaxe identique à Search_Cour_Cassation:
- Mots simples → ET automatique
- "mot1" ET "mot2" → opérateur ET explicite
- "mot1" OU "mot2" → opérateur OU explicite
- "expression exacte" → entre guillemets
- "L. 1235-3" ou "L1235-3" → décisions citant cet article (normalisé auto)
- Mixte: "divorce" ET "L. 229" → mots-clés + article

Exemples: "divorce prestation compensatoire", "L. 229" ET "prestation", "L. 373-2-9"."""
                },
                "APPEL_SIEGE_APPEL": {
                    "type": "array",
                    "items": {
                        "type": "string",
                        "enum": ["PARIS", "VERSAILLES", "LYON", "AIX-PROVENCE", "TOULOUSE", "BORDEAUX", "RENNES", "DOUAI", "MONTPELLIER", "ROUEN", "NANCY", "DIJON", "GRENOBLE", "ANGERS", "ORLEANS", "AMIENS", "METZ", "NIMES", "LIMOGES", "CAEN", "REIMS", "BOURGES", "POITIERS", "RIOM", "PAU", "BESANCON", "AGEN", "COLMAR", "BASTIA", "CHAMBERY", "BASSE-TERRE", "FORT-DE-FRANCE", "ST-DENIS-REUNION", "NOUMEA", "PAPEETE"]
                    },
                    "description": "Cour(s) d'appel ciblée(s) par ville"
                },
                "date_debut": {
                    "type": "string",
                    "description": "Date début YYYY-MM-DD (défaut: 3 ans)"
                },
                "date_fin": {
                    "type": "string",
                    "description": "Date fin YYYY-MM-DD"
                },
                "page_size": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 100,
                    "default": 15
                },
                "page_number": {
                    "type": "integer",
                    "minimum": 1,
                    "default": 1
                }
            },
            "required": ["query"]
        }
    },
    {
        "name": "Search_Conseil_Etat",
        "description": "Recherche ciblée dans la jurisprudence du CONSEIL D'ÉTAT avec parsing intelligent de la query.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": """Mots-clés avec opérateurs logiques et recherche par article visé.

SYNTAXE SUPPORTÉE:
1. Mots simples: "responsabilité hospitalière" → cherche les 2 mots (ET automatique)
2. Opérateur ET: "responsabilité" ET "faute" → les 2 mots obligatoires
3. Opérateur OU: "responsabilité" OU "faute" → au moins un des 2 mots
4. Expression exacte: "responsabilité sans faute" → phrase exacte (avec guillemets)
5. Référence article: "L. 1235-3" → décisions citant cet article (normalisé automatiquement)
6. Mixte: "responsabilité" ET "L. 1142-1" → combine mots-clés et article

EXEMPLES CONCRETS:
✅ "responsabilité hospitalière" → mots-clés simples
✅ "responsabilité" ET "établissement public" → opérateur ET
✅ "L. 1142-1" → article du Code de la santé publique
✅ "annulation acte administratif" → contexte administratif
✅ "principe égalité" OU "principe neutralité" → plusieurs principes

NOTE: Les références d'articles sont automatiquement normalisées."""
                },
                "PUBLICATION_RECUEIL": {
                    "type": "string",
                    "enum": ["TOUS", "PUBLIE", "NON_PUBLIE"],
                    "default": "TOUS",
                    "description": "PUBLIE = décisions publiées au recueil Lebon uniquement"
                },
                "date_debut": {
                    "type": "string",
                    "description": "Date début YYYY-MM-DD (défaut: 5 ans en arrière)"
                },
                "date_fin": {
                    "type": "string",
                    "description": "Date fin YYYY-MM-DD (défaut: aujourd'hui)"
                },
                "page_size": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 100,
                    "default": 10
                },
                "page_number": {
                    "type": "integer",
                    "minimum": 1,
                    "default": 1
                }
            },
            "required": ["query"]
        }
    },
    {
        "name": "Search_CAA",
        "description": "Recherche dans la jurisprudence des COURS ADMINISTRATIVES D'APPEL avec parsing intelligent. Permet de filtrer par ville de la CAA.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": """Mots-clés avec opérateurs logiques et recherche par article visé.

Syntaxe identique à Search_Conseil_Etat:
- Mots simples → ET automatique
- "mot1" ET "mot2" → opérateur ET explicite
- "mot1" OU "mot2" → opérateur OU explicite
- "expression exacte" → entre guillemets
- "L. 1235-3" ou "L1235-3" → décisions citant cet article (normalisé auto)
- Mixte: "urbanisme" ET "L. 123-1" → mots-clés + article

Exemples: "permis de construire", "L. 421-6" ET "urbanisme", "refus titre séjour"."""
                },
                "CAA_VILLE": {
                    "type": "array",
                    "items": {
                        "type": "string",
                        "enum": ["PARIS", "VERSAILLES", "LYON", "MARSEILLE", "BORDEAUX", "NANTES", "NANCY", "DOUAI", "TOULOUSE"]
                    },
                    "description": "Cour(s) administrative(s) d'appel ciblée(s) par ville"
                },
                "PUBLICATION_RECUEIL": {
                    "type": "string",
                    "enum": ["TOUS", "PUBLIE", "NON_PUBLIE"],
                    "default": "TOUS",
                    "description": "PUBLIE = décisions publiées au recueil Lebon uniquement"
                },
                "date_debut": {
                    "type": "string",
                    "description": "Date début YYYY-MM-DD (défaut: 3 ans)"
                },
                "date_fin": {
                    "type": "string",
                    "description": "Date fin YYYY-MM-DD"
                },
                "page_size": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 100,
                    "default": 15
                },
                "page_number": {
                    "type": "integer",
                    "minimum": 1,
                    "default": 1
                }
            },
            "required": ["query"]
        }
    },
    {
        "name": "Search_Premiere_Instance",
        "description": "Recherche dans la jurisprudence des JURIDICTIONS DE PREMIÈRE INSTANCE. Volume très limité dans la base (~50 décisions). Query automatiquement optimisée (opérateur OU, au moins un mot - car volume faible).",
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": """Mots-clés avec opérateurs logiques et recherche par article visé.

SYNTAXE SUPPORTÉE:
1. Mots simples: "divorce pension alimentaire" → cherche avec OU (au moins un mot)
2. Opérateur ET: "divorce" ET "pension" → les 2 mots obligatoires
3. Opérateur OU: "divorce" OU "séparation" → au moins un des 2 mots
4. Expression exacte: "pension alimentaire" → phrase exacte (avec guillemets)
5. Référence article: "L. 1235-3" ou "L1235-3" → décisions citant cet article (normalisé auto)
6. Combinaisons: "divorce" ET "pension alimentaire" ET "L. 229" → mixte

EXEMPLES:
- "licenciement" → décisions contenant au moins ce mot
- "L. 1235-3" → décisions citant cet article du Code du travail
- "L. 1235-3" ET "faute grave" → article + contexte
- "divorce" ET "pension" → décisions avec les 2 mots
- "clause de non-concurrence" → expression exacte
- "prud'hommes" ET "rappel salaire" → termes combinés

NOTE: Volume très faible en première instance (~50 décisions totales), opérateur OU par défaut sauf si ET/OU explicite dans la query.
Les références d'articles (L., R., D.) sont automatiquement normalisées."""
                },
                "PREMIER_DEGRE_TYPE_JURIDICTION": {
                    "type": "array",
                    "items": {
                        "type": "string",
                        "enum": ["Tribunal de grande instance", "Tribunal judiciaire de Paris", "Conseil de prud'hommes", "Chambre de l'application des peines du TSA de St Pierre"]
                    },
                    "description": "Type de juridiction de première instance"
                },
                "date_debut": {
                    "type": "string",
                    "description": "Date début YYYY-MM-DD"
                },
                "date_fin": {
                    "type": "string",
                    "description": "Date fin YYYY-MM-DD"
                },
                "page_size": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 100,
                    "default": 20
                },
                "page_number": {
                    "type": "integer",
                    "minimum": 1,
                    "default": 1
                }
            },
            "required": ["query"]
        }
    },
    {
        "name": "Search_Code",
        "description": "Recherche INTELLIGENTE dans les codes juridiques français (Code du travail, Code civil, etc.) avec parsing automatique des références d'articles et opérateurs logiques.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": """Recherche avec détection automatique du format.

FORMATS SUPPORTÉS:

1. RÉFÉRENCE D'ARTICLE EXACTE:
   - "L. 1234-1" ou "L.1234-1" ou "L 1234-1" ou "L1234-1"
   - "R. 2242-1" (articles réglementaires)
   - "D. 1234-56" (articles décrets)
   → Recherche exacte dans NUM_ARTICLE (normalisé automatiquement)

2. MOTS-CLÉS SIMPLES:
   - "licenciement économique" → cherche les 2 mots (ET automatique)
   - "faute grave" → cherche les 2 mots

3. OPÉRATEUR ET EXPLICITE:
   - "licenciement" ET "motif économique" → les 2 termes obligatoires

4. OPÉRATEUR OU EXPLICITE:
   - "démission" OU "rupture conventionnelle" → au moins un des termes

5. EXPRESSION EXACTE (guillemets):
   - "clause de non-concurrence" → phrase exacte
   - "faute lourde de l'employeur" → expression exacte

6. COMBINAISONS:
   - "L1234-1 ET indemnité" → article + mot-clé
   - "Code du travail" ET "licenciement" ET "économique"

EXEMPLES CONCRETS:
- "L1235-3" → trouve l'article L. 1235-3 (indemnité licenciement)
- "licenciement pour motif économique" → articles sur ce sujet
- "clause de mobilité" → expression exacte
- "préavis" ET "démission" → articles contenant les 2 mots
- "rupture" OU "résiliation" → articles avec l'un ou l'autre

NOTE: Incluez le nom du code dans la query pour cibler un code spécifique (ex: "752 code de procédure civile")."""
                },
                "date": {
                    "type": "string",
                    "description": "Date de vigueur souhaitée au format YYYY-MM-DD (ex: '2020-01-15'). Par défaut, seuls les articles EN VIGUEUR aujourd'hui sont recherchés. Utilisez ce paramètre pour obtenir la version d'un article valable à une date passée."
                },
                "sort": {
                    "type": "string",
                    "enum": ["PERTINENCE", "DATE_VERSION_ASC", "DATE_VERSION_DESC"],
                    "default": "PERTINENCE",
                    "description": "Tri des résultats"
                },
                "page_size": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 50,
                    "default": 10,
                    "description": "Nombre de résultats par page"
                },
                "page_number": {
                    "type": "integer",
                    "minimum": 1,
                    "default": 1,
                    "description": "Numéro de page"
                }
            },
            "required": ["query"]
        }
    },
        {
            "name": "consulter_decision",
            "description": "Get Jurisprudence content with Legifrance API & return result with link https://www.legifrance.gouv.fr/juri/id/{text_id}",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "text_id": {
                        "type": "string",
                        "description": "Should be in format : 'JURITEXT000006949246')"
                    }
                },
                "required": ["text_id"]
            }
        },
    # ============================================================================
    # TOOL 4 : TRACKING (BODACC)
    # ============================================================================
    {
        "name": "Tracking_BODACC",
        "description": "Search French BODACC for company situation with its SIREN number(procédure collective)",
        "inputSchema": {
            "type": "object",
            "properties": {
                "siren": {
                    "type": "string",
                    "description": "Numéro SIREN de l'entreprise (9 chiffres)"
                },
                "type_recherche": {
                    "type": "string",
                    "enum": ["complet", "procedures_collectives", "historique"],
                    "description": "Type de recherche à effectuer",
                    "default": "complet"
                }
            },
            "required": ["siren"]
        }
    },
    
]

# ============================================================================
# RESSOURCES MCP
# ============================================================================

MCP_RESOURCES = [
    {
        "uri": "resource://dictionnaire-juridique",
        "name": "Dictionnaire juridique",
        "description": "Définitions et terminologie juridique française",
        "mimeType": "text/markdown"
    },
    {
        "uri": "resource://guide-conclusions",
        "name": "Guide de rédaction des conclusions",
        "description": "Guide complet pour rédiger des conclusions juridiques",
        "mimeType": "text/markdown"
    },
    {
        "uri": "resource://exemples-rappel-faits",
        "name": "Exemples de rappel des faits",
        "description": "Exemples de rédaction de rappel des faits",
        "mimeType": "text/markdown"
    },
    {
        "uri": "resource://exemples-discussion",
        "name": "Exemples de discussion",
        "description": "Exemples de rédaction de discussion juridique",
        "mimeType": "text/markdown"
    },
    {
        "uri": "resource://exemples-dispositif",
        "name": "Exemples de dispositif",
        "description": "Exemples de rédaction de dispositif",
        "mimeType": "text/markdown"
    }
]

# ============================================================================
# PROMPTS MCP
# ============================================================================

MCP_PROMPTS = [
    {
        "name": "workflow_conclusions",
        "description": "Workflow complet de génération de conclusions",
        "arguments": []
    }
]


# ============================================================================
# MAPPING FILTRES PAR FOND
# ============================================================================
