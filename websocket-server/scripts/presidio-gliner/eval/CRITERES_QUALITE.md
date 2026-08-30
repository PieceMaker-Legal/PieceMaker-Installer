# Étapes 1 à 3 du plan v3 — état réel et vérification

**Les trois étapes étaient déjà implémentées** (commit `e629580`), contrairement à ce que laisse
croire `AUDIT_PERF_QUALITE.md`, qui les décrit encore comme à faire. Ce fichier-là est un plan figé
au moment où il a été écrit ; le code a avancé depuis.

Ce qui manquait n'était pas le code, mais la **vérification contre les critères d'acceptation que le
plan s'était lui-même donnés**. Elle est faite ici, et elle a trouvé une fuite de PII réelle.

Rejouer : `node verify_substitution.cjs <doc.md> <doc_sensitive_map.json>` ·
`python3 verify_whitespace.py <doc_sensitive_map.json> [doc.md]`

---

## Étape 1 — substitution · critère « 0 substitution à l'intérieur d'un mot »

`buildEntityRegex` (limites de mot Unicode, longueur minimale 4 sauf acronymes majuscules,
sensibilité à la casse pour les entités courtes, tolérance aux blancs) et
`byDescendingEntityLength` (la plus longue d'abord) — `websocket-server/lib/anonymization-server.cjs`.

Mesuré sur GENSIGHT_URD, 793 entités distinctes issues d'un vrai scan :

| règle | substitutions | dont à l'intérieur d'un mot |
|---|---|---|
| ancienne (`new RegExp(escapeRegex(x), 'gi')`) | 47 273 | **32 329** (68 %) |
| **actuelle** | 17 157 | **0** |

Pires entités sous l'ancienne règle : `CE` 6 915 (« Registered Offi**ce** », « Fran**ce** »),
`CA` 4 724 (« share **ca**pital »), `ANC` 2 662 (« Fr**anc**e »), `US`/`us` 1 918 chacun,
`SO` 1 396, `EP` 1 350, `AU` 1 028 (« F**au**bourg »).

**CRITÈRE TENU.** Trois entités sont refusées comme trop ambiguës : `WWe`, `Lam`, `us`.

## Étape 2 — normalisation des blancs · critère « 0 entité avec `\n` ou double espace »

`normalize_markdown_whitespace` (à la conversion, `smart_converter.py`) et
`normalize_entity_text` (clé d'identité, `scan_utils.py`).

| document | occurrences | distinctes | `\n` | double espace | insécable | largeur nulle |
|---|---|---|---|---|---|---|
| GENSIGHT_URD | 3 586 | 793 | **0** | **0** | **0** | **0** |
| Assignation URGOT | 62 | 23 | **0** | **0** | **0** | **0** |
| Conclusions | 35 | 11 | **0** | **0** | **0** | **0** |

Aucun faux distinct ne subsiste (793 brutes → 793 normalisées). **CRITÈRE TENU.**

## Étape 3 — arbitrage de spans

`resolve_overlapping_spans` (`scan_utils.py`) supprime tout chevauchement **quel que soit le type**,
départage par longueur puis score puis priorité de type. Déjà en place et appelé par le worker.

---

## La fuite trouvée par la vérification : les traits d'union Unicode

Sur GENSIGHT, **une entité détectée n'était jamais substituée** — donc laissée en clair dans le
document remis au tiers, ce qui est la seule faute grave possible pour cet outil.

`normalize_entity_text` applique NFKC, qui réécrit **U+2011 NON-BREAKING HYPHEN en U+2010 HYPHEN**.
Le document contient `Kreos‑A` (U+2011), le mapping portait donc `Kreos‐A` (U+2010), et la regex
construite sur la forme normalisée ne trouvait rien.

Corrigé dans `buildEntityRegex` par le même principe que la tolérance aux blancs : chaque
tiret, apostrophe et guillemet est traduit en classe couvrant toutes ses graphies Unicode
(`CHAR_VARIANTS`). Les apostrophes sont incluses parce que le français en dépend
(`d'affaires` / `d’affaires`), même si NFKC ne les touche pas.

Après correction : **0 entité jamais retrouvée**, sur les trois documents.

> C'est le genre de défaut qu'aucune relecture ne trouve : le code est correct, la normalisation
> est correcte, et c'est leur composition qui fuit. Il fallait compter les entités dont la regex ne
> matche rien.

---

## Un piège de robustesse trouvé au passage

`scanner_worker.py` écrivait une ligne stderr **par entité** (3 586 sur GENSIGHT). Un parent qui ne
vide pas stderr en continu remplit le tube de 64 Ko et le worker se bloque définitivement dans son
`print()` — observé comme un blocage de 25 minutes en plein scan, sans erreur. La liste complète est
désormais derrière `PIECEMAKER_DEBUG_ENTITIES`, qui protégeait déjà le texte des entités.
