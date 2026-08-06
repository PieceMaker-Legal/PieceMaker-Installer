#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Guide de rédaction des conclusions juridiques"""

GUIDE_CONCLUSIONS = """
# GUIDE DE RÉDACTION DES CONCLUSIONS

## STRUCTURE GÉNÉRALE

### 1. EN-TÊTE
- Type de conclusions (assignation, défense, appelant, intimé)
- Juridiction saisie
- Numéro RG

### 2. PARTIES
**POUR :** Identité complète du client
- Personne physique : Civilité, nom, prénom, date et lieu de naissance, domicile
- Personne morale : Dénomination, forme, SIREN, siège social, représentant légal

**CONTRE :** Identité complète de l'adversaire

### 3. RAPPEL DES FAITS
Structure chronologique :
1. Présentation des parties et de leur relation
2. Faits pertinents avec dates précises
3. Références aux pièces (Pièce n°X)

**Règles :**
- Un fait = un paragraphe
- Chaque fait important doit renvoyer à une pièce
- Rester factuel, éviter les jugements de valeur

### 4. RAPPEL DE LA PROCÉDURE
- Date et nature de l'acte introductif
- Décisions intermédiaires éventuelles
- Historique procédural

### 5. DISCUSSION
Pour chaque prétention :

**A. En droit**
- Articles de loi applicables (citation exacte)
- Jurisprudence pertinente (juridiction, date, n° RG/pourvoi)
- Doctrine si pertinent

**B. En fait**
- Application des règles aux faits de l'espèce
- Renvoi aux pièces justificatives
- Démonstration logique

**C. Conclusion partielle**
- "Par conséquent, il est demandé à [juridiction] de..."

### 6. DISPOSITIF ("PAR CES MOTIFS")
- Commence par "Plaise au [Tribunal/à la Cour]"
- Chaque prétention sur une ligne distincte
- Formulations précises et chiffrées
- Se termine par les demandes accessoires (art. 700, dépens)

### 7. BORDEREAU DE PIÈCES
Liste numérotée de toutes les pièces citées :
- Pièce n°1 : [Description] [Date si pertinent]

---

## RÈGLES DE RÉDACTION

### Style
- Phrases courtes et claires
- Vocabulaire juridique précis
- Éviter les répétitions
- Structure logique

### Citations
- Articles de loi : "Aux termes de l'article X du Code Y..."
- Jurisprudence : "La Cour de cassation a jugé que... (Cass. civ. 1ère, date, n° pourvoi)"

### Références aux pièces
- Format : "(Pièce n°X)" après chaque affirmation factuelle
- Numérotation continue

### Chiffrage
- Montants en chiffres ET en lettres pour le dispositif
- Détailler le calcul des préjudices

---

## TYPES DE CONCLUSIONS

### Assignation
- Initiative de la procédure
- Exposer les demandes principales
- Justifier la compétence

### Défense
- Répondre point par point aux demandes adverses
- Soulever les fins de non-recevoir
- Former des demandes reconventionnelles si nécessaire

### Appelant
- Critique du jugement chef par chef
- Demander l'infirmation totale ou partielle
- Reprendre les demandes de première instance

### Intimé
- Défendre le jugement favorable
- Demander la confirmation
- Former appel incident si nécessaire

---

## ERREURS FRÉQUENTES À ÉVITER

1. **Prétentions imprécises** : Toujours chiffrer
2. **Absence de fondement juridique** : Citer les textes
3. **Faits sans pièces** : Toujours justifier
4. **Dispositif incohérent avec la discussion**
5. **Oubli des demandes accessoires** (art. 700, dépens)
6. **Non-respect des délais** de signification
7. **Pièces non numérotées** correctement

---

## CHECKLIST AVANT DÉPÔT

□ En-tête complet (parties, juridiction, RG)
□ Faits chronologiques avec pièces
□ Fondements juridiques cités
□ Discussion structurée (droit/fait)
□ Dispositif précis et chiffré
□ Bordereau de pièces complet
□ Relecture orthographe/typographie
□ Vérification des montants
□ Cohérence pièces citées / bordereau
"""

RESOURCE_METADATA = {
    "uri": "resource://guide-conclusions",
    "name": "Guide de rédaction des conclusions",
    "description": "Guide complet pour rédiger des conclusions juridiques",
    "mimeType": "text/markdown"
}


def get_guide_complet() -> str:
    """Retourne le guide complet"""
    return GUIDE_CONCLUSIONS


def get_guide_section(section: str) -> str:
    """Retourne une section spécifique du guide"""
    sections = {
        "structure": "## STRUCTURE GÉNÉRALE",
        "regles": "## RÈGLES DE RÉDACTION",
        "types": "## TYPES DE CONCLUSIONS",
        "erreurs": "## ERREURS FRÉQUENTES",
        "checklist": "## CHECKLIST"
    }
    
    if section not in sections:
        return f"Section '{section}' non trouvée. Sections disponibles: {list(sections.keys())}"
    
    start_marker = sections[section]
    lines = GUIDE_CONCLUSIONS.split('\n')
    
    capture = False
    content = []
    
    for line in lines:
        if start_marker in line:
            capture = True
        elif capture and line.startswith('## '):
            break
        
        if capture:
            content.append(line)
    
    return '\n'.join(content)
