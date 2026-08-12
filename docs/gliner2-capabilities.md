# GLiNER2 — capacités mesurées et usage dans PieceMaker

Le modèle chargé par le scanner (`fastino/gliner2-multi-v1`, ~205 M paramètres,
encodeur mdeberta-v3) n'est pas un simple extracteur d'entités : GLiNER2 est un
extracteur **multi-tâches piloté par schéma**. Ce document consigne ce que le
modèle sait faire, mesuré sur la machine cible avec le modèle réellement
installé — pas d'après la documentation — et pourquoi la chronologie
(nature + date + personnes citées) s'appuie dessus sans dépendance nouvelle.

## Les quatre têtes, en un seul passage

| Méthode | Rôle | Forme de sortie |
| --- | --- | --- |
| `extract_entities(text, types)` | NER (déjà utilisé pour la PII) | `{TYPE: [spans]}` |
| `classify_text(text, {tâche: labels})` | classification (mono/multi-label) | `{tâche: "label"}` ou `{tâche: {label, confidence}}` |
| `extract_json(text, {nom: {champ: desc}})` | enregistrement structuré | `{nom: [{champ: [valeurs]}]}` |
| `extract_relations(text, relations)` | triplets sujet–relation–objet | `{relation: [[sujet, objet]]}` |
| `extract(text, schema)` | schéma unifié (`create_schema().entities().classification().relations().structure().build()`) | combine les précédents |

Le schéma unifié est censé exécuter toutes les tâches en **un seul passage
avant**. C'est l'argument de conception du modèle, et c'est ce qui rend
l'ancienne objection de coût caduque.

## Mesures (modèle installé, extrait de conclusions français)

Sur un slice d'en-tête (~120 mots), après chargement du modèle (~14 s, une fois) :

- `classify_text` (nature du document, 22 labels) : **~200 ms**, label unique
  propre avec confiance (`{"nature_document": {"label": "assignation",
  "confidence": 0.85}}`).
- `extract_json` (record en-tête date + juridiction) : **~200 ms**
  (`{"acte": [{"date_acte": ["14 mars 2023"], "juridiction": ["Tribunal
  judiciaire de Paris"]}]}`).
- `extract_relations` (parties) : **~200–570 ms**, triplets corrects
  (Gilly → gérant → SCI ; Rodriguez → assigne → SCI).
- `extract_entities` (person/company/location/**date**) : **~200 ms**, la date
  ressort à 0,999 de confiance.

À comparer aux **81 min** citées dans `scanner_worker.py` : ce chiffre venait
d'un `classify_text` à 221 labels appelé **une fois par occurrence
d'organisation** (1 689 fois). Appelée **une fois par document**, sur un
en-tête borné, la classification est triviale. Le coût n'a jamais été celui de
la tâche, mais celui de l'ancienne boucle.

## Le piège trouvé en testant : `extract()` unifié perd les entités

Sur ce modèle (`gliner2-multi-v1`, v1.2.4), quand un schéma combine des entités
avec de la classification/structure, la sortie renvoie `entities: {}` — vide —
alors que la classification et les relations, elles, sont correctes. Les entités
extraites **séparément** (`extract_entities`) fonctionnent parfaitement.

**Conséquence de conception :** PieceMaker n'utilise pas le schéma unifié. Le
scan PII reste un appel `extract_entities` dédié (sur tout le document, par
chunks), et les métadonnées de document sont deux appels séparés
(`classify_text` + `extract_json`) sur l'en-tête. Chacun est sous la seconde ;
même 2–3 passages par document restent négligeables devant le scan complet.

## Ce que la chronologie en tire, et ce qu'elle n'en tire pas

- **Nature** → `classify_text`, un label par document, indicatif et
  **modifiable** dans l'administration (le modèle peut confondre une
  « assignation » citée dans des conclusions — voir la confiance).
- **Date du document** → `extract_json` (`date_acte`) normalisée en ISO par
  `normalize_document_date` (formes « 14 mars 2023 » et « 14/03/2023 »).
- **Personnes / sociétés / adresses citées** → les codes issus du scan PII
  existant. GLiNER2 fournit la matière ; **le lien entre documents se calcule**
  à partir des codes partagés (`buildChronology`), pas par le modèle.
- Ce que GLiNER2 **ne fait pas** : décider seul qu'une date est *la* date de
  l'acte (règle : première date de l'en-tête), ni relier deux documents (calcul
  sur les codes). La classification et les relations restent des assistances,
  jamais une source de vérité juridique.

## Reproduire les mesures

```bash
python3 - <<'PY'
from gliner2 import GLiNER2
g = GLiNER2.from_pretrained("fastino/gliner2-multi-v1")
print(g.classify_text("CONCLUSIONS EN DEFENSE ... assignation devant le Tribunal",
      {"nature": ["assignation","conclusions","courrier","autre"]}, include_confidence=True))
print(g.extract_json("Par acte du 14 mars 2023 devant le Tribunal judiciaire de Paris",
      {"acte": {"date_acte": "date de l'acte", "juridiction": "tribunal saisi"}}))
PY
```
