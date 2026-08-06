#/tools/handlers.py 
#! MCP SERVEUR LOCAL
"""Handlers pour les outils MCP"""

import json
import os
from datetime import datetime, timedelta
from typing import Dict, Any, Optional

from tools.session_manager import session_manager
from tools.case_manager import case_manager
from tools.legifrance_client import legifrance_client
from tools.bodacc_client import bodacc_client
from tools.query_parser import parse_query
from tools.code_parser import parse_code_query
LEGIFRANCE_BASE_URL = "https://www.legifrance.gouv.fr"

def create_response(text: str, resource: Dict = None, is_error: bool = False) -> Dict[str, Any]:
    """Crée une réponse MCP formatée"""
    content = [{"type": "text", "text": text}]
    if resource:
        content.append({"type": "resource", "resource": resource})
    return {"content": content, "isError": is_error}

def handle_tracking_bodacc(args: Dict[str, Any], user_id: str) -> Dict[str, Any]:
    """TOOL 4 : Vérification SIREN via BODACC"""
    siren = args.get("siren")
    type_recherche = args.get("type_recherche", "complet")
    
    if type_recherche == "procedures_collectives":
        result = bodacc_client.get_procedures_collectives(siren)
    elif type_recherche == "historique":
        result = bodacc_client.get_company_history(siren)
    else:
        result = bodacc_client.get_company_history(siren)
    
    if not result.get("success"):
        return create_response(result.get("error", "Erreur BODACC"), is_error=True)
    
    alertes = result.get("alertes", [])
    total = result.get("total_annonces", 0)
    
    summary = f"""Vérification SIREN {siren}

**Total annonces BODACC:** {total}"""
    
    if alertes:
        summary += "\n\n**⚠️ ALERTES:**"
        for alerte in alertes:
            summary += f"\n{alerte}"
    else:
        summary += "\n\n✅ Aucune alerte détectée"
    
    return create_response(
        summary,
        resource={
            "uri": f"bodacc://siren/{siren}",
            "mimeType": "application/json",
            "text": json.dumps(result, ensure_ascii=False, indent=2)
        }
    )


def handle_recherche_jurisprudence(args: Dict[str, Any], user_id: str) -> Dict[str, Any]:
    """
    Recherche dans la jurisprudence (JURI)
    """
    fond = args.get("fond", "JURI")
    query = args.get("query")
    
    # Paramètres de recherche
    type_champ = args.get("type_champ", "ALL")
    type_recherche = args.get("type_recherche", "UN_DES_MOTS")
    proximite = args.get("proximite", 10)
    operateur = args.get("operateur", "OU")  # ✅ Ajout opérateur
    filtres = args.get("filtres", [])
    
    # Pagination et tri
    page_number = args.get("page_number", 1)
    page_size = args.get("page_size", 10)
    sort = args.get("sort", "PERTINENCE")
    
    try:
        result = legifrance_client.search(
            fond=fond,
            query=query,
            filtres=filtres,
            type_champ=type_champ,
            type_recherche=type_recherche,
            proximite=proximite,
            operateur=operateur,  # ✅ Passé à l'API
            page_number=page_number,
            page_size=page_size,
            sort=sort,
            second_sort="ID",
            type_pagination="DEFAUT"
        )
        
        # Construire le résumé
        total = result.get("totalResultNumber", 0)
        resultats = result.get("results", [])
        
        summary_parts = [
            f"**RECHERCHE JURISPRUDENCE - {fond}**",
            f"**Requête:** {query}",
            f"**Type de champ:** {type_champ}",
            f"**Résultats:** {len(resultats)} sur {total} total",
            ""
        ]
        
        # Formatter selon le fond
        if fond == "JURI":
            summary_parts.append("**JURISPRUDENCE JUDICIAIRE:**")
            summary_parts.append("")
            
            for i, r in enumerate(resultats, 1):
                # ✅ TOUS LES CHAMPS EXTRAITS
                
                # titles
                titles = r.get("titles", [])
                if titles:
                    titre_complet = titles[0].get("title", "")
                    juri_id = titles[0].get("id", "")
                    cid = titles[0].get("cid", "")
                else:
                    titre_complet = "Titre non disponible"
                    juri_id = ""
                    cid = ""
                
                # Champs de base
                nature = r.get("nature", "")
                origin = r.get("origin", "")
                type_doc = r.get("type", "")
                etat = r.get("etat")
                date = r.get("date")
                num = r.get("num")
                
                # Texte et extraits
                texte_extrait = r.get("text", "")
                
                # Résumés
                resume_principal = r.get("resumePrincipal", [])
                autre_resume = r.get("autreResume", [])
                
                # Sections (contient Abstrat, Résumé, etc.)
                sections = r.get("sections", [])
                
                # JORF (si applicable)
                jorf_text = r.get("jorfText")
                num_parution = r.get("numParution")
                date_publication = r.get("datePublication")
                
                # Métadonnées juridiques
                dossiers_legislatifs = r.get("dossiersLegislatifs", [])
                nor = r.get("nor")
                mots_cles = r.get("motsCles", [])
                appellations = r.get("appellations", [])
                themes = r.get("themes", [])
                conforme = r.get("conforme", False)
                
                # Pièces jointes
                id_attachment = r.get("idAttachment")
                size_attachment = r.get("sizeAttachment")
                
                # Conventions collectives (si KALI)
                raison_sociale = r.get("raisonSociale")
                idcc = r.get("idcc")
                
                # Autres
                description_fusion = r.get("descriptionFusionHtml")
                date_signature = r.get("dateSignature")
                date_diffusion = r.get("dateDiffusion")
                reference = r.get("reference")
                more_article = r.get("moreArticle", False)
                additional_result = r.get("additionalResult", {})
                
                # ===== AFFICHAGE COMPLET =====
                summary_parts.append(f"**═══ DÉCISION N°{i} ═══**")
                summary_parts.append(f"**Titre:** {titre_complet}")
                summary_parts.append(f"**ID:** {juri_id} | CID: {cid}")
                summary_parts.append(f"**Nature:** {nature} | Type: {type_doc} | Origine: {origin}")
                
                if date:
                    summary_parts.append(f"**Date:** {date}")
                if num:
                    summary_parts.append(f"**Numéro:** {num}")
                if etat:
                    summary_parts.append(f"**État:** {etat}")
                
                summary_parts.append(f"🔗 [Lire sur Légifrance](https://www.legifrance.gouv.fr/juri/id/{juri_id})")
                summary_parts.append("")
                
                # Résumés
                if resume_principal:
                    summary_parts.append("**📋 Résumé principal:**")
                    for res in resume_principal:
                        summary_parts.append(f"   {res}")
                    summary_parts.append("")
                
                if autre_resume:
                    summary_parts.append("**📋 Autre résumé:**")
                    for res in autre_resume:
                        summary_parts.append(f"   {res}")
                    summary_parts.append("")
                
                # Sections (Abstrats, etc.)
                if sections:
                    summary_parts.append("**📄 Sections:**")
                    for section in sections:
                        extracts = section.get("extracts", [])
                        for extract in extracts:
                            field_name = extract.get("searchFieldName", "")
                            values = extract.get("values", [])
                            if values:
                                summary_parts.append(f"   • {field_name}:")
                                for val in values[:2]:  # Limiter à 2 valeurs
                                    summary_parts.append(f"     {val[:300]}...")
                    summary_parts.append("")
                
                # Extrait de texte
                if texte_extrait:
                    summary_parts.append("**📝 Extrait:**")
                    summary_parts.append(f"   {texte_extrait[:500]}...")
                    summary_parts.append("")
                
                # Métadonnées supplémentaires
                if mots_cles:
                    summary_parts.append(f"**🏷️ Mots-clés:** {', '.join(mots_cles)}")
                
                if themes:
                    summary_parts.append(f"**📚 Thèmes:** {', '.join(themes)}")
                
                if nor:
                    summary_parts.append(f"**NOR:** {nor}")
                
                if date_signature:
                    summary_parts.append(f"**Date signature:** {date_signature}")
                
                if date_publication:
                    summary_parts.append(f"**Date publication:** {date_publication}")
                
                if dossiers_legislatifs:
                    summary_parts.append(f"**Dossiers législatifs:** {len(dossiers_legislatifs)}")
                
                if id_attachment:
                    summary_parts.append(f"**📎 Pièce jointe:** ID {id_attachment} ({size_attachment} octets)")
                
                if raison_sociale:
                    summary_parts.append(f"**Raison sociale:** {raison_sociale}")
                
                if idcc:
                    summary_parts.append(f"**IDCC:** {idcc}")
                
                if conforme:
                    summary_parts.append("**✅ Conforme**")
                
                summary_parts.append("")
                summary_parts.append("─" * 80)
                summary_parts.append("")
        
        # Informations sur les filtres appliqués
        if filtres:
            summary_parts.append("**Filtres appliqués:**")
            for f in filtres:
                facette = f.get("facette")
                if "dates" in f:
                    dates = f["dates"]
                    summary_parts.append(f"• {facette}: {dates.get('start')} → {dates.get('end')}")
                elif "valeurs" in f:
                    summary_parts.append(f"• {facette}: {', '.join(f['valeurs'])}")
                elif "valeur" in f:
                    summary_parts.append(f"• {facette}: {f['valeur']}")
        
        summary = "\n".join(summary_parts)
        
        return create_response(
            summary,
            resource={
                "uri": f"legifrance://jurisprudence/{fond}/{hash(query)}",
                "mimeType": "application/json",
                "text": json.dumps(result, ensure_ascii=False, indent=2)
            }
        )
    
    except Exception as e:
        return create_response(
            f"❌ **Erreur lors de la recherche jurisprudence**\n\n"
            f"Fond: {fond}\n"
            f"Requête: {query}\n"
            f"Erreur: {str(e)}\n\n"
            f"Vérifiez que les paramètres et filtres sont corrects.",
            is_error=True
        )
    
def handle_consulter_decision(args: Dict[str, Any], user_id: str) -> Dict[str, Any]:
    """
    Récupère le texte intégral d'une décision de jurisprudence.
    Retourne uniquement: nature, titre, visas, texte, decisionAttaquee
    """
    text_id = args.get("text_id") or args.get("id")

    if not text_id:
        return create_response("text_id requis", is_error=True)

    # Nettoyer l'ID
    text_id = text_id.strip()

    try:
        result = legifrance_client.get_decision_text(text_id)

        # Extraire uniquement les champs demandés
        text = result.get("text", {})

        nature = text.get("nature", "")
        titre = text.get("titre", "")
        visas = text.get("visas", "")
        texte = text.get("texte", "")
        decision_attaquee = text.get("decisionAttaquee", {})

        # Tronquer le texte si "MOYENS ANNEXES" présent (Cour de cassation)
        if "MOYENS ANNEXES" in texte:
            moyens_index = texte.find("MOYENS ANNEXES")
            texte = texte[:moyens_index] + "..."

        # Construction de la réponse synthétique
        summary_parts = [
            f"DÉCISION: {titre}",
            f"",
            f"Nature: {nature}",
        ]

        # Visas (si présents)
        if visas:
            summary_parts.append(f"")
            summary_parts.append(f"VISAS:")
            summary_parts.append(visas)

        # Décision attaquée (si présente)
        if decision_attaquee:
            formation = decision_attaquee.get("formation", "")
            date_da = decision_attaquee.get("date", "")
            if formation or date_da:
                summary_parts.append(f"")
                summary_parts.append(f"Décision attaquée: {formation}")
                if date_da:
                    from datetime import datetime
                    date_str = datetime.fromtimestamp(date_da / 1000).strftime("%d/%m/%Y")
                    summary_parts.append(f"Date: {date_str}")

        # Texte intégral
        summary_parts.append(f"")
        summary_parts.append(f"{'='*80}")
        summary_parts.append(f"TEXTE INTÉGRAL:")
        summary_parts.append(f"{'='*80}")
        summary_parts.append(f"")
        summary_parts.append(texte)
        summary_parts.append(f"")
        summary_parts.append(f"Lien: {LEGIFRANCE_BASE_URL}/juri/id/{text_id}")

        summary = "\n".join(summary_parts)

        # Compter les tokens approximatifs (1 token ≈ 4 caractères)
        estimated_tokens = len(summary) // 4

        # Si > 25000 tokens, déclencher un téléchargement automatique
        if estimated_tokens > 25000:
            # Nettoyer le titre pour le nom de fichier
            safe_titre = "".join(c for c in titre if c.isalnum() or c in (' ', '-', '_')).strip()[:100]
            filename = f"decision_{text_id}_{safe_titre}.txt"

            # Retourner un message court avec la ressource téléchargeable
            short_summary = "\n".join([
                f"DÉCISION: {titre}",
                f"",
                f"⚠️ **Décision trop longue** (≈ {estimated_tokens:,} tokens)".replace(',', ' '),
                f"",
                f"📥 **Téléchargement automatique:** {filename}",
                f"",
                f"Nature: {nature}",
                f"Lien: {LEGIFRANCE_BASE_URL}/juri/id/{text_id}",
                f"",
                f"Le texte intégral sera téléchargé automatiquement."
            ])

            return create_response(
                short_summary,
                resource={
                    "uri": f"data:text/plain;base64,{summary}",
                    "mimeType": "text/plain",
                    "text": summary,
                    "blob": summary.encode('utf-8')
                }
            )

        return create_response(summary)

    except Exception as e:
        return create_response(
            f"❌ **Erreur consultation décision**\n\n"
            f"ID: {text_id}\n"
            f"Erreur: {str(e)}",
            is_error=True
        )

def handle_consulter_article(args: Dict[str, Any], user_id: str) -> Dict[str, Any]:
    """
    Récupère le contenu complet d'un article de code
    """
    article_id = args.get("article_id") or args.get("id")

    if not article_id:
        return create_response("article_id requis", is_error=True)

    article_id = article_id.strip()

    try:
        result = legifrance_client.get_article(article_id)

        # Extraction des informations
        article = result.get("article", {})

        # Informations essentielles
        num = article.get("num", "Article")
        texte = article.get("texte", "")

        # Dates (convertir millisecondes en format lisible)
        date_debut_ms = article.get("dateDebut", 0)
        date_fin_ms = article.get("dateFin", 0)

        from datetime import datetime
        if date_debut_ms:
            date_debut_str = datetime.fromtimestamp(date_debut_ms / 1000).strftime("%Y-%m-%d")
        else:
            date_debut_str = "?"

        if date_fin_ms:
            date_fin_str = datetime.fromtimestamp(date_fin_ms / 1000).strftime("%Y-%m-%d")
        else:
            date_fin_str = "en vigueur"

        # Section
        section_titre = article.get("sectionParentTitre", "")

        # Obtenir le nom du code depuis le contexte
        context = article.get("context", {})
        titre_txt = context.get("titreTxt", [])
        code_nom = titre_txt[0].get("titre", "") if titre_txt else ""

        # Construction de la réponse simplifiée
        summary_parts = [
            f"**{num}**",
            ""
        ]

        if code_nom:
            summary_parts.append(f"Code: {code_nom}")

        if section_titre:
            summary_parts.append(f"Section: {section_titre}")

        summary_parts.extend([
            f"Validité: {date_debut_str} → {date_fin_str}",
            "",
            texte if texte else "_Texte non disponible_"
        ])

        summary = "\n".join(summary_parts)

        return create_response(summary)

    except Exception as e:
        return create_response(
            f"<tool-use-error>\n"
            f"Erreur consultation article\n"
            f"ID: {article_id}\n"
            f"Erreur: {str(e)}\n"
            f"</tool-use-error>",
            is_error=True
        )

# ============================================================================
# NOUVEAUX HANDLERS - RECHERCHE JURISPRUDENCE OPTIMISÉE
# ============================================================================

def handle_search_cour_cassation(args: Dict[str, Any], user_id: str) -> Dict[str, Any]:
    """Recherche Cour de cassation avec parsing intelligent de la query"""

    query = args.get("query", "").strip()

    # Parser la query pour extraire opérateurs et termes
    operateur_query, type_recherche, criteres_parsed = parse_query(query)
    type_champ = "ALL"

    # Dates par défaut : 5 ans
    date_fin = args.get("date_fin")
    date_debut = args.get("date_debut")
    if not date_fin:
        date_fin = datetime.now().strftime("%Y-%m-%d")
    if not date_debut:
        date_debut = (datetime.now() - timedelta(days=5*365)).strftime("%Y-%m-%d")

    # Pagination et tri
    sort = "PERTINENCE"  # Fixé sur PERTINENCE
    page_size = args.get("page_size", 10)
    page_number = args.get("page_number", 1)

    # Construction des filtres
    filtres = [
        {
            "facette": "JURIDICTION_JUDICIAIRE",
            "valeurs": ["Cour de cassation"]
        },
        {
            "facette": "DATE_DECISION",
            "dates": {
                "start": date_debut,
                "end": date_fin
            }
        }
    ]

    # Filtre MATIERE → mapper vers formations API
    matiere = args.get("matiere", "TOUTES")
    if matiere != "TOUTES":
        # Mapping des matières simples vers les formations Cour de cassation
        mapping_matieres = {
            "CIVIL": ["CHAMBRE_CIVILE_1", "CHAMBRE_CIVILE_2", "CHAMBRE_CIVILE_3", "CHAMBRE_CIVILE", "ASSEMBLEE_PLENIERE", "CHAMBRE_MIXTE", "CHAMBRES_REUNIES", "AVIS"],
            "COMMERCIAL": ["CHAMBRE_COMMERCIALE", "ASSEMBLEE_PLENIERE", "CHAMBRE_MIXTE", "CHAMBRES_REUNIES", "AVIS"],
            "PENAL": ["CHAMBRE_CRIMINELLE", "ASSEMBLEE_PLENIERE", "CHAMBRE_MIXTE", "CHAMBRES_REUNIES", "AVIS"],
            "SOCIAL": ["CHAMBRE_SOCIALE", "ASSEMBLEE_PLENIERE", "CHAMBRE_MIXTE", "CHAMBRES_REUNIES", "AVIS"]
        }
        formations_api = mapping_matieres.get(matiere, [])
        if formations_api:
            filtres.append({
                "facette": "CASSATION_FORMATION",
                "valeurs": formations_api
            })

    # Filtre PUBLICATION
    publication = args.get("CASSATION_TYPE_PUBLICATION_BULLETIN", "TOUS")
    if publication != "TOUS":
        valeur_pub = "T" if publication == "PUBLIE" else "F"
        filtres.append({
            "facette": "CASSATION_TYPE_PUBLICATION_BULLETIN",
            "valeurs": [valeur_pub]
        })

    # Filtre NATURE_DECISION
    natures = args.get("CASSATION_NATURE_DECISION", ["TOUS"])
    if natures and natures != ["TOUS"] and "TOUS" not in natures:
        # Mapper vers les valeurs API correctes
        nature_mapping = {
            "CASSATION": "arret",  # En fait l'API ne distingue pas, c'est dans le texte
            "REJET": "arret",
            "CASSATION_PARTIELLE": "arret"
        }
        # Pour l'instant on ne filtre pas car l'API ne fournit pas cette facette directement
        pass

    try:
        # Appel API avec critères parsés
        # On passe directement les critères au lieu de laisser legifrance_client splitter la query
        result = legifrance_client.search_with_criteres(
            fond="JURI",
            criteres=criteres_parsed,
            operateur=operateur_query,
            filtres=filtres,
            type_champ=type_champ,
            page_number=page_number,
            page_size=page_size,
            sort=sort
        )

        # Construction du résumé
        total = result.get("totalResultNumber", 0)
        resultats = result.get("results", [])

        # Vérifier si la requête est trop large (> 500 résultats)
        if total > 500:
            return create_response(
                f"<tool-use-error>\n"
                f"Requête trop large: {total} résultats trouvés (max 500).\n\n"
                f"Affinez avec:\n"
                f"- Mots-clés plus spécifiques ou opérateurs (ET, OU, \"exacte\")\n"
                f"- Article ciblé (ex: \"L. 1235-3\")\n\n"
                f"Note: Réduire la période seule ne garantit pas la pertinence.\n"
                f"</tool-use-error>",
                is_error=True
            )

        matiere_str = matiere if matiere != "TOUTES" else "TOUTES"

        summary_parts = [
            f"**🏛️ COUR DE CASSATION**",
            f"",
            f"**Requête:** {query}",
            f"**Matière:** {matiere_str}",
            f"**Période:** {date_debut} → {date_fin}",
            f"**Total:** {total:,} décisions".replace(',', ' '),
            f"**Affichées:** {len(resultats)} résultats",
            f""
        ]

        if publication != "TOUS":
            summary_parts.append(f"**Publication:** {publication}")

        summary_parts.append("")
        summary_parts.append("═" * 80)
        summary_parts.append("")

        # Formater les résultats
        for i, r in enumerate(resultats, 1):
            titles = r.get("titles", [])
            if titles:
                titre = titles[0].get("title", "")
                juri_id = titles[0].get("id", "")
            else:
                titre = "Sans titre"
                juri_id = ""

            # Titre de la décision
            summary_parts.append(f"{i}. {titre}")

            # Lien Légifrance
            if juri_id:
                summary_parts.append(f"   Lien: https://www.legifrance.gouv.fr/juri/id/{juri_id}")

            # Extraire l'Abstrat (analyse), résumé et articles visés depuis les sections/extracts
            sections = r.get("sections", [])
            abstrat_found = False
            resume_found = False
            articles_vises = []

            for section in sections:
                extracts = section.get("extracts", [])
                for extract in extracts:
                    field_name = extract.get("searchFieldName", "")
                    values = extract.get("values", [])

                    # Récupérer l'Abstrat (analyse juridique) - arrêts publiés
                    if field_name == "Abstrat" and values and not abstrat_found:
                        abstrat_text = values[0].replace("<mark>", "**").replace("</mark>", "**")
                        # Nettoyer les [...] au début et fin
                        abstrat_text = abstrat_text.strip()
                        if abstrat_text.startswith("[...]"):
                            abstrat_text = abstrat_text[5:].strip()
                        if abstrat_text.endswith("[...]"):
                            abstrat_text = abstrat_text[:-5].strip()

                        summary_parts.append(f"   Analyse: {abstrat_text}")
                        abstrat_found = True

                    # Si pas d'Abstrat, afficher le Résumé principal (arrêts inédits)
                    elif field_name == "Résumé principal" and values and not abstrat_found and not resume_found:
                        resume_text = values[0].replace("<mark>", "**").replace("</mark>", "**")
                        resume_text = resume_text.strip()
                        if resume_text.startswith("[...]"):
                            resume_text = resume_text[5:].strip()
                        if resume_text.endswith("[...]"):
                            resume_text = resume_text[:-5].strip()

                        summary_parts.append(f"   Analyse: {resume_text}")
                        resume_found = True

                    # Récupérer les articles visés
                    elif field_name == "Texte appliqué" and values:
                        for val in values:
                            clean = val.replace("<mark>", "").replace("</mark>", "").replace("[...]", "").strip()
                            if clean and clean not in articles_vises:
                                articles_vises.append(clean)

            # Si aucune analyse trouvée (arrêt inédit), afficher les extraits du champ text
            if not abstrat_found and not resume_found:
                text_content = r.get("text", "")
                if text_content:
                    # Nettoyer les balises et garder les extraits
                    text_clean = text_content.replace("<mark>", "**").replace("</mark>", "**")
                    summary_parts.append(f"   Extraits: {text_clean}")

            # Afficher les articles visés
            if articles_vises:
                summary_parts.append(f"   Articles visés: {', '.join(articles_vises[:3])}")
                if len(articles_vises) > 3:
                    summary_parts.append(f"   ... et {len(articles_vises) - 3} autre(s)")

            summary_parts.append("")

        summary = "\n".join(summary_parts)

        return create_response(summary)

    except Exception as e:
        return create_response(
            f"❌ **Erreur recherche Cour de cassation**\n\n"
            f"Requête: {query}\n"
            f"Erreur: {str(e)}",
            is_error=True
        )


def handle_search_cour_appel(args: Dict[str, Any], user_id: str) -> Dict[str, Any]:
    """Recherche Cours d'appel avec parsing intelligent de la query"""

    query = args.get("query", "").strip()

    # Parser la query
    operateur_query, type_recherche, criteres_parsed = parse_query(query)
    type_champ = "ALL"

    # Dates par défaut : 3 ans (volume plus élevé)
    date_fin = args.get("date_fin")
    date_debut = args.get("date_debut")
    if not date_fin:
        date_fin = datetime.now().strftime("%Y-%m-%d")
    if not date_debut:
        date_debut = (datetime.now() - timedelta(days=3*365)).strftime("%Y-%m-%d")

    sort = args.get("sort", "DATE_DESC")
    page_size = args.get("page_size", 15)
    page_number = args.get("page_number", 1)

    # Construction des filtres
    filtres = [
        {
            "facette": "JURIDICTION_JUDICIAIRE",
            "valeurs": ["Juridictions d'appel"]
        },
        {
            "facette": "DATE_DECISION",
            "dates": {
                "start": date_debut,
                "end": date_fin
            }
        }
    ]

    # Filtre APPEL_SIEGE_APPEL
    sieges = args.get("APPEL_SIEGE_APPEL", [])
    if sieges:
        filtres.append({
            "facette": "APPEL_SIEGE_APPEL",
            "valeurs": sieges
        })

    try:
        result = legifrance_client.search_with_criteres(
            fond="JURI",
            criteres=criteres_parsed,
            operateur=operateur_query,
            filtres=filtres,
            type_champ=type_champ,
            page_number=page_number,
            page_size=page_size,
            sort=sort
        )

        total = result.get("totalResultNumber", 0)
        resultats = result.get("results", [])

        # Vérifier si la requête est trop large (> 500 résultats)
        if total > 500:
            return create_response(
                f"<tool-use-error>\n"
                f"Requête trop large: {total} résultats trouvés (max 500).\n\n"
                f"Affinez avec:\n"
                f"- Mots-clés plus spécifiques ou opérateurs (ET, OU, \"exacte\")\n"
                f"- Article ciblé (ex: \"L. 1235-3\")\n\n"
                f"Note: Réduire la période seule ne garantit pas la pertinence.\n"
                f"</tool-use-error>",
                is_error=True
            )

        sieges_str = ", ".join(sieges) if sieges else "TOUTES"

        summary_parts = [
            f"**⚖️ COURS D'APPEL**",
            f"",
            f"**Requête:** {query}",
            f"**Cour(s):** {sieges_str}",
            f"**Période:** {date_debut} → {date_fin}",
            f"**Total:** {total:,} décisions".replace(',', ' '),
            f"**Affichées:** {len(resultats)}",
            f"",
            "═" * 80,
            ""
        ]

        for i, r in enumerate(resultats, 1):
            titles = r.get("titles", [])
            if titles:
                titre = titles[0].get("title", "")
                juri_id = titles[0].get("id", "")
            else:
                titre = "Sans titre"
                juri_id = ""

            # Titre de la décision
            summary_parts.append(f"{i}. {titre}")

            # Lien Légifrance
            if juri_id:
                summary_parts.append(f"   Lien: https://www.legifrance.gouv.fr/juri/id/{juri_id}")

            # Extraire l'Abstrat (analyse) et articles visés
            sections = r.get("sections", [])
            abstrat_found = False
            resume_found = False
            articles_vises = []

            for section in sections:
                extracts = section.get("extracts", [])
                for extract in extracts:
                    field_name = extract.get("searchFieldName", "")
                    values = extract.get("values", [])

                    # Récupérer l'Abstrat (analyse juridique)
                    if field_name == "Abstrat" and values and not abstrat_found:
                        abstrat_text = values[0].replace("<mark>", "**").replace("</mark>", "**")
                        abstrat_text = abstrat_text.strip()
                        if abstrat_text.startswith("[...]"):
                            abstrat_text = abstrat_text[5:].strip()
                        if abstrat_text.endswith("[...]"):
                            abstrat_text = abstrat_text[:-5].strip()

                        summary_parts.append(f"   Analyse: {abstrat_text}")
                        abstrat_found = True

                    # Si pas d'Abstrat, afficher le Résumé principal (arrêts inédits)
                    elif field_name == "Résumé principal" and values and not abstrat_found and not resume_found:
                        resume_text = values[0].replace("<mark>", "**").replace("</mark>", "**")
                        resume_text = resume_text.strip()
                        if resume_text.startswith("[...]"):
                            resume_text = resume_text[5:].strip()
                        if resume_text.endswith("[...]"):
                            resume_text = resume_text[:-5].strip()

                        summary_parts.append(f"   Analyse: {resume_text}")
                        resume_found = True

                    # Récupérer les articles visés
                    elif field_name == "Texte appliqué" and values:
                        for val in values:
                            clean = val.replace("<mark>", "").replace("</mark>", "").replace("[...]", "").strip()
                            if clean and clean not in articles_vises:
                                articles_vises.append(clean)

            # Si aucune analyse trouvée (arrêt inédit), afficher les extraits du champ text
            if not abstrat_found and not resume_found:
                text_content = r.get("text", "")
                if text_content:
                    # Nettoyer les balises et garder les extraits
                    text_clean = text_content.replace("<mark>", "**").replace("</mark>", "**")
                    summary_parts.append(f"   Extraits: {text_clean}")

            # Afficher les articles visés
            if articles_vises:
                summary_parts.append(f"   Articles visés: {', '.join(articles_vises[:3])}")
                if len(articles_vises) > 3:
                    summary_parts.append(f"   ... et {len(articles_vises) - 3} autre(s)")

            summary_parts.append("")

        summary = "\n".join(summary_parts)

        return create_response(summary)

    except Exception as e:
        return create_response(
            f"❌ **Erreur recherche Cours d'appel**\n\n"
            f"Erreur: {str(e)}",
            is_error=True
        )


def handle_search_conseil_etat(args: Dict[str, Any], user_id: str) -> Dict[str, Any]:
    """Recherche Conseil d'État avec parsing intelligent de la query"""

    query = args.get("query", "").strip()

    # Parser la query pour extraire opérateurs et termes
    operateur_query, type_recherche, criteres_parsed = parse_query(query)
    type_champ = "ALL"

    # Dates par défaut : 5 ans
    date_fin = args.get("date_fin")
    date_debut = args.get("date_debut")
    if not date_fin:
        date_fin = datetime.now().strftime("%Y-%m-%d")
    if not date_debut:
        date_debut = (datetime.now() - timedelta(days=5*365)).strftime("%Y-%m-%d")

    # Pagination et tri
    sort = "PERTINENCE"
    page_size = args.get("page_size", 10)
    page_number = args.get("page_number", 1)

    # Construction des filtres
    filtres = [
        {
            "facette": "DATE_DECISION",
            "dates": {
                "start": date_debut,
                "end": date_fin
            }
        }
    ]

    # Filtre PUBLICATION_RECUEIL
    publication = args.get("PUBLICATION_RECUEIL", "TOUS")
    if publication != "TOUS":
        valeur_pub = "PUBLIE" if publication == "PUBLIE" else "NON_PUBLIE"
        filtres.append({
            "facette": "PUBLICATION_RECUEIL",
            "valeurs": [valeur_pub]
        })

    try:
        # Appel API
        result = legifrance_client.search_with_criteres(
            fond="CETAT",
            criteres=criteres_parsed,
            operateur=operateur_query,
            filtres=filtres,
            type_champ=type_champ,
            page_number=page_number,
            page_size=page_size,
            sort=sort
        )

        # Filtrer les résultats pour ne garder que le Conseil d'État
        total = result.get("totalResultNumber", 0)
        resultats_bruts = result.get("results", [])

        resultats = []
        for r in resultats_bruts:
            titre = r.get("titles", [{}])[0].get("title", "")
            if "Conseil d'État" in titre or "CE" in titre[:10]:
                resultats.append(r)

        # Vérifier si la requête est trop large (> 500 résultats)
        if total > 500:
            return create_response(
                f"<tool-use-error>\n"
                f"Requête trop large: {total} résultats trouvés (max 500).\n\n"
                f"Affinez avec:\n"
                f"- Mots-clés plus spécifiques ou opérateurs (ET, OU, \"exacte\")\n"
                f"- Article ciblé (ex: \"L. 1142-1\")\n\n"
                f"Note: Réduire la période seule ne garantit pas la pertinence.\n"
                f"</tool-use-error>",
                is_error=True
            )

        summary_parts = [
            f"**⚖️ CONSEIL D'ÉTAT**",
            f"",
            f"**Requête:** {query}",
            f"**Période:** {date_debut} → {date_fin}",
            f"**Total CETAT:** {total:,} décisions".replace(',', ' '),
            f"**Conseil d'État:** {len(resultats)} décisions affichées",
            f""
        ]

        if publication != "TOUS":
            summary_parts.append(f"**Publication:** {publication}")

        summary_parts.append("")
        summary_parts.append("═" * 80)
        summary_parts.append("")

        # Formater les résultats
        for i, r in enumerate(resultats, 1):
            titles = r.get("titles", [])
            if titles:
                titre = titles[0].get("title", "")
                juri_id = titles[0].get("id", "")
            else:
                titre = "Sans titre"
                juri_id = ""

            summary_parts.append(f"**{i}. {titre}**")
            summary_parts.append(f"   ID: {juri_id}")

            # Lien Légifrance
            if juri_id:
                summary_parts.append(f"   Lien: {LEGIFRANCE_BASE_URL}/cetat/id/{juri_id}")

            # Résumé principal si disponible
            resume_principal = r.get("resumePrincipal", [])
            if resume_principal:
                resume_text = resume_principal[0] if isinstance(resume_principal, list) else resume_principal
                resume_clean = resume_text.replace("<br/>", " ").strip()
                summary_parts.append(f"   Analyse: {resume_clean}")

            # Si pas de résumé principal, chercher dans les extraits
            sections = r.get("sections", [])
            abstrat_found = False
            resume_found = bool(resume_principal)

            for section in sections:
                extracts = section.get("extracts", [])
                for extract in extracts:
                    field_name = extract.get("searchFieldName", "")
                    values = extract.get("values", [])

                    if field_name == "Abstrat" and values and not abstrat_found:
                        abstrat_text = values[0].replace("[...]", "").strip()
                        abstrat_clean = abstrat_text.replace("<mark>", "**").replace("</mark>", "**")
                        if not resume_found:
                            summary_parts.append(f"   Analyse: {abstrat_clean}")
                        abstrat_found = True
                        break

            # Si aucune analyse trouvée (décision inédite), afficher les extraits du champ text
            if not abstrat_found and not resume_found:
                text_content = r.get("text", "")
                if text_content:
                    text_clean = text_content.replace("<mark>", "**").replace("</mark>", "**")
                    summary_parts.append(f"   Extraits: {text_clean}")

            summary_parts.append("")

        summary = "\n".join(summary_parts)

        return create_response(summary)

    except Exception as e:
        return create_response(
            f"<tool-use-error>\n"
            f"Erreur recherche Conseil d'État\n"
            f"Requête: {query}\n"
            f"Erreur: {str(e)}\n"
            f"</tool-use-error>",
            is_error=True
        )


def handle_search_caa(args: Dict[str, Any], user_id: str) -> Dict[str, Any]:
    """Recherche CAA avec parsing intelligent de la query"""

    query = args.get("query", "").strip()

    # Parser la query pour extraire opérateurs et termes
    operateur_query, type_recherche, criteres_parsed = parse_query(query)
    type_champ = "ALL"

    # Dates par défaut : 3 ans
    date_fin = args.get("date_fin")
    date_debut = args.get("date_debut")
    if not date_fin:
        date_fin = datetime.now().strftime("%Y-%m-%d")
    if not date_debut:
        date_debut = (datetime.now() - timedelta(days=3*365)).strftime("%Y-%m-%d")

    # Pagination et tri
    sort = "PERTINENCE"
    page_size = args.get("page_size", 15)
    page_number = args.get("page_number", 1)

    # Construction des filtres
    filtres = [
        {
            "facette": "DATE_DECISION",
            "dates": {
                "start": date_debut,
                "end": date_fin
            }
        }
    ]

    # Filtre PUBLICATION_RECUEIL
    publication = args.get("PUBLICATION_RECUEIL", "TOUS")
    if publication != "TOUS":
        valeur_pub = "PUBLIE" if publication == "PUBLIE" else "NON_PUBLIE"
        filtres.append({
            "facette": "PUBLICATION_RECUEIL",
            "valeurs": [valeur_pub]
        })

    # Filtre CAA_VILLE
    villes = args.get("CAA_VILLE", [])

    try:
        # Appel API
        result = legifrance_client.search_with_criteres(
            fond="CETAT",
            criteres=criteres_parsed,
            operateur=operateur_query,
            filtres=filtres,
            type_champ=type_champ,
            page_number=page_number,
            page_size=page_size,
            sort=sort
        )

        # Filtrer les résultats pour ne garder que les CAA
        total = result.get("totalResultNumber", 0)
        resultats_bruts = result.get("results", [])

        resultats = []
        for r in resultats_bruts:
            titre = r.get("titles", [{}])[0].get("title", "")

            # Vérifier que c'est une CAA
            if "CAA" not in titre:
                continue

            # Si filtre ville spécifié, vérifier la ville
            if villes:
                ville_trouvee = False
                for ville in villes:
                    if ville.upper() in titre.upper():
                        ville_trouvee = True
                        break
                if not ville_trouvee:
                    continue

            resultats.append(r)

        # Vérifier si la requête est trop large (> 500 résultats)
        if total > 500:
            return create_response(
                f"<tool-use-error>\n"
                f"Requête trop large: {total} résultats trouvés (max 500).\n\n"
                f"Affinez avec:\n"
                f"- Mots-clés plus spécifiques ou opérateurs (ET, OU, \"exacte\")\n"
                f"- Article ciblé (ex: \"L. 421-6\")\n"
                f"- Ville de la CAA\n\n"
                f"Note: Réduire la période seule ne garantit pas la pertinence.\n"
                f"</tool-use-error>",
                is_error=True
            )

        villes_str = ", ".join(villes) if villes else "TOUTES"

        summary_parts = [
            f"**⚖️ COURS ADMINISTRATIVES D'APPEL**",
            f"",
            f"**Requête:** {query}",
            f"**Ville(s):** {villes_str}",
            f"**Période:** {date_debut} → {date_fin}",
            f"**Total CETAT:** {total:,} décisions".replace(',', ' '),
            f"**CAA affichées:** {len(resultats)} décisions",
            f""
        ]

        if publication != "TOUS":
            summary_parts.append(f"**Publication:** {publication}")

        summary_parts.append("")
        summary_parts.append("═" * 80)
        summary_parts.append("")

        # Formater les résultats
        for i, r in enumerate(resultats, 1):
            titles = r.get("titles", [])
            if titles:
                titre = titles[0].get("title", "")
                juri_id = titles[0].get("id", "")
            else:
                titre = "Sans titre"
                juri_id = ""

            summary_parts.append(f"**{i}. {titre}**")
            summary_parts.append(f"   ID: {juri_id}")

            # Lien Légifrance
            if juri_id:
                summary_parts.append(f"   Lien: {LEGIFRANCE_BASE_URL}/cetat/id/{juri_id}")

            # Résumé principal si disponible
            resume_principal = r.get("resumePrincipal", [])
            if resume_principal:
                resume_text = resume_principal[0] if isinstance(resume_principal, list) else resume_principal
                resume_clean = resume_text.replace("<br/>", " ").strip()
                summary_parts.append(f"   Analyse: {resume_clean}")

            # Si pas de résumé principal, chercher dans les extraits
            sections = r.get("sections", [])
            abstrat_found = False
            resume_found = bool(resume_principal)

            for section in sections:
                extracts = section.get("extracts", [])
                for extract in extracts:
                    field_name = extract.get("searchFieldName", "")
                    values = extract.get("values", [])

                    if field_name == "Abstrat" and values and not abstrat_found:
                        abstrat_text = values[0].replace("[...]", "").strip()
                        abstrat_clean = abstrat_text.replace("<mark>", "**").replace("</mark>", "**")
                        if not resume_found:
                            summary_parts.append(f"   Analyse: {abstrat_clean}")
                        abstrat_found = True
                        break

            # Si aucune analyse trouvée (décision inédite), afficher les extraits du champ text
            if not abstrat_found and not resume_found:
                text_content = r.get("text", "")
                if text_content:
                    text_clean = text_content.replace("<mark>", "**").replace("</mark>", "**")
                    summary_parts.append(f"   Extraits: {text_clean}")

            summary_parts.append("")

        summary = "\n".join(summary_parts)

        return create_response(summary)

    except Exception as e:
        return create_response(
            f"<tool-use-error>\n"
            f"Erreur recherche CAA\n"
            f"Requête: {query}\n"
            f"Erreur: {str(e)}\n"
            f"</tool-use-error>",
            is_error=True
        )


def handle_search_premiere_instance(args: Dict[str, Any], user_id: str) -> Dict[str, Any]:
    """Recherche première instance avec parsing intelligent de la query"""

    query = args.get("query", "").strip()

    # Parser la query (utilise OU par défaut si pas d'opérateur explicite dans la query)
    operateur_query, type_recherche, criteres_parsed = parse_query(query)

    # Si la query ne contient pas d'opérateurs explicites ET/OU, forcer OU car volume faible
    if " ET " not in query.upper() and " OU " not in query.upper():
        operateur_query = "OU"
        # Mettre à jour les critères avec OU
        for c in criteres_parsed:
            c["operateur"] = "OU"

    type_champ = "ALL"

    # Dates par défaut : 5 ans
    date_fin = args.get("date_fin")
    date_debut = args.get("date_debut")
    if not date_fin:
        date_fin = datetime.now().strftime("%Y-%m-%d")
    if not date_debut:
        date_debut = (datetime.now() - timedelta(days=5*365)).strftime("%Y-%m-%d")

    sort = args.get("sort", "DATE_DESC")
    page_size = args.get("page_size", 20)
    page_number = args.get("page_number", 1)

    # Construction des filtres
    filtres = [
        {
            "facette": "JURIDICTION_JUDICIAIRE",
            "valeurs": ["Juridictions du premier degré"]
        },
        {
            "facette": "DATE_DECISION",
            "dates": {
                "start": date_debut,
                "end": date_fin
            }
        }
    ]

    # Filtre PREMIER_DEGRE_TYPE_JURIDICTION
    types_jur = args.get("PREMIER_DEGRE_TYPE_JURIDICTION", [])
    if types_jur:
        filtres.append({
            "facette": "PREMIER_DEGRE_TYPE_JURIDICTION",
            "valeurs": types_jur
        })

    try:
        result = legifrance_client.search_with_criteres(
            fond="JURI",
            criteres=criteres_parsed,
            operateur=operateur_query,
            filtres=filtres,
            type_champ=type_champ,
            page_number=page_number,
            page_size=page_size,
            sort=sort
        )

        total = result.get("totalResultNumber", 0)
        resultats = result.get("results", [])

        # Vérifier si la requête est trop large (> 500 résultats)
        if total > 500:
            return create_response(
                f"<tool-use-error>\n"
                f"Requête trop large: {total} résultats trouvés (max 500).\n\n"
                f"Affinez avec:\n"
                f"- Mots-clés plus spécifiques ou opérateurs (ET, OU, \"exacte\")\n"
                f"- Article ciblé (ex: \"L. 1235-3\")\n\n"
                f"Note: Réduire la période seule ne garantit pas la pertinence.\n"
                f"</tool-use-error>",
                is_error=True
            )

        types_str = ", ".join(types_jur) if types_jur else "TOUTES"

        summary_parts = [
            f"**📋 JURIDICTIONS DE PREMIÈRE INSTANCE**",
            f"",
            f"**Requête:** {query}",
            f"**Type(s):** {types_str}",
            f"**Période:** {date_debut} → {date_fin}",
            f"**Total:** {total} décisions",
            f"**Affichées:** {len(resultats)}",
            f"",
            f"⚠️ Volume très limité dans la base Légifrance",
            f"",
            "═" * 80,
            ""
        ]

        for i, r in enumerate(resultats, 1):
            titles = r.get("titles", [])
            if titles:
                titre = titles[0].get("title", "")
                juri_id = titles[0].get("id", "")
            else:
                titre = "Sans titre"
                juri_id = ""

            # Titre de la décision
            summary_parts.append(f"{i}. {titre}")

            # Lien Légifrance
            if juri_id:
                summary_parts.append(f"   Lien: https://www.legifrance.gouv.fr/juri/id/{juri_id}")

            # Extraire l'Abstrat (analyse) et articles visés
            sections = r.get("sections", [])
            abstrat_found = False
            resume_found = False
            articles_vises = []

            for section in sections:
                extracts = section.get("extracts", [])
                for extract in extracts:
                    field_name = extract.get("searchFieldName", "")
                    values = extract.get("values", [])

                    # Récupérer l'Abstrat (analyse juridique)
                    if field_name == "Abstrat" and values and not abstrat_found:
                        abstrat_text = values[0].replace("<mark>", "**").replace("</mark>", "**")
                        abstrat_text = abstrat_text.strip()
                        if abstrat_text.startswith("[...]"):
                            abstrat_text = abstrat_text[5:].strip()
                        if abstrat_text.endswith("[...]"):
                            abstrat_text = abstrat_text[:-5].strip()

                        summary_parts.append(f"   Analyse: {abstrat_text}")
                        abstrat_found = True

                    # Si pas d'Abstrat, afficher le Résumé principal (arrêts inédits)
                    elif field_name == "Résumé principal" and values and not abstrat_found and not resume_found:
                        resume_text = values[0].replace("<mark>", "**").replace("</mark>", "**")
                        resume_text = resume_text.strip()
                        if resume_text.startswith("[...]"):
                            resume_text = resume_text[5:].strip()
                        if resume_text.endswith("[...]"):
                            resume_text = resume_text[:-5].strip()

                        summary_parts.append(f"   Analyse: {resume_text}")
                        resume_found = True

                    # Récupérer les articles visés
                    elif field_name == "Texte appliqué" and values:
                        for val in values:
                            clean = val.replace("<mark>", "").replace("</mark>", "").replace("[...]", "").strip()
                            if clean and clean not in articles_vises:
                                articles_vises.append(clean)

            # Si aucune analyse trouvée (arrêt inédit), afficher les extraits du champ text
            if not abstrat_found and not resume_found:
                text_content = r.get("text", "")
                if text_content:
                    # Nettoyer les balises et garder les extraits
                    text_clean = text_content.replace("<mark>", "**").replace("</mark>", "**")
                    summary_parts.append(f"   Extraits: {text_clean}")

            # Afficher les articles visés
            if articles_vises:
                summary_parts.append(f"   Articles visés: {', '.join(articles_vises[:3])}")
                if len(articles_vises) > 3:
                    summary_parts.append(f"   ... et {len(articles_vises) - 3} autre(s)")

            summary_parts.append("")

        summary = "\n".join(summary_parts)

        return create_response(summary)

    except Exception as e:
        return create_response(
            f"❌ **Erreur recherche première instance**\n\n"
            f"Erreur: {str(e)}",
            is_error=True
        )


def handle_search_code(args: Dict[str, Any], user_id: str) -> Dict[str, Any]:
    """Recherche dans les codes juridiques avec parsing intelligent"""

    query = args.get("query", "").strip()

    # Parser la query pour détecter références d'articles et opérateurs
    operateur_query, type_recherche, criteres_parsed, type_champ = parse_code_query(query)

    # Pagination et tri
    sort = "PERTINENCE"  # Fixé sur PERTINENCE
    page_size = args.get("page_size", 10)
    page_number = args.get("page_number", 1)

    # Construction des filtres
    filtres = []

    # Filtre CODE (nom du code)
    codes = args.get("CODE", [])
    if codes:
        # Note: basé sur les tests API, le filtre CODE peut causer des erreurs 500
        # On va plutôt chercher le nom du code dans la query si possible
        pass

    try:
        # Appel API avec critères parsés
        result = legifrance_client.search_with_criteres(
            fond="CODE_DATE",
            criteres=criteres_parsed,
            operateur=operateur_query,
            filtres=filtres if filtres else None,
            type_champ=type_champ,
            page_number=page_number,
            page_size=page_size,
            sort=sort,
            type_pagination="ARTICLE"
        )

        # Construction du résumé
        total = result.get("totalResultNumber", 0)
        resultats = result.get("results", [])

        summary_parts = [
            f"**Requête:** {query}",
            f"**Type recherche:** {type_recherche} ({type_champ})",
            f"**Total:** {total:,} résultats".replace(',', ' '),
            f"**Affichés:** {len(resultats)}",
            f""
        ]

        # Formater les résultats
        for i, r in enumerate(resultats, 1):
            titles = r.get("titles", [])
            if titles:
                titre_code = titles[0].get("title", "")
                code_id = titles[0].get("cid", "")
            else:
                titre_code = "Sans titre"
                code_id = ""

            sections = r.get("sections", [])

            summary_parts.append(f"**{i}. {titre_code}**")

            # Extraire les articles trouvés dans les sections
            if sections:
                for section in sections[:2]:  # Max 2 sections par résultat
                    section_title = section.get("title", "")
                    extracts = section.get("extracts", [])

                    if section_title:
                        # Nettoyer les balises <mark>
                        clean_title = section_title.replace("<mark>", "**").replace("</mark>", "**")
                        summary_parts.append(f"   📖 {clean_title}")

                    for extract in extracts[:3]:  # Max 3 articles par section
                        article_num = extract.get("title", "")
                        article_id = extract.get("id", "")
                        article_text = extract.get("text", "")

                        if article_num:
                            summary_parts.append(f"   • Article {article_num}")

                        if article_id:
                            summary_parts.append(f"     🔗 https://www.legifrance.gouv.fr/codes/article_lc/{article_id}")

                        if article_text:
                            # Nettoyer les balises <mark> dans le texte
                            clean_text = article_text.replace("<mark>", "**").replace("</mark>", "**")
                            summary_parts.append(f"     {clean_text}")

            summary_parts.append("")

        summary = "\n".join(summary_parts)

        return create_response(summary)

    except Exception as e:
        return create_response(
            f"❌ **Erreur recherche codes**\n\n"
            f"Requête: {query}\n"
            f"Erreur: {str(e)}",
            is_error=True
        )


# ============================================================================
# ROUTER PRINCIPAL
# ============================================================================

TOOL_HANDLERS = {
    # Nouveaux outils optimisés
    "Search_Cour_Cassation": handle_search_cour_cassation,
    "Search_Cour_Appel": handle_search_cour_appel,
    "Search_Conseil_Etat": handle_search_conseil_etat,
    "Search_CAA": handle_search_caa,
    "Search_Premiere_Instance": handle_search_premiere_instance,
    "Search_Code": handle_search_code,

    # mcp_definitions.py annonce « Tracking_BODACC » (T majuscule) alors que la
    # table ne contenait que « tracking_BODACC » : l'outil annoncé tombait donc
    # sur « Outil non reconnu ». Les deux clés sont enregistrées pour corriger
    # l'appel sans casser un appelant existant.
    "Tracking_BODACC": handle_tracking_bodacc,

    # Anciens outils (compatibilité)
    "recherche_jurisprudence": handle_recherche_jurisprudence,
    "consulter_decision": handle_consulter_decision,
    "consulter_article": handle_consulter_article,
    "tracking_BODACC": handle_tracking_bodacc,
}


def handle_tool_call(tool_name: str, arguments: Dict[str, Any], user_id: str) -> Dict[str, Any]:
    """Router principal des appels d'outils"""
    handler = TOOL_HANDLERS.get(tool_name)
    
    if not handler:
        return create_response(f"Outil '{tool_name}' non reconnu", is_error=True)
    
    try:
        return handler(arguments, user_id)
    except Exception as e:
        return create_response(f"Erreur: {str(e)}", is_error=True)
