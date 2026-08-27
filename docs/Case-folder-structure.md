Voici l'organisation classique et standard d'un dossier juridique sur ordinateur pour un avocat français. Cette structure utilise une arborescence de dossiers numérotés pour maintenir un ordre logique immuable.

Structure type de l'arborescence (Dossier Racine)
* 00_ADMINISTRATIF_ET_FACTURATION
    * Convention d'honoraires, mandats et pouvoir.
    * Factures émises, provisions et fiches de temps.
* 01_CORRESPONDANCE
    * 01_Client : Courriels et courriers échangés avec le client.
    * 02_Avocats_adverses : Échanges officiels ou confidentiels avec la partie adverse.
    * 03_Tiers : Échanges avec les huissiers, experts ou greffes.
    * 00 - Emails convertis Md (YYYY-MM-DD - Titre de l’email -> également attribuées aux pièces originales)
* 02_DATA_ROOM
    * Pièces justificatives fournies par le client (originales), trouvées sur le web
    * 00 - Pièces converties Md (YYYY-MM-DD - Titre de la pièce -> également attribuées aux pièces originales)
* 03_PROJETS
    * Tout projet docx en cours (assignation, conclusions, contrats, etc).
* 04_NOTES_ET_RECHERCHES
    * Notes de synthèse, comptes-rendus de rendez-vous, stratégies.
    * Recherches juridiques, jurisprudence applicable, articles de doctrine.
* 05_PROCEDURE (si le dossier est contentieux - en conseil, dossier inutile).
    * Assignations, conclusions au fond, conclusions d'incident, pièces tamponnées.
    * Ordonnances de clôture, jugements, arrêts, notifications de dates d'audience.
    * Un sous-dossier par phase (Tribunal > Cour d’appel > etc ; dedans assignation, conclusions, ordonnance, jugement, etc).

Bonnes pratiques de nommage des fichiers numérique
* Format de date inversé : Commencer chaque nom de document par la date (AAAA-MM-JJ) pour un tri chronologique automatique parfait (ex: 2026-08-26_Courrier_Client.pdf).
* Zéro initial pour les pièces : Nommer les pièces sous le format 01, 02 plutôt que 1, 2 pour éviter que l'ordinateur ne classe la pièce 10 juste après la pièce 1.
* Fichiers PDF textuels : Privilégier le format PDF converti (et non scanné) ou utiliser un outil OCR (reconnaissance de caractères) pour pouvoir effectuer des recherches par mots-clés dans les documents.
Pour m'aider à affiner cette structure, dites-moi :
* S'agit-il d'un dossier de conseil (contrats, audits) ou de contentieux (tribunal) ?
* Utilisez-vous un logiciel de gestion de cabinet (Secib, Diapaz, Jarvis...) qui impose déjà ses propres dossiers ?

GLINER
N’est lancé avec la conversion md que sur la correspondance & la data room.
