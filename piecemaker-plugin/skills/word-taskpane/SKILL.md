---
name: word-taskpane
description: Lire et écrire dans un document Word (.docx) — soit via le volet PieceMaker (Word ouvert, read_doc/edit_doc, suivi des modifications + anonymisation), soit en éditant directement l'OOXML du fichier. À utiliser dès qu'il faut ouvrir, lire ou modifier un .docx.
---

# Lire et écrire dans Word

Deux voies. **Volet** = édition interactive dans Word ouvert (suivi des
modifications + anonymisation transparente). **OOXML** = édition directe du
`.docx` sur disque, sans Word.

## Où vit le code

| Rôle | Emplacement |
| --- | --- |
| Manifeste de l'add-in (identité, URLs, ruban) | `taskpane/manifest.xml` |
| Scripts de lancement / sideload | `taskpane/package.json` + `taskpane/scripts/` |
| Préflight + lancement en une commande | `taskpane/scripts/dev.sh` |
| Nettoyage d'un sideload resté en place | `taskpane/scripts/clear-sideload.js` |
| Manifeste de production (origine publique) | `taskpane/scripts/build-manifest.js` → `taskpane/dist/` |
| Enregistrement développeur (API) | `websocket-server/lib/word-launcher.cjs` — `ensureDevRegistration` / `isDevRegistered` / `removeDevRegistration` |
| Lancement de Word sur un document | `websocket-server/lib/word-launcher.cjs` — `launchWord` / `activateWord` |
| Injection de l'auto-ouverture dans le .docx | `websocket-server/lib/docx-autoopen.cjs` |
| Serveur HTTPS qui sert le volet | `websocket-server/server.cjs` — `express.static('taskpane')`, port 43098 |
| Étape d'installation | `installer/steps/12-word-taskpane.mjs` (`piecemaker --step 12-word-taskpane`) |
| Certificat HTTPS | `installer/steps/05-certificats.mjs` → `websocket-server/localhost.{crt,key}` |

## Le mécanisme d'ouverture, en trois briques

1. **Le volet est servi en statique.** Il n'y a **pas de bundler** : le serveur
   PieceMaker fait `express.static(taskpane/)` et sert `taskpane.html`,
   `taskpane.js`, `taskpane.css` et `assets/` tels qu'ils sont dans le dépôt, en
   HTTPS sur `https://localhost:43098`. Modifier un fichier du volet ne demande
   aucune recompilation, seulement un rechargement du volet.

2. **L'add-in est enregistré en mode développeur**, une fois par poste. Cet
   enregistrement est intégralement délégué à l'outillage Microsoft
   `office-addin-dev-settings` (le moteur de `office-addin-debugging`) :
   - **macOS** : lien dur du manifeste dans
     `~/Library/Containers/com.microsoft.Word/Data/Documents/wef/`, nommé
     `<Id du manifeste>.manifest.xml` ;
   - **Windows** : valeur `REG_SZ` sous
     `HKCU\SOFTWARE\Microsoft\Office\16.0\Wef\Developer`, dont le **nom** est
     l'`<Id>` du manifeste et la **donnée** le chemin du manifeste.

   Trois chemins déclenchent le même enregistrement, avec le même code :
   `npm start --prefix taskpane`, l'étape d'installation 12, et l'appel
   `/api/word/open-doc` du serveur.

3. **Le document porte la référence du volet.** `docx-autoopen.cjs` écrit dans
   le `.docx` les parties OOXML `word/webextensions/*` qui pointent l'add-in par
   son GUID (`store="developer" storeType="Registry"`). C'est cette référence,
   résolue contre l'enregistrement de la brique 2, qui fait apparaître le volet
   **sans clic sur le ruban** à l'ouverture du document.

**L'`<Id>` et la `<Version>` de `taskpane/manifest.xml` sont load-bearing** :
`docx-autoopen.cjs` les recopie dans chaque `.docx` préparé. Les changer casse
l'auto-ouverture de tous les documents déjà préparés.

## Démarrage — macOS

1. **[MANUEL]** Vérifier que Microsoft Word (bureau) est installé.
2. **[MANUEL]** Lancer, depuis la racine du dépôt :
   `bash taskpane/scripts/dev.sh` (ou `npm run taskpane:dev`).
3. **[AUTO]** Contrôle de Node (≥ 18).
4. **[AUTO]** Complément du `.env` **de la racine** — `PORT`,
   `PIECEMAKER_ADDIN_ID`, `PIECEMAKER_ADDIN_VERSION` — en **ajout seulement**,
   et alerte si l'`ID` du `.env` diverge du `<Id>` du manifeste.
5. **[AUTO]** `npm install` à la racine.
6. **[AUTO]** Contrôle du certificat `websocket-server/localhost.crt`
   (présence + expiration à 30 jours), régénération si nécessaire, et
   vérification que la CA est approuvée par le trousseau macOS.
7. **[MANUEL]** Si le script signale une CA non approuvée :
   `piecemaker --step 05-certificats` (demande le mot de passe administrateur).
8. **[AUTO]** Contrôle du port 43098 : serveur déjà en ligne (réutilisé), port
   libre (le serveur sera démarré), ou port squatté (arrêt du script).
9. **[AUTO]** Fermeture de Word (`osascript … quit`). Word ne relit ni le
   dossier de sideload ni la confiance des certificats à chaud.
10. **[MANUEL]** Si Word refuse de se fermer (document non enregistré) :
    le fermer à la main puis relancer.
11. **[AUTO]** `npm start` → `office-addin-debugging start manifest.xml`, qui
    enregistre l'add-in, s'assure que le serveur répond sur 43098, et ouvre
    Word.
12. **[MANUEL]** Dans Word : **Accueil → PieceMaker → Ouvrir PieceMaker**
    (inutile pour un document préparé par `open_doc` : le volet s'ouvre seul).
13. **[MANUEL]** Pour terminer la session : `npm run taskpane:stop`.

Variantes : `bash taskpane/scripts/dev.sh --setup-only` fait tout sauf fermer
Word et lancer ; `FORCE=1` lance malgré un serveur injoignable.

## Démarrage — Windows

Le mécanisme est identique ; seuls l'enregistrement (registre au lieu du
dossier `wef`) et le shell changent.

1. **[MANUEL]** Prérequis : Word bureau (Microsoft 365 ou 2019+), Node ≥ 18, et
   — pour `dev.sh` uniquement — **Git Bash** ou WSL. `dev.sh` est un script
   bash : il ne s'exécute pas sous `cmd.exe` ni PowerShell.
2. **[MANUEL]** Générer et approuver le certificat :
   `piecemaker --step 05-certificats` (utilise `certutil -addstore -user Root`).
3. **[MANUEL]** Démarrer le serveur : `npm run server` à la racine.
4. **[MANUEL]** Enregistrer l'add-in et ouvrir Word :
   - avec Git Bash : `bash taskpane/scripts/dev.sh` (procédure macOS ci-dessus,
     étape 9 fermant `WINWORD.EXE` via `taskkill`) ;
   - **chemin de secours sans bash**, depuis `cmd.exe` ou PowerShell :
     `npm start --prefix taskpane`. Ce chemin est complet — les hooks
     `prestart`/`predev` et `office-addin-debugging` fonctionnent nativement —
     mais il **saute tout le préflight** (certificat, port, fermeture de Word).
5. **[AUTO]** `clear-sideload.js` supprime un éventuel enregistrement resté en
   place, puis `office-addin-debugging` écrit la valeur sous
   `HKCU\SOFTWARE\Microsoft\Office\16.0\Wef\Developer` et lance Word.
6. **[MANUEL]** Si Word était ouvert, le fermer complètement et relancer :
   Word ne relit pas le registre à chaud.
7. **[MANUEL]** Dans Word : **Accueil → PieceMaker → Ouvrir PieceMaker**.

Alternative sans aucune CLI : `piecemaker --step 12-word-taskpane` réalise le
seul enregistrement (sans ouvrir Word), via exactement le même code.

## Voie volet — Word ouvert

**Une seule commande** ouvre Word sur le document *choisi* (le vrai fichier, en
place) **avec le volet PieceMaker déjà affiché**. C'est la seule voie qui y
parvient : `office-addin-debugging start --document` copie le fichier dans un
dossier temporaire, et sans `--document` il ouvre un document vierge.

Depuis Claude Code, via l'outil MCP :

```
open_doc { "path": "/abs/…/doc.docx" }   # enregistre l'add-in, injecte le volet
                                          # dans le .docx, lance Word + volet
read_doc {}                              # relève les index de paragraphes
edit_doc { "operation": "insert_after", "target_index": 12, "text": "## Titre\nTexte" }
```

Équivalent HTTP brut (serveur `43098` démarré) — retourne
`paneReady:true, panesConnected:1` quand le volet est connecté :

```bash
curl -sk -X POST https://localhost:43098/api/word/open-doc \
  -H 'Content-Type: application/json' \
  -d '{"path":"/abs/…/doc.docx"}'
```

- `.docx` uniquement, chemin absolu ; idempotent, macOS + Windows.
- `read_doc` **obligatoire avant** `edit_doc` (imposé côté serveur).
- Texte = Markdown → mise en forme Word (titres, gras, listes, `[^footnote: …]`).
- Modifs en **suivi des modifications** ; mapping d'anonymisation appliqué
  automatiquement (skill `anonymisation`).
- Si le doc est déjà ouvert dans Word, le fermer d'abord (le fichier est réécrit).

## Voie OOXML — fichier .docx, sans Word

`.docx` = archive ZIP de XML ; le texte vit dans `word/document.xml`.

Le `.docx` original **reste dans son dossier** (jamais modifié en place). On
dézippe une copie de travail dans un sous-dossier de `Fichiers convertis
PieceMaker/` **dont le nom finit par `-ooxml`** (classé espace de travail) :

```bash
unzip -d "Fichiers convertis PieceMaker/doc-ooxml" doc.docx
```

- **Lire** : `word/document.xml` de la copie extraite.
- **Écrire** : éditer `word/document.xml` (suivi des modifications = balises
  `<w:ins>` / `<w:del>`) → rezipper **toute** la copie extraite (jamais le seul
  `document.xml`) vers un nouveau `.docx`, `[Content_Types].xml` stocké non
  compressé ; ou `python-docx` pour créer un document de zéro.

  ```bash
  cd "Fichiers convertis PieceMaker/doc-ooxml"
  zip -X -0 "../doc-modifié.docx" "[Content_Types].xml"      # stocké
  zip -rX "../doc-modifié.docx" . -x "[Content_Types].xml"   # tout le reste
  ```

## Commandes

Depuis la racine du dépôt :

| Commande | Effet |
| --- | --- |
| `npm run taskpane:dev` | Préflight complet puis enregistrement + ouverture de Word |
| `npm run taskpane:start` | Enregistrement + ouverture de Word, sans préflight |
| `npm run taskpane:stop` | Retire l'enregistrement développeur |
| `npm run taskpane:validate` | Valide `taskpane/manifest.xml` |
| `npm run taskpane:build` | Manifeste de production dans `taskpane/dist/` (requiert `PIECEMAKER_ADDIN_PUBLIC_URL`) |
| `npm run server` | Serveur PieceMaker seul (sert le volet sur 43098) |
| `piecemaker --step 12-word-taskpane` | Enregistrement seul, sans ouvrir Word |

## Écarts assumés par rapport au projet amont (Mike)

- **Pas de dev-server webpack.** Le volet Mike est bundlé par webpack sur
  `https://localhost:3200` ; PieceMaker sert des fichiers statiques depuis son
  propre serveur. `office-addin-debugging` reçoit donc
  `--dev-server "node ../websocket-server/server.cjs" --dev-server-port 43098` :
  si le serveur tourne déjà, il est **réutilisé** ; sinon il est démarré.
- **Certificat.** Mike utilise `office-addin-dev-certs`. PieceMaker présente son
  propre certificat (`websocket-server/localhost.crt`, produit par
  `generate-ca-certificates.cjs`) : c'est celui-là que `dev.sh` vérifie.
  Installer `office-addin-dev-certs` ne servirait à rien et déclencherait une
  invite trousseau inutile — voir le dépannage ci-dessous.
- **Fichier `.env`.** Mike régénère `word-addin/.env` intégralement. Ici les
  variables vivent dans le `.env` **de la racine**, chargé par `dotenv` dans
  `server.cjs` et porteur d'autres secrets : `dev.sh` n'y **ajoute** que les
  clés manquantes. Modèle : `taskpane/.env.example`.

## Dépannage

**« EEXIST … link 'manifest.xml' → …/wef/….manifest.xml »**
Un sideload précédent n'a pas été arrêté. `npm run taskpane:stop`, puis
relancer. Les hooks `prestart`/`predev` (`clear-sideload.js`) le font
normalement tout seuls.

**Le port 43098 est occupé**
`lsof -nP -iTCP:43098 -sTCP:LISTEN` (macOS) ou
`netstat -ano | findstr :43098` (Windows) pour identifier le processus. Si c'est
déjà le serveur PieceMaker, il n'y a rien à faire : `dev.sh` le détecte via
`/health` et le réutilise.

**Word affiche « contenu bloqué : certificat de sécurité non valide »**
La CA PieceMaker n'est pas (ou plus) approuvée par le système, ou le certificat
a expiré. `piecemaker --step 05-certificats`, puis **quitter complètement Word**
(Cmd-Q / fermer `WINWORD.EXE`) : son moteur de rendu met la confiance en cache.

**Une invite trousseau « office-addin-dev-certs » apparaît**
`office-addin-debugging` installe ce certificat avant de démarrer un dev-server
qui n'est pas déjà en ligne. PieceMaker ne s'en sert pas. Pour l'éviter :
démarrer `npm run server` **avant** `npm run taskpane:dev` — le serveur étant
déjà en ligne, l'outil ne touche pas aux certificats.

**Le volet ne s'ouvre pas tout seul sur un document préparé**
Trois causes, dans l'ordre :
1. add-in non enregistré → `piecemaker --step 12-word-taskpane` puis vérifier
   avec `piecemaker --check` (étape 12 doit être « done ») ;
2. `PIECEMAKER_ADDIN_ID` du `.env` racine ≠ `<Id>` de `taskpane/manifest.xml` →
   la référence webextension du `.docx` ne résout pas ; réaligner puis
   réappeler `open_doc` sur le document ;
3. le volet a été fermé puis le document enregistré → Word a réécrit
   `visibility="0"` ; `open_doc` répare (`injectionReason: "repaired"`).

**Le bouton n'apparaît pas dans le ruban**
Word n'a pas relu l'enregistrement : le fermer complètement et le rouvrir.
Sur Windows, vérifier la valeur :
`reg query "HKCU\SOFTWARE\Microsoft\Office\16.0\Wef\Developer"`.

**Le manifeste est refusé**
`npm run taskpane:validate`. L'étape d'installation 12 lance la même validation
et refuse de s'enregistrer sur un manifeste invalide.
