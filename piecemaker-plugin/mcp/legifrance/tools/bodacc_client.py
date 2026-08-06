#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Client API BODACC pour vérification SIREN"""

import requests
from typing import Dict, Any, List, Optional
from config.settings import BODACC_API_URL


class BodaccClient:
    """Client pour l'API BODACC"""
    
    def __init__(self):
        self.base_url = BODACC_API_URL
    
    def search_by_siren(self, siren: str, limit: int = 20) -> Dict[str, Any]:
        """
        Recherche les annonces BODACC pour un SIREN
        
        Args:
            siren: Numéro SIREN (9 chiffres)
            limit: Nombre max de résultats
        
        Returns:
            Dict avec les annonces trouvées
        """
        # Nettoyer le SIREN
        siren_clean = ''.join(filter(str.isdigit, siren))
        
        if len(siren_clean) != 9:
            return {"success": False, "error": "SIREN invalide (9 chiffres requis)"}
        
        params = {
            "where": f"registre like '*{siren_clean}*'",
            "limit": limit,
            "order_by": "dateparution DESC"
        }
        
        try:
            response = requests.get(self.base_url, params=params, timeout=15)
            response.raise_for_status()
            data = response.json()
            
            records = data.get("records", [])
            
            annonces = []
            for record in records:
                fields = record.get("record", {}).get("fields", {})
                annonces.append({
                    "id": fields.get("id"),
                    "date_parution": fields.get("dateparution"),
                    "type_avis": fields.get("typeavis_lib"),
                    "famille_avis": fields.get("familleavis_lib"),
                    "commercant": fields.get("commercant"),
                    "ville": fields.get("ville"),
                    "tribunal": fields.get("tribunal"),
                    "jugement": fields.get("jugement"),
                    "acte": fields.get("acte"),
                    "url": fields.get("url_complete")
                })
            
            return {
                "success": True,
                "siren": siren_clean,
                "total": data.get("total_count", len(annonces)),
                "annonces": annonces
            }
        
        except requests.exceptions.RequestException as e:
            return {"success": False, "error": str(e)}
    
    def get_procedures_collectives(self, siren: str) -> Dict[str, Any]:
        """Recherche spécifique des procédures collectives"""
        params = {
            "where": f"registre like '*{siren}*' AND familleavis_lib like '*Procédures collectives*'",
            "limit": 50,
            "order_by": "dateparution DESC"
        }
        
        try:
            response = requests.get(self.base_url, params=params, timeout=15)
            response.raise_for_status()
            data = response.json()
            
            procedures = []
            for record in data.get("records", []):
                fields = record.get("record", {}).get("fields", {})
                procedures.append({
                    "date": fields.get("dateparution"),
                    "type": fields.get("typeavis_lib"),
                    "tribunal": fields.get("tribunal"),
                    "jugement": fields.get("jugement"),
                    "commercant": fields.get("commercant")
                })
            
            return {
                "success": True,
                "siren": siren,
                "has_procedure": len(procedures) > 0,
                "procedures": procedures
            }
        
        except requests.exceptions.RequestException as e:
            return {"success": False, "error": str(e)}
    
    def get_company_history(self, siren: str) -> Dict[str, Any]:
        """Historique complet d'une société"""
        result = self.search_by_siren(siren, limit=100)
        
        if not result.get("success"):
            return result
        
        # Catégoriser les annonces
        categories = {
            "immatriculations": [],
            "modifications": [],
            "radiations": [],
            "procedures_collectives": [],
            "ventes_cessions": [],
            "autres": []
        }
        
        for annonce in result.get("annonces", []):
            famille = (annonce.get("famille_avis") or "").lower()
            type_avis = (annonce.get("type_avis") or "").lower()
            
            if "immatriculation" in famille:
                categories["immatriculations"].append(annonce)
            elif "radiation" in famille or "radiation" in type_avis:
                categories["radiations"].append(annonce)
            elif "procédure" in famille or "collective" in famille:
                categories["procedures_collectives"].append(annonce)
            elif "vente" in famille or "cession" in famille:
                categories["ventes_cessions"].append(annonce)
            elif "modification" in famille:
                categories["modifications"].append(annonce)
            else:
                categories["autres"].append(annonce)
        
        # Alertes
        alertes = []
        if categories["procedures_collectives"]:
            alertes.append(f"⚠️ {len(categories['procedures_collectives'])} procédure(s) collective(s)")
        if categories["radiations"]:
            alertes.append(f"⚠️ {len(categories['radiations'])} radiation(s)")
        
        return {
            "success": True,
            "siren": siren,
            "total_annonces": result.get("total", 0),
            "categories": categories,
            "alertes": alertes
        }


# Instance globale
bodacc_client = BodaccClient()
