---
name: redaction-juridique
description: "Rédiger, réviser ou commenter un acte juridique français (assignation, conclusions en défense, conclusions d'appel, décision d'associé unique SCI, courrier, mémo) pour PieceMaker, à partir des templates du cabinet, en s'appuyant sur la skill `recherche-juridique` pour les citations. À utiliser dès qu'il faut rédiger ou relire un acte de procédure ou un document juridique."
---

# Rédaction juridique française — à partir des templates du cabinet

## Bibliothèque de templates

Quatre templates Word sont disponibles dans `/Users/tsardet/Desktop/` :

| Fichier | Usage | Placeholders (`{{...}}`) |
| --- | --- | --- |
| `01 - Template Assignation.docx` | Assignation devant une juridiction (acte d'huissier). | `JURIDICTION_COMPETENTE`, `TYPE_DOCUMENT`, `PARTIE_CLIENTE`, `ROLE_CLIENT`, `PARTIE_ADVERSE`, `ROLE_ADVERSE`, `ADRESSE_TRIBUNAL`, `MENTIONS_OBLIGATOIRES`, `PLAISE`, `FAITS`, `DISCUSSION_ASSIGNATION`, `DISPOSITIF`, `BORDEREAU_PIECES`. |
| `02 - Template Conclusions en défense.docx` | Conclusions en défense (première instance, communiquées par RPVA). | `JURIDICTION_COMPETENTE`, `DATE_GENERATION`, `TYPE_DOCUMENT`, `PARTIE_CLIENTE`, `ROLE_CLIENT`, `PARTIE_ADVERSE`, `ROLE_ADVERSE`, `PLAISE`, `FAITS`, `DISCUSSION`, `DISPOSITIF`, `BORDEREAU_PIECES`. |
| `03 - Template Conclusions Appel.docx` | Conclusions d'appel (communiquées par RPVA). | Comme les conclusions en défense, plus `CHEFS_JUGEMENT_CRITIQUES`, `DISCUSSION_APPEL`, `DISPOSITIF_APPEL`. |
| `04 - Template Décisions Associé Unique SCI.docx` | *Prévu pour* une décision d'associé unique de SCI. | **À vérifier avant usage** — voir l'avertissement ci-dessous. |

Chaque template suit la même architecture générale : en-tête (juridiction, parties, avocats), un bloc `{{PLAISE}}`, un rappel des faits, une discussion, un dispositif ("PAR CES MOTIFS"), puis le bordereau de pièces communiquées (`{{BORDEREAU_PIECES}}`).

Le fichier template source reste entièrement générique : il contient des
placeholders `{{...}}`, jamais une entité réelle ni un code d'anonymisation. Les
codes éventuels n'apparaissent que dans le document de travail au moment de la
rédaction.

**Avertissement sur le template n°4** : à la vérification, le fichier `04 - Template Décisions Associé Unique SCI.docx` contient actuellement le même contenu que `01 - Template Assignation.docx` (mêmes placeholders, même texte d'acte d'huissier "J'AI, huissier soussigné, DONNÉ ASSIGNATION A…") — ce n'est pas la structure attendue pour une décision d'associé unique de SCI. Avant de s'en servir pour un acte réel, signalez cette anomalie à l'utilisateur et demandez confirmation ou un template corrigé plutôt que de rédiger une décision de SCI sur un canevas d'assignation.

Ces templates peuvent être déplacés vers `~/.piecemaker/templates/` pour un emplacement stable, indépendant du Bureau ; voir la skill `ajout-de-fonctionnalites` pour la gestion des templates personnels.

## Workflow de rédaction

1. **Choisir le bon template** selon la nature de l'acte (voir tableau ci-dessus).
2. **Préparer un document de travail `.docx`** dans le dossier du client — ne jamais ouvrir le template original comme document cible. Appeler `open_doc` sur ce document et conserver le `paneId` renvoyé.
3. **Injecter le template** avec son chemin absolu :

   ```text
   template { "paneId": "a1b2", "path": "/Users/tsardet/Desktop/01 - Template Assignation.docx" }
   ```

   `template` remplace intégralement le contenu et les styles du document de travail. L'appeler une seule fois, au début, après avoir vérifié que la cible ne contient rien à conserver. Utiliser le `paneId` du document cible, pas celui d'un autre volet. En cas de succès, son payload est `{ "success": true, "content": "<texte intégral du template, placeholders inclus>" }` : `content` n'est jamais limité à un placeholder particulier.
4. **Remplir les placeholders** repérés directement dans `content`, un par un, en s'appuyant sur les pièces du dossier (voir l'agent `analyste-piece` pour synthétiser une pièce avant de rédiger les faits) et sans jamais inventer une information absente du dossier. Le document Word injecté est l'unique source des placeholders : ne charger ni fichier JSON compagnon, ni ordre ou consigne de placeholder stocké hors du document.
5. **Citer via `recherche-juridique`** : toute référence à un texte de loi ou à une décision insérée dans `{{DISCUSSION}}` / `{{DISCUSSION_APPEL}}` / `{{DISCUSSION_ASSIGNATION}}` / `{{DISPOSITIF*}}` doit d'abord être vérifiée avec cette skill — jamais citée de mémoire.
6. **Anonymiser avant toute sortie externe** du document rédigé — skill `anonymisation`, puis vérification par l'agent `verificateur-anonymisation` avant envoi.

## Règles qui s'appliquent toujours

- **Citations vérifiables uniquement** : voir la skill `recherche-juridique` pour le détail des outils et de la procédure de vérification. Ne jamais produire un identifiant de texte ou de décision non confirmé.
- **Ne jamais réutiliser un nom réel** présent dans une pièce anonymisée du dossier pour rédiger un extrait destiné à sortir du dossier de travail — rester sur les codes du mapping (`PERSONNE_PHYSIQUE_1`, `PERSONNE_MORALE_1`, `SOCIETE_SCI_1`, `ADRESSE_1`, etc.) tant que le document n'est pas définitivement destiné à un usage interne au dossier.
- **Respecter les règles de validation du template** (ex. : une section "FAITS" doit s'appuyer sur des notes de bas de page référençant les pièces communiquées) plutôt que de les contourner pour faire passer un placeholder vide ou incomplet.
- Les outils `template` / `read_doc` / `edit_doc` (voir la skill `word-taskpane`) opèrent sur le document Word ouvert via Office.js et exigent le `paneId` renvoyé par `open_doc`. Après l'injection initiale, toute édition doit préserver le suivi des modifications (track changes) et la structure des titres.

## Ce qu'il ne faut pas faire

- Ne jamais fabriquer un numéro d'article, de décision ou de dossier pour combler un manque d'information.
- Ne jamais présenter une jurisprudence non vérifiée comme un fait établi.
- Ne jamais modifier un template original sur le Bureau ou dans `~/.piecemaker/templates/` : toujours travailler sur une copie.
- Ne jamais appeler `template` sur un document contenant déjà du travail à conserver : l'outil remplace le contenu et les styles.
- Ne jamais simplifier une règle de validation de template juridique sans validation d'un expert du domaine.
- Ne jamais utiliser le template n°4 pour une vraie décision de SCI tant que son contenu n'a pas été corrigé (voir l'avertissement ci-dessus).
