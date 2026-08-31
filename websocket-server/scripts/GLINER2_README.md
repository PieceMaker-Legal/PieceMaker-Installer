# GLiNER2.5 Entity Extractor

## Description

PieceMaker utilise GLiNER2.5, un extracteur d'entités nommé multilingue basé sur
la nouvelle architecture boundary de Fastino (287 M paramètres). Il détecte
localement les entités sensibles dans les documents Markdown.

## Installation

```bash
pip install 'gliner2[local]>=2.0.0'
```

Le modèle `fastino/gliner2.5-multi-v1` est téléchargé par l’installateur
(environ 1,1 Go). La migration depuis `fastino/gliner2-multi-v1` est obligatoire.

## Utilisation via l'interface

1. Cliquer sur le bouton 🏷️ dans la barre de contrôle
2. Sélectionner un ou plusieurs fichiers Markdown (.md)
3. Cliquer sur "▶ Extraire"
4. Les résultats sont sauvegardés dans le dossier de sortie configuré

## Utilisation en ligne de commande

```bash
python presidio-gliner/presidio-gliner.py <fichier.md> -o <dossier_sortie>
```

### Exemple

```bash
python presidio-gliner/presidio-gliner.py document.md -o ./presidio_gliner_output
```

## Entités détectées

Le pipeline GLiNER2.5 + Presidio détecte notamment les types suivants :

- **person**: Noms de personnes
- **email**: Adresses email
- **phone**: Numéros de téléphone (mobile et fixe)
- **address**: Adresses physiques et localisations
- **organization**: Noms d'entreprises et organisations
- **date**: Dates (incluant dates de naissance)
- **ssn**: Numéros de sécurité sociale
- **credit_card**: Numéros de carte de crédit
- **bank_account**: Numéros de compte bancaire
- **passport**: Numéros de passeport
- **ip_address**: Adresses IP
- **url**: URLs et adresses web

## Format de sortie

Le script génère un fichier JSON avec la structure suivante:

```json
{
  "source_file": "/chemin/vers/fichier.md",
  "scanned_at": "2025-01-15T10:30:00Z",
  "entities": {
    "PERSON": [
      {
        "text": "John Doe",
        "start": 123,
        "end": 131,
        "score": 0.95,
        "recognizer": "gliner2"
      }
    ],
    "EMAIL": [
      {
        "text": "john.doe@example.com",
        "start": 145,
        "end": 165,
        "score": 0.98,
        "recognizer": "gliner2"
      }
    ]
  },
  "summary": {
    "total_entities_found": 15,
    "entity_types": ["PERSON", "EMAIL", "PHONE", "ADDRESS"],
    "model": "fastino/gliner2.5-multi-v1"
  }
}
```

## Configuration

### Seuil de confiance

Le scanner utilise le seuil de confiance 0,5 recommandé par défaut pour la
nouvelle tête boundary. Les entités moins certaines ne sont pas retournées.

### Variables d'environnement

- `GLINER2_SCAN_PATH`: Chemin personnalisé vers le script Python
- `PYTHON_PATH`: Chemin vers l'interpréteur Python (défaut: `python3`)

## Comparaison avec Presidio

| Caractéristique | GLiNER2 | Presidio |
|----------------|---------|----------|
| API | Simple, 1 modèle | Multiple composants |
| Performance CPU | Optimisée | Plus lente |
| Confidence scores | Natif | Natif |
| Spans de texte | Natif | Natif |
| Format de sortie | JSON natif | JSON natif |
| Taille du modèle | 287M params | Variable |
| Personnalisation | Labels flexibles | Patterns regex |

## Avantages de GLiNER2

1. **API simplifiée**: Un seul modèle, une seule méthode d'extraction
2. **Performance**: Optimisé pour CPU, inférence rapide
3. **Flexibilité**: Support de labels personnalisés sans réentraînement
4. **Extraction native**: Confidence scores et spans inclus sans post-processing
5. **Format JSON**: Output structuré directement utilisable

## Dépendances

- Python 3.10+
- `gliner2[local]>=2.0.0`
- torch et transformers (installés par l’extra `local`)

## Limitations

- Nécessite un téléchargement initial du modèle (~1,1 Go)
- Performance optimale sur CPU moderne (multi-core recommandé)
- Précision variable selon la qualité du texte source

## Support

Pour plus d'informations sur GLiNER2.5 :
- Documentation : https://github.com/fastino-ai/GLiNER2
- Modèle : https://huggingface.co/fastino/gliner2.5-multi-v1
