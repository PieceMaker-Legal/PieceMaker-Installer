import json
import os
import sys
import tempfile
import unittest


HERE = os.path.dirname(os.path.dirname(__file__))
sys.path.insert(0, HERE)

from tools.research_corpus import (
    _context_windows,
    _mapping_candidate,
    _quote_quality_errors,
    build_research_corpus,
    rebuild_research_mapping,
    validate_research_cards,
)


def search_result(text_id, title):
    return {"titles": [{"id": text_id, "title": title}], "sections": []}


class FakeLegifranceClient:
    def __init__(self):
        self.search_calls = []
        self.fetch_calls = []

    def search_with_criteres(self, **kwargs):
        self.search_calls.append(kwargs)
        values = [criterion["valeur"] for criterion in kwargs["criteres"]]
        query = " ".join(values)
        if "premiere" in query:
            results = [search_result("JURITEXT001", "Décision une"), search_result("JURITEXT002", "Décision deux")]
        else:
            results = [search_result("JURITEXT002", "Décision deux"), search_result("JURITEXT003", "Décision trois")]
        return {"totalResultNumber": len(results), "results": results}

    def get_decision_text(self, text_id):
        self.fetch_calls.append(text_id)
        suffix = text_id[-3:]
        return {
            "text": {
                "id": text_id,
                "titre": f"Arrêt {suffix}",
                "juridiction": "Cour de cassation",
                "formation": "CHAMBRE_COMMERCIALE",
                "dateTexte": 1_700_000_000_000,
                "numeroAffaire": f"22-{suffix}",
                "solution": "REJET",
                "typePublicationBulletin": "PUBLIE",
                "sommaire": "La révocation doit respecter la contradiction.",
                "texte": (
                    f"La société anonyme examine la révocation de son dirigeant {suffix}.\n\n"
                    "Le dirigeant doit avoir connaissance des motifs et pouvoir présenter ses observations.\n\n"
                    "PAR CES MOTIFS, REJETTE le pourvoi."
                ),
            }
        }


class ResearchCorpusTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="legifrance-research-")
        self.addCleanup(self.temp.cleanup)

    def test_build_deduplicates_fetches_every_text_and_records_tokens(self):
        client = FakeLegifranceClient()
        info = build_research_corpus({
            "question": "Conditions de révocation",
            "queries": ["premiere révocation", "seconde révocation"],
            "juridictions": ["cassation"],
            "output_dir": self.temp.name,
            "max_decisions": 10,
            "fetch_workers": 2,
            "batch_target_tokens": 5000,
        }, client=client)

        self.assertEqual(info["identified"], 3)
        self.assertEqual(info["downloaded"], 3)
        self.assertEqual(info["scanned"], 3)
        self.assertEqual(sorted(client.fetch_calls), ["JURITEXT001", "JURITEXT002", "JURITEXT003"])
        self.assertFalse(info["truncated"])
        self.assertGreater(info["tokens_input_estimated"], 0)

        with open(info["telemetry"], encoding="utf-8") as handle:
            telemetry = json.load(handle)
        self.assertEqual(telemetry["decisions_scannees"], 3)
        self.assertIsNone(telemetry["tokens_modele_exacts"])
        self.assertTrue(os.path.exists(info["batch_plan"]))

        with open(info["batch_plan"], encoding="utf-8") as handle:
            plan = json.load(handle)
        self.assertEqual(sum(batch["nombre_decisions"] for batch in plan), 3)

    def test_boolean_candidate_filter_is_proximity_based_and_keeps_all_contexts(self):
        relevant = {
            "texte": (
                "Une société anonyme a réuni son conseil. "
                "La révocation du directeur général a été décidée. "
                "Plus loin, la révocation de son administrateur a aussi été examinée."
            )
        }
        scattered = {
            "texte": (
                "Une société anonyme est partie au litige. Révocation. "
                + ("x" * 500)
                + " Le directeur général est mentionné sans rapport."
            )
        }

        self.assertTrue(_mapping_candidate(relevant)[0])
        self.assertFalse(_mapping_candidate(scattered)[0])
        self.assertEqual(len(_context_windows(relevant["texte"])), 1)

    def test_batch_decision_cap_preserves_small_low_cost_model_batches(self):
        info = build_research_corpus({
            "question": "Conditions de révocation",
            "queries": ["premiere révocation", "seconde révocation"],
            "output_dir": self.temp.name,
            "fetch_workers": 1,
            "batch_target_tokens": 150000,
            "batch_max_decisions": 2,
        }, client=FakeLegifranceClient())

        with open(info["batch_plan"], encoding="utf-8") as handle:
            plan = json.load(handle)
        self.assertEqual([batch["nombre_decisions"] for batch in plan], [2, 1])

    def test_rebuild_mapping_archives_previous_artifacts_without_api_calls(self):
        info = build_research_corpus({
            "question": "Conditions de révocation",
            "queries": ["premiere révocation"],
            "output_dir": self.temp.name,
            "fetch_workers": 1,
        }, client=FakeLegifranceClient())

        rebuilt = rebuild_research_mapping({"folder": info["folder"]})

        self.assertEqual(rebuilt["scanned"], 2)
        self.assertEqual(rebuilt["model_candidates"], 2)
        self.assertTrue(os.path.isdir(rebuilt["archive"]))
        self.assertTrue(os.path.isdir(os.path.join(rebuilt["archive"], "batches")))
        self.assertTrue(os.path.exists(os.path.join(info["folder"], "batch-plan.json")))

    def test_validation_requires_full_coverage_and_source_backed_quotes(self):
        info = build_research_corpus({
            "question": "Conditions de révocation",
            "queries": ["premiere révocation", "seconde révocation"],
            "output_dir": self.temp.name,
            "fetch_workers": 1,
        }, client=FakeLegifranceClient())

        cards_path = os.path.join(info["folder"], "cards", "lot-001.jsonl")
        cards = []
        for text_id in ("JURITEXT001", "JURITEXT002", "JURITEXT003"):
            quote = "Le dirigeant doit avoir connaissance des motifs et pouvoir présenter ses observations."
            if text_id == "JURITEXT003":
                quote = "Cette phrase a été inventée"
            cards.append({
                "id": text_id,
                "pertinent": True,
                "question_juridique": "contradictoire",
                "faits_determinants": [],
                "solution": "rejet",
                "portee": "condition procédurale",
                "sens": "neutre",
                "citation_exacte": quote,
                "incertitudes": [],
            })
        with open(cards_path, "w", encoding="utf-8") as handle:
            for card in cards:
                handle.write(json.dumps(card, ensure_ascii=False) + "\n")

        invalid = validate_research_cards({"folder": info["folder"]})
        self.assertFalse(invalid["coverage_complete"])
        self.assertEqual(invalid["missing"], 0)
        self.assertEqual(invalid["invalid_quotes"], 1)
        self.assertEqual(invalid["valid_cards"], 2)

        cards[-1]["citation_exacte"] = (
            "Le dirigeant doit avoir connaissance des motifs et pouvoir présenter ses observations."
        )
        with open(cards_path, "w", encoding="utf-8") as handle:
            for card in cards:
                handle.write(json.dumps(card, ensure_ascii=False) + "\n")

        valid = validate_research_cards({
            "folder": info["folder"],
            "usage": {"input_tokens": 1200, "output_tokens": 300},
        })
        self.assertTrue(valid["coverage_complete"])
        self.assertEqual(valid["exact_usage"]["input_tokens"], 1200)
        self.assertTrue(os.path.exists(valid["matrix"]))

    def test_validation_rejects_normalized_but_non_literal_quote_and_bad_schema(self):
        info = build_research_corpus({
            "question": "Conditions de révocation",
            "queries": ["premiere révocation"],
            "output_dir": self.temp.name,
            "fetch_workers": 1,
        }, client=FakeLegifranceClient())

        cards_path = os.path.join(info["folder"], "cards", "lot-001.jsonl")
        cards = []
        for text_id in ("JURITEXT001", "JURITEXT002"):
            cards.append({
                "id": text_id,
                "pertinent": True,
                "question_juridique": "contradictoire",
                "faits_determinants": [],
                "solution": "rejet",
                "portee": "condition procédurale",
                "sens": "neutre",
                "citation_exacte": (
                    "Le dirigeant doit avoir connaissance des motifs et pouvoir presenter ses observations."
                ),
                "incertitudes": [],
            })
        cards[1]["sens"] = "indetermine"
        with open(cards_path, "w", encoding="utf-8") as handle:
            for card in cards:
                handle.write(json.dumps(card, ensure_ascii=False) + "\n")

        result = validate_research_cards({"folder": info["folder"]})
        self.assertFalse(result["coverage_complete"])
        self.assertEqual(result["invalid_quotes"], 2)
        self.assertEqual(result["valid_cards"], 0)
        with open(os.path.join(info["folder"], "metrics.json"), encoding="utf-8") as handle:
            metrics = json.load(handle)
        self.assertEqual(metrics["erreurs_schema"], 1)
        self.assertEqual(metrics["fiches_pertinentes_sans_citation"], 2)

    def test_quote_quality_rejects_fragments_facts_arguments_and_boilerplate(self):
        quotes = [
            "que la révocation avait été décidée sans que le dirigeant puisse répondre aux griefs formulés ;",
            "Attendu, selon l'arrêt attaqué, que le dirigeant a été révoqué par le conseil d'administration ;",
            "Soutenant que sa révocation était abusive, le dirigeant a demandé des dommages-intérêts ;",
            "Ainsi fait et jugé par la Cour de cassation et prononcé en audience publique.",
        ]
        for quote in quotes:
            with self.subTest(quote=quote):
                self.assertTrue(_quote_quality_errors(quote, quote, 0))

        holding = (
            "Attendu que la révocation d'un administrateur peut intervenir à tout moment "
            "et n'est abusive que si elle porte atteinte à sa réputation ou à son honneur ;"
        )
        self.assertEqual(_quote_quality_errors(holding, holding, 0), [])


if __name__ == "__main__":
    unittest.main()
