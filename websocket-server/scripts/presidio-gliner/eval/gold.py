"""Reference annotation for three fixed slices of GENSIGHT_URD_2023.

ANNOTATED BY CLAUDE, NOT BY THE USER. It encodes one explicit editorial rule that a
lawyer may want to overrule, so it must be reviewed before any of it is treated as
ground truth:

  * A *named, identifiable* body is an ORGANIZATION (FDA, EMA, Sofinnova Partners SAS).
  * A *generic institutional role* is not (Institutional Review Board, IBC, DSMB,
    "advisory committee", "Board of Directors").
  * Job titles are never PERSON ("Chief Executive Officer", "Chairman").
  * Products, clinical trials, genes, laws and standards are not entities
    (LUMEVOQ®, REVERSE, ND4, PDUFA, GMP).
  * Journals and publications are not organisations (Ophthalmology Therapy).

Recall is scored over DISTINCT entities, not occurrences: anonymisation substitutes by
string globally, so detecting an entity once is enough to redact every mention.
"""

GOLD = {
    "slice_A": {
        "PERSON": [],
        "ORGANIZATION": [
            "GenSight Biologics", "GenSight", "EMA", "FDA", "MHRA",
            "CAT", "Santhera",
        ],
        "LOCATION": ["Europe", "United States", "European Union", "France",
                     "United Kingdom", "UK"],
    },
    "slice_B": {
        "PERSON": [],
        "ORGANIZATION": [
            "FDA", "NIH", "NIH Office of Biotechnology Activities", "OBA", "RAC",
            "GenSight Biologics", "National Institute of Health",
        ],
        "LOCATION": ["U.S."],
    },
    "slice_C": {
        "PERSON": [
            "Bernard Gilly", "Philippe Motté", "Michael Wyzga", "Laurence Rodriguez",
            "Peter Goodfellow", "Simone Seiter", "Maritza McIntyre", "Elsy Boglioli",
            "Françoise de Craecker", "Natalie Mount", "Cédric Moreau",
        ],
        "ORGANIZATION": [
            "GenSight Biologics", "GenSight Biologics France SAS",
            "Sofinnova Partners SAS", "AMF",
        ],
        "LOCATION": [],
    },
}

# Distinctive token used for relaxed matching of a person: a prediction counts as
# finding the person if it carries the surname ("Mr. Gilly", "Gilly", "Bernard Gilly").
PERSON_KEY = {
    "Bernard Gilly": "gilly", "Philippe Motté": "motté", "Michael Wyzga": "wyzga",
    "Laurence Rodriguez": "rodriguez", "Peter Goodfellow": "goodfellow",
    "Simone Seiter": "seiter", "Maritza McIntyre": "mcintyre",
    "Elsy Boglioli": "boglioli", "Françoise de Craecker": "craecker",
    "Natalie Mount": "mount", "Cédric Moreau": "moreau",
}
