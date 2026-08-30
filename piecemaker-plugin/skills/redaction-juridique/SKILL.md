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
2. **Préparer un document de travail `.docx`** dans le dossier du client en
   **copiant** le template choisi vers ce nouveau chemin (`cp`) — ne jamais
   éditer le template original en place, et ne jamais copier par-dessus un
   fichier de travail contenant déjà de la rédaction à conserver. Aucun
   document n'a besoin d'être ouvert dans une application Word : toute la
   suite passe par le skill `document-skills:docx` (Bash, `pandoc`,
   dépaquetage OOXML) — il n'y a ni volet, ni `paneId`.
3. **Lire le contenu du document de travail** avec `pandoc -t markdown
   fichier.docx` pour repérer tous les placeholders `{{...}}` restants, puis
   le dépaqueter pour éditer son XML :

   ```bash
   unzip -q fichier.docx -d unpacked/
   python scripts/merge_runs.py unpacked/   # coalesce les runs fragmentés
   # éditer unpacked/word/document.xml : remplacer chaque {{PLACEHOLDER}}
   (cd unpacked && rm -f ../fichier.docx && zip -Xr ../fichier.docx .)
   python scripts/validate.py fichier.docx   # contrôle XSD
   ```

   `merge_runs.py` est nécessaire car Word fragmente souvent un placeholder
   sur plusieurs `<w:r>` : sans fusion, `{{PLACEHOLDER}}` peut ne pas exister
   comme chaîne contiguë dans le XML brut.
4. **Remplir les placeholders** repérés à l'étape précédente, un par un, en
   s'appuyant sur les pièces du dossier (voir l'agent `analyste-piece` pour
   synthétiser une pièce avant de rédiger les faits) et sans jamais inventer
   une information absente du dossier. Le document de travail est l'unique
   source des placeholders : ne charger ni fichier JSON compagnon, ni ordre ou
   consigne de placeholder stocké hors du document.
5. **Citer via `recherche-juridique`** : toute référence à un texte de loi ou à une décision insérée dans `{{DISCUSSION}}` / `{{DISCUSSION_APPEL}}` / `{{DISCUSSION_ASSIGNATION}}` / `{{DISPOSITIF*}}` doit d'abord être vérifiée avec cette skill — jamais citée de mémoire.
6. **Anonymiser avant toute sortie externe** du document rédigé — skill `anonymisation`, puis vérification par l'agent `verificateur-anonymisation` avant envoi.

## Règles qui s'appliquent toujours

- **Citations vérifiables uniquement** : voir la skill `recherche-juridique` pour le détail des outils et de la procédure de vérification. Ne jamais produire un identifiant de texte ou de décision non confirmé.
- **Ne jamais réutiliser un nom réel** présent dans une pièce anonymisée du dossier pour rédiger un extrait destiné à sortir du dossier de travail — rester sur les codes du mapping (`PERSONNE_PHYSIQUE_1`, `PERSONNE_MORALE_1`, `SOCIETE_SCI_1`, `ADRESSE_1`, etc.) tant que le document n'est pas définitivement destiné à un usage interne au dossier.
- **Respecter les règles de validation du template** (ex. : une section "FAITS" doit s'appuyer sur des notes de bas de page référençant les pièces communiquées) plutôt que de les contourner pour faire passer un placeholder vide ou incomplet.
- L'édition du document de travail passe par le skill `document-skills:docx` :
  dépaquetage OOXML (`unzip`/`zip`), lecture via `pandoc -t markdown`, édition
  directe de `word/document.xml`. Ce sont des scripts Bash/Python locaux sur
  le fichier `.docx` — aucune application Word n'est requise, il n'y a pas de
  `paneId`. Après le remplissage initial des placeholders, toute édition
  ultérieure doit rester en suivi des modifications (`<w:ins>`/`<w:del>` avec
  `w:id`/`w:author`/`w:date`) et être validée avec
  `python scripts/validate.py fichier.docx --original <version précédente>
  --author "<nom>"`, qui signale tout texte changé sans balise de suivi.
- **Corriger une mise en forme se fait en éditant `word/styles.xml`** dans le
  même dépaquetage, jamais en recopiant le template par-dessus le document
  déjà rédigé : redéfinir dans ce fichier un style déjà déclaré (police,
  taille, alignement, espacements) se propage à tous les paragraphes qui le
  portent et laisse le contenu intact. Le skill `docx` n'a **pas** d'outil
  dédié équivalent à l'ancien `doc_styles` (qui redéfinissait un style en un
  seul appel, sans repasser par un dépaquetage) : c'est une édition XML
  manuelle comme les autres, à revalider avec `validate.py` avant de refermer
  le zip.

## Ce qu'il ne faut pas faire

- Ne jamais fabriquer un numéro d'article, de décision ou de dossier pour combler un manque d'information.
- Ne jamais présenter une jurisprudence non vérifiée comme un fait établi.
- Ne jamais modifier un template original sur le Bureau ou dans `~/.piecemaker/templates/` : toujours travailler sur une copie.
- Ne jamais copier un template par-dessus un document de travail contenant déjà du travail à conserver : la copie initiale ne se fait qu'une fois, sur un fichier de travail vide ou tout juste créé.
- Ne jamais simplifier une règle de validation de template juridique sans validation d'un expert du domaine.
- Ne jamais utiliser le template n°4 pour une vraie décision de SCI tant que son contenu n'a pas été corrigé (voir l'avertissement ci-dessus).
