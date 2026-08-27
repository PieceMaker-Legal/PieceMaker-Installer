# Plan d’adaptation de Graphify au graphe juridique PieceMaker

**Date** : 2026-08-26  
**Branche de travail PieceMaker** : `legal-graphify`  
**Fork Graphify** : `PieceMaker-Legal/graphify`, branche
`feature/mapping-default-entities`, basée sur Graphify upstream 0.9.48

## 1. Décision structurante

Le `mapping_default.json` a deux fonctions différentes qui ne doivent plus être
confondues :

1. son mapping complet sert à pseudonymiser toutes les données sensibles avant
   un appel au modèle ;
2. `informations_dossier.parties_clientes` et
   `informations_dossier.parties_adverses` identifient les seules personnes ou
   sociétés qui ont été choisies par l’utilisateur comme parties à la
   procédure.

Le résultat brut de GLiNER est donc un **vivier de données sensibles**, pas une
ontologie du dossier. Il peut contenir des témoins, salariés, correspondants,
signataires accessoires, membres de famille ou personnes citées dans une pièce
sans avoir de qualité procédurale.

Le graphe juridique riche doit prendre pour registre autoritatif uniquement les
parties sélectionnées par l’utilisateur après le scan GLiNER.

Cette sélection est une **frontière dure du graphe**, pas un indice de
classement : le graphe juridique se construit exclusivement autour de ces
parties. Une pièce qui ne mentionne aucune partie sélectionnée, ainsi que les
concepts que le modèle pourrait en extraire, restent hors du graphe juridique
riche.

Conséquences :

- toutes les entrées du mapping continuent d’être remplacées dans le texte pour
  garantir la confidentialité ;
- seules les affectations d’identité des parties sélectionnées deviennent des
  nœuds de personne ou de société dans le graphe juridique ;
- un code GLiNER seulement mentionné dans une pièce ne suffit jamais à devenir
  une partie ;
- les dossiers Data Room et Correspondance alimentent toujours Graphify,
  que le nom des parties y figure ou non (implémentation en cours — voir
  § 6.1.1) ;
- tout nœud juridique conservé doit posséder un chemin vers au moins une partie
  sélectionnée ;
- le préfixe d’un code (`CLIENT_`, `ADVERSAIRE_`, `DEMANDEUR_`, etc.) sert à
  contrôler la cohérence, jamais à reconstruire silencieusement un choix
  utilisateur absent ;
- sans parties sélectionnées, le graphe juridique riche n’est pas construit.
  Le graphe documentaire GLiNER et la chronologie restent disponibles.

## 2. Périmètre exact des entités importantes

Une entité est une partie autorisée si et seulement si elle provient d’un objet
de `parties_clientes` ou `parties_adverses` et peut être reliée à un code par :

1. une entrée de `mapping_assignments` dont `field === "identite"` ;
2. pour un ancien mapping, une correspondance exacte entre le champ choisi par
   l’utilisateur (`nom` ou `societe_nom`) et le mapping complet.

La deuxième voie est une compatibilité de migration. Elle reste fondée sur la
liste de parties saisie par l’utilisateur ; elle ne parcourt pas le mapping à la
recherche de parties probables.

Les affectations de date de naissance, adresse, SIREN, siège social ou
représentant ne créent pas de partie.

Un dirigeant renseigné comme représentant d’une société n’est pas, de ce seul
fait, partie à la procédure. Il ne doit donc pas être un nœud central. Il ne
devient une partie que si l’utilisateur l’ajoute séparément dans la liste des
parties. Une relation société-représentant pourra être ajoutée ultérieurement,
mais elle ne fait pas partie du premier lot.

## 3. Flux cible

```text
scan GLiNER
    │
    ├── mapping complet ──▶ applyMapping() ──▶ corpus entièrement pseudonymisé
    │
    └── choix utilisateur dans informations_dossier
              │
              ▼
       registre des parties sélectionnées
              │
              ├── sélection des seules pièces qui mentionnent une partie
              ├── projection temporaire sans PII pour Graphify
              └── sous-graphe connecté aux parties sélectionnées
```

La projection transmise à Graphify ne reprend ni les noms, ni les aliases, ni
`extracted_data`, ni le chemin du mapping :

```json
{
  "schema_version": 1,
  "mapping": {
    "Laurent Dumas":
      "Laurent Dumas"
  },
  "entity_metadata": {
    "Laurent Dumas": {
      "entity_type": "personne",
      "procedural_role": "demandeur",
      "side": "client",
      "is_key_party": true
    }
  }
}
```

Les valeurs admises sont fermées :

- `entity_type` : `personne` ou `societe` ;
- `procedural_role` : `demandeur`, `defendeur`, `appelant`, `intime`,
  `requerant`, `mis_en_cause`, `intervenant` ou `autre` ;
- `side` : `client` ou `adversaire` ;
- `is_key_party` : toujours `true` dans ce registre.

`position_libelle` n’est pas transmis : c’est un champ libre qui n’est pas
nécessaire au moteur et ne doit pas franchir la frontière de pseudonymisation.

## 4. Lot 1 — Extraire un registre autoritatif des parties

Créer `websocket-server/legal-party-registry.cjs` afin de ne pas ajouter cette
logique métier au fichier `legal-graph.cjs`, déjà volumineux.

Le module exposera au minimum :

- `buildLegalPartyRegistry(mappingDocument)` ;
- `partyCodeForSelection(party, mappingDocument)` ;
- `partyRelationForPosition(position)` ;
- `serializeSafePartyRegistry(registry)`.

### 4.1 Résolution

Pour chaque côté :

1. normaliser les parties avec les règles existantes de `mapping.cjs` ;
2. ne considérer que l’affectation `field === "identite"` ;
3. vérifier que son code existe toujours dans `reverse_mapping` ou dans les
   valeurs du mapping direct ;
4. vérifier que la catégorie correspond au type de partie choisi ;
5. produire un enregistrement sûr : `code`, `entityType`, `side`, `position` ;
6. à défaut d’affectation, tenter uniquement la correspondance exacte du nom
   explicitement choisi dans le mapping ;
7. si la partie reste irrésolue, refuser la construction et demander à
   l’utilisateur de rouvrir puis d’enregistrer les parties.

### 4.2 Conflits

La construction doit échouer avant Graphify si :

- deux parties distinctes revendiquent le même code avec des côtés ou positions
  incompatibles ;
- une personne sélectionnée pointe vers un code société, ou inversement ;
- une affectation d’identité pointe vers un code absent du mapping ;
- la liste contient une partie sans identité exploitable.

Il ne doit exister aucun comportement « dernier enregistrement gagnant ».

### 4.3 Absence de sélection

`buildLegalGraph()` et `legalGraphStatus()` doivent distinguer :

- `mapping_missing` : le dossier n’a pas encore été anonymisé ;
- `parties_required` : le scan existe mais l’utilisateur n’a pas sélectionné
  les parties ;
- `party_selection_invalid` : la sélection existe mais ne rejoint plus le
  mapping ;
- `ready` : le registre des parties est cohérent.

Une fois le registre valide, la construction distingue aussi
`no_party_documents` lorsqu’aucune pièce analysable ne mentionne une partie
sélectionnée. Dans ce cas, elle s’arrête avant Graphify et demande de vérifier
le mapping, le scan ou la sélection des parties.

Le message utilisateur de `parties_required` doit renvoyer vers l’éditeur des
parties de la procédure dans l’administration.

## 5. Lot 2 — Étendre le fork Graphify de façon sûre

Le fork sait déjà lire `mapping_default.json`, canoniser les aliases et ajouter
des références documentaires déterministes. En revanche,
`graphify/entity_mapping.py` ne conserve actuellement que `entity_type` ; les
champs de rôle et de côté seraient ignorés.

### 5.1 Modèle

Étendre `MappedEntity` avec des champs typés, sans dictionnaire arbitraire :

- `procedural_role: str | None` ;
- `side: str | None` ;
- `is_key_party: bool`.

`entity_type` reste le type grossier existant.

### 5.2 Lecture et validation

`load_entity_mapping()` doit :

- lire `entity_metadata` par code canonique ;
- ignorer ou refuser tout champ non autorisé ;
- valider les enums ci-dessus ;
- refuser une métadonnée visant un code absent de `mapping` ;
- continuer à lire `extracted_data` pour les usages historiques ;
- ne jamais recopier les aliases privés ni le chemin du fichier dans le
  graphe.

### 5.3 Nœuds canoniques

`augment_extraction()` doit poser sur le nœud canonique :

- `entity_type` ;
- `procedural_role` ;
- `side` ;
- `is_key_party` ;
- `extraction_method: "entity_mapping"`.

Ces métadonnées proviennent du registre déterministe et gagnent sur les valeurs
éventuellement produites par le LLM.

### 5.4 Tests Graphify

Compléter `tests/test_entity_mapping.py` avec :

- propagation des quatre champs autorisés ;
- rejet des enums invalides et des codes inconnus ;
- non-propagation d’un champ libre ou d’un alias ;
- compatibilité avec un mapping sans `entity_metadata` ;
- stabilité des IDs et idempotence ;
- test CLI `--entity-map-labels canonical` sans nom en clair.

## 6. Lot 3 — Recentrer la topologie PieceMaker

### 6.1 `legalTopology()`

Remplacer la collecte de toutes les entrées `personne` et `societe` de la
chronologie par :

1. la construction du registre des parties ;
2. l’inclusion systématique de toutes les pièces situées dans les dossiers
   Data Room et Correspondance, indépendamment de la mention d’une partie ;
3. pour les autres pièces, l’intersection entre `doc.codes` et les codes du
   registre ; inclusion si cette intersection n’est pas vide ;
4. le signalement séparé des pièces écartées, qui restent disponibles dans la
   chronologie et le graphe documentaire GLiNER.

### 6.1.1 Inclusion automatique Data Room / Correspondance — EN SUSPENS

Les pièces des dossiers Data Room (`02_DATA_ROOM`) et Correspondance
(`01_CORRESPONDANCE`) alimentent Graphify sans condition de mention d’une
partie sélectionnée. L’implémentation nécessite la résolution du chemin de
chaque pièce par rapport à l’arborescence métier définie dans
`case-folder-structure.cjs`. Ce point est en cours d’implémentation et
sera intégré une fois la structure de dossier exploitable par
`legalTopology()`.

La topologie contiendra :

```javascript
{
  parties: [{ code, entityType, side, position }],
  documents: [{ ..., partyCodes: ["Laurent Dumas"] }],
  excludedDocuments: [{ key, reason: "aucune_partie_selectionnee" }]
}
```

Les anciens champs `codes` pourront être maintenus temporairement comme alias
interne de `partyCodes` pendant la migration, puis supprimés.

Une partie sélectionnée qui n’est mentionnée dans aucune pièce reste dans le
registre. Son nœud sera créé, avec `review_required` et la raison
`partie_absente_des_pieces`.

Si aucune partie sélectionnée n’est mentionnée dans aucune pièce analysable,
il n’existe pas de corpus juridique valable : la construction renvoie
`no_party_documents` au lieu de produire un graphe composé seulement de nœuds
isolés ou de connaissances générales.

### 6.2 Corpus

`applyMapping()` continue d’utiliser le mapping complet sur tout le corps de la
pièce. L’en-tête devient :

```markdown
- parties_explicites: Laurent Dumas (demandeur/client)
```

Il ne liste aucun autre code GLiNER.

Le prompt juridique doit préciser que :

- seuls les codes énumérés comme parties autorisées peuvent devenir des nœuds
  `legal_kind="personne"` ;
- les autres codes pseudonymisés présents dans le texte sont de simples données
  de contexte ;
- Graphify ne doit leur inventer ni qualité procédurale ni nœud de partie.

Seules les pièces déjà retenues par `legalTopology()` sont écrites dans le
corpus temporaire. Une pièce hors périmètre n’est pas envoyée au LLM pour cette
construction, même si elle a été convertie et pseudonymisée.

### 6.3 Entity map temporaire

`writeLegalInputs()` utilise `serializeSafePartyRegistry()`. Il ne copie jamais
le véritable `mapping_default.json` ni son `extracted_data` dans le répertoire
temporaire Graphify.

### 6.4 Cache

`topologySignature()` doit intégrer :

- la version du schéma du registre ;
- pour chaque partie : code, type, côté et position ;
- les `partyCodes` de chaque pièce ;
- les identifiants et raisons des pièces exclues ;
- la version du prompt juridique et la version d’intégration Graphify.

Modifier une partie ou sa position invalide ainsi le cache, même si le texte
des pièces n’a pas changé.

### 6.5 Cadre juridique général

Les nœuds statiques du cadre français ne doivent plus être ajoutés
inconditionnellement à chaque dossier. Une norme ou un principe général n’entre
dans le graphe de l’affaire que s’il est relié à un concept extrait d’une pièce
du périmètre et, par ce chemin, à une partie sélectionnée.

Le cadre général peut rester une source de référence pour l’extraction, mais la
finalisation doit élaguer ses nœuds déconnectés. À terme, ce cadre pourra vivre
dans un graphe de référence séparé, interrogé puis greffé au sous-graphe du
dossier uniquement lorsqu’une question ou une pièce le justifie.

## 7. Lot 4 — Construire les relations procédurales déterministes

`finalizeLegalGraph()` doit traiter le registre PieceMaker comme prioritaire sur
la sortie du modèle.

### 7.1 Nœuds

- créer exactement un nœud canonique par partie sélectionnée ;
- conserver le code comme label persistant ;
- poser `entity_type`, `procedural_role`, `side` et `is_key_party` ;
- rejeter tout nœud personne/société produit par le modèle dont le code ne
  figure pas dans le registre ;
- créer un nœud stable `procedure_dossier`, sans nom de dossier ni autre PII.

### 7.2 Arêtes

Créer sans LLM :

- `procedure_dossier --a_pour_demandeur--> partie` pour un demandeur ;
- `procedure_dossier --a_pour_defendeur--> partie` pour un défendeur ;
- `procedure_dossier --a_pour_partie--> partie` pour les autres positions, le
  rôle précis restant porté par `procedural_role` ;
- `document --mentionne--> partie` seulement lorsque l’index de la pièce
  contient son code ;
- `index_personnes_dossier --porte_sur--> partie` pour chaque partie
  sélectionnée.

Ces arêtes donnent aux parties leur centralité structurelle. Le degré brut
n’est plus utilisé pour décider a posteriori quelles personnes seraient
importantes.

### 7.3 Invariant de connexité aux parties

Après l’ajout des arêtes déterministes, calculer les nœuds atteignables depuis
l’ensemble des parties sélectionnées sur la vue non dirigée du graphe.

Ne conserver que :

- les parties sélectionnées ;
- `procedure_dossier` et les index qui leur sont effectivement reliés ;
- les documents du périmètre ;
- les concepts, relations, normes et hyperarêtes atteignables depuis ces
  parties.

Un nœud sémantique isolé, un fragment de cadre général sans lien avec l’affaire
ou un concept provenant d’une pièce exclue est supprimé. La finalisation échoue
si un document ou un concept conservé référence un fichier qui n’appartient pas
au corpus filtré.

### 7.4 Contrôles

- les métadonnées du registre écrasent celles du LLM ;
- un code non partie ne peut pas devenir un nœud de personne par reformulation
  du modèle ;
- chaque nœud métier persistant est atteignable depuis une partie sélectionnée ;
- la vérification finale contre tous les noms clairs du mapping complet reste
  active ;
- les statistiques distinguent `selectedParties`, `mentionedParties` et
  `selectedPartiesWithoutMention`, ainsi que `excludedDocuments` et
  `prunedDisconnectedNodes`.

## 8. Lot 5 — Requêtes et restitution

Dans le premier lot fonctionnel, conserver le moteur de requête BFS de
Graphify. Ajouter à `enrichLegalQueryOutput()` :

- `role` ;
- `side` ;
- `is_key_party` ;
- la mention qu’une partie est absente des pièces indexées.

Les requêtes générales sur les acteurs doivent partir du nœud
`procedure_dossier` ou de `index_personnes_dossier`, et non d’un classement de
tous les codes GLiNER par degré.

Le PPR/BM25 décrit dans l’audit reste une évolution ultérieure. Il devra être
évalué une fois le périmètre des parties correct, sinon les mesures seraient
biaisées par les entités sensibles hors dossier actuellement injectées dans le
graphe.

La visualisation du graphe juridique riche est également différée. Le viewer
actuel de `admin/app.js` représente le graphe documentaire de la chronologie ;
le modifier ne rendrait pas automatiquement le graphe juridique visible.

## 9. Lot 6 — Publication et installation du fork

Le développement local importe actuellement le code du checkout Graphify basé
sur 0.9.48 alors que `graphify --version` affiche 0.9.39. Cette divergence doit
être supprimée avant livraison.

Dans le dépôt Graphify :

1. mettre à jour la version du package ;
2. exécuter les tests ciblés puis la suite Python pertinente ;
3. exécuter `graphify update .` après les modifications de code, conformément à
   son `AGENTS.md` ;
4. publier un tag immuable du fork PieceMaker.

Dans PieceMaker :

1. ajouter une étape d’installation Graphify idempotente ;
2. utiliser un environnement virtuel Graphify séparé du venv GLiNER ;
3. installer le tag exact du fork, pas une branche mouvante ;
4. faire rechercher ce binaire géré avant `~/.local/bin/graphify` ;
5. ajouter à `piecemaker doctor` les contrôles de version et de prise en charge
   d’`entity_metadata`.

## 10. Tests PieceMaker

### 10.1 Fixture principale

Créer un dossier contenant :

- un client demandeur sélectionné ;
- une société adverse défenderesse sélectionnée ;
- le dirigeant de cette société, renseigné comme représentant mais non partie ;
- un témoin détecté par GLiNER mais non sélectionné ;
- une personne citée sans rapport direct avec la procédure ;
- une partie sélectionnée qui n’apparaît dans aucune pièce ;
- une pièce ne mentionnant aucune partie sélectionnée mais contenant des
  concepts juridiques plausibles ;
- des adresses, SIREN et autres données sensibles.

Attendus :

- seuls le demandeur et la société défenderesse sont des nœuds de partie ;
- le dirigeant, le témoin et la personne accessoire ne sont pas des parties ;
- la pièce sans partie sélectionnée et tous ses concepts sont absents du graphe
  riche ;
- le mapping complet pseudonymise néanmoins toutes leurs surfaces dans le
  corpus ;
- la partie sans mention existe et demande une révision ;
- aucune donnée en clair n’apparaît dans le graphe, le manifeste ou la sortie de
  requête.

### 10.2 Cas de validation

Ajouter des tests pour :

- mapping présent sans parties : `parties_required` ;
- ancien `informations_dossier` sans `mapping_assignments`, mais identité
  choisie retrouvée exactement ;
- identité sélectionnée absente du mapping : erreur avant Graphify ;
- même code revendiqué par deux parties incompatibles : erreur ;
- changement de position : cache périmé ;
- code GLiNER personne/société non sélectionné : aucun nœud de partie ;
- pièce sans partie sélectionnée : jamais écrite dans le corpus Graphify ;
- aucune pièce ne mentionnant une partie sélectionnée :
  `no_party_documents` ;
- nœud sémantique ou norme générale déconnecté des parties : élagué ;
- invariant global : tout nœud métier du résultat possède un chemin vers une
  partie sélectionnée ;
- dirigeant ajouté séparément comme partie : il devient alors un nœud central
  comme toute autre partie explicitement choisie.

### 10.3 Commandes de validation

```bash
node --test test/legal-party-registry.test.cjs
node --test test/legal-graph.test.cjs
node --test test/admin-mapping-model.test.mjs
npm test
```

Dans le fork Graphify :

```bash
pytest -q tests/test_entity_mapping.py
graphify update .
```

## 11. Ordre de livraison

1. **Contrat et tests Graphify** : prise en charge sûre d’`entity_metadata`.
2. **Registre PieceMaker** : résolution exclusive des parties choisies et états
   `parties_required` / `party_selection_invalid`.
3. **Topologie et finalisation** : filtrage des codes, nœud procédure et arêtes
   déterministes.
4. **Cache et restitution** : invalidation sur les rôles et sortie enrichie.
5. **Packaging** : tag du fork, installation PieceMaker et diagnostic.
6. **Évolutions mesurées** : PPR/BM25, graphe temporel puis viewer juridique.

Chaque étape doit rester utilisable seule et ne doit jamais dégrader le graphe
documentaire sans LLM.

## 12. Critères d’acceptation globaux

Le travail est terminé lorsque :

- aucune personne ou société ne devient importante sur la seule décision de
  GLiNER ou du LLM ;
- toutes les parties centrales résultent d’un choix utilisateur traçable dans
  `informations_dossier` ;
- aucune pièce ni aucun concept juridique hors du voisinage des parties
  sélectionnées n’entre dans le graphe riche ;
- chaque nœud métier persistant est relié à au moins une partie sélectionnée ;
- le graphe juridique refuse une sélection absente ou incohérente ;
- l’intégralité du mapping reste appliquée pour la confidentialité ;
- seuls des codes et métadonnées procédurales fermées sont transmis à
  Graphify ;
- la construction des nœuds et relations de procédure ne dépend pas du LLM ;
- les caches réagissent aux changements de parties et de positions ;
- le fork installé est versionné, reproductible et contrôlé par
  `piecemaker doctor` ;
- les suites de tests PieceMaker et Graphify sont vertes.

## 13. Hors périmètre du premier lot

- déduire des parties depuis l’ensemble des résultats GLiNER ;
- considérer tous les dirigeants ou représentants comme parties ;
- analyser dans le graphe riche une pièce ne mentionnant aucune partie
  sélectionnée ;
- conserver des normes ou concepts généraux déconnectés des parties ;
- utiliser les préfixes de codes comme substitut à une sélection utilisateur ;
- copier le véritable mapping ou `extracted_data` dans Graphify ;
- porter immédiatement les ontology profiles du fork TypeScript ;
- ajouter PPR, temporal slicing, réconciliation ou viewer juridique avant que
  le registre des parties soit correct et testé.
