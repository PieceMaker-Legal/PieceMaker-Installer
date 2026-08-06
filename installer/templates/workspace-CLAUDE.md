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

1. **Les « Pièces originales » ne se lisent jamais.** Un hook `PreToolUse`
   (`protect-originals.mjs`) refuse tout `Read`/`Grep`/`Glob`/`Bash` visant un
   sous-dossier « Pièces originales », quelle que soit la casse ou
   l'accentuation. On travaille sur le Markdown converti et sur les mappings,
   jamais sur l'original. Un refus du hook n'est pas un bug : ne pas le
   contourner.
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
- **Quoi** : uniquement les `.md` et les `.json`. Les originaux, les PDF, les
  DOCX et tout ce qui est sous « Pièces originales » sont exclus par
  construction.
- **Quand** : après chaque écriture, et seulement si l'arbre a réellement
  changé (pas de commit vide). Auteur `PieceMaker <commits@piecemaker.local>`,
  message = « Création/Modification de <chemin relatif> ».
- **Consulter ou restaurer** : par l'administration
  (`https://localhost:43098/admin/`), section historique du dossier. Ne pas
  manipuler `~/.piecemaker/case-history/` à la main.
- **Désactiver** : `commits.enabled: false` dans `~/.piecemaker/config.json`.

## Anonymisation

- `pre-anonymize.mjs` (PreToolUse) : heuristique rapide (email, téléphone,
  IBAN, SIREN/SIRET) avant lecture d'un document. Avertit ; ne bloque que si
  `anonymization.blockOnPII` est vrai.
- `post-anonymize.mjs` (PostToolUse) : le vrai scan GLiNER/Presidio après
  production d'un document.
- **Mapping du dossier** : `mapping_dossier.json`, à la racine du dossier
  juridique. Les entrées sont triées de la plus longue entité à la plus
  courte — toute substitution doit respecter cet ordre, sinon « Dupont »
  corrompt « Jean Dupont-Martin ». Un code n'est jamais réattribué ; une
  entrée supprimée passe sous `ignored` pour ne pas revenir au rebuild.
- Skill `anonymisation` : scan, lecture/édition d'un mapping, ré-identification
  d'un texte codé.

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
