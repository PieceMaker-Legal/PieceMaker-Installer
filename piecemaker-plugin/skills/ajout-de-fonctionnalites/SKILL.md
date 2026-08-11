---
name: ajout-de-fonctionnalites
description: À utiliser quand l'utilisateur veut ajouter ou modifier ses propres instructions, préférences, gabarits ou une nouvelle capacité personnelle, qui doivent rester disponibles après une mise à jour de PieceMaker. Couvre les instructions globales, une skill personnelle, un gabarit personnel, ou un élément propre à un seul dossier.
---

# Ajouter ses propres éléments (persistants aux mises à jour)

PieceMaker évolue par mises à jour (`git pull` sur le dépôt, ou
`claude plugin update` pour le plugin installé). Ces mises à jour
remplacent le contenu fourni par PieceMaker — mais jamais ce que l'avocat a
ajouté lui-même **en dehors** du dépôt et de la copie figée du plugin. Cette
skill sert de guide pour ranger un ajout personnel au bon endroit.

## Où vivent les éléments personnels, et pourquoi ils survivent

| Type d'ajout | Emplacement | Portée |
| --- | --- | --- |
| Instructions ou préférences globales (style, rappels, habitudes) | `/Users/tsardet/.piecemaker/custom/perso.md` | Toutes les affaires — ce fichier est importé automatiquement dans chaque dossier via `/Users/tsardet/.piecemaker/CLAUDE.md`. |
| Skill personnelle réutilisable | Nouveau dossier `/Users/tsardet/.claude/skills/<nom>/SKILL.md` | Toutes les sessions Claude Code — découverte automatique, jamais écrasée par PieceMaker (un fichier créé à la main n'est jamais remplacé par l'application). |
| Gabarit personnel (acte, courrier type…) | `/Users/tsardet/.piecemaker/templates/` | Disponible pour toute rédaction, indépendamment du dépôt de l'application. |
| Élément propre à une seule affaire (parties, juridiction, échéances) | Section « Ce dossier » du `CLAUDE.md` / `AGENTS.md` de ce dossier | Uniquement ce dossier-là. |

Ces emplacements sont hors du dépôt PieceMaker et hors de la copie figée du
plugin installé (celle que `claude plugin update` remplace) : une mise à
jour de PieceMaker ne les touche jamais. Réciproquement, modifier l'un de
ces fichiers ne modifie ni n'affecte le fonctionnement standard de
PieceMaker — la garantie va dans les deux sens.

## Format minimal d'une skill personnelle

Un fichier `/Users/tsardet/.claude/skills/<nom>/SKILL.md` avec un en-tête
puis du texte libre :

```markdown
---
name: <nom>
description: Une phrase expliquant quand cette skill doit se déclencher.
---

# Titre

Instructions pour l'assistant, en français, centrées sur la tâche.
```

## Ce que l'assistant doit faire quand cette skill se déclenche

1. **Demander ce que l'avocat veut ajouter** si ce n'est pas déjà clair :
   une préférence générale, une skill dédiée, un gabarit, ou un élément
   propre à un dossier en cours.
2. **Choisir l'emplacement approprié** dans le tableau ci-dessus selon la
   portée voulue (globale, réutilisable, ou limitée à un dossier).
3. **Créer ou éditer le fichier correspondant**, en respectant le format
   attendu (front matter pour une skill, section « Ce dossier » pour un
   élément local, etc.).
4. **Pour un nouveau dossier d'affaire** qui n'a pas encore de wrapper : sur
   demande, proposer et créer `CLAUDE.md` et `AGENTS.md` à la racine du
   dossier, avec exactement ce contenu (chemin absolu, jamais `~`) :

   ```
   @/Users/tsardet/.piecemaker/CLAUDE.md

   # Ce dossier
   <!-- Éléments propres à ce dossier : parties, juridiction, échéances, particularités. À compléter. -->
   ```

   Si l'un de ces deux fichiers existe déjà dans le dossier, ne jamais
   l'écraser : le lire, et s'il ne contient pas déjà cette ligne d'import,
   l'ajouter en tête sans supprimer le contenu existant.
