---
name: redaction-juridique
description: "Rédiger, réviser ou commenter un acte juridique français (assignation, conclusions en défense, conclusions d'appel, décision d'associé unique SCI, courrier, mémo) pour PieceMaker, à partir des templates du cabinet, en s'appuyant sur la skill `recherche-juridique` pour les citations. À utiliser dès qu'il faut rédiger ou relire un acte de procédure ou un document juridique."
---

# Rédaction juridique française — à partir des templates du cabinet

## Bibliothèque de gabarits

Quatre gabarits Word sont disponibles pour `/Users/tsardet/Desktop/` :

| Fichier | Usage | Placeholders (`{{...}}`) |
| --- | --- | --- |
| `01 - Template Assignation.docx` | Assignation devant une juridiction (acte d'huissier). | `JURIDICTION_COMPETENTE`, `TYPE_DOCUMENT`, `PARTIE_CLIENTE`, `ROLE_CLIENT`, `PARTIE_ADVERSE`, `ROLE_ADVERSE`, `ADRESSE_TRIBUNAL`, `MENTIONS_OBLIGATOIRES`, `PLAISE`, `FAITS`, `DISCUSSION_ASSIGNATION`, `DISPOSITIF`, `BORDEREAU_PIECES`. |
| `02 - Template Conclusions en défense.docx` | Conclusions en défense (première instance, communiquées par RPVA). | `JURIDICTION_COMPETENTE`, `DATE_GENERATION`, `TYPE_DOCUMENT`, `PARTIE_CLIENTE`, `ROLE_CLIENT`, `PARTIE_ADVERSE`, `ROLE_ADVERSE`, `PLAISE`, `FAITS`, `DISCUSSION`, `DISPOSITIF`, `BORDEREAU_PIECES`. |
| `03 - Template Conclusions Appel.docx` | Conclusions d'appel (communiquées par RPVA). | Comme les conclusions en défense, plus `CHEFS_JUGEMENT_CRITIQUES`, `DISCUSSION_APPEL`, `DISPOSITIF_APPEL`. |
| `04 - Template Décisions Associé Unique SCI.docx` | *Prévu pour* une décision d'associé unique de SCI. | **À vérifier avant usage** — voir l'avertissement ci-dessous. |

Chaque gabarit suit la même architecture générale : en-tête (juridiction, parties, avocats), un bloc `{{PLAISE}}`, un rappel des faits, une discussion, un dispositif ("PAR CES MOTIFS"), puis le bordereau de pièces communiquées (`{{BORDEREAU_PIECES}}`).

**Avertissement sur le gabarit n°4** : à la vérification, le fichier `04 - Template Décisions Associé Unique SCI.docx` contient actuellement le même contenu que `01 - Template Assignation.docx` (mêmes placeholders, même texte d'acte d'huissier "J'AI, huissier soussigné, DONNÉ ASSIGNATION A…") — ce n'est pas la structure attendue pour une décision d'associé unique de SCI. Avant de s'en servir pour un acte réel, signalez cette anomalie à l'utilisateur et demandez confirmation ou un gabarit corrigé plutôt que de rédiger une décision de SCI sur un canevas d'assignation.

Ces gabarits peuvent être déplacés vers `~/.piecemaker/templates/` pour un emplacement stable, indépendant du Bureau ; voir la skill `ajout-de-fonctionnalites` pour la gestion des gabarits personnels.

## Workflow de rédaction

1. **Choisir le bon gabarit** selon la nature de l'acte (voir tableau ci-dessus).
2. **En faire une copie de travail** dans le dossier du client — ne jamais modifier ni écraser le fichier original sur le Bureau. Le fichier de travail est celui qui sera ouvert et édité.
3. **Remplir les placeholders** un par un, en s'appuyant sur les pièces du dossier (voir l'agent `analyste-piece` pour synthétiser une pièce avant de rédiger les faits) et sans jamais inventer une information absente du dossier.
4. **Citer via `recherche-juridique`** : toute référence à un texte de loi ou à une décision insérée dans `{{DISCUSSION}}` / `{{DISCUSSION_APPEL}}` / `{{DISCUSSION_ASSIGNATION}}` / `{{DISPOSITIF*}}` doit d'abord être vérifiée avec cette skill — jamais citée de mémoire.
5. **Anonymiser avant toute sortie externe** du document rédigé — skill `anonymisation`, puis vérification par l'agent `verificateur-anonymisation` avant envoi.

## Règles qui s'appliquent toujours

- **Citations vérifiables uniquement** : voir la skill `recherche-juridique` pour le détail des outils et de la procédure de vérification. Ne jamais produire un identifiant de texte ou de décision non confirmé.
- **Ne jamais réutiliser un nom réel** présent dans une pièce anonymisée du dossier pour rédiger un extrait destiné à sortir du dossier de travail — rester sur les codes du mapping (`PERSONNE_PHYSIQUE_1`, `PERSONNE_MORALE_1`, `SOCIETE_SCI_1`, `ADRESSE_1`, etc.) tant que le document n'est pas définitivement destiné à un usage interne au dossier.
- **Respecter les règles de validation du gabarit** (ex. : une section "FAITS" doit s'appuyer sur des notes de bas de page référençant les pièces communiquées) plutôt que de les contourner pour faire passer un placeholder vide ou incomplet.
- Les outils `read_doc` / `edit_doc` (voir la skill `word-taskpane`) opèrent sur le document Word ouvert via Office.js : toute édition doit préserver le suivi des modifications (track changes) et la structure des titres.

## Ce qu'il ne faut pas faire

- Ne jamais fabriquer un numéro d'article, de décision ou de dossier pour combler un manque d'information.
- Ne jamais présenter une jurisprudence non vérifiée comme un fait établi.
- Ne jamais modifier un gabarit original sur le Bureau ou dans `~/.piecemaker/templates/` : toujours travailler sur une copie.
- Ne jamais simplifier une règle de validation de gabarit juridique sans validation d'un expert du domaine.
- Ne jamais utiliser le gabarit n°4 pour une vraie décision de SCI tant que son contenu n'a pas été corrigé (voir l'avertissement ci-dessus).
