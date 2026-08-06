---
name: anonymisation
description: Lancer un scan PII GLiNER/Presidio sur un document PieceMaker, lire ou modifier un fichier de mapping d'anonymisation (mapping_{documentId}.json), ou ré-identifier (dé-anonymiser) un texte déjà codé. À utiliser dès qu'il est question d'anonymiser une pièce, de vérifier qu'un document ne contient plus de données personnelles, ou d'éditer/consulter un mapping d'anonymisation existant.
---

# Anonymisation PieceMaker (GLiNER/Presidio)

## Ce que fait réellement ce pipeline

- Le scanner PII local est
  `websocket-server/scripts/presidio-gliner/presidio-gliner.py`. Il prend un
  fichier **Markdown** (pas de PDF/DOCX direct) et écrit
  `<output_dir>/<stem>_sensitive_map.json` :
  ```
  python3 websocket-server/scripts/presidio-gliner/presidio-gliner.py document.md -o output_dir
  ```
  Positional : `md_file`. Option : `-o`/`--output` (défaut
  `./presidio_gliner_output`). Le script détecte la langue, combine des
  reconnaisseurs à motifs (emails, IBAN, SIREN/SIRET, téléphones, etc.) et un
  reconnaisseur NER (Presidio + GLiNER2) pour PERSON/ORGANIZATION/LOCATION,
  puis résout les chevauchements de spans avant d'écrire le payload.
- Si le document n'est pas encore en Markdown, convertissez-le d'abord (voir
  la skill `conversion-md`), ou utilisez
  `websocket-server/scripts/convert_and_scan_pipeline.py` qui enchaîne
  conversion + scan et journalise `PROGRESS:CONVERT:...` /
  `PROGRESS:SCAN:...` sur stdout.
- Le fichier de mapping consommé par l'application vit à
  `output/mapping_<documentId>.json` (ou dans le répertoire de sortie choisi)
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

1. **Scanner** : convertir en Markdown si nécessaire, puis lancer
   `presidio-gliner.py` sur le fichier. Lire `<stem>_sensitive_map.json`
   pour connaître les entités détectées (type, texte, position, score).
2. **Construire/mettre à jour le mapping** : transformer les entités en
   paires `{texte: code}` / `{code: [texte, ...]}`, en donnant un code stable
   par type (`PERSON_01`, `ORGANIZATION_01`, `LOCATION_01`, ...), sans
   jamais réutiliser un code pour deux textes différents.
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

- Le flux de production principal de PieceMaker
  (`POST /api/anonymize/process` dans `websocket-server/server.cjs`) délègue
  l'anonymisation en masse à un service MCP distant et n'utilise pas
  `presidio-gliner.py` directement — cette skill couvre le scan/mapping
  **local**, utilisé pour l'audit, le contrôle qualité et l'édition fine.
- `presidio-gliner.py` ne détecte pas nécessairement 100% des PII (faux
  négatifs possibles sur des formats atypiques) : une relecture humaine du
  document anonymisé reste nécessaire avant tout envoi à un tiers.
