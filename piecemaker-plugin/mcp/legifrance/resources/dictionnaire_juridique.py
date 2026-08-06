#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Dictionnaire juridique - Définitions et terminologie"""

DICTIONNAIRE_JURIDIQUE = """
# DICTIONNAIRE JURIDIQUE

## PRÉTENTION
Demande formulée par une partie au juge. Elle doit être précise, chiffrée si nécessaire, et accompagnée de ses fondements juridiques.

**Exemples :**
- "Condamner M. X à payer la somme de 10.000 € à titre de dommages-intérêts"
- "Prononcer la résolution du contrat de vente du 15 mars 2023"
- "Ordonner l'expulsion de M. Y des lieux loués"

## MOYEN
Argument de fait ou de droit invoqué au soutien d'une prétention.

**Moyen de fait :** Argument tiré des circonstances factuelles
**Moyen de droit :** Argument tiré d'une règle juridique (loi, jurisprudence, principe)

## FONDEMENT JURIDIQUE
Base légale ou jurisprudentielle sur laquelle repose une prétention.

**Types :**
- Article de code (ex: Article 1240 du Code civil)
- Texte réglementaire
- Décision de justice (arrêt de principe)
- Principe général du droit

## CHEF DE DEMANDE / CHEF DE JUGEMENT
Chaque point distinct de la demande ou du dispositif d'une décision.

## DISPOSITIF
Partie finale des conclusions énonçant les demandes précises adressées au juge. Commence généralement par "PAR CES MOTIFS".

## MOTIFS
Partie des conclusions développant les arguments (faits et droit) au soutien des prétentions.

## QUALIFICATION JURIDIQUE
Opération consistant à rattacher les faits à une catégorie juridique déterminée.

**Exemple :** Des coups portés → Qualification en "violence volontaire" (pénal) ou "faute" (civil)

## ASSIGNATION
Acte d'huissier par lequel le demandeur cite le défendeur à comparaître devant une juridiction.

**Mentions obligatoires (Article 56 CPC) :**
- Identité des parties
- Juridiction saisie
- Objet de la demande
- Moyens de fait et de droit
- Pièces sur lesquelles la demande est fondée

## CONCLUSIONS
Acte de procédure exposant les prétentions et moyens d'une partie.

**Types :**
- Conclusions en demande (assignation)
- Conclusions en défense
- Conclusions d'appelant
- Conclusions d'intimé
- Conclusions récapitulatives

## INTIMÉ
Partie contre laquelle l'appel est formé. Celui qui a gagné en première instance.

## APPELANT
Partie qui forme l'appel. Celui qui conteste le jugement de première instance.

## INFIRMATION
Réformation d'un jugement par la cour d'appel.

## CONFIRMATION
Validation du jugement de première instance par la cour d'appel.

## FIN DE NON-RECEVOIR
Moyen de défense tendant à faire déclarer l'adversaire irrecevable en sa demande, sans examen au fond.

**Exemples :**
- Prescription
- Défaut de qualité pour agir
- Défaut d'intérêt à agir
- Autorité de la chose jugée

## EXCEPTION DE PROCÉDURE
Moyen de défense visant à contester la régularité de la procédure.

**Exemples :**
- Exception d'incompétence
- Exception de nullité
- Exception de litispendance

## IRRECEVABILITÉ
Sanction d'une demande qui ne remplit pas les conditions pour être examinée au fond.

## FORCLUSION
Perte d'un droit d'agir en raison de l'expiration d'un délai préfix.

## PRESCRIPTION
Extinction d'un droit par l'écoulement d'un délai.

**Délais courants :**
- 5 ans : droit commun (art. 2224 C. civ.)
- 2 ans : consommation, construction
- 10 ans : dommage corporel
- 30 ans : réel immobilier

## CHOSE JUGÉE (AUTORITÉ DE LA)
Effet attaché à une décision de justice définitive empêchant de remettre en cause ce qui a été jugé.

**Triple identité :**
- Même objet
- Même cause
- Mêmes parties

## EXÉCUTION PROVISOIRE
Possibilité d'exécuter un jugement avant qu'il ne devienne définitif, malgré l'exercice d'une voie de recours.

## ASTREINTE
Condamnation accessoire au paiement d'une somme d'argent par jour de retard dans l'exécution d'une obligation.

## ARTICLE 700 CPC
Indemnité destinée à couvrir les frais irrépétibles (honoraires d'avocat notamment) exposés par une partie.

## DÉPENS
Frais de procédure (huissier, expertise, etc.) mis à la charge de la partie perdante.

## RG (NUMÉRO)
Numéro de Répertoire Général attribué à chaque affaire par le greffe.

## POURVOI
Recours extraordinaire formé devant la Cour de cassation contre une décision rendue en dernier ressort.
"""

RESOURCE_METADATA = {
    "uri": "resource://dictionnaire-juridique",
    "name": "Dictionnaire juridique",
    "description": "Définitions et terminologie juridique française",
    "mimeType": "text/markdown"
}


def get_dictionnaire() -> str:
    """Retourne le dictionnaire complet"""
    return DICTIONNAIRE_JURIDIQUE


def get_definition(terme: str) -> str:
    """Retourne la définition d'un terme spécifique"""
    terme_upper = terme.upper()
    lines = DICTIONNAIRE_JURIDIQUE.split('\n')
    
    capture = False
    definition = []
    
    for line in lines:
        if line.startswith('## ') and terme_upper in line.upper():
            capture = True
            definition.append(line)
        elif capture:
            if line.startswith('## '):
                break
            definition.append(line)
    
    return '\n'.join(definition) if definition else f"Terme '{terme}' non trouvé."
