# Rapport de test — recherche jurisprudentielle Légifrance sans RAG

**Date du test :** 20 août 2026  
**Branche :** `legifrance-research`  
**Question :** « Révocation de dirigeant de société anonyme — quelles conditions ? »

## Résultat exécutif

Le prototype fonctionne de bout en bout : le MCP a identifié 836 décisions de
la Cour de cassation, obtenu et scanné 832 textes intégraux, créé une fiche pour
chacun de ces textes et validé les 832 fiches. Les quatre écarts sont des textes
vides renvoyés par l'API et restent expressément inscrits au manifeste. Aucun
plafond n'a tronqué les résultats.

Le flux n'utilise ni embeddings, ni base vectorielle, ni recherche sémantique,
ni top-k. Un filtre booléen statique, public et rejouable a fermé 471 décisions
manifestement incompatibles. Les 361 candidates restantes ont toutes été lues
par des sous-agents `gpt-5.6-luna`, puis contrôlées par code. Après audit des
citations et requalification des faux positifs, 90 décisions sont matériellement
pertinentes.

Le test final produit : 832/832 fiches valides, aucune fiche manquante, aucun
doublon, aucune erreur de schéma, aucune citation inventée et aucune citation
fragmentaire ou issue seulement des prétentions d'une partie.

## Réponse juridique au cas test

Il n'existe pas un régime unique pour tous les « dirigeants » de SA. L'organe
compétent, l'exigence d'un juste motif et le risque indemnitaire varient selon le
mandat.

1. **Administrateur.** L'assemblée générale ordinaire peut le révoquer à tout
   moment ([article L. 225-18](https://www.legifrance.gouv.fr/codes/article_lc/LEGIARTI000051322385)).
   Elle peut le faire même si la question n'était pas inscrite à l'ordre du jour,
   et procéder à son remplacement
   ([article L. 225-105](https://www.legifrance.gouv.fr/codes/article_lc/LEGIARTI000049720564)).
   Aucun juste motif n'est requis. La liberté de révocation n'autorise cependant
   ni la brutalité déloyale ni l'atteinte à l'honneur ou à la réputation.

2. **Président du conseil d'administration.** Le conseil d'administration peut
   le révoquer à tout moment ; toute clause contraire est réputée non écrite
   ([article L. 225-47](https://www.legifrance.gouv.fr/codes/article_lc/LEGIARTI000051322469)).
   Le principe est donc la révocation *ad nutum*, sans préavis, motif ni indemnité,
   sous réserve de l'abus dans les circonstances.

3. **Directeur général et directeur général délégué.** Le conseil révoque le DG
   à tout moment et, sur proposition du DG, le DGD. L'absence de juste motif peut
   ouvrir droit à dommages-intérêts, sauf lorsque le DG est également président
   du conseil ([article L. 225-55](https://www.legifrance.gouv.fr/codes/article_lc/LEGIARTI000006224059)).
   L'absence de juste motif n'anéantit donc pas la décision de révocation : elle
   déplace le litige vers la réparation.

4. **Membre du directoire ou directeur général unique.** L'assemblée générale
   est compétente ; le conseil de surveillance l'est aussi si les statuts le
   prévoient. Une révocation sans juste motif peut donner lieu à dommages-intérêts.
   Un contrat de travail distinct n'est pas résilié par la seule cessation du
   mandat ([article L. 225-61](https://www.legifrance.gouv.fr/codes/article_lc/LEGIARTI000006224179)).

5. **Procédure loyale.** Pour les mandats révocables *ad nutum*, le contradictoire
   n'est pas un procès miniature et ne transforme pas le juste motif en condition
   de validité. En revanche, le dirigeant doit pouvoir connaître les griefs et
   présenter utilement ses observations lorsque les circonstances rendraient
   autrement la décision brutale ou déloyale. Une révocation hors ordre du jour
   peut être juridiquement possible tout en devenant abusive si elle a été
   préméditée pour surprendre l'intéressé.

6. **Réparation.** L'abus ne répare pas la perte du mandat elle-même ni la chance
   de le conserver : seuls les dommages causés par les circonstances abusives
   sont réparables. Une convention de départ, une indemnité ou un nouveau contrat
   ne peut, par son poids, dissuader réellement l'organe compétent d'exercer son
   pouvoir de révocation.

### Arrêts structurants et citations exactes

- **Cass. com., 14 mai 2013, n° 11-22.845** — standard actuel de l'abus et de la
  loyauté ([JURITEXT000027424134](https://www.legifrance.gouv.fr/juri/id/JURITEXT000027424134)).

  > Attendu que la révocation d'un administrateur peut intervenir à tout moment et n'est abusive que si elle a été accompagnée de circonstances ou a été prise dans des conditions qui portent atteinte à sa réputation ou à son honneur ou si elle a été décidée brutalement, sans respecter l'obligation de loyauté dans l'exercice du droit de révocation ;

- **Cass. com., 1er juillet 2008, n° 06-19.020** — révocation possible hors ordre
  du jour ([JURITEXT000019127721](https://www.legifrance.gouv.fr/juri/id/JURITEXT000019127721)).

  > Mais attendu, en premier lieu, qu'il résulte des dispositions de l'article L. 225-105 du code de commerce que si l'assemblée générale ne peut délibérer sur une question qui n'est pas inscrite à l'ordre du jour, elle peut néanmoins, en toutes circonstances, révoquer un ou plusieurs administrateurs ou membre du conseil de surveillance et procéder à leur remplacement ;

- **Cass. com., 21 juin 1988, n° 86-19.166** — président révocable sans préavis,
  motif ni indemnité ([JURITEXT000007021057](https://www.legifrance.gouv.fr/juri/id/JURITEXT000007021057)).

  > Mais attendu que la révocation du président du conseil d'administration d'une société peut intervenir à tout moment, sans préavis ni précisions de motifs, ni indemnité, et ne peut, dès lors, donner lieu à dommages-intérêts qu'en cas d'abus commis dans l'exercice de ce droit ;

- **Cass. com., 15 novembre 2011, n° 09-10.893** — le PDG cumule deux fonctions
  révocables sans juste motif ; une indemnité ne peut neutraliser ce principe
  ([JURITEXT000024821010](https://www.legifrance.gouv.fr/juri/id/JURITEXT000024821010)).

  > Attendu, en troisième lieu, que dans le cas où la direction générale d'une société anonyme est assumée par le président du conseil d'administration, celui-ci est, au titre de ses deux fonctions, révocable à tout moment par le conseil d'administration, sans que sa révocation doive être  fondée sur un juste motif ;

- **Cass. com., 3 janvier 1996, n° 94-10.765** — brutalité, réputation et
  contradiction ([JURITEXT000007035122](https://www.legifrance.gouv.fr/juri/id/JURITEXT000007035122)).

  > Attendu que la révocation d'un directeur général peut intervenir à tout moment et n'est abusive que si elle a été accompagnée de circonstances ou a été prise dans des conditions qui portent atteinte à la réputation ou à l'honneur du dirigeant révoqué ou si elle a été décidée brutalement sans respecter le principe de la contradiction ;

- **Cass. com., 19 décembre 2006, n° 05-15.803** — mésentente grave constituant
  un juste motif pour un membre du directoire
  ([JURITEXT000007054616](https://www.legifrance.gouv.fr/juri/id/JURITEXT000007054616)).

  > Mais attendu qu'après avoir constaté qu'un grave désaccord sur le mode de gestion de la société et une forte mésentente opposaient les deux membres du directoire et relevé que ces circonstances ne permettaient pas un fonctionnement collégial de cet organe et étaient de nature à mettre en péril la bonne marche et la pérennité de la société, l'arrêt retient que la répercussion négative sur la vie de la société des désaccords profonds et manifestes entre les membres du directoire a constitué pour les actionnaires un juste motif pour révoquer M. X... de ses fonctions ;

- **Cass. com., 7 juin 1983, n° 81-11.437** — la seule divergence d'opinion,
  sans faute de gestion, ne suffit pas
  ([JURITEXT000007012553](https://www.legifrance.gouv.fr/juri/id/JURITEXT000007012553)).

  ```text
  MAIS ATTENDU QUE LA COUR D'APPEL, APRES AVOIR RELEVE QU'AUCUNE FAUTE DE GESTION N'AVAIT ETE ALLEGUEE A L'EGARD DE M X... DE LA GRAVIERE, A RETENU QUE CELUI-CI S'ETAIT BORNE A USER DE SON DROIT DE S'EXPRIMER LIBREMENT, TANDIS QUE L'ASSEMBLEE DES ACTIONNAIRES, EN ADOPTANT LE MOTIF AVANCE PAR LE CONSEIL DE SURVEILLANCE, AVAIT, EN REALITE, FAIT A M X... DE LA GRAVIERE UN <VERITABLE PROCES D'INTENTION> ;
  ```

- **Cass. com., 3 mars 2015, n° 14-12.036** — étendue limitée du préjudice
  réparable ([JURITEXT000030328209](https://www.legifrance.gouv.fr/juri/id/JURITEXT000030328209)).

  > Mais attendu, en premier lieu, qu'après avoir retenu que la révocation abusive n'ouvre droit à réparation ni du préjudice résultant de la révocation, ni même du préjudice constitué par la perte d'une chance de conserver ses fonctions, mais seulement du préjudice causé par la circonstance constitutive d'abus considérée en elle-même, la cour d'appel a alloué à M. X... une indemnité  au titre de la révocation abusive de ses mandats ;

## Protocole du test

### Périmètre déclaré

- Juridiction : Cour de cassation uniquement.
- Aucune borne de date, afin de conserver les arrêts de principe historiques.
- Six requêtes :
  - `révocation dirigeant société anonyme` — 246 résultats API ;
  - `révocable à tout moment société anonyme` — 68 ;
  - `révocation abusive société anonyme` — 332 ;
  - `révocation administrateur société anonyme` — 279 ;
  - `révocation directeur général société anonyme` — 389 ;
  - `juste motif révocation société anonyme` — 180.
- 17 appels paginés de recherche ; 836 identifiants uniques après déduplication.
- Plafond par requête : 500 ; plafond global : 1 000 ; aucune troncature.

« Exhaustif » signifie ici : chaque résultat appartenant à l'union de ces six
requêtes, dans les limites déclarées, a été conservé et traité. Cela ne signifie
pas que toute la jurisprudence française existante a été capturée.

### Pipeline sans RAG

1. Pagination de chaque requête et déduplication par identifiant officiel.
2. Téléchargement concurrent et conservation locale de chaque texte intégral.
3. Scan statique de tous les textes : révocation + fonction dirigeante dans une
   distance maximale de 300 caractères + contexte de SA.
4. Fermeture déterministe de 471 incompatibilités ; lecture par modèle des 361
   candidates, sans classement de sélection.
5. Transmission de toutes les fenêtres de cooccurrence, fusionnées à ±1 200
   caractères ; accès au texte intégral local en cas d'ambiguïté.
6. Une fiche JSON plate par décision. Il n'existe pas de champ `preuves` ; le
   champ `citation_exacte` est obligatoire pour toute fiche pertinente.
7. Validation statique de la cardinalité, des identifiants, du schéma et de la
   présence littérale de chaque citation dans la source. Le validateur rejette
   aussi les fragments, rappels de faits, moyens des parties et formules de
   clôture.

## Couverture mesurée

| Mesure | Résultat |
| --- | ---: |
| Résultats API cumulés avant déduplication | 1 494 |
| Décisions uniques identifiées | 836 |
| Textes intégraux téléchargés et scannés | 832 |
| Textes vides / échecs conservés | 4 |
| Décisions fermées statiquement | 471 |
| Décisions lues par les sous-agents | 361 |
| Fiches reçues et valides | 832 / 832 |
| Décisions finalement pertinentes | 90 |
| Citations invalides ou faibles | 0 |
| Corpus tronqué | non |

Identifiants sans texte exploitable : `JURITEXT000006962616`,
`JURITEXT000006964170`, `JURITEXT000006957216` et
`JURITEXT000006964469`.

Les artefacts rejouables du test sont conservés dans :

`/private/tmp/piecemaker-legifrance-live/20260820-114253-853286-revocation-de-dirigeant-de-societe-anonyme-quelles`

## Consommation de tokens

Le runner des sous-agents ne fournit pas la télémétrie de facturation du
fournisseur. Il serait donc inexact de présenter un nombre de tokens « mangés »
comme exact. Les chiffres suivants sont des estimations de contenu selon la
méthode publique `ceil(nombre de caractères UTF-8 décodés / 4)` ; ils excluent
le prompt système, le raisonnement interne, les appels d'outils et le cache.

| Mesure | Tokens estimés |
| --- | ---: |
| Texte intégral brut des 832 décisions | 3 096 978 |
| Baseline : envoi de tous les textes au modèle | 3 311 095 en entrée |
| Pipeline hybride : 361 candidates | 591 250 en entrée |
| Sortie des seuls sous-agents | 49 049 |
| Total de contenu modèle du pilote | **640 299** |
| Fiches statiques, sans appel modèle | 22 050 en sortie déterministe |

La réduction d'entrée contre la baseline est de **82,14 %**. Les étapes API,
scan, filtre et validation consomment **0 token modèle**. L'usage exact reste
`null` dans `metrics.json` tant qu'un fournisseur ne le transmet pas.

Le pilote historique a utilisé 11 lots ciblés par volume de tokens. À la suite
du contrôle qualité, le MCP limite désormais aussi chaque futur lot à 30
décisions par défaut : le faible surcoût d'en-tête protège la qualité des petits
modèles lorsque les décisions sont courtes.

## Intégration réalisée

- Nouveaux outils MCP : `Build_Research_Corpus` et
  `Validate_Research_Cards`.
- Transport stdio autonome et adaptateur HTTP local lié uniquement à
  `127.0.0.1` ; test vivant réussi sur le port 8765.
- Configuration par environnement, `.env` local ou `LEGIFRANCE_ENV_FILE`, sans
  chemin d'installation PieceMaker requis par le serveur.
- Dossiers de sortie autonomes sous `~/.legifrance-mcp/` par défaut.
- `AGENTS.md` propre au MCP, 138 lignes, avec contrat autonome, invariants sans
  RAG, tests et arborescence.
- Agents de recherche et de tri adaptés au corpus exhaustif et au schéma plat
  fondé sur `citation_exacte`.
- Rapporteur PieceMaker enrichi des mesures de couverture, troncature et tokens
  exacts ou estimés.

## Vérifications

- 11 tests Python autonomes du MCP : réussis.
- 9 tests Node ciblés du corpus, du protocole MCP et du rapporteur : réussis.
- Suite globale : 294 tests, 291 réussis, 2 ignorés et 1 refus d'ouverture de
  port par la sandbox. Le test concerné, relancé seul hors sandbox, réussit 2/2.
- `tools/list` sur stdio : réussi sans identifiants.
- `/health` et `tools/list` sur HTTP local : réussis.
- Validation du corpus vivant : couverture complète, 832 fiches valides, zéro
  citation rejetée.

## Limites et suite recommandée

- Le pilote ne couvre que la Cour de cassation. Pour une consultation en fait,
  ajouter des requêtes de cours d'appel ciblées, avec un plafond séparé et
  clairement rapporté.
- La qualité de rappel dépend des formulations Légifrance déclarées. Un filtre
  lexical large reste auditable, mais peut produire des faux négatifs ; ils sont
  impossibles à exclure absolument sans lire sémantiquement tous les textes.
- Le contrôle statique prouve l'exactitude littérale et élimine plusieurs
  mauvaises formes de citation ; il ne remplace pas l'appréciation juridique de
  la portée d'un arrêt.
- Le droit positif et la jurisprudence doivent être revérifiés à la date de
  chaque consultation. Ce rapport est une preuve de fonctionnement et une
  synthèse de recherche, non un avis juridique sur un dossier factuel.
