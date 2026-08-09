# PieceMaker — dossiers juridiques

Ce fichier est à la racine du workspace PieceMaker. Toute session Claude Code
ouverte dans un dossier juridique (ou l'un de ses sous-dossiers) le lit
automatiquement : Claude Code remonte l'arborescence depuis le répertoire
courant. Il oriente le travail sur les dossiers — pas sur le code de
PieceMaker (celui-là a son propre CLAUDE.md dans le dépôt).

**Chaque sous-dossier immédiat de cette racine est un dossier juridique
indépendant.** Rien ne circule d'un dossier à l'autre : ni historique, ni
mapping d'anonymisation, ni facturation.

## Règles absolues

1. **Les pièces protégées ne se lisent jamais.** Un hook `PreToolUse`
   (`protect-originals.mjs`) refuse tout `Read`/`Grep`/`Glob`/`Bash` visant une
   pièce protégée, où qu'elle soit rangée dans le dossier. La protection est une
   propriété du fichier, décidée dans l'administration, pas de son emplacement :
   **tout ce qui n'est ni `.md` ni `.json` est protégé par défaut**, et seul un
   décochage explicite libère une pièce. On travaille sur le Markdown converti
   et sur les mappings, jamais sur l'original. Le refus indique le `.md` à lire
   à la place ; ce n'est pas un bug, ne pas le contourner.
2. **Rien d'identifiant ne sort du cabinet.** Avant tout envoi, dépôt ou
   partage d'un document, passer par l'agent `verificateur-anonymisation`.
3. **Aucune citation juridique inventée.** Texte, article et date de version
   doivent être vérifiables — utiliser les outils MCP `legifrance`.

## Commits automatiques

Chaque `Write` ou `Edit` réussi déclenche un hook `PostToolUse`
(`commit-track.mjs`) qui enregistre un point de sauvegarde du dossier
juridique concerné. Rien à lancer à la main.

- **Où** : dépôt Git *nu*, hors des données client, dans
  `~/.piecemaker/case-history/<nom-du-dossier>-<empreinte>.git`, branche
  `main`, work-tree pointé sur le dossier juridique. Le dossier juridique
  lui-même ne contient donc aucun `.git`.
- **Quoi** : uniquement les `.md` et les `.json`. Les originaux, PDF et DOCX
  sont exclus par construction.
- **Quand** : après chaque écriture, et seulement si les fichiers produits par
  l'opération ont réellement changé (pas de commit vide). Le commit automatique
  est ciblé : il ne capture jamais les autres modifications présentes dans le
  dossier. Les conversions, scans PII et modifications du mapping lancés depuis
  l'administration créent leur propre commit ciblé. Auteur
  `PieceMaker <commits@piecemaker.local>`, message descriptif de l'opération.
- **Consulter ou restaurer** : par l'administration
  (`https://localhost:43098/admin/`), section historique du dossier. Ne pas
  manipuler `~/.piecemaker/case-history/` à la main.
- **Désactiver** : `commits.enabled: false` dans `~/.piecemaker/config.json`.

## Anonymisation

**Le modèle ne voit que des codes ; le cabinet ne voit que des noms.** Les
fichiers restent en clair sur le disque ; ce sont les résultats d'outil et les
entrées d'outil que les hooks réécrivent au passage.

- `anonymize-read.mjs` (PostToolUse sur `Read`/`Grep`/`Glob`/`Bash`) : applique
  le mapping du dossier au résultat avant que le modèle le voie. Aucun nom réel
  ne part vers l'API.
- `deanonymize-write.mjs` (PreToolUse sur `Write`/`Edit` et sur l'outil `reply`
  de Telegram) : rétablit les vrais noms sur ce qui est écrit ou envoyé. Un
  `Edit` voit **ses deux chaînes** rétablies : le modèle a lu le fichier codé,
  son `old_string` porte donc des codes alors que le disque porte les noms.
- Les hooks **ne scannent pas** les données personnelles. Le scan GLiNER/Presidio
  est lancé depuis l'administration (« Anonymiser & mapper »), seul endroit où
  les modèles NER sont chargés.
- **Mapping du dossier** : `mapping_dossier.json`, à la racine du dossier
  juridique. Les entrées sont triées de la plus longue entité à la plus
  courte — toute substitution doit respecter cet ordre, sinon « Dupont »
  corrompt « Jean Dupont-Martin ». Un code n'est jamais réattribué ; une
  entrée supprimée passe sous `ignored` pour ne pas revenir au rebuild.
- **Sans mapping, pas d'anonymisation** : un dossier dont le mapping n'a jamais
  été construit livre son Markdown tel quel. C'est la raison d'être du bouton
  « Anonymiser & mapper » de l'administration.
- Skill `anonymisation` : scan, lecture/édition d'un mapping, ré-identification
  d'un texte codé.

## Protection des pièces

- Décidée dans l'administration (`https://localhost:43098/admin/`), colonne des
  pièces : le bouclier de chaque ligne bascule la protection, la vue « Toutes »
  montre le dossier entier, sous-dossiers compris.
- Stockée dans `<dossier>/.piecemaker/protection.json`, qui n'enregistre que les
  **exceptions**. Une pièce déposée entre deux passages est donc protégée sans
  action.
- `.md` et `.json` ne sont jamais protégés : ce sont les surfaces que
  `anonymize-read.mjs` code à la volée.

## Documents Word

Le skill `docx` (plugin officiel `document-skills`) est ce qui permet de lire,
créer et surtout **réviser en modifications suivies** un `.docx`. Il travaille
par `pandoc` et par dépaquetage OOXML, donc par Bash : le garde-fou inspecte
aussi les commandes shell, et un `pandoc pièce.pdf` sur une pièce protégée est
refusé au même titre qu'un `Read`.

## Ce qui est disponible dans une session

**Skills** (`/nom` ou déclenchement automatique)
- `conversion-md` — convertir une pièce (PDF, DOCX, scan) en Markdown ;
  arbitre entre markitdown et MinerU (OCR).
- `anonymisation` — scan PII, mapping, dé-anonymisation.
- `redaction-juridique` — rédiger/réviser conclusions, assignation, courrier,
  mémo, avec citations vérifiées via `legifrance`.
- `tamponnage` — tampon du cabinet et numérotation des pièces d'un bordereau ;
  écrit dans le sous-dossier « Pièces » sous la forme « Pièce n°1.pdf ».

**Agents** (via l'outil Agent)
- `analyste-piece` — synthèse structurée d'une pièce : type, date, faits
  saillants, pertinence probatoire. Lecture seule.
- `verificateur-anonymisation` — audit avant sortie du cabinet. Lecture seule,
  ne modifie ni le document ni le mapping.

**MCP `legifrance`** — `Search_Code`, `Search_Cour_Cassation`,
`Search_Conseil_Etat`, `Search_Cour_Appel`, `Search_CAA`,
`Search_Premiere_Instance`, `consulter_decision`, `Tracking_BODACC`,
`Brainstorming`. Nécessite `LEGIFRANCE_CLIENT_ID` / `LEGIFRANCE_CLIENT_SECRET`.

**MCP `PieceMaker`** — `read_doc`, `edit_doc`, `read_case`, `get_resource`,
`draft`, `template_library`, `Stamping`, `Call_Ollama`. Ces outils passent par
le serveur local puis par le volet Office dans Word : ils supposent
`piecemaker start` **et** Word ouvert sur le document. Sans cela, l'appel
échoue — vérifier avec `piecemaker status` avant de conclure à un bug.

## Facturation

Les hooks `Stop` et `TaskCompleted` (`billing-track.mjs`) alimentent
`~/.piecemaker/billing/<AAAA-MM>.jsonl` et les synthèses associées. Suivi
automatique du temps par dossier ; consultable en lecture seule depuis
l'administration.

## Repères

| Quoi | Où |
| --- | --- |
| Racine des dossiers | ce répertoire (`workspacePath` de `~/.piecemaker/config.json`) |
| Administration | `https://localhost:43098/admin/` |
| Serveur | `piecemaker start` / `stop` / `status` / `logs` |
| Historique des dossiers | `~/.piecemaker/case-history/` |
| Facturation | `~/.piecemaker/billing/` |
| Configuration | `~/.piecemaker/config.json` |
