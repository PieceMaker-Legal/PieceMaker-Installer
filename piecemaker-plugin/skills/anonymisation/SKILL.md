---
name: anonymisation
description: Lancer un scan PII GLiNER/Presidio sur un document PieceMaker, lire ou modifier le mapping_default.json cumulatif, ou ré-identifier (dé-anonymiser) un texte déjà codé. À utiliser dès qu'il est question d'anonymiser une pièce, de vérifier qu'un document ne contient plus de données personnelles, ou d'éditer/consulter un mapping d'anonymisation existant.
---

# Anonymisation PieceMaker (GLiNER/Presidio)

## Ce que fait réellement ce pipeline

- Le scanner PII local bas niveau est
  `websocket-server/scripts/presidio-gliner/presidio-gliner.py`. Il prend un
  fichier **Markdown** (pas de PDF/DOCX direct) et écrit un payload brut
  `<output_dir>/<stem>_sensitive_map.json`. Cette commande est réservée au
  diagnostic ponctuel et doit viser un répertoire temporaire :
  ```
  python3 websocket-server/scripts/presidio-gliner/presidio-gliner.py document.md -o output_dir
  ```
  Positional : `md_file`. Option : `-o`/`--output` (défaut
  `./presidio_gliner_output`). Le script détecte la langue, combine des
  reconnaisseurs à motifs (emails, IBAN, SIREN/SIRET, téléphones, etc.) et un
  reconnaisseur NER (Presidio + GLiNER2) pour PERSON/ORGANIZATION/LOCATION,
  puis résout les chevauchements de spans avant d'écrire le payload.
- Pour le flux normal, utilisez
  `websocket-server/scripts/convert_and_scan_pipeline.py` qui enchaîne
  conversion + scan et journalise `PROGRESS:CONVERT:...` /
  `PROGRESS:SCAN:...` sur stdout. Les payloads bruts sont alors temporaires :
  seul `mapping_default.json` demeure et s'enrichit à chaque lot.
- Le fichier de mapping consommé par l'application vit dans le sous-dossier des
  fichiers produits du dossier,
  `<dossier>/Fichiers convertis PieceMaker/mapping_default.json` (la lecture
  retombe sur une copie restée à la racine pendant la migration),
  et a la forme :
  ```json
  { "mapping": { "Jean Dupont": "PERSON_01" },
    "reverse_mapping": { "PERSON_01": ["Jean Dupont"] } }
  ```
  Il est géré côté serveur par
  `taskpane/modules/anonymization-server.cjs`, qui expose
  `GET/PUT/DELETE /api/anonymize/mapping/:documentId` et
  `POST /api/anonymize/text` (paramètre `direction`: `anonymize` ou
  `deanonymize`).

## Règle impérative : ordre longest-entity-first

Avant d'appliquer un mapping à du texte (remplacement direct ou édition
manuelle), **triez toujours les entités par longueur décroissante** avant de
substituer, exactement comme `byDescendingEntityLength` dans
`anonymization-server.cjs`. Sinon une entité courte contenue dans une plus
longue (ex. "Dupont" dans "Jean Dupont-Martin") est remplacée en premier et
casse l'entité longue. Cette règle s'applique aussi bien en écrivant du code
qu'en éditant un mapping JSON à la main.

## Workflow type

1. **Scanner et mettre à jour** : lancer `convert_and_scan_pipeline.py` sur
   les pièces. Il fusionne immédiatement les entités dans
   `mapping_default.json`, sans laisser de sensitive map par pièce.
2. **État de traitement** : ne jamais déduire les fichiers analysés du mapping.
   `.piecemaker/anonymization-state.json` ne contient que des clés de chemins
   hachées et des empreintes taille/mtime distinctes pour conversion et scan ;
   l'administration l'utilise pour ne relancer que les sources nouvelles ou
   modifiées.
3. **Éditer un mapping existant** : lisez toujours le fichier avant de le
   réécrire (`GET /api/anonymize/mapping/:documentId` ou lecture directe du
   JSON) — n'écrasez jamais un mapping sans l'avoir d'abord chargé, un faux
   positif retiré à la main ne doit pas être réintroduit par un scan
   ultérieur qui écraserait le fichier entier.
4. **Vérifier l'absence de PII résiduelle** avant tout envoi externe d'un
   document : voir l'agent `verificateur-anonymisation`, qui automatise
   exactement cette vérification en lecture seule.
5. **Ré-identifier** (dé-anonymiser) : appliquer le `reverse_mapping` au
   texte anonymisé, code → texte original, en interne uniquement — ne jamais
   exposer le `reverse_mapping` en dehors du contexte de travail légitime sur
   le dossier.

## Limites à connaître

- L'anonymisation de PieceMaker est **entièrement locale** : le scan et le
  mapping reposent sur `presidio-gliner.py` (pipeline admin ou cette skill).
  Il n'existe pas de service d'anonymisation distant.
- `presidio-gliner.py` ne détecte pas nécessairement 100% des PII (faux
  négatifs possibles sur des formats atypiques) : une relecture humaine du
  document anonymisé reste nécessaire avant tout envoi à un tiers.
