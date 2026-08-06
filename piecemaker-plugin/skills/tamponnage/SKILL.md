---
name: tamponnage
description: Configurer le tampon du cabinet et tamponner les pièces d'un dossier PieceMaker pour un bordereau — sélection des fichiers originaux, apposition du tampon numéroté et écriture dans le sous-dossier « Pièces » du dossier de travail sous la forme « Pièce n°1.pdf ». À utiliser dès qu'il est question de tamponner des pièces, de préparer ou numéroter un bordereau de pièces, ou de créer/enregistrer/supprimer le tampon.
---

# Tamponnage des pièces (bordereau)

## Où vit le code

| Rôle | Emplacement |
| --- | --- |
| Enregistrer / lire / supprimer le tampon | `websocket-server/server.cjs` — `POST /api/tampon/save` (2761), `GET /api/tampon/load` (2793), `DELETE /api/tampon/delete` (2820) |
| Tamponner une liste de pièces | `websocket-server/server.cjs` — `POST /api/stamping`, avec `pdf-lib` |
| Convertir l'original en PDF | `websocket-server/lib/office-to-pdf.cjs` — LibreOffice headless (bureautique) ou `pdf-lib` (images, texte) |
| Installer LibreOffice | `installer/steps/10-libreoffice.mjs` (`piecemaker --step 10-libreoffice`) |
| Mémoriser le dossier de travail | `websocket-server/server.cjs` — `rememberDossierFolder` / `getDossierFolder`, registre `<racine PieceMaker>/.piecemaker/dossier_folders.json` alimenté par `POST /api/extract/write-md` |
| Outil MCP `Stamping` | `mcp-server/mcp-server-local.js` → `POST /api/word/stamping` (server.cjs:3212) → WebSocket → `localTools.stamping` (`taskpane/taskpane.js`:2833) → `POST /api/stamping` |
| Interface Word (modal « 🕹️ Configurer le tampon ») | `taskpane/taskpane.html` (modal `#modalTampon`) + `taskpane/modules/anonymization.js` (`openTamponModal`, `handleTamponImageUpload`, `saveTampon`, `clearTampon`, `loadTamponFromStorage`) |
| Interface d'administration (`/admin/` → onglet « Tampon et pièces ») | `admin/index.html` (section `#pieces`), `admin/app.js` (bloc « Tampon et tamponnage des pièces »), liste des dossiers via `GET /api/admin/dossiers` (`websocket-server/admin-routes.cjs`) |

Le tampon est **un seul fichier** : `<racine PieceMaker>/.piecemaker/tampon.png`
(image PNG ou JPEG postée en base64 sur `/api/tampon/save`, cf.
`getSystemDataPath`). Un seul tampon pour tout le cabinet — pas de tampon par
dossier ni par utilisateur.

## Chaîne de traitement réelle

1. **Le tampon doit exister.** Sans `.piecemaker/tampon.png`, `/api/stamping`
   répond 400 (« Aucun tampon configuré »). On l'enregistre depuis l'onglet
   « Tampon et pièces » de `/admin/` (téléversement d'une image *ou* création
   d'un tampon dessiné dans la page, puis « Enregistrer le tampon ») ou depuis
   le menu « 🕹️ Configurer le tampon » du volet Word.
2. **La liste des pièces vient de la compilation du dossier juridique** :
   `<dossier juridique>/compilation_dossier_<documentId>.json`, champ `documents[]`
   (`id`, `filename`, `type_document`, `date_document`, `texte_integral`). Elle
   est écrite lors du chargement/anonymisation du dossier.
3. **Appel** : `POST /api/stamping` avec
   `{ "pieces": ["0001", "0003", "0002"], "documentId": "<id>", "folder": "<dossier de travail>" }`.
   **L'ordre du tableau fait la numérotation** : premier élément → Pièce n°1.
   `folder` est facultatif si le dossier de travail a déjà été mémorisé pour ce
   `documentId` (extraction faite depuis le volet Word) ; sinon la requête est
   refusée en 400 plutôt que d'écrire ailleurs. Le dossier transmis est ramené
   à son **dossier juridique** — le sous-dossier immédiat de la racine
   PieceMaker qui le contient (`resolveLegalCaseFolder`) — et tout chemin hors
   de cette racine est refusé.
4. **Pour chaque pièce**, le serveur retrouve l'entrée par son `id`, ouvre le
   **fichier original** désigné par `document.filename` (chemin complet — pas
   le `.md` produit par la conversion Markdown), le charge dans `pdf-lib`,
   appose le tampon sur la **première page**, en haut à droite (carré de
   100 pt, marge de 20 pt), avec le numéro de pièce imprimé au centre.
5. **Sortie** : `<dossier juridique>/Pièces/Pièce n°N.pdf`.
   Le dossier juridique est celui du **document Word ouvert**
   (`getCurrentDocFolder()` côté volet), jamais la racine PieceMaker : les
   pièces tamponnées restent avec le dossier du client. Réponse
   `{ folder, tamponnedDir, results[], summary: { total, success, failure } }`,
   chaque `result` portant `pieceNumber`, `id`, `filename`, `outputFileName`
   ou `error`.

**Règle de nommage — non négociable** : un fichier par pièce, nommé
exactement `Pièce n°<N>.pdf` (`Pièce n°1.pdf`, `Pièce n°2.pdf`, …), numéroté
selon l'ordre du bordereau. Pas de préfixe de dossier, pas de nom d'origine
conservé, pas de zéro de remplissage.

## Conversion en PDF de l'original

`/api/stamping` convertit chaque pièce avant de la tamponner
(`websocket-server/lib/office-to-pdf.cjs`) :

| Original | Moteur | Dépendance |
| --- | --- | --- |
| `.pdf` | aucun, le fichier est tamponné tel quel | — |
| `.xlsx` `.xlsm` `.xls` `.ods` `.csv` | LibreOffice headless | **LibreOffice requis** |
| `.docx` `.doc` `.odt` `.rtf` `.pptx` `.ppt` `.odp` `.html` | LibreOffice headless | **LibreOffice requis** |
| `.png` `.jpg` `.jpeg` | `pdf-lib`, image centrée sur une page A4 | aucune |
| `.txt` `.md` `.log` | `pdf-lib`, texte paginé A4 | aucune |
| autre (`.zip`, `.tif`, …) | refusé pièce par pièce | — |

LibreOffice est appelé avec un profil utilisateur isolé
(`-env:UserInstallation=…`), ce qui permet de convertir même quand une
instance de LibreOffice est déjà ouverte sur le poste — même précaution que le
script `office/soffice.py` des skills documentaires officielles d'Anthropic.

Si le binaire est absent, la pièce échoue avec un message d'installation et
les autres pièces sont traitées quand même. Résolution :
`piecemaker --step 10-libreoffice`, ou `SOFFICE_PATH` dans `.env` si
LibreOffice est installé à un emplacement non standard. `GET /api/admin/status`
expose `libreOffice: false` dans ce cas, et l'onglet « Tampon et pièces » de
l'administration affiche l'avertissement.

Deux règles constantes : `smart_converter.py` (skill `conversion-md`) produit
du **Markdown**, pas du PDF — il n'intervient pas ici ; et on ne tamponne
jamais le `.md` d'une pièce, le bordereau doit renvoyer au document d'origine.

## Diagnostic des erreurs fréquentes

| Message | Cause |
| --- | --- |
| `Aucun tampon configuré` | `.piecemaker/tampon.png` absent — enregistrer un tampon d'abord |
| `Dossier de travail inconnu` | le document Word n'a jamais été enregistré / l'extraction n'a pas eu lieu — passer `folder`, ou renseigner « Dossier de travail » dans l'administration |
| `Le document doit être enregistré dans un dossier juridique sous la racine PieceMaker` | le Word ouvert est hors de la racine configurée — le déplacer, ou corriger la racine dans l'administration |
| `Dossier de travail introuvable : …` | le chemin transmis n'existe pas (dossier déplacé, lecteur réseau non monté) |
| `Fichier compilation_dossier non trouvé` | dossier jamais chargé pour ce `documentId` |
| `Document avec ID … introuvable dans la compilation` | l'`id` envoyé n'existe pas dans `documents[]` (ids au format `0001`) |
| `Fichier introuvable : …` | `document.filename` ne pointe pas vers un chemin existant — le fichier original a été déplacé ou n'a jamais été enregistré avec son chemin complet |
| `Un classeur Excel exige LibreOffice…` | LibreOffice absent — `piecemaker --step 10-libreoffice` ou `SOFFICE_PATH` |
| `Conversion LibreOffice échouée (…)` | fichier protégé par mot de passe, corrompu, ou format non reconnu par LibreOffice |
| `Type de fichier non pris en charge pour le tamponnage` | extension hors du tableau ci-dessus (archive, TIFF…) |

## Règles

- Le nombre de pièces tamponnées et leur ordre doivent correspondre exactement
  au bordereau rédigé dans le document Word : renumérotez le bordereau si la
  sélection change, la numérotation n'est pas persistée côté serveur.
- Compilations et pièces tamponnées contiennent des données de client : ne
  recopiez pas leur contenu dans des logs ou des messages hors du poste local.
- Relancer `/api/stamping` écrase les `Pièce n°N.pdf` existants du sous-dossier
  `Pièces` — c'est le comportement attendu lors d'une renumérotation, mais
  prévenez avant de le faire sur un bordereau déjà déposé.
- N'écrivez jamais de pièce tamponnée à la racine du dossier juridique ni à
  celle de la racine PieceMaker : le sous-dossier `Pièces` est le seul
  emplacement.
